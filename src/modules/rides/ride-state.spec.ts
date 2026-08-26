import { RideStatus } from './entities/ride.entity';
import {
  isClientRideTransitionAllowed,
  TERMINAL_RIDE_STATUSES,
} from './ride-state';

describe('ride state machine', () => {
  it('allows the driver progress path accepted → arriving → in_progress', () => {
    expect(
      isClientRideTransitionAllowed(RideStatus.ACCEPTED, RideStatus.ARRIVING),
    ).toBe(true);
    expect(
      isClientRideTransitionAllowed(
        RideStatus.ARRIVING,
        RideStatus.IN_PROGRESS,
      ),
    ).toBe(true);
  });

  it.each([
    [RideStatus.COMPLETED, RideStatus.IN_PROGRESS],
    [RideStatus.COMPLETED, RideStatus.ACCEPTED],
    [RideStatus.CANCELLED, RideStatus.SEARCHING],
    [RideStatus.UNMATCHED, RideStatus.OFFERED],
    [RideStatus.IN_PROGRESS, RideStatus.ACCEPTED],
    [RideStatus.IN_PROGRESS, RideStatus.COMPLETED],
    [RideStatus.SEARCHING, RideStatus.ACCEPTED],
    [RideStatus.OFFERED, RideStatus.IN_PROGRESS],
    [RideStatus.MATCHED, RideStatus.ARRIVING],
  ] as Array<[RideStatus, RideStatus]>)('rejects %s → %s', (from, to) => {
    expect(isClientRideTransitionAllowed(from, to)).toBe(false);
  });

  it('treats completed, cancelled, and unmatched as terminal', () => {
    expect(TERMINAL_RIDE_STATUSES.has(RideStatus.COMPLETED)).toBe(true);
    expect(TERMINAL_RIDE_STATUSES.has(RideStatus.CANCELLED)).toBe(true);
    expect(TERMINAL_RIDE_STATUSES.has(RideStatus.UNMATCHED)).toBe(true);
    expect(TERMINAL_RIDE_STATUSES.has(RideStatus.IN_PROGRESS)).toBe(false);
  });
});
