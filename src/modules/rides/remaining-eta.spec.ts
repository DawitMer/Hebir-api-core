import { remainingEta } from './remaining-eta';

const pickup = { lat: 9.03, lng: 38.75 };
const dropoff = { lat: 9.05, lng: 38.78 };

describe('remainingEta', () => {
  it('targets pickup before the trip starts', () => {
    const eta = remainingEta({
      driver: { lat: 9.031, lng: 38.751 },
      pickup,
      dropoff,
      status: 'accepted',
    });
    expect(eta.target).toBe('pickup');
    expect(eta.remainingMetres).toBeGreaterThan(0);
    expect(eta.etaSeconds).toBeGreaterThan(0);
  });

  it('targets dropoff once in_progress', () => {
    const eta = remainingEta({
      driver: pickup,
      pickup,
      dropoff,
      status: 'in_progress',
      quotedDistanceM: 4000,
      quotedDurationS: 600,
    });
    expect(eta.target).toBe('dropoff');
    expect(eta.remainingMetres).toBeGreaterThan(1000);
  });

  it('returns zero ETA when the car is on the pin', () => {
    const eta = remainingEta({
      driver: pickup,
      pickup,
      dropoff,
      status: 'arriving',
    });
    expect(eta.remainingMetres).toBeLessThan(40);
    expect(eta.etaSeconds).toBe(0);
  });
});
