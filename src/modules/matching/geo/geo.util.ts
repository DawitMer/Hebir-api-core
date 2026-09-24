/**
 * Pure geo helpers for matching / surge zoning.
 * Keep algorithm math here — services only orchestrate I/O.
 */
import { cellToBoundary, cellToLatLng, gridDisk, latLngToCell } from 'h3-js';

export type GeoPoint = { lat: number; lng: number };

export const EARTH_RADIUS_KM = 6371;

/**
 * Uber H3 resolution for marketplace surge hexes.
 * Res 8 ≈ 0.46 km edge (~0.74 km²) — hyperlocal, not city-wide.
 * Must match location-svc demand.H3Resolution.
 */
export const H3_SURGE_RESOLUTION = 8;

/** Approximate average edge length (km) at [H3_SURGE_RESOLUTION]. */
export const H3_RES8_EDGE_KM = 0.461;

/** @deprecated Square grid — kept for reading legacy Redis keys during cutover. */
export const ZONE_CELL_SIZE_DEGREES = 0.02;

/** H3 cell id used as the surge / demand zone key. */
export function zoneIdFor(
  point: GeoPoint,
  resolution: number = H3_SURGE_RESOLUTION,
): string {
  return latLngToCell(point.lat, point.lng, resolution);
}

/**
 * H3 k-ring (origin + neighbours) for geographic dispatch expansion.
 * ring=0 → pickup cell only; ring=1 → cell + 6 neighbours; etc.
 */
export function hexCellsAround(
  point: GeoPoint,
  ring: number,
  resolution: number = H3_SURGE_RESOLUTION,
): string[] {
  const origin = zoneIdFor(point, resolution);
  const k = Math.max(0, Math.floor(ring));
  try {
    return [...gridDisk(origin, k)];
  } catch {
    return [origin];
  }
}

/**
 * Approximate search radius covering an H3 k-ring at surge resolution.
 * Slightly oversized so Redis GEO fallback still includes hex-boundary drivers.
 */
export function radiusKmForHexRing(ring: number): number {
  const k = Math.max(0, Math.floor(ring));
  // Res-8 centre-to-centre ≈ 0.9 km; cover ring + half-cell margin.
  return Math.max(1.0, (k + 1) * H3_RES8_EDGE_KM * 2);
}

export function zoneCenter(zoneId: string): GeoPoint | null {
  if (zoneId.startsWith('z:')) {
    const parts = zoneId.split(':');
    if (parts.length !== 3) return null;
    const latCell = Number(parts[1]);
    const lngCell = Number(parts[2]);
    if (!Number.isFinite(latCell) || !Number.isFinite(lngCell)) return null;
    return {
      lat: (latCell + 0.5) * ZONE_CELL_SIZE_DEGREES,
      lng: (lngCell + 0.5) * ZONE_CELL_SIZE_DEGREES,
    };
  }
  try {
      const { lat, lng } = (() => {
        const pair = cellToLatLng(zoneId);
        return { lat: pair[0], lng: pair[1] };
      })();
      return { lat, lng };
    } catch {
      return null;
    }
}

/** Outer ring of the H3 hex as lat/lng vertices (for map polygons). */
export function zoneBoundary(zoneId: string): GeoPoint[] {
  if (zoneId.startsWith('z:')) {
    const c = zoneCenter(zoneId);
    if (!c) return [];
    const half = ZONE_CELL_SIZE_DEGREES / 2;
    return [
      { lat: c.lat - half, lng: c.lng - half },
      { lat: c.lat - half, lng: c.lng + half },
      { lat: c.lat + half, lng: c.lng + half },
      { lat: c.lat + half, lng: c.lng - half },
    ];
  }
  try {
    return cellToBoundary(zoneId).map(([lat, lng]) => ({ lat, lng }));
  } catch {
    return [];
  }
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
  const path = routePath?.length >= 2 ? routePath : [start, destination];
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
  averageSpeedKmh = 18,
): number {
  const directKm = haversineKm(tripStart, tripDest);
  const withDetourKm =
    haversineKm(tripStart, pickup) +
    haversineKm(pickup, dropoff) +
    haversineKm(dropoff, tripDest);
  const extraKm = Math.max(0, withDetourKm - directKm);
  return (extraKm / averageSpeedKmh) * 60;
}
