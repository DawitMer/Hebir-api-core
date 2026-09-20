import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';

type GoogleServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

type CachedToken = { value: string; expiresAtMs: number };

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Events that are socket-only: never worth waking a phone for. */
const SKIP_PUSH_EVENTS = new Set([
  'ride.driver_location',
  'ride.chat_read',
  'booking.hold_created',
]);

/**
 * Android notification channels. They must match the channels the Flutter
 * apps create at startup, otherwise Android silently falls back to a default
 * channel and the offer loses its custom sound and heads-up importance.
 */
export const ANDROID_CHANNEL_OFFERS = 'ridehebir_ride_offers_v4';
export const ANDROID_CHANNEL_TRIP = 'hebir_trip_updates';
export const ANDROID_CHANNEL_GENERAL = 'hebir_general';

export type PushPriority = 'high' | 'normal';

export interface PushPolicy {
  /** Deliver even when the user has a live WebSocket (must-wake events). */
  critical: boolean;
  priority: PushPriority;
  ttlSeconds: number;
  androidChannelId: string;
  /** Android raw resource / iOS bundle sound file, without extension for Android. */
  sound?: string;
  /** Collapse newer copies of the same kind of alert into one notification. */
  collapseKey?: string;
  /** iOS interruption level (time-sensitive breaks through Focus modes). */
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive';
}

export interface PushCopy {
  title: string;
  body: string;
}

const OFFER_TTL_FALLBACK_SECONDS = 120;

export function pushPolicyForEvent(
  event: string,
  payload: unknown,
): PushPolicy | null {
  if (SKIP_PUSH_EVENTS.has(event)) return null;
  const data = asRecord(payload);
  switch (event) {
    case 'ride.offer': {
      // Stop delivering once the offer has expired on the server.
      const expiresAt = Date.parse(String(data.offerExpiresAt ?? ''));
      const ttl = Number.isFinite(expiresAt)
        ? Math.ceil((expiresAt - Date.now()) / 1000)
        : OFFER_TTL_FALLBACK_SECONDS;
      return {
        critical: true,
        priority: 'high',
        ttlSeconds: clamp(ttl, 15, OFFER_TTL_FALLBACK_SECONDS),
        androidChannelId: ANDROID_CHANNEL_OFFERS,
        sound: 'hebir_offer',
        collapseKey: 'ride.offer',
        interruptionLevel: 'time-sensitive',
      };
    }
    case 'ride.matched':
    case 'ride.cancelled':
    case 'ride.unmatched':
    case 'ride.rematching':
    case 'ride.driver_initiated':
    case 'incident.sos_peer':
      return {
        critical: true,
        priority: 'high',
        ttlSeconds: 15 * 60,
        androidChannelId: ANDROID_CHANNEL_TRIP,
        sound: 'default',
        collapseKey: `${event}:${String(data.rideId ?? '')}`,
        interruptionLevel: 'time-sensitive',
      };
    case 'ride.status_changed':
      return {
        critical: false,
        priority: 'high',
        ttlSeconds: 10 * 60,
        androidChannelId: ANDROID_CHANNEL_TRIP,
        sound: 'default',
        collapseKey: `ride.status:${String(data.rideId ?? '')}`,
        interruptionLevel: 'active',
      };
    case 'ride.chat_message':
      return {
        critical: false,
        priority: 'high',
        ttlSeconds: 60 * 60,
        androidChannelId: ANDROID_CHANNEL_TRIP,
        sound: 'default',
        collapseKey: `ride.chat:${String(data.rideId ?? '')}`,
        interruptionLevel: 'active',
      };
    case 'ride.completed':
      return {
        critical: false,
        priority: 'normal',
        ttlSeconds: 6 * 60 * 60,
        androidChannelId: ANDROID_CHANNEL_TRIP,
        sound: 'default',
        collapseKey: `ride.completed:${String(data.rideId ?? '')}`,
        interruptionLevel: 'active',
      };
    default:
      return {
        critical: false,
        priority: 'normal',
        ttlSeconds: 24 * 60 * 60,
        androidChannelId: ANDROID_CHANNEL_GENERAL,
        sound: 'default',
        collapseKey: event,
        interruptionLevel: 'passive',
      };
  }
}

export function pushCopyForEvent(
  event: string,
  payload: unknown,
): PushCopy | null {
  if (SKIP_PUSH_EVENTS.has(event)) return null;
  const data = asRecord(payload);
  switch (event) {
    case 'ride.offer': {
      const pickup = labelOf(data.pickupAddress);
      return {
        title: 'Incoming trip request',
        body: pickup ? `Pickup: ${pickup}` : 'A nearby rider needs a ride.',
      };
    }
    case 'ride.matched':
      return { title: 'Driver found', body: 'Your driver is on the way.' };
    case 'ride.rematching':
      return {
        title: 'Finding another driver',
        body: 'Your trip is still searching.',
      };
    case 'ride.cancelled': {
      const reason = labelOf(data.reason);
      return {
        title: 'Ride cancelled',
        body: reason ? reason : 'This trip is no longer active.',
      };
    }
    case 'ride.unmatched':
      return { title: 'No driver found', body: 'Try requesting again.' };
    case 'ride.completed':
      return { title: 'Trip completed', body: 'Rate your trip when you can.' };
    case 'ride.chat_message':
      return { title: 'New message', body: 'Open the trip chat.' };
    case 'ride.driver_initiated':
      return {
        title: 'Trip started by your driver',
        body: 'Open Hebir to confirm the ride.',
      };
    case 'ride.status_changed': {
      const status = typeof data.status === 'string' ? data.status : '';
      switch (status) {
        case 'accepted':
          return { title: 'Driver found', body: 'Your driver is on the way.' };
        case 'arriving':
          return {
            title: 'Driver arriving',
            body: 'Your driver is at the pickup point.',
          };
        case 'in_progress':
          return { title: 'Trip started', body: 'Enjoy your ride.' };
        case 'completed':
          return {
            title: 'Trip completed',
            body: 'Rate your trip when you can.',
          };
        case 'cancelled':
          return {
            title: 'Ride cancelled',
            body: 'This trip is no longer active.',
          };
        default:
          return { title: 'Ride update', body: 'Open Hebir for details.' };
      }
    }
    case 'incident.sos_peer':
      return {
        title: 'Safety alert',
        body: 'The other party triggered SOS. Open Hebir now.',
      };
    case 'incident.sos_ack':
      return {
        title: 'Help is on the way',
        body: 'Hebir operations received your SOS.',
      };
    case 'incident.status':
      return { title: 'Safety case update', body: 'Open Hebir for details.' };
    case 'subscription.suspended':
      return {
        title: 'Subscription ended',
        body: 'Renew to keep going online when the paywall is on.',
      };
    case 'tip.received':
      return { title: 'You received a tip', body: 'Thank you for the trip.' };
    case 'expense.approved':
      return { title: 'Expense approved', body: 'Open Earnings for details.' };
    case 'expense.rejected':
      return {
        title: 'Expense needs changes',
        body: 'Open Earnings to review the note.',
      };
    default:
      return { title: 'Hebir', body: event.replace(/[._]/g, ' ') };
  }
}

/**
 * Builds an FCM HTTP v1 `message` object. Data values must be strings; the
 * `event` and `rideId` keys are what the apps use to deep-link on tap.
 */
export function buildFcmMessage(params: {
  token: string;
  platform: string;
  event: string;
  copy: PushCopy;
  policy: PushPolicy;
  payload: unknown;
}): Record<string, unknown> {
  const { token, event, copy, policy, payload } = params;
  const data: Record<string, string> = {
    event,
    ...flattenPushData(payload),
  };
  // Lets the Flutter side route by event without inspecting the payload shape.
  if (!data.route) data.route = routeForEvent(event);

  const androidNotification: Record<string, unknown> = {
    channel_id: policy.androidChannelId,
    // Grouping keeps ten chat pushes from becoming ten banners.
    tag: policy.collapseKey ?? event,
    default_vibrate_timings: true,
  };
  if (policy.sound) androidNotification.sound = policy.sound;

  const aps: Record<string, unknown> = {
    'thread-id': policy.collapseKey ?? event,
  };
  if (policy.sound) {
    aps.sound = policy.sound === 'default' ? 'default' : `${policy.sound}.wav`;
  }
  if (policy.interruptionLevel) {
    aps['interruption-level'] = policy.interruptionLevel;
  }

  const apnsHeaders: Record<string, string> = {
    'apns-priority': policy.priority === 'high' ? '10' : '5',
    'apns-push-type': 'alert',
    'apns-expiration': String(
      Math.floor(Date.now() / 1000) + policy.ttlSeconds,
    ),
  };
  if (policy.collapseKey) {
    // APNs limits collapse ids to 64 bytes.
    apnsHeaders['apns-collapse-id'] = policy.collapseKey.slice(0, 64);
  }

  const android: Record<string, unknown> = {
    priority: policy.priority.toUpperCase(),
    ttl: `${policy.ttlSeconds}s`,
    notification: androidNotification,
  };
  if (policy.collapseKey) android.collapse_key = policy.collapseKey;

  return {
    token,
    notification: { title: copy.title, body: copy.body },
    data,
    android,
    apns: { headers: apnsHeaders, payload: { aps } },
  };
}

export function routeForEvent(event: string): string {
  switch (event) {
    case 'ride.offer':
      return 'offer';
    case 'ride.chat_message':
      return 'chat';
    case 'ride.completed':
      return 'history';
    case 'incident.sos_peer':
    case 'incident.sos_ack':
    case 'incident.status':
      return 'safety';
    case 'tip.received':
    case 'expense.approved':
    case 'expense.rejected':
      return 'earnings';
    case 'subscription.suspended':
      return 'subscription';
    default:
      return event.startsWith('ride.') ? 'trip' : 'home';
  }
}

/**
 * FCM v1 error taxonomy. `UNREGISTERED` (app uninstalled / token rotated) and
 * an `INVALID_ARGUMENT` about the registration token mean the token is dead
 * and must be deleted; everything else is transient or our bug.
 */
export function classifyFcmFailure(
  status: number,
  bodyText: string,
): 'dead-token' | 'retryable' | 'permanent' {
  if (status === 404 || status === 410) return 'dead-token';
  const lower = bodyText.toLowerCase();
  if (status === 400 && lower.includes('registration token')) {
    return 'dead-token';
  }
  if (lower.includes('unregistered') || lower.includes('not_found')) {
    return 'dead-token';
  }
  if (status === 429 || status >= 500) return 'retryable';
  return 'permanent';
}

/**
 * One Google service account serves both Firebase Auth verification and FCM.
 * Accepts inline JSON (`FCM_SERVICE_ACCOUNT_JSON` or the shared
 * `FIREBASE_SERVICE_ACCOUNT_JSON`), base64 of that JSON, or a file path via
 * `GOOGLE_APPLICATION_CREDENTIALS`. Private keys pasted into dashboards often
 * arrive with literal `\n`, which is normalised here.
 */
export function loadFcmServiceAccount(
  config: ConfigService,
): GoogleServiceAccount | null {
  const inline =
    config.get<string>('FCM_SERVICE_ACCOUNT_JSON')?.trim() ||
    config.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON')?.trim();
  if (inline) return parseServiceAccount(inline);
  const path = config.get<string>('GOOGLE_APPLICATION_CREDENTIALS')?.trim();
  if (!path) return null;
  try {
    return parseServiceAccount(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function parseServiceAccount(raw: string): GoogleServiceAccount | null {
  const candidates = [raw];
  if (!raw.startsWith('{')) {
    try {
      candidates.push(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      // not base64
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<GoogleServiceAccount>;
      if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
        continue;
      }
      return {
        project_id: parsed.project_id,
        client_email: parsed.client_email,
        private_key: parsed.private_key.replace(/\\n/g, '\n'),
      };
    } catch {
      // try next
    }
  }
  return null;
}

export async function googleAccessToken(
  sa: GoogleServiceAccount,
  fetchImpl: typeof fetch,
  cache: { current?: CachedToken },
  nowMs = Date.now(),
): Promise<string> {
  if (cache.current && cache.current.expiresAtMs - 60_000 > nowMs) {
    return cache.current.value;
  }
  const now = Math.floor(nowMs / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: FCM_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  ).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const jwt = `${header}.${payload}.${signer.sign(sa.private_key, 'base64url')}`;

  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!res.ok || !json?.access_token) {
    throw new Error('Google OAuth token request failed');
  }
  cache.current = {
    value: json.access_token,
    expiresAtMs: nowMs + (json.expires_in ?? 3600) * 1000,
  };
  return json.access_token;
}

/** FCM data values must be strings; nested objects are dropped. */
export function flattenPushData(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    payload as Record<string, unknown>,
  )) {
    if (value == null) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      // FCM rejects data keys that collide with reserved names.
      if (key === 'from' || key === 'notification' || key.startsWith('google.'))
        continue;
      out[key] = String(value);
    }
  }
  return out;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : {};
}

function labelOf(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
