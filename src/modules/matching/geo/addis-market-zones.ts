/**
 * Named Addis Ababa marketplace zones for ops surge control.
 *
 * Live demand still resolves per H3 res-8 hex (~0.7 km²). Ops never sets
 * “one multiplier for the whole city” — they set multipliers on these
 * neighborhoods; we expand each to a disk of H3 cells.
 *
 * Centers are approximate demand hubs (not legal woreda boundaries).
 */
import { gridDisk, latLngToCell } from 'h3-js';
import { H3_SURGE_RESOLUTION } from './geo.util';

export type AddisMarketZone = {
  id: string;
  name: string;
  /** Short Amharic label for ops UI. */
  nameAm: string;
  lat: number;
  lng: number;
  /**
   * H3 gridDisk radius around the center.
   * Res 8 ≈ 0.46 km edge → k=2 ≈ 1 km, k=3 ≈ 1.5 km, k=4 ≈ 2 km.
   */
  ring: number;
};

/** Stable catalog — order is display order in ops. */
export const ADDIS_MARKET_ZONES: readonly AddisMarketZone[] = [
  {
    id: 'bole',
    name: 'Bole',
    nameAm: 'ቦሌ',
    lat: 8.994,
    lng: 38.789,
    ring: 4,
  },
  {
    id: 'airport',
    name: 'Bole Airport',
    nameAm: 'አውሮፕላን ማረፊያ',
    lat: 8.9779,
    lng: 38.7993,
    ring: 3,
  },
  {
    id: 'cmc',
    name: 'CMC / Summit',
    nameAm: 'ሲኤምሲ',
    lat: 9.012,
    lng: 38.827,
    ring: 3,
  },
  {
    id: 'megenagna',
    name: 'Megenagna',
    nameAm: 'መገናኛ',
    lat: 9.018,
    lng: 38.802,
    ring: 3,
  },
  {
    id: 'kazanchis',
    name: 'Kazanchis / UNECA',
    nameAm: 'ካዛንቺስ',
    lat: 9.013,
    lng: 38.763,
    ring: 3,
  },
  {
    id: 'piazza',
    name: 'Piazza / Arada',
    nameAm: 'ፒያሳ',
    lat: 9.033,
    lng: 38.75,
    ring: 3,
  },
  {
    id: 'merkato',
    name: 'Merkato',
    nameAm: 'መርካቶ',
    lat: 9.031,
    lng: 38.736,
    ring: 3,
  },
  {
    id: 'mexico',
    name: 'Mexico / Lideta',
    nameAm: 'ሜክሲኮ',
    lat: 9.01,
    lng: 38.745,
    ring: 3,
  },
  {
    id: '4kilo',
    name: '4 Kilo / Sidist Kilo',
    nameAm: 'አራት ኪሎ',
    lat: 9.04,
    lng: 38.761,
    ring: 3,
  },
  {
    id: 'gotera',
    name: 'Gotera / Kera',
    nameAm: 'ጎተራ',
    lat: 8.98,
    lng: 38.758,
    ring: 3,
  },
  {
    id: 'sarbet',
    name: 'Sarbet / Tor Hailoch',
    nameAm: 'ሳር ቤት',
    lat: 8.995,
    lng: 38.72,
    ring: 3,
  },
  {
    id: 'lebu',
    name: 'Lebu / Jemo',
    nameAm: 'ለቡ',
    lat: 8.955,
    lng: 38.72,
    ring: 3,
  },
  {
    id: 'ayat',
    name: 'Ayat',
    nameAm: 'አያት',
    lat: 9.035,
    lng: 38.87,
    ring: 3,
  },
  {
    id: 'akaki',
    name: 'Akaki / Kaliti',
    nameAm: 'አቃቂ',
    lat: 8.88,
    lng: 38.79,
    ring: 4,
  },
] as const;

export function marketZoneById(id: string): AddisMarketZone | undefined {
  return ADDIS_MARKET_ZONES.find((z) => z.id === id);
}

/** H3 cells that belong to one named market zone. */
export function h3CellsForMarketZone(zone: AddisMarketZone): string[] {
  const origin = latLngToCell(zone.lat, zone.lng, H3_SURGE_RESOLUTION);
  return gridDisk(origin, Math.max(0, Math.floor(zone.ring)));
}

/**
 * Expand named-zone multipliers → H3 cell map.
 * Overlapping cells take the higher multiplier (hotter wins).
 * Multipliers ≤ 1 are ignored (clear that zone’s force).
 */
export function expandNamedZoneOverrides(
  named: Record<string, number>,
): Record<string, number> {
  const cells: Record<string, number> = {};
  for (const zone of ADDIS_MARKET_ZONES) {
    const raw = Number(named[zone.id]);
    if (!Number.isFinite(raw) || raw <= 1.001) continue;
    const m = Math.round(raw * 100) / 100;
    for (const cell of h3CellsForMarketZone(zone)) {
      const prev = cells[cell];
      if (prev == null || m > prev) cells[cell] = m;
    }
  }
  return cells;
}
