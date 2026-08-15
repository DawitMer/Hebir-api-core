/** Expanding-radius on-demand dispatch (resumable Redis queue). */
export const INITIAL_RADIUS_KM = 1.5;
export const RADIUS_EXPAND_KM = 1.5;
/** Overall search budget — long enough for a few 2-minute offers. */
export const MAX_DISPATCH_MS = 6 * 60_000;
/** How long a driver has to accept/decline a live offer. */
export const OFFER_TIMEOUT_MS = 2 * 60_000;
export const DISPATCH_POLL_MS = 1_000;

/** How often the safety-net sweep for stalled dispatch state runs. */
export const DISPATCH_REAP_MS = 15_000;

export const DISPATCH_DUE_KEY = 'ride:dispatch:due';
export const DISPATCH_JOB_PREFIX = 'ride:dispatch:job:';
export const DISPATCH_STATE_PREFIX = 'ride:dispatch:state:';
export const DISPATCH_DRAIN_LOCK = 'ride:dispatch:drain-lock';
export const DISPATCH_REAP_LOCK = 'ride:dispatch:reap-lock';

export type DispatchJobType = 'tick' | 'offer_check';

/** A job is retried this many times before the reap sweep takes over. */
export const DISPATCH_MAX_ATTEMPTS = 3;

export type DispatchJob = {
  id: string;
  type: DispatchJobType;
  rideId: string;
  startedAt: number;
  radiusKm: number;
  triedDriverIds: string[];
  /** Set on offer_check jobs. */
  offerDriverId?: string;
  /** Delivery attempts so far (retry bookkeeping). */
  attempts?: number;
};

export type DispatchState = {
  startedAt: number;
  radiusKm: number;
  triedDriverIds: string[];
};
