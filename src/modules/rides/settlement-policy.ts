import type { FareBreakdown } from '../fare/fare.service';
import type { TripMeterSettlement } from './gps-gap-settlement';
import { RideSettlementStatus } from './entities/ride.entity';

export { RideSettlementStatus };

export type SettlementEstimateReason = 'gps_gap' | 'zero_gps' | null;

export interface ChargedSettlement {
  status: RideSettlementStatus;
  estimateReason: SettlementEstimateReason;
  /** Distance used for receipts / actualDistanceM. */
  billedDistanceM: number;
  /** Fare the rider is charged (already quote-capped when estimated). */
  fare: FareBreakdown;
  /** Quoted fare recomputed from the ride snapshot (for ops review). */
  quotedFareTotal: number;
  /** Pre-cap estimated fare when status is estimated; else equals fare.total. */
  uncappedFareTotal: number;
}

/**
 * Final fare from the universal FareService formula (locked rates × actual
 * distance/time). Destination completions keep an upfront-price safety net:
 * - Continuous meter → charge metered fare.
 * - Gap/stale estimate → charge min(estimate, quoted).
 * - Zero accepted GPS at destination → charge the quoted fare.
 *
 * Early drop-off always charges the metered (actual) fare — never invents the
 * remaining trip or forces the original quote.
 *
 * Also: whenever the universal metered total is below the quote and we have
 * any recorded meters, prefer that metered total (short / early trips).
 */
export function chooseChargedSettlement(args: {
  meter: TripMeterSettlement;
  meteredFare: FareBreakdown;
  quotedFare: FareBreakdown;
  quotedDistanceM: number | null | undefined;
  /** Completed away from the destination pin. */
  earlyDropoff?: boolean;
}): ChargedSettlement {
  const quotedTotal = Math.max(0, Math.round(args.quotedFare.total));
  const zeroGps = args.meter.recordedDistanceM <= 0;
  const meteredTotal = Math.max(0, Math.round(args.meteredFare.total));

  if (args.earlyDropoff) {
    return {
      status:
        zeroGps || args.meter.estimated
          ? RideSettlementStatus.ESTIMATED
          : RideSettlementStatus.METERED,
      estimateReason: zeroGps
        ? 'zero_gps'
        : args.meter.estimated
          ? 'gps_gap'
          : null,
      billedDistanceM: args.meter.distanceM,
      fare: args.meteredFare,
      quotedFareTotal: quotedTotal,
      uncappedFareTotal: meteredTotal,
    };
  }

  // Shorter than quote with real GPS → charge actual, even at the pin
  // (e.g. rider exited early but last fix drifted near drop-off).
  if (!zeroGps && meteredTotal < quotedTotal) {
    return {
      status: args.meter.estimated
        ? RideSettlementStatus.ESTIMATED
        : RideSettlementStatus.METERED,
      estimateReason: args.meter.estimated ? 'gps_gap' : null,
      billedDistanceM: args.meter.distanceM,
      fare: args.meteredFare,
      quotedFareTotal: quotedTotal,
      uncappedFareTotal: meteredTotal,
    };
  }

  if (zeroGps) {
    return {
      status: RideSettlementStatus.ESTIMATED,
      estimateReason: 'zero_gps',
      billedDistanceM: Math.max(0, Math.round(args.quotedDistanceM ?? 0)),
      fare: args.quotedFare,
      quotedFareTotal: quotedTotal,
      uncappedFareTotal: quotedTotal,
    };
  }

  if (!args.meter.estimated) {
    return {
      status: RideSettlementStatus.METERED,
      estimateReason: null,
      billedDistanceM: args.meter.distanceM,
      fare: args.meteredFare,
      quotedFareTotal: quotedTotal,
      uncappedFareTotal: meteredTotal,
    };
  }

  if (meteredTotal <= quotedTotal) {
    return {
      status: RideSettlementStatus.ESTIMATED,
      estimateReason: 'gps_gap',
      billedDistanceM: args.meter.distanceM,
      fare: args.meteredFare,
      quotedFareTotal: quotedTotal,
      uncappedFareTotal: meteredTotal,
    };
  }

  return {
    status: RideSettlementStatus.ESTIMATED,
    estimateReason: 'gps_gap',
    billedDistanceM: Math.max(
      0,
      Math.round(args.quotedDistanceM ?? args.meter.distanceM),
    ),
    fare: args.quotedFare,
    quotedFareTotal: quotedTotal,
    uncappedFareTotal: meteredTotal,
  };
}
