import { FareService } from '../fare/fare.service';
import { FARE_RATE_DEFAULTS, FareRateKeys } from '../fare/fare-rates';

/**
 * Pricing version lock behaviour: completing a trip must use the rates
 * snapshotted at request time, not whatever Operations published later.
 */
describe('pricing version lock (fare snapshot)', () => {
  const live = { ...FARE_RATE_DEFAULTS };
  let service: FareService;

  beforeEach(() => {
    service = new FareService(
      { get: (key: string) => live[key as keyof typeof live] } as never,
      { get: () => undefined } as never,
      { enabled: false, isOpen: true } as never,
    );
  });

  it('estimate and final charge share locked rates after publish', async () => {
    const locked = service.getRates();
    const estimate = await service.calculate(
      { distanceKm: 8, durationMinutes: 22, surgeMultiplier: 1.2 },
      locked,
    );

    // Ops publishes higher per-meter rates
    live[FareRateKeys.perMeterEtb] = locked.perMeterEtb * 3;

    const final = await service.calculate(
      {
        distanceKm: 8.4,
        durationMinutes: 24,
        surgeMultiplier: 1.2,
      },
      locked,
    );

    const liveFinal = await service.calculate({
      distanceKm: 8.4,
      durationMinutes: 24,
      surgeMultiplier: 1.2,
    });

    expect(final.rates.perMeterEtb).toBe(locked.perMeterEtb);
    expect(final.total).toBeLessThan(liveFinal.total);
    expect(estimate.rates).toEqual(locked);
  });

  it('ignores client-supplied total — only server breakdown is authoritative', async () => {
    const fare = await service.calculate({
      distanceKm: 3,
      durationMinutes: 10,
      surgeMultiplier: 1,
    });
    const maliciousClientTotal = 1;
    expect(fare.total).not.toBe(maliciousClientTotal);
    expect(fare.total).toBeGreaterThan(maliciousClientTotal);
  });

  it('applies surge only when multiplier > 1', async () => {
    const base = await service.calculate({
      distanceKm: 5,
      durationMinutes: 15,
      surgeMultiplier: 1,
    });
    const surged = await service.calculate({
      distanceKm: 5,
      durationMinutes: 15,
      surgeMultiplier: 1.5,
    });
    expect(surged.total).toBe(Math.round(base.subtotal * 1.5));
  });

  it('applies wait charge from server wait minutes', async () => {
    const noWait = await service.calculate({
      distanceKm: 2,
      durationMinutes: 8,
      waitMinutes: 0,
      surgeMultiplier: 1,
    });
    const waited = await service.calculate({
      distanceKm: 2,
      durationMinutes: 8,
      waitMinutes: 5,
      surgeMultiplier: 1,
    });
    expect(waited.total).toBeGreaterThan(noWait.total);
    expect(waited.waitCharge).toBeGreaterThan(0);
  });

  it('settled wait minutes feed the fare wait charge', async () => {
    const arrived = new Date('2026-08-16T10:00:00Z');
    const started = new Date('2026-08-16T10:08:00Z');
    const waitMinutes = service.settledWaitMinutes(arrived, started);
    expect(waitMinutes).toBe(6);
    const fare = await service.calculate({
      distanceKm: 2,
      durationMinutes: 8,
      waitMinutes,
      surgeMultiplier: 1,
    });
    expect(fare.waitMinutes).toBe(6);
    expect(fare.waitCharge).toBeGreaterThan(0);
  });
});
