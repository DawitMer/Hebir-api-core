import { GeoPoint, haversineKm } from '../matching/geo/geo.util';

/** Do not invent more than 15 km of undriven gap. */
export const GPS_GAP_MAX_ADDED_M = 15_000;
/** Quoted-distance ceiling for the estimated fill (never below recorded GPS). */
export const GPS_GAP_QUOTE_CAP_MULT = 1.35;
export const STALE_FIX_MS = 120_000;

export interface TripMeterSettlement {
  distanceM: number;
  estimated: boolean;
  recordedDistanceM: number;
  estimatedAddedM: number;
}

/**
 * GPS-gap fare policy: bill recorded GNSS distance plus a capped estimate of
 * the remaining last-fix → dropoff chord. Never substitute a pure straight-line
 * quote for a metered trip, and never discard recorded meters.
 */
export function settleTripMeterDistance(args: {
  recordedDistanceM: number;
  lastFix: GeoPoint | null | undefined;
  dropoff: GeoPoint;
  quotedDistanceM?: number | null;
  hasGaps: boolean;
  lastFixAgeMs: number;
}): TripMeterSettlement {
  const recorded = Math.max(0, Math.round(args.recordedDistanceM));
  const needsEstimate = args.hasGaps || args.lastFixAgeMs > STALE_FIX_MS;
  if (!needsEstimate) {
    return {
      distanceM: recorded,
      estimated: false,
      recordedDistanceM: recorded,
      estimatedAddedM: 0,
    };
  }

  const remainingM =
    args.lastFix &&
    Number.isFinite(args.lastFix.lat) &&
    Number.isFinite(args.lastFix.lng)
      ? Math.round(haversineKm(args.lastFix, args.dropoff) * 1000)
      : 0;
  const estimatedAddedM = Math.min(
    Math.max(0, remainingM),
    GPS_GAP_MAX_ADDED_M,
  );
  const uncapped = recorded + estimatedAddedM;
  const quoted =
    args.quotedDistanceM != null && args.quotedDistanceM > 0
      ? args.quotedDistanceM
      : null;
  const cap =
    quoted != null
      ? Math.max(Math.round(quoted * GPS_GAP_QUOTE_CAP_MULT), recorded)
      : uncapped;

  return {
    distanceM: Math.min(uncapped, cap),
    estimated: true,
    recordedDistanceM: recorded,
    estimatedAddedM,
  };
}
