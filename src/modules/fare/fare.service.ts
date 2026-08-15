import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigurationService } from '../subscription/configuration.service';
import { LocationSvcClient } from '../../common/location-svc/location-svc.client';
import {
  FareRateKeys,
  FareRates,
  FARE_RATE_DEFAULTS,
  perKmFromMeter,
} from './fare-rates';

export interface FareCalculationInput {
  /** Trip distance in kilometers (converted internally to meters). */
  distanceKm: number;
  durationMinutes: number;
  waitMinutes?: number;
  /** Zone id for live demand surge (optional). */
  zoneId?: string;
  /**
   * Locked surge from quote/request time. When set, live demand is not
   * re-fetched so rider quote, driver offer, and final charge stay identical.
   */
  surgeMultiplier?: number;
  /** Requested vehicle class — prices moto below and SUV/XL above sedan. */
  vehicleType?: string | null;
}

export interface FareBreakdown {
  /** Relative price factor for the requested vehicle class (1 = sedan). */
  vehicleMultiplier: number;
  /** Flat initial fee from DB. */
  initialFee: number;
  /** Distance charge = perMeter × meters. */
  distanceCharge: number;
  timeCharge: number;
  waitCharge: number;
  distanceMeters: number;
  rates: FareRates;
  surgeMultiplier: number;
  subtotal: number;
  total: number;
  /**
   * Platform's cut of the fare. Always zero under the current business
   * model — the platform earns from the monthly driver subscription, not
   * a per-ride cut, and 100% of the fare (plus any tip) goes to the
   * driver. Kept on the breakdown so callers never have to hardcode it.
   */
  platformFee: number;
  /** @deprecated Use initialFee — kept for older clients. */
  base: number;
}

@Injectable()
export class FareService {
  private readonly logger = new Logger(FareService.name);

  /** Short TTL cache: matching used to hit location-svc once per candidate trip. */
  private readonly surgeByZone = new Map<
    string,
    { multiplier: number; expiresAt: number }
  >();
  private readonly surgeCacheTtlMs = 5_000;

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly config: ConfigService,
    private readonly locationSvc: LocationSvcClient,
  ) {}

  /** Snapshot of independently tunable rates from Neon `configuration`. */
  getRates(): FareRates {
    return {
      initialFeeEtb: this.readNumber(
        FareRateKeys.initialFeeEtb,
        FARE_RATE_DEFAULTS[FareRateKeys.initialFeeEtb],
      ),
      perMeterEtb: this.readNumber(
        FareRateKeys.perMeterEtb,
        FARE_RATE_DEFAULTS[FareRateKeys.perMeterEtb],
      ),
      perMinuteEtb: this.readNumber(
        FareRateKeys.perMinuteEtb,
        FARE_RATE_DEFAULTS[FareRateKeys.perMinuteEtb],
      ),
      perWaitMinuteEtb: this.readNumber(
        FareRateKeys.perWaitMinuteEtb,
        FARE_RATE_DEFAULTS[FareRateKeys.perWaitMinuteEtb],
      ),
      minimumEtb: this.readNumber(
        FareRateKeys.minimumEtb,
        FARE_RATE_DEFAULTS[FareRateKeys.minimumEtb],
      ),
      surgeMaxMultiplier: this.readNumber(
        FareRateKeys.surgeMaxMultiplier,
        FARE_RATE_DEFAULTS[FareRateKeys.surgeMaxMultiplier],
      ),
    };
  }

  /**
   * Canonical fare algorithm (cash / share marketplace):
   *
   *   distanceCharge = fare_per_meter_etb × (distanceKm × 1000)
   *   timeCharge     = fare_per_minute_etb × durationMinutes
   *   waitCharge     = fare_per_wait_minute_etb × waitMinutes
   *   subtotal       = max(initial + distance + time + wait, minimum)
   *   total          = round(subtotal × surge, 2)
   *
   * Initial fee and per-meter rate are independent DB keys — change one
   * without touching the other.
   */
  async calculate(input: FareCalculationInput): Promise<FareBreakdown> {
    const rates = this.getRates();
    const distanceMeters = Math.max(0, input.distanceKm) * 1000;
    const durationMinutes = Math.max(0, input.durationMinutes);
    const waitMinutes = Math.max(0, input.waitMinutes ?? 0);

    const initialFee = rates.initialFeeEtb;
    const distanceCharge = rates.perMeterEtb * distanceMeters;
    const timeCharge = rates.perMinuteEtb * durationMinutes;
    const waitCharge = rates.perWaitMinuteEtb * waitMinutes;

    const raw = initialFee + distanceCharge + timeCharge + waitCharge;
    const subtotal = Math.max(raw, rates.minimumEtb);

    const surgeMultiplier =
      input.surgeMultiplier != null && Number.isFinite(input.surgeMultiplier)
        ? Math.min(
            Math.max(1, input.surgeMultiplier),
            rates.surgeMaxMultiplier,
          )
        : input.zoneId
          ? await this.resolveSurgeMultiplier(
              input.zoneId,
              rates.surgeMaxMultiplier,
            )
          : 1;

    const vehicleMultiplier = this.vehicleTypeMultiplier(input.vehicleType);
    const total =
      Math.round(subtotal * surgeMultiplier * vehicleMultiplier * 100) / 100;

    return {
      vehicleMultiplier,
      initialFee,
      distanceCharge: Math.round(distanceCharge * 100) / 100,
      timeCharge: Math.round(timeCharge * 100) / 100,
      waitCharge: Math.round(waitCharge * 100) / 100,
      distanceMeters: Math.round(distanceMeters * 100) / 100,
      rates: {
        ...rates,
        // expose derived km for dashboards that still think in km
      },
      surgeMultiplier,
      subtotal: Math.round(subtotal * 100) / 100,
      total,
      platformFee: 0,
      base: initialFee,
    };
  }

  /**
   * Relative pricing per vehicle class, mirroring dispatch's capacity bands
   * (rides.service vehicleMatchesType): moto below sedan, SUV/van/XL above.
   * The same multiplier is used at quote time and at trip completion so the
   * rider is charged what they were quoted.
   */
  vehicleTypeMultiplier(vehicleType?: string | null): number {
    const wanted = (vehicleType ?? 'any').toLowerCase().trim();
    if (
      wanted.includes('moto') ||
      wanted.includes('motor') ||
      wanted.includes('bike')
    ) {
      return 0.7;
    }
    if (
      wanted.includes('suv') ||
      wanted.includes('van') ||
      wanted.includes('xl')
    ) {
      return 1.5;
    }
    return 1;
  }

  /** City-speed ETA helper used when true routing duration is unavailable. */
  estimateDurationMinutes(distanceKm: number, averageSpeedKmh = 25): number {
    if (distanceKm <= 0) return 0;
    return (distanceKm / averageSpeedKmh) * 60;
  }

  ratesPublicView() {
    const rates = this.getRates();
    return {
      ...rates,
      perKmEtb: perKmFromMeter(rates.perMeterEtb),
      formula:
        'total = max(initialFee + perMeter×meters + perMinute×minutes + wait, minimum) × surge',
    };
  }

  private readNumber(key: string, fallback: number): number {
    try {
      const value = this.configuration.get<unknown>(key);
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  }

  private async resolveSurgeMultiplier(
    zoneId: string,
    maxMultiplier: number,
  ): Promise<number> {
    const cached = this.surgeByZone.get(zoneId);
    if (cached && cached.expiresAt > Date.now()) {
      return Math.min(cached.multiplier, maxMultiplier);
    }

    if (!this.locationSvc.enabled || this.locationSvc.isOpen) return 1;
    try {
      const data = await this.locationSvc.get<{ demandRatio: number }>(
        `/zones/${zoneId}/demand`,
        undefined,
        500,
      );
      // A non-numeric body would otherwise propagate NaN all the way into the
      // charged total.
      const ratio = Number(data?.demandRatio);
      if (!Number.isFinite(ratio)) {
        this.logger.warn(
          `Surge lookup for zone ${zoneId} returned a non-numeric ratio; using 1.0`,
        );
        return 1;
      }
      const multiplier = 1 + Math.max(0, ratio - 1);
      this.surgeByZone.set(zoneId, {
        multiplier,
        expiresAt: Date.now() + this.surgeCacheTtlMs,
      });
      return Math.min(multiplier, maxMultiplier);
    } catch (error) {
      this.logger.warn(
        `Surge lookup failed for zone ${zoneId}: ${(error as Error).message}`,
      );
      return 1;
    }
  }
}
