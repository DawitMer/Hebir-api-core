/**
 * Curated Addis Ababa landmarks used to describe a coordinate when the
 * online geocoder is unreachable. Coordinates are approximate centroids —
 * they only need to be good enough to name the nearest recognizable place.
 */
export interface AddisPlace {
  name: string;
  subCity: string;
  lat: number;
  lng: number;
}

export const ADDIS_PLACES: readonly AddisPlace[] = [
  // Bole
  {
    name: 'Bole International Airport',
    subCity: 'Bole',
    lat: 8.9779,
    lng: 38.7993,
  },
  { name: 'Edna Mall', subCity: 'Bole', lat: 8.9975, lng: 38.789 },
  {
    name: 'Bole Medhanialem Church',
    subCity: 'Bole',
    lat: 8.996,
    lng: 38.7865,
  },
  {
    name: 'Bole Road (Africa Avenue)',
    subCity: 'Bole',
    lat: 8.9903,
    lng: 38.7876,
  },
  {
    name: 'Friendship Business Center',
    subCity: 'Bole',
    lat: 8.9938,
    lng: 38.7842,
  },
  { name: 'Atlas Roundabout', subCity: 'Bole', lat: 9.0015, lng: 38.7847 },
  { name: 'Wollo Sefer', subCity: 'Bole', lat: 9.0009, lng: 38.7683 },
  { name: 'Gerji', subCity: 'Bole', lat: 9.0072, lng: 38.8121 },
  { name: 'Megenagna', subCity: 'Bole', lat: 9.0206, lng: 38.8003 },
  { name: 'CMC', subCity: 'Bole', lat: 9.0295, lng: 38.8248 },
  { name: 'Summit', subCity: 'Bole', lat: 8.9997, lng: 38.8425 },
  { name: 'Bole Bulbula', subCity: 'Bole', lat: 8.9445, lng: 38.7799 },

  // Kirkos
  { name: 'Meskel Square', subCity: 'Kirkos', lat: 9.0105, lng: 38.7612 },
  { name: 'Kazanchis', subCity: 'Kirkos', lat: 9.0146, lng: 38.7712 },
  { name: 'Stadium', subCity: 'Kirkos', lat: 9.0119, lng: 38.7553 },
  { name: 'Gotera Interchange', subCity: 'Kirkos', lat: 8.9977, lng: 38.7562 },
  { name: 'Urael Church', subCity: 'Kirkos', lat: 9.0083, lng: 38.7756 },
  { name: 'Hayahulet Mazoria', subCity: 'Kirkos', lat: 9.0179, lng: 38.7862 },

  // Arada
  { name: 'Piassa', subCity: 'Arada', lat: 9.033, lng: 38.75 },
  { name: 'Arada Giorgis', subCity: 'Arada', lat: 9.0345, lng: 38.7515 },
  { name: 'Sidist Kilo', subCity: 'Arada', lat: 9.0402, lng: 38.7625 },
  { name: 'Arat Kilo', subCity: 'Arada', lat: 9.0341, lng: 38.7626 },
  { name: 'Merkato', subCity: 'Addis Ketema', lat: 9.0344, lng: 38.7397 },
  { name: 'Autobus Tera', subCity: 'Addis Ketema', lat: 9.0323, lng: 38.7331 },

  // Lideta / Kolfe
  { name: 'Mexico Square', subCity: 'Lideta', lat: 9.005, lng: 38.744 },
  { name: 'Lideta', subCity: 'Lideta', lat: 9.0135, lng: 38.7359 },
  { name: 'Torhailoch', subCity: 'Kolfe Keranio', lat: 9.0006, lng: 38.7237 },
  { name: 'Ayer Tena', subCity: 'Kolfe Keranio', lat: 8.9793, lng: 38.6976 },

  // Yeka
  { name: 'Kotebe', subCity: 'Yeka', lat: 9.0345, lng: 38.8395 },
  { name: 'Shola Market', subCity: 'Yeka', lat: 9.0248, lng: 38.7929 },
  { name: 'Meganagna Yeka', subCity: 'Yeka', lat: 9.0264, lng: 38.8091 },

  // Nifas Silk-Lafto / Akaki
  { name: 'Sarbet', subCity: 'Nifas Silk-Lafto', lat: 8.9932, lng: 38.7501 },
  {
    name: 'Old Airport',
    subCity: 'Nifas Silk-Lafto',
    lat: 8.9862,
    lng: 38.7414,
  },
  { name: 'Jemo', subCity: 'Nifas Silk-Lafto', lat: 8.9509, lng: 38.7095 },
  { name: 'Lebu', subCity: 'Nifas Silk-Lafto', lat: 8.9455, lng: 38.7247 },
  { name: 'Kality', subCity: 'Akaki Kality', lat: 8.9152, lng: 38.7688 },

  // Gulele
  { name: 'Shiro Meda', subCity: 'Gulele', lat: 9.0546, lng: 38.7573 },
  { name: 'Entoto Park', subCity: 'Gulele', lat: 9.0776, lng: 38.7638 },
];

const EARTH_RADIUS_M = 6371000;

const toRad = (deg: number) => (deg * Math.PI) / 180;

export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export function compassBearing(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): string {
  const dLng = toRad(to.lng - from.lng);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  const index = Math.round(((deg + 360) % 360) / 45) % 8;
  return COMPASS[index];
}

export function nearestAddisPlace(point: { lat: number; lng: number }): {
  place: AddisPlace;
  distanceM: number;
} | null {
  let best: AddisPlace | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const place of ADDIS_PLACES) {
    const d = distanceMeters(point, place);
    if (d < bestDistance) {
      bestDistance = d;
      best = place;
    }
  }

  return best ? { place: best, distanceM: bestDistance } : null;
}
