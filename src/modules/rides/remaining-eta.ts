import { GeoPoint, haversineKm } from '../matching/geo/geo.util';

/** Mixed Addis traffic when the ping has no usable speed. ~22 km/h. */
const ADDIS_URBAN_MPS = 6.1;
/** Below this, GPS speed is crawl/noise — use the urban default instead. */
const MIN_REPORTED_SPEED_MPS = 1.5;
/** Bird-flight to road factor when no quoted route length exists. */
const DEFAULT_ROAD_FACTOR = 1.25;
const ARRIVED_METRES = 40;

export type RemainingEta = {
  remainingMetres: number;
  etaSeconds: number;
  target: 'pickup' | 'dropoff';
};

/**
 * Remaining distance/ETA without calling OSRM on every GPS ping.
 *
 * Uses haversine as a cheap remaining-chord, scaled by the quoted road
 * distance when we have one, then / effective speed.
 * O(1) time / O(1) space per ping.
 */
export function remainingEta(args: {
  driver: GeoPoint;
  speedMps?: number | null;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  status: string;
  quotedDistanceM?: number | null;
  quotedDurationS?: number | null;
}): RemainingEta {
  const inTrip = args.status === 'in_progress';
  const targetPoint = inTrip ? args.dropoff : args.pickup;
  const target: RemainingEta['target'] = inTrip ? 'dropoff' : 'pickup';
  const chordM = haversineKm(args.driver, targetPoint) * 1000;

  let roadFactor = DEFAULT_ROAD_FACTOR;
  if (inTrip && args.quotedDistanceM && args.quotedDistanceM > 50) {
    const tripChordM = haversineKm(args.pickup, args.dropoff) * 1000;
    if (tripChordM > 50) {
      roadFactor = Math.min(
        1.6,
        Math.max(1, args.quotedDistanceM / tripChordM),
      );
    }
  }

  const remainingMetres = Math.max(0, Math.round(chordM * roadFactor));
  if (remainingMetres <= ARRIVED_METRES) {
    return { remainingMetres, etaSeconds: 0, target };
  }

  const quotedSpeed =
    args.quotedDistanceM && args.quotedDurationS && args.quotedDurationS > 0
      ? args.quotedDistanceM / args.quotedDurationS
      : null;
  const reported = args.speedMps ?? null;
  const speedMps =
    reported != null && reported >= MIN_REPORTED_SPEED_MPS
      ? reported
      : quotedSpeed != null && quotedSpeed >= MIN_REPORTED_SPEED_MPS
        ? quotedSpeed
        : ADDIS_URBAN_MPS;

  return {
    remainingMetres,
    etaSeconds: Math.max(1, Math.round(remainingMetres / speedMps)),
    target,
  };
}
