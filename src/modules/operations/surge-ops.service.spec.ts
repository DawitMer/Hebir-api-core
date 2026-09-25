import {
  ADDIS_MARKET_ZONES,
  expandNamedZoneOverrides,
  h3CellsForMarketZone,
} from '../matching/geo/addis-market-zones';
import { zoneCenter } from '../matching/geo/geo.util';
import { SurgeConfigKeys, SurgeOpsService } from './surge-ops.service';

/** Prefer h3-js isValidCell when present; fall back to zoneCenter. */
function cellLooksValid(zoneId: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isValidCell } = require('h3-js') as {
      isValidCell?: (id: string) => boolean;
    };
    if (typeof isValidCell === 'function') return isValidCell(zoneId);
  } catch {
    // h3-js version without isValidCell
  }
  return zoneCenter(zoneId) != null;
}

describe('SurgeOpsService hex overrides', () => {
  let store: Record<string, unknown>;
  let configuration: {
    get: (key: string) => unknown;
    setMany: jest.Mock;
  };
  let fareService: { clearSurgeCache: jest.Mock };
  let audit: {
    create: jest.Mock;
    save: jest.Mock;
  };
  let service: SurgeOpsService;

  beforeEach(() => {
    store = {
      [SurgeConfigKeys.overrideEnabled]: false,
      [SurgeConfigKeys.overrideMultiplier]: 1,
      [SurgeConfigKeys.zoneOverrides]: {},
      [SurgeConfigKeys.hexOverrides]: {},
      [SurgeConfigKeys.namedZoneOverrides]: {},
      [SurgeConfigKeys.maxMultiplier]: 2.5,
      [SurgeConfigKeys.minActiveRiders]: 2,
      [SurgeConfigKeys.maxStepUp]: 0.2,
      [SurgeConfigKeys.maxStepDown]: 0.3,
      [SurgeConfigKeys.neighborBlend]: 0.35,
    };
    configuration = {
      get: (key: string) => {
        if (!(key in store)) throw new Error(`missing ${key}`);
        return store[key];
      },
      setMany: jest.fn(async (updates: Array<{ key: string; value: unknown }>) => {
        for (const u of updates) store[u.key] = u.value;
      }),
    };
    fareService = { clearSurgeCache: jest.fn() };
    audit = {
      create: jest.fn((row) => row),
      save: jest.fn(async (row) => row),
    };
    service = new SurgeOpsService(
      configuration as never,
      fareService as never,
      audit as never,
    );
  });

  it('getState merges named expand + hexOverrides (hex wins on same cell)', () => {
    const bole = ADDIS_MARKET_ZONES.find((z) => z.id === 'bole')!;
    const boleCells = h3CellsForMarketZone(bole);
    expect(boleCells.length).toBeGreaterThan(0);
    const contested = boleCells[0]!;

    store[SurgeConfigKeys.namedZoneOverrides] = { bole: 1.5 };
    store[SurgeConfigKeys.hexOverrides] = { [contested]: 2.2 };

    const fromNamed = expandNamedZoneOverrides({ bole: 1.5 });
    expect(fromNamed[contested]).toBe(1.5);

    const state = service.getState();
    expect(state.hexOverrides[contested]).toBe(2.2);
    expect(state.zoneOverrides[contested]).toBe(2.2);
    expect(state.namedZoneOverrides.bole).toBe(1.5);

    // Other named-only cells keep the named multiplier.
    const namedOnly = boleCells.find((c) => c !== contested)!;
    expect(state.zoneOverrides[namedOnly]).toBe(1.5);
  });

  it('update with hexOverrides replaces the hex map and enables override', async () => {
    const bole = ADDIS_MARKET_ZONES.find((z) => z.id === 'bole')!;
    const cells = h3CellsForMarketZone(bole);
    const keep = cells[0]!;
    const drop = cells[1]!;

    store[SurgeConfigKeys.hexOverrides] = { [drop]: 1.8 };
    store[SurgeConfigKeys.overrideEnabled] = false;

    const next = await service.update('admin-1', {
      hexOverrides: { [keep]: 1.9 },
    });

    expect(configuration.setMany).toHaveBeenCalled();
    expect(fareService.clearSurgeCache).toHaveBeenCalled();
    expect(next.hexOverrides).toEqual({ [keep]: 1.9 });
    expect(next.hexOverrides[drop]).toBeUndefined();
    expect(next.overrideEnabled).toBe(true);
    expect(store[SurgeConfigKeys.overrideEnabled]).toBe(true);
    expect(store[SurgeConfigKeys.hexOverrides]).toEqual({ [keep]: 1.9 });
  });

  it('resolveCell from lat/lng returns a valid zoneId', () => {
    // Bole / central Addis pin
    const cell = service.resolveCell({ lat: 8.9806, lng: 38.7578 });
    expect(typeof cell.zoneId).toBe('string');
    expect(cell.zoneId.length).toBeGreaterThan(0);
    expect(cellLooksValid(cell.zoneId)).toBe(true);
    expect(Number.isFinite(cell.lat)).toBe(true);
    expect(Number.isFinite(cell.lng)).toBe(true);
    expect(Array.isArray(cell.boundary)).toBe(true);
  });
});
