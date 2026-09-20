import { settleTripMeterDistance } from './gps-gap-settlement';

const pickup = { lat: 8.9806, lng: 38.7578 };
const dropoff = { lat: 9.0122, lng: 38.7614 };

describe('settleTripMeterDistance', () => {
  it('uses recorded meters when the trace is continuous and fresh', () => {
    const result = settleTripMeterDistance({
      recordedDistanceM: 4200,
      lastFix: dropoff,
      dropoff,
      quotedDistanceM: 4500,
      hasGaps: false,
      lastFixAgeMs: 5_000,
    });
    expect(result).toEqual({
      distanceM: 4200,
      estimated: false,
      recordedDistanceM: 4200,
      estimatedAddedM: 0,
    });
  });

  it('fills a GPS gap with remaining last-fix to dropoff, capped by quote', () => {
    const result = settleTripMeterDistance({
      recordedDistanceM: 800,
      lastFix: pickup,
      dropoff,
      quotedDistanceM: 4000,
      hasGaps: true,
      lastFixAgeMs: 30_000,
    });
    expect(result.estimated).toBe(true);
    expect(result.recordedDistanceM).toBe(800);
    expect(result.distanceM).toBeGreaterThan(800);
    expect(result.distanceM).toBeLessThanOrEqual(Math.round(4000 * 1.35));
  });

  it('never bills less than recorded GPS meters even if the quote is smaller', () => {
    const result = settleTripMeterDistance({
      recordedDistanceM: 12_000,
      lastFix: dropoff,
      dropoff,
      quotedDistanceM: 4000,
      hasGaps: true,
      lastFixAgeMs: 1_000,
    });
    expect(result.distanceM).toBe(12_000);
  });

  it('estimates a stale meter the same way as a flagged gap', () => {
    const result = settleTripMeterDistance({
      recordedDistanceM: 1000,
      lastFix: pickup,
      dropoff,
      quotedDistanceM: 5000,
      hasGaps: false,
      lastFixAgeMs: 180_000,
    });
    expect(result.estimated).toBe(true);
    expect(result.distanceM).toBeGreaterThan(1000);
  });
});
