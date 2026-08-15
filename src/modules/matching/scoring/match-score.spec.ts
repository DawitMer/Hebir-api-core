import { computeMatchScore } from './match-score';

describe('computeMatchScore', () => {
  const base = {
    waitingMinutes: 10,
    detourMinutes: 5,
    priceDifference: 20,
    surgeMultiplier: 1,
    waitWeight: 1,
    detourWeight: 2,
    priceWeight: 0.5,
    surgeRankWeight: 3,
  };

  it('rewards waiting time and penalizes detour', () => {
    // 1*10 - 2*5 - 0 - 0 = 0
    expect(computeMatchScore(base)).toBe(0);
  });

  it('penalizes price above ceiling (negative priceDifference)', () => {
    const overCeiling = computeMatchScore({
      ...base,
      priceDifference: -40,
    });
    // 10 - 10 - 0.5*40 - 0 = -20
    expect(overCeiling).toBe(-20);
  });

  it('does not reward surplus under ceiling beyond zero price penalty', () => {
    const cheap = computeMatchScore({ ...base, priceDifference: 100 });
    const baseline = computeMatchScore({ ...base, priceDifference: 0 });
    expect(cheap).toBe(baseline);
  });

  it('penalizes surge above 1.0', () => {
    const surged = computeMatchScore({
      ...base,
      surgeMultiplier: 1.5,
    });
    // 10 - 10 - 0 - 3*0.5 = -1.5
    expect(surged).toBe(-1.5);
  });

  it('ranks longer wait higher when other factors equal', () => {
    const shortWait = computeMatchScore({ ...base, waitingMinutes: 2 });
    const longWait = computeMatchScore({ ...base, waitingMinutes: 20 });
    expect(longWait).toBeGreaterThan(shortWait);
  });
});
