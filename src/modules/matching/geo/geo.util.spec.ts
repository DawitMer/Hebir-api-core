import {
  angularDifference,
  bearing,
  haversineKm,
  zoneBoundary,
  zoneCenter,
  zoneIdFor,
} from './geo.util';

describe('geo.util', () => {
  it('haversineKm is ~0 for identical points', () => {
    const p = { lat: 9.03, lng: 38.74 };
    expect(haversineKm(p, p)).toBeCloseTo(0, 6);
  });

  it('haversineKm is positive for distant points', () => {
    const a = { lat: 8.987, lng: 38.79 };
    const b = { lat: 9.012, lng: 38.76 };
    expect(haversineKm(a, b)).toBeGreaterThan(1);
    expect(haversineKm(a, b)).toBeLessThan(10);
  });

  it('zoneIdFor buckets nearby points into the same H3 cell', () => {
    const a = { lat: 9.001, lng: 38.741 };
    const b = { lat: 9.002, lng: 38.742 };
    expect(zoneIdFor(a)).toBe(zoneIdFor(b));
    expect(zoneIdFor(a)).toMatch(/^[0-9a-f]+$/i);
  });

  it('distant points land in different H3 cells', () => {
    const a = { lat: 8.9878, lng: 38.791 };
    const b = { lat: 9.05, lng: 38.85 };
    expect(zoneIdFor(a)).not.toBe(zoneIdFor(b));
  });

  it('zoneCenter and zoneBoundary return geometry for an H3 id', () => {
    const id = zoneIdFor({ lat: 8.9878, lng: 38.791 });
    const center = zoneCenter(id);
    expect(center).not.toBeNull();
    expect(center!.lat).toBeGreaterThan(8.9);
    expect(center!.lng).toBeGreaterThan(38.7);
    const boundary = zoneBoundary(id);
    expect(boundary.length).toBeGreaterThanOrEqual(6);
  });

  it('angularDifference wraps around 360', () => {
    expect(angularDifference(10, 350)).toBe(20);
    expect(angularDifference(0, 180)).toBe(180);
  });

  it('bearing is roughly north for due-north travel', () => {
    const from = { lat: 9.0, lng: 38.7 };
    const to = { lat: 9.1, lng: 38.7 };
    expect(bearing(from, to)).toBeCloseTo(0, 0);
  });
});
