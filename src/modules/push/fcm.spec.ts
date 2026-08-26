import { pushCopyForEvent } from './fcm';

describe('pushCopyForEvent', () => {
  it('does not push live GPS pings', () => {
    expect(pushCopyForEvent('ride.driver_location', { lat: 9 })).toBeNull();
  });

  it('maps an incoming offer', () => {
    expect(pushCopyForEvent('ride.offer', {})?.title).toBe(
      'Incoming trip request',
    );
  });
});
