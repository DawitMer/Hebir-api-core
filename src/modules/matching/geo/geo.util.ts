/**
 * Pure geo helpers for matching / surge zoning.
 * Keep algorithm math here — services only orchestrate I/O.
 */
export type GeoPoint = { lat: number; lng: number };

export const EARTH_RADIUS_KM = 6371;

/** ~2 km cells — must match location-svc handlers.zoneIDFor */
export const ZONE_CELL_SIZE_DEGREES = 0.02;

export function zoneIdFor(point: GeoPoint): string {
  const latCell = Math.floor(point.lat / ZONE_CELL_SIZE_DEGREES);
  const lngCell = Math.floor(point.lng / ZONE_CELL_SIZE_DEGREES);
  return `z:${latCell}:${lngCell}`;
}

export function zoneCenter(zoneId: string): GeoPoint | null {
  const parts = zoneId.split(':');
  if (parts.length !== 3 || parts[0] !== 'z') return null;
  const latCell = Number(parts[1]);
  const lngCell = Number(parts[2]);
  if (!Number.isFinite(latCell) || !Number.isFinite(lngCell)) return null;
  return {
    lat: (latCell + 0.5) * ZONE_CELL_SIZE_DEGREES,
    lng: (lngCell + 0.5) * ZONE_CELL_SIZE_DEGREES,
  };
}

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  // Clamped: floating point can push h slightly above 1 for antipodal points,
  // and asin(>1) is NaN, which would poison every downstream distance filter.
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing degrees [0, 360). */
export function bearing(from: GeoPoint, to: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const deltaLng = toRad(to.lng - from.lng);
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Shortest angular distance on the compass. */
export function angularDifference(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Bearing of the route segment nearest the rider pickup (advanced filter).
 * Falls back to trip chord if path is missing.
 */
export function localBearingAtPickup(
  routePath: GeoPoint[],
  start: GeoPoint,
  destination: GeoPoint,
  pickup: GeoPoint,
): number {
  const path =
    routePath?.length >= 2 ? routePath : [start, destination];
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < path.length - 1; i++) {
    const mid = {
      lat: (path[i].lat + path[i + 1].lat) / 2,
      lng: (path[i].lng + path[i + 1].lng) / 2,
    };
    const d = haversineKm(mid, pickup);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bearing(path[bestIdx], path[bestIdx + 1]);
}

export function estimateDetourMinutes(
  tripStart: GeoPoint,
  tripDest: GeoPoint,
  pickup: GeoPoint,
  dropoff: GeoPoint,
  averageSpeedKmh = 30,
): number {
  const directKm = haversineKm(tripStart, tripDest);
  const withDetourKm =
    haversineKm(tripStart, pickup) +
    haversineKm(pickup, dropoff) +
    haversineKm(dropoff, tripDest);
  const extraKm = Math.max(0, withDetourKm - directKm);
  return (extraKm / averageSpeedKmh) * 60;
}
