import {
  MAX_RADIUS_KM,
  shouldEndEmptySearch,
} from './dispatch.types';

describe('dispatch empty-search end condition', () => {
  it('keeps expanding below the max radius', () => {
    expect(shouldEndEmptySearch(1.5)).toBe(false);
    expect(shouldEndEmptySearch(6)).toBe(false);
    expect(shouldEndEmptySearch(MAX_RADIUS_KM - 0.1)).toBe(false);
  });

  it('ends the attempt at the max local radius', () => {
    expect(shouldEndEmptySearch(MAX_RADIUS_KM)).toBe(true);
    expect(shouldEndEmptySearch(MAX_RADIUS_KM + 1.5)).toBe(true);
  });
});
