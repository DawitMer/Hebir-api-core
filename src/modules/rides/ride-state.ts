import { RideStatus } from './entities/ride.entity';

/**
 * Client-facing PATCH /rides/:id/status edges only.
 * Dispatch (`offered`/`matched`) and accept live on dedicated methods so a
 * rider/driver cannot forge those states through the generic patch.
 * `cancelled` is routed to cancelRide() before this table is consulted.
 * `completed` is exclusive to completeRide().
 */
export const CLIENT_RIDE_TRANSITIONS: Record<RideStatus, RideStatus[]> = {
  [RideStatus.REQUESTED]: [],
  [RideStatus.SEARCHING]: [],
  [RideStatus.OFFERED]: [],
  [RideStatus.MATCHED]: [],
  [RideStatus.ACCEPTED]: [RideStatus.ARRIVING],
  [RideStatus.ARRIVING]: [RideStatus.IN_PROGRESS],
  [RideStatus.IN_PROGRESS]: [],
  [RideStatus.COMPLETED]: [],
  [RideStatus.CANCELLED]: [],
  [RideStatus.UNMATCHED]: [],
};

/** Only the assigned driver reports physical progress towards the rider. */
export const DRIVER_ONLY_TRANSITIONS = new Set<RideStatus>([
  RideStatus.ARRIVING,
  RideStatus.IN_PROGRESS,
]);

export const TERMINAL_RIDE_STATUSES = new Set<RideStatus>([
  RideStatus.COMPLETED,
  RideStatus.CANCELLED,
  RideStatus.UNMATCHED,
]);

export function isClientRideTransitionAllowed(
  from: RideStatus,
  to: RideStatus,
): boolean {
  return (CLIENT_RIDE_TRANSITIONS[from] ?? []).includes(to);
}
