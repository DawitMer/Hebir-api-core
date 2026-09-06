import { validateRouteSample } from './trip-route-recorder.service';

describe('route sample validation (SQL persistence is covered by database.e2e)', () => {
  const last = { lat: 8.9806, lng: 38.7578, timestampMs: 1000 };
  it('meters realistic movement', () => {
    expect(
      validateRouteSample(last, { ...last, lat: 8.9851, timestampMs: 31000 })
        .distanceM,
    ).toBeGreaterThan(450);
  });
  it.each([1000, 999])(
    'rejects duplicate/out-of-order timestamp %s',
    (timestampMs) => {
      expect(validateRouteSample(last, { ...last, timestampMs }).reason).toBe(
        'out_of_order',
      );
    },
  );
  it('rejects impossible jumps', () => {
    expect(
      validateRouteSample(last, { ...last, lat: 9.0706, timestampMs: 3000 })
        .reason,
    ).toBe('impossible_speed_jump');
  });
  it('rejects poor accuracy', () => {
    expect(
      validateRouteSample(last, { ...last, timestampMs: 10000, accuracy: 120 })
        .reason,
    ).toBe('accuracy_too_poor');
  });
  it('rejects invalid coordinates', () => {
    expect(
      validateRouteSample(last, { ...last, lat: NaN, timestampMs: 10000 })
        .reason,
    ).toBe('invalid_fix');
  });
  it('rejects future fixes', () => {
    expect(
      validateRouteSample(last, { ...last, timestampMs: Date.now() + 60000 })
        .reason,
    ).toBe('future_fix');
  });
  it('flags gaps rather than representing them as a continuous GPS trace', () => {
    expect(
      validateRouteSample(last, { ...last, lat: 8.9851, timestampMs: 200000 })
        .hasGap,
    ).toBe(true);
  });
});
