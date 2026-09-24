import {
  MAX_HEX_RING,
  MAX_RADIUS_KM,
  expandDispatchSearch,
  initialDispatchState,
  normalizeDispatchState,
  shouldEndEmptySearch,
} from './dispatch.types';

describe('dispatch empty-search end condition', () => {
  it('keeps expanding below the max hex ring', () => {
    expect(shouldEndEmptySearch(1.5, 0)).toBe(false);
    expect(shouldEndEmptySearch(6, MAX_HEX_RING - 1)).toBe(false);
  });

  it('ends the attempt at the max hex ring', () => {
    expect(shouldEndEmptySearch(MAX_RADIUS_KM, MAX_HEX_RING)).toBe(true);
    expect(shouldEndEmptySearch(1, MAX_HEX_RING + 1)).toBe(true);
  });

  it('falls back to radius cap when hexRing is omitted (legacy jobs)', () => {
    expect(shouldEndEmptySearch(MAX_RADIUS_KM - 0.1)).toBe(false);
    expect(shouldEndEmptySearch(MAX_RADIUS_KM)).toBe(true);
  });
});

describe('hexagonal dispatch state', () => {
  it('starts at ring 0 with a covering GEO radius', () => {
    const state = initialDispatchState(['driver-a']);
    expect(state.hexRing).toBe(0);
    expect(state.radiusKm).toBeGreaterThan(0);
    expect(state.triedDriverIds).toEqual(['driver-a']);
  });

  it('expands one ring per empty tick', () => {
    const next = expandDispatchSearch(initialDispatchState());
    expect(next.hexRing).toBe(1);
    expect(next.radiusKm).toBeGreaterThan(initialDispatchState().radiusKm);
  });

  it('normalizes legacy Redis state that only stored radiusKm', () => {
    const legacy = normalizeDispatchState({
      startedAt: 1,
      radiusKm: 3,
      triedDriverIds: ['d1'],
    });
    expect(legacy.hexRing).toBe(0);
    expect(legacy.radiusKm).toBe(3);
    expect(legacy.triedDriverIds).toEqual(['d1']);
  });
});
