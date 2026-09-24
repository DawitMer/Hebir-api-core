/** Hexagonal (H3) + radius on-demand dispatch (resumable Redis queue). */
import { radiusKmForHexRing } from '../../matching/geo/geo.util';

/** First search: pickup hex only (ring 0). */
export const INITIAL_HEX_RING = 0;
/** Grow one H3 ring per empty tick. */
export const HEX_RING_EXPAND = 1;
/**
 * Cap ring expansion (~res-8 ring 7 ≈ 7 km). After this with no eligible
 * drivers, the attempt ends as unmatched and the rider can Retry.
 */
export const MAX_HEX_RING = 7;

/** @deprecated Prefer hexRing — kept for Redis state cutover / GEO fallback. */
export const INITIAL_RADIUS_KM = radiusKmForHexRing(INITIAL_HEX_RING);
/** @deprecated Prefer HEX_RING_EXPAND. */
export const RADIUS_EXPAND_KM = 1.5;
/**
 * Cap so an empty city does not search the whole country. After this radius
 * with no eligible drivers, the attempt ends as unmatched and the rider can Retry.
 */
export const MAX_RADIUS_KM = radiusKmForHexRing(MAX_HEX_RING);
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
  /** H3 k-ring around pickup (0 = pickup cell only). */
  hexRing: number;
  /** Derived GEO radius covering [hexRing] — used by location-svc fallback. */
  radiusKm: number;
  triedDriverIds: string[];
  /** Set on offer_check jobs. */
  offerDriverId?: string;
  /** Delivery attempts so far (retry bookkeeping). */
  attempts?: number;
};

export type DispatchState = {
  startedAt: number;
  hexRing: number;
  radiusKm: number;
  triedDriverIds: string[];
};

/** Normalize legacy Redis state that only stored radiusKm. */
export function normalizeDispatchState(
  raw: Partial<DispatchState> & { radiusKm?: number },
): DispatchState {
  const hexRing =
    typeof raw.hexRing === 'number' && Number.isFinite(raw.hexRing)
      ? Math.max(0, Math.floor(raw.hexRing))
      : INITIAL_HEX_RING;
  const radiusKm =
    typeof raw.radiusKm === 'number' && Number.isFinite(raw.radiusKm)
      ? raw.radiusKm
      : radiusKmForHexRing(hexRing);
  return {
    startedAt: raw.startedAt ?? Date.now(),
    hexRing,
    radiusKm,
    triedDriverIds: Array.isArray(raw.triedDriverIds)
      ? raw.triedDriverIds.filter(Boolean)
      : [],
  };
}

export function initialDispatchState(
  skipDriverIds: string[] = [],
): DispatchState {
  return {
    startedAt: Date.now(),
    hexRing: INITIAL_HEX_RING,
    radiusKm: radiusKmForHexRing(INITIAL_HEX_RING),
    triedDriverIds: [...new Set(skipDriverIds.filter(Boolean))],
  };
}

/** Expand one hex ring (and matching GEO radius). */
export function expandDispatchSearch(state: DispatchState): DispatchState {
  const hexRing = Math.min(state.hexRing + HEX_RING_EXPAND, MAX_HEX_RING);
  return {
    ...state,
    hexRing,
    radiusKm: radiusKmForHexRing(hexRing),
  };
}

/** Whether an empty-ring tick should end the attempt instead of expanding. */
export function shouldEndEmptySearch(
  radiusKm: number,
  hexRing?: number,
): boolean {
  if (typeof hexRing === 'number' && Number.isFinite(hexRing)) {
    return hexRing >= MAX_HEX_RING;
  }
  return radiusKm >= MAX_RADIUS_KM - 1e-9;
}
