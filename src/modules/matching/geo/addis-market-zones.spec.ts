import {
  ADDIS_MARKET_ZONES,
  expandNamedZoneOverrides,
  h3CellsForMarketZone,
} from './addis-market-zones';

describe('Addis market surge zones', () => {
  it('catalog covers major demand hubs', () => {
    const ids = ADDIS_MARKET_ZONES.map((z) => z.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'bole',
        'airport',
        'merkato',
        'piazza',
        'kazanchis',
        'megenagna',
      ]),
    );
  });

  it('expands a named zone into multiple H3 cells', () => {
    const bole = ADDIS_MARKET_ZONES.find((z) => z.id === 'bole')!;
    const cells = h3CellsForMarketZone(bole);
    expect(cells.length).toBeGreaterThan(10);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('overlapping zones keep the hotter multiplier', () => {
    const map = expandNamedZoneOverrides({
      bole: 1.5,
      airport: 2.0,
    });
    expect(Object.keys(map).length).toBeGreaterThan(20);
    expect(Object.values(map).every((m) => m === 1.5 || m === 2)).toBe(true);
    expect(Object.values(map).some((m) => m === 2)).toBe(true);
  });

  it('ignores 1.0 (live demand) zones', () => {
    expect(expandNamedZoneOverrides({ bole: 1, merkato: 1 })).toEqual({});
  });
});
