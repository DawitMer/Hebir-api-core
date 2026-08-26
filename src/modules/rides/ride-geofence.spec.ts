import { isWithinRadius, ARRIVE_RADIUS_M } from './ride-geofence';

const bole = { lat: 8.9806, lng: 38.7999 };

describe('ride geofence', () => {
  it('accepts a car next to the pickup pin', () => {
    expect(
      isWithinRadius(bole, { lat: 8.981, lng: 38.8 }, ARRIVE_RADIUS_M),
    ).toBe(true);
  });

  it('rejects a car several kilometres away', () => {
    expect(
      isWithinRadius(bole, { lat: 9.03, lng: 38.75 }, ARRIVE_RADIUS_M),
    ).toBe(false);
  });
});
