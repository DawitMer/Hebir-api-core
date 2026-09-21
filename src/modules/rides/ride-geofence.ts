import { GeoPoint, haversineKm } from '../matching/geo/geo.util';

/**
 * Landmark pickups + cheap GNSS in Addis are often 30–80 m off the pin.
 * These radii are "are you actually here", not lane-level.
 */
export const ARRIVE_RADIUS_M = 250;
export const START_RADIUS_M = 350;
/** Destination pins are often a neighbourhood, not a doorway. */
export const COMPLETE_RADIUS_M = 2000;
/**
 * Within this of the drop-off pin, completion may still fill GPS gaps toward
 * the destination. Farther away = early drop-off → bill actual meters/time only.
 * Keep this much tighter than COMPLETE_RADIUS_M so a rider who gets out early
 * is not charged the full quote.
 */
export const FARE_AT_DESTINATION_RADIUS_M = 400;

export function metresBetween(a: GeoPoint, b: GeoPoint): number {
  return haversineKm(a, b) * 1000;
}

export function isWithinRadius(
  from: GeoPoint,
  to: GeoPoint,
  radiusM: number,
): boolean {
  return metresBetween(from, to) <= radiusM;
}
