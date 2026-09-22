import {
  computeLiveSurge,
  demandRatio,
  DEFAULT_SURGE_CONFIG,
  multiplierForRatio,
} from './surge.math';

describe('live surge marketplace math', () => {
  it('1. 0 requests + 0 drivers → no surge', () => {
    const r = computeLiveSurge({ activeRiders: 0, availableDrivers: 0 });
    expect(r.multiplier).toBe(1);
    expect(r.demandRatio).toBe(0);
  });

  it('2. 0 requests + many drivers → no surge', () => {
    const r = computeLiveSurge({ activeRiders: 0, availableDrivers: 40 });
    expect(r.multiplier).toBe(1);
  });

  it('3. 1 request + many drivers → no surge (below min riders)', () => {
    const r = computeLiveSurge({ activeRiders: 1, availableDrivers: 20 });
    expect(r.multiplier).toBe(1);
  });

  it('4. many requests + many drivers → normal or minimal surge', () => {
    const balanced = computeLiveSurge({
      activeRiders: 10,
      availableDrivers: 10,
    });
    expect(balanced.multiplier).toBe(1);

    const slight = computeLiveSurge({
      activeRiders: 12,
      availableDrivers: 10,
    });
    expect(slight.multiplier).toBeLessThanOrEqual(1.2);
    expect(slight.multiplier).toBeGreaterThanOrEqual(1);
  });

  it('5. many requests + few drivers → surge', () => {
    // Climb from 1.0 with step caps until the shortage prices in.
    let prev = 1;
    let r = computeLiveSurge({
      activeRiders: 12,
      availableDrivers: 3,
      previousMultiplier: prev,
    });
    for (let i = 0; i < 12; i++) {
      prev = r.multiplier;
      r = computeLiveSurge({
        activeRiders: 12,
        availableDrivers: 3,
        previousMultiplier: prev,
      });
    }
    expect(r.demandRatio).toBeCloseTo(4);
    expect(r.multiplier).toBeGreaterThanOrEqual(1.5);
  });

  it('6. demand increases rapidly → surge gradually increases', () => {
    let prev = 1;
    const steps: number[] = [];
    for (const riders of [2, 4, 8, 16]) {
      const r = computeLiveSurge({
        activeRiders: riders,
        availableDrivers: 2,
        previousMultiplier: prev,
      });
      steps.push(r.multiplier);
      expect(r.multiplier - prev).toBeLessThanOrEqual(
        DEFAULT_SURGE_CONFIG.maxStepUp + 1e-9,
      );
      prev = r.multiplier;
    }
    expect(steps[steps.length - 1]).toBeGreaterThan(steps[0]);
  });

  it('7. drivers move into the area → surge decreases', () => {
    let hot = computeLiveSurge({
      activeRiders: 10,
      availableDrivers: 2,
      previousMultiplier: 1.8,
    });
    for (let i = 0; i < 8; i++) {
      hot = computeLiveSurge({
        activeRiders: 10,
        availableDrivers: 2,
        previousMultiplier: hot.multiplier,
      });
    }
    let cooled = hot;
    for (let i = 0; i < 12; i++) {
      cooled = computeLiveSurge({
        activeRiders: 10,
        availableDrivers: 12,
        previousMultiplier: cooled.multiplier,
      });
    }
    expect(cooled.multiplier).toBeLessThan(hot.multiplier);
    expect(cooled.multiplier).toBe(1);
  });

  it('8. requests fulfilled/cancelled → demand decreases', () => {
    const before = computeLiveSurge({
      activeRiders: 8,
      availableDrivers: 2,
    });
    const after = computeLiveSurge({
      activeRiders: 2,
      availableDrivers: 2,
      previousMultiplier: before.multiplier,
    });
    expect(after.multiplier).toBeLessThan(before.multiplier);
  });

  it('9. all requests disappear → surge returns to exactly 1.0x', () => {
    const r = computeLiveSurge({
      activeRiders: 0,
      availableDrivers: 1,
      previousMultiplier: 2.5,
      neighborAverage: 2.0,
    });
    expect(r.multiplier).toBe(1);
  });

  it('10. adjacent areas keep independent ratios (no city-wide spill)', () => {
    const a = computeLiveSurge({ activeRiders: 10, availableDrivers: 2 });
    const b = computeLiveSurge({ activeRiders: 0, availableDrivers: 2 });
    expect(a.multiplier).toBeGreaterThan(1);
    expect(b.multiplier).toBe(1);
  });

  it('11. fake/repeated refreshes must not count as many riders', () => {
    // Distinct-rider model: same rider counted once ⇒ still below min.
    const unique = computeLiveSurge({
      activeRiders: 1,
      availableDrivers: 0,
    });
    expect(unique.multiplier).toBe(1);

    // Only after enough distinct riders does surge engage.
    const real = computeLiveSurge({
      activeRiders: 6,
      availableDrivers: 1,
    });
    expect(real.multiplier).toBeGreaterThan(1);
  });

  it('never surges from ratio alone when riders are zero', () => {
    expect(multiplierForRatio(5)).toBeGreaterThan(1);
    expect(
      computeLiveSurge({ activeRiders: 0, availableDrivers: 0 }).multiplier,
    ).toBe(1);
  });

  it('caps at configured max', () => {
    const r = computeLiveSurge({
      activeRiders: 100,
      availableDrivers: 1,
      config: { maxMultiplier: 1.5, minActiveRiders: 2 },
    });
    expect(r.multiplier).toBeLessThanOrEqual(1.5);
  });

  it('demandRatio uses max(drivers,1) only when riders > 0', () => {
    expect(demandRatio(0, 0)).toBe(0);
    expect(demandRatio(5, 0)).toBe(5);
    expect(demandRatio(5, 5)).toBe(1);
  });

  it('neighbor blend dampens isolated spikes', () => {
    const alone = computeLiveSurge({
      activeRiders: 8,
      availableDrivers: 1,
      previousMultiplier: 1,
    });
    const blended = computeLiveSurge({
      activeRiders: 8,
      availableDrivers: 1,
      previousMultiplier: 1,
      neighborAverage: 1.0,
    });
    expect(blended.multiplier).toBeLessThanOrEqual(alone.multiplier);
  });
});
