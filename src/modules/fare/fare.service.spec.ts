import { FareService } from './fare.service';
import { FARE_RATE_DEFAULTS, FareRateKeys } from './fare-rates';

describe('FareService', () => {
  const rates = { ...FARE_RATE_DEFAULTS };
  let service: FareService;

  beforeEach(() => {
    const configuration = {
      get: (key: string) => rates[key as keyof typeof rates],
    };
    service = new FareService(
      configuration as never,
      { get: () => undefined } as never,
      { enabled: false, isOpen: true } as never,
    );
  });

  it('prices a typical 5 km / 18 min Addis sedan trip in the Ride/Feres range', async () => {
    const fare = await service.calculate({
      distanceKm: 5,
      durationMinutes: 18,
    });
    // 50 + 16*5 + 2*18 = 50 + 80 + 36 = 166
    expect(fare.initialFee).toBe(50);
    expect(fare.distanceCharge).toBe(80);
    expect(fare.timeCharge).toBe(36);
    expect(fare.total).toBe(166);
    expect(fare.total).toBeGreaterThanOrEqual(150);
    expect(fare.total).toBeLessThan(250);
  });

  it('never drops below the 70 ETB minimum', async () => {
    const fare = await service.calculate({
      distanceKm: 0.4,
      durationMinutes: 2,
    });
    expect(fare.total).toBe(70);
  });

  it('applies moto and SUV multipliers to the whole fare', async () => {
    const sedan = await service.calculate({
      distanceKm: 5,
      durationMinutes: 18,
      vehicleType: 'sedan',
    });
    const moto = await service.calculate({
      distanceKm: 5,
      durationMinutes: 18,
      vehicleType: 'moto',
    });
    const suv = await service.calculate({
      distanceKm: 5,
      durationMinutes: 18,
      vehicleType: 'suv',
    });
    expect(moto.total).toBe(Math.round(sedan.total * 0.7));
    expect(suv.total).toBe(Math.round(sedan.total * 1.5));
  });

  it('uses urban circuity when the client omits road distance', () => {
    const bole = { lat: 8.9806, lng: 38.7578 };
    const kazanchis = { lat: 9.014, lng: 38.763 };
    const quoted = service.quotedTripMetrics(bole, kazanchis);
    const straight = service.quotedTripMetrics(bole, kazanchis, 1, 4);
    expect(quoted.distanceKm).toBeGreaterThan(straight.distanceKm);
    expect(quoted.durationMinutes).toBeGreaterThan(0);
  });

  it('settles duration from the trip clock within a 90–140% band', () => {
    const started = new Date('2026-08-16T10:00:00Z');
    const done = new Date('2026-08-16T10:25:00Z');
    expect(service.settledDurationMinutes(18, started, done)).toBe(25);
    expect(service.settledDurationMinutes(18, started, new Date('2026-08-16T10:05:00Z'))).toBe(
      18 * 0.9,
    );
  });

  it('exposes the new default rates', () => {
    expect(service.getRates().initialFeeEtb).toBe(
      FARE_RATE_DEFAULTS[FareRateKeys.initialFeeEtb],
    );
    expect(service.getRates().perMeterEtb).toBe(0.016);
  });
});
