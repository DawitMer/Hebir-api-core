import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate_limit';

export type RateLimitKeyBy = 'ip' | 'user' | 'both';

export type RateLimitOptions = {
  /** Redis key namespace, e.g. `rl:auth`. */
  prefix: string;
  /** Max requests in the window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
  /**
   * Identity used for the bucket.
   * - `ip` — client IP (auth / webhooks)
   * - `user` — JWT userId (GPS)
   * - `both` — user if present else IP
   */
  keyBy?: RateLimitKeyBy;
  /** When true (or auth/webhook prefixes), Redis outage returns 503 instead of allowing. */
  failClosed?: boolean;
};

export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);

/** Sensible defaults for Phase-0 hot paths. Override via env in the guard. */
export const RateLimitPresets = {
  /** Login / register brute-force shield. */
  auth: {
    prefix: 'rl:auth',
    limit: 10,
    windowSec: 60,
    keyBy: 'ip' as const,
  },
  /** Refresh is authenticated but still abuseable. */
  authRefresh: {
    prefix: 'rl:auth-refresh',
    limit: 30,
    windowSec: 60,
    keyBy: 'user' as const,
  },
  /** Provider retries; keep higher than auth. */
  webhook: {
    prefix: 'rl:webhook',
    limit: 120,
    windowSec: 60,
    keyBy: 'ip' as const,
  },
  /**
   * Driver GPS pings (~every 12s → ~5/min). Allow short bursts but
   * block flooders (~20/min ≈ one ping every 3s).
   */
  gps: {
    prefix: 'rl:gps',
    limit: 20,
    windowSec: 60,
    keyBy: 'user' as const,
  },
  /** Demand heat grid polling. */
  demand: {
    prefix: 'rl:demand',
    limit: 30,
    windowSec: 60,
    keyBy: 'user' as const,
  },
  /**
   * Rider home-map + in-trip driver pins. Home polls ~12s and the live
   * tracker ~4s, so this needs more headroom than a single GPS writer.
   */
  nearbyDrivers: {
    prefix: 'rl:nearby-drivers',
    limit: 40,
    windowSec: 60,
    keyBy: 'user' as const,
  },
  /**
   * Ride requests. Each one starts a dispatch search that reserves drivers,
   * so a retry storm from one rider must not tie up the local fleet.
   */
  rideRequest: {
    prefix: 'rl:ride-request',
    limit: 12,
    windowSec: 60,
    keyBy: 'user' as const,
  },
  chat: {
    prefix: 'rl:chat',
    limit: 40,
    windowSec: 60,
    keyBy: 'user' as const,
  },
} satisfies Record<string, RateLimitOptions>;
