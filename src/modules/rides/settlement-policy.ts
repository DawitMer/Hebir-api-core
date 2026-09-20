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
 * Industry-standard upfront pricing when the trip meter is unreliable:
 * - Continuous meter → charge metered fare.
 * - Gap/stale estimate → charge min(estimate, quoted).
 * - Zero accepted GPS → charge the quoted fare (driver is never blocked).
 */
export function chooseChargedSettlement(args: {
  meter: TripMeterSettlement;
  meteredFare: FareBreakdown;
  quotedFare: FareBreakdown;
  quotedDistanceM: number | null | undefined;
}): ChargedSettlement {
  const quotedTotal = Math.max(0, Math.round(args.quotedFare.total));
  const zeroGps = args.meter.recordedDistanceM <= 0;

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
      uncappedFareTotal: Math.round(args.meteredFare.total),
    };
  }

  const uncapped = Math.max(0, Math.round(args.meteredFare.total));
  if (uncapped <= quotedTotal) {
    return {
      status: RideSettlementStatus.ESTIMATED,
      estimateReason: 'gps_gap',
      billedDistanceM: args.meter.distanceM,
      fare: args.meteredFare,
      quotedFareTotal: quotedTotal,
      uncappedFareTotal: uncapped,
    };
  }

  return {
    status: RideSettlementStatus.ESTIMATED,
    estimateReason: 'gps_gap',
    billedDistanceM: Math.max(0, Math.round(args.quotedDistanceM ?? args.meter.distanceM)),
    fare: args.quotedFare,
    quotedFareTotal: quotedTotal,
    uncappedFareTotal: uncapped,
  };
}
