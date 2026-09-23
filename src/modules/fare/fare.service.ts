import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigurationService } from '../subscription/configuration.service';
import { LocationSvcClient } from '../../common/location-svc/location-svc.client';
import {
  FareRateKeys,
  FareRates,
  FARE_RATE_DEFAULTS,
  perKmFromMeter,
  ADDIS_AVERAGE_SPEED_KMH,
  URBAN_ROAD_CIRCUITY,
} from './fare-rates';
import { computeLiveSurge, DEFAULT_SURGE_CONFIG } from './surge.math';
import { haversineKm, type GeoPoint } from '../matching/geo/geo.util';

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
  /**
   * Ops-configured multipliers from the active/locked pricing version.
   * When omitted, built-in defaults apply (moto 0.7, suv/xl 1.5, else 1).
   */
  vehicleMultipliers?: Record<string, number> | null;
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
  durationMinutes: number;
  waitMinutes: number;
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
   *   total          = round(subtotal × surge × vehicle)   // whole ETB (cash)
   *
   * Initial fee and per-meter rate are independent DB keys — change one
   * without touching the other.
   */
  async calculate(
    input: FareCalculationInput,
    rateSnapshot?: FareRates | null,
  ): Promise<FareBreakdown> {
    const rates = rateSnapshot ?? this.getRates();
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
        ? Math.min(Math.max(1, input.surgeMultiplier), rates.surgeMaxMultiplier)
        : input.zoneId
          ? await this.resolveSurgeMultiplier(
              input.zoneId,
              rates.surgeMaxMultiplier,
            )
          : 1;

    const vehicleMultiplier = this.vehicleTypeMultiplier(
      input.vehicleType,
      input.vehicleMultipliers,
    );
    const combinedMultiplier = surgeMultiplier * vehicleMultiplier;
    const total = Math.round(subtotal * combinedMultiplier);

    // Scale component charges with multiplier and reconcile with total
    // so receipts, driver earnings, and rider invoices always sum exactly to total.
    const distanceScaled =
      Math.round(distanceCharge * combinedMultiplier * 100) / 100;
    const timeScaled = Math.round(timeCharge * combinedMultiplier * 100) / 100;
    const waitScaled = Math.round(waitCharge * combinedMultiplier * 100) / 100;
    const initialScaled =
      Math.round((total - distanceScaled - timeScaled - waitScaled) * 100) /
      100;

    return {
      vehicleMultiplier,
      initialFee: initialScaled,
      distanceCharge: distanceScaled,
      timeCharge: timeScaled,
      waitCharge: waitScaled,
      distanceMeters: Math.round(distanceMeters * 100) / 100,
      durationMinutes: Math.round(durationMinutes * 10) / 10,
      waitMinutes: Math.round(waitMinutes * 10) / 10,
      rates: {
        ...rates,
      },
      surgeMultiplier,
      subtotal: Math.round(subtotal * 100) / 100,
      total,
      platformFee: 0,
      base: initialScaled,
    };
  }

  /**
   * Road kilometres + minutes for quoting. Client OSRM may refine the path
   * but cannot undercut crow-fly distance or invent a near-zero trip.
   */
  quotedTripMetrics(
    pickup: GeoPoint,
    dropoff: GeoPoint,
    clientDistanceKm?: number | null,
    clientDurationMinutes?: number | null,
  ): { distanceKm: number; durationMinutes: number } {
    const crowFlyKm = haversineKm(pickup, dropoff);
    const fallbackKm = Math.max(crowFlyKm * URBAN_ROAD_CIRCUITY, crowFlyKm);
    const floorKm = crowFlyKm;
    const capKm = Math.max(fallbackKm * 3, crowFlyKm + 1);

    let distanceKm = fallbackKm;
    if (clientDistanceKm != null && Number.isFinite(clientDistanceKm)) {
      distanceKm = Math.min(Math.max(clientDistanceKm, floorKm), capKm);
    }

    const fallbackMinutes = this.estimateDurationMinutes(distanceKm);
    let durationMinutes = fallbackMinutes;
    if (
      clientDurationMinutes != null &&
      Number.isFinite(clientDurationMinutes) &&
      clientDurationMinutes > 0
    ) {
      const floorMin = fallbackMinutes * 0.5;
      const capMin = fallbackMinutes * 2.5;
      durationMinutes = Math.min(
        Math.max(clientDurationMinutes, floorMin),
        capMin,
      );
    }

    return { distanceKm, durationMinutes };
  }

  /**
   * At completion, keep the quoted road distance (the rider bought that trip)
   * but bill travel minutes from the clock so Bole traffic is not free.
   * Floor 90% of quote / cap 140% so a forgotten End Trip cannot explode fare.
   */
  settledDurationMinutes(
    quotedDurationMinutes: number,
    startedAt: Date | null | undefined,
    completedAt: Date = new Date(),
  ): number {
    const quoted = Math.max(0, quotedDurationMinutes);
    if (!startedAt) return quoted;
    const elapsed =
      (completedAt.getTime() - new Date(startedAt).getTime()) / 60_000;
    if (!Number.isFinite(elapsed) || elapsed < 0.5) return quoted;
    const floor = quoted * 0.9;
    const cap = Math.max(quoted * 1.4, quoted + 8);
    return Math.min(Math.max(elapsed, floor), cap);
  }

  /**
   * Billable pickup wait = arrive → start, after a short free grace.
   * Caps so a forgotten Start Trip cannot invent unlimited wait.
   */
  settledWaitMinutes(
    arrivedAt: Date | null | undefined,
    startedAt: Date | null | undefined,
    opts?: { freeMinutes?: number; maxMinutes?: number },
  ): number {
    if (!arrivedAt || !startedAt) return 0;
    const free = Math.max(0, opts?.freeMinutes ?? 2);
    const max = Math.max(free, opts?.maxMinutes ?? 45);
    const raw =
      (new Date(startedAt).getTime() - new Date(arrivedAt).getTime()) / 60_000;
    if (!Number.isFinite(raw) || raw <= free) return 0;
    return Math.min(raw - free, max - free);
  }

  /**
   * Relative pricing per vehicle class. Prefers ops-configured multipliers from
   * the locked pricing version; falls back to dispatch capacity bands.
   */
  vehicleTypeMultiplier(
    vehicleType?: string | null,
    configured?: Record<string, number> | null,
  ): number {
    const wanted = (vehicleType ?? 'any').toLowerCase().trim();
    if (configured && Object.keys(configured).length > 0) {
      const direct = configured[wanted];
      if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) {
        return direct;
      }
      for (const [key, value] of Object.entries(configured)) {
        if (
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value > 0 &&
          (wanted.includes(key) || key.includes(wanted))
        ) {
          return value;
        }
      }
      if (
        typeof configured.any === 'number' &&
        Number.isFinite(configured.any) &&
        configured.any > 0
      ) {
        return configured.any;
      }
    }
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
  estimateDurationMinutes(
    distanceKm: number,
    averageSpeedKmh = ADDIS_AVERAGE_SPEED_KMH,
  ): number {
    if (distanceKm <= 0) return 0;
    return (distanceKm / averageSpeedKmh) * 60;
  }

  ratesPublicView() {
    const rates = this.getRates();
    return {
      ...rates,
      perKmEtb: perKmFromMeter(rates.perMeterEtb),
      formula:
        'total = round(max(initialFee + perMeter×meters + perMinute×minutes + wait, minimum) × surge × vehicle)',
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
    // Ops override is authoritative when enabled — never from the client.
    const override = this.readOpsSurgeOverride(zoneId, maxMultiplier);
    if (override != null) {
      this.surgeByZone.set(zoneId, {
        multiplier: override,
        expiresAt: Date.now() + this.surgeCacheTtlMs,
      });
      return override;
    }

    const cached = this.surgeByZone.get(zoneId);
    if (cached && cached.expiresAt > Date.now()) {
      return Math.min(cached.multiplier, maxMultiplier);
    }

    if (!this.locationSvc.enabled || this.locationSvc.isOpen) return 1;
    try {
      const data = await this.locationSvc.get<{
        demandRatio?: number;
        riders?: number;
        drivers?: number;
        surgeMultiplier?: number;
      }>(`/zones/${zoneId}/demand`, undefined, 500);

      const riders = Number(data?.riders);
      const drivers = Number(data?.drivers);
      const hasCounts = Number.isFinite(riders) && Number.isFinite(drivers);

      // Hard rule first: no live riders ⇒ no surge (ignore stale smoothed values).
      if (hasCounts && riders <= 0) {
        this.surgeByZone.set(zoneId, {
          multiplier: 1,
          expiresAt: Date.now() + this.surgeCacheTtlMs,
        });
        return 1;
      }

      // Prefer location-svc's already-smoothed hex multiplier (neighbor blend +
      // step caps applied once). Re-applying Nest step caps would slow climb.
      const serverSurge = Number(data?.surgeMultiplier);
      if (Number.isFinite(serverSurge) && serverSurge >= 1) {
        const multiplier = Math.min(Math.max(1, serverSurge), maxMultiplier);
        this.surgeByZone.set(zoneId, {
          multiplier,
          expiresAt: Date.now() + this.surgeCacheTtlMs,
        });
        return multiplier;
      }

      const previous = cached?.multiplier ?? 1;
      const result = hasCounts
        ? computeLiveSurge({
            activeRiders: riders,
            availableDrivers: drivers,
            previousMultiplier: previous,
            config: {
              maxMultiplier,
              minActiveRiders: this.readNumber(
                'surge_min_active_riders',
                DEFAULT_SURGE_CONFIG.minActiveRiders,
              ),
              maxStepUp: this.readNumber(
                'surge_max_step_up',
                DEFAULT_SURGE_CONFIG.maxStepUp,
              ),
              maxStepDown: this.readNumber(
                'surge_max_step_down',
                DEFAULT_SURGE_CONFIG.maxStepDown,
              ),
              neighborBlend: this.readNumber(
                'surge_neighbor_blend',
                DEFAULT_SURGE_CONFIG.neighborBlend,
              ),
            },
          })
        : null;

      let multiplier = result?.multiplier ?? 1;
      if (!result) {
        const ratio = Number(data?.demandRatio);
        if (!Number.isFinite(ratio) || ratio <= 0) {
          this.logger.warn(
            `Surge lookup for zone ${zoneId} returned no counts; using 1.0`,
          );
          return 1;
        }
        multiplier = computeLiveSurge({
          activeRiders: Math.max(2, Math.ceil(ratio)),
          availableDrivers: 1,
          previousMultiplier: previous,
          config: { maxMultiplier },
        }).multiplier;
      }

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

  /** Drop in-process surge cache after ops changes overrides. */
  clearSurgeCache() {
    this.surgeByZone.clear();
  }

  /**
   * Backend-only surge override from Neon configuration.
   * Zone map wins over global. Returns null when demand surge should run.
   */
  private readOpsSurgeOverride(
    zoneId: string,
    maxMultiplier: number,
  ): number | null {
    try {
      const enabled = this.configuration.get<unknown>('surge_override_enabled');
      const on =
        enabled === true || enabled === 'true' || enabled === 1;
      if (!on) return null;
    } catch {
      return null;
    }

    const max = Math.max(1, maxMultiplier);
    try {
      const zones = this.configuration.get<unknown>('surge_zone_overrides');
      const zoneMap =
        zones && typeof zones === 'object' && !Array.isArray(zones)
          ? (zones as Record<string, unknown>)
          : {};
      const raw = zoneMap[zoneId];
      const z = Number(raw);
      if (Number.isFinite(z) && z >= 1) {
        return Math.min(Math.max(1, z), max);
      }

      // Named / hex map active → unlisted hexes follow live demand (not city-wide).
      const named = this.configuration.get<unknown>(
        'surge_named_zone_overrides',
      );
      const namedActive =
        named &&
        typeof named === 'object' &&
        !Array.isArray(named) &&
        Object.values(named as Record<string, unknown>).some(
          (v) => Number(v) > 1.001,
        );
      if (namedActive || Object.keys(zoneMap).length > 0) {
        return null;
      }
    } catch {
      // fall through to global
    }

    try {
      const g = this.readNumber('surge_override_multiplier', 1);
      if (!Number.isFinite(g) || g <= 1.001) return null;
      return Math.min(Math.max(1, g), max);
    } catch {
      return null;
    }
  }
}
