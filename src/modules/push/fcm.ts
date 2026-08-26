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
const SKIP_PUSH_EVENTS = new Set(['ride.driver_location']);

export function pushCopyForEvent(
  event: string,
  payload: unknown,
): { title: string; body: string } | null {
  if (SKIP_PUSH_EVENTS.has(event)) return null;
  const data =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  switch (event) {
    case 'ride.offer':
      return {
        title: 'Incoming trip request',
        body: 'A nearby rider needs a ride.',
      };
    case 'ride.matched':
      return { title: 'Driver found', body: 'Your driver is on the way.' };
    case 'ride.rematching':
      return {
        title: 'Finding another driver',
        body: 'Your trip is still searching.',
      };
    case 'ride.cancelled':
      return {
        title: 'Ride cancelled',
        body: 'This trip is no longer active.',
      };
    case 'ride.unmatched':
      return { title: 'No driver found', body: 'Try requesting again.' };
    case 'ride.completed':
      return { title: 'Trip completed', body: 'Rate your trip when you can.' };
    case 'ride.chat_message':
      return { title: 'New message', body: 'Open the trip chat.' };
    case 'ride.status_changed': {
      const status = typeof data.status === 'string' ? data.status : 'updated';
      return { title: 'Ride update', body: `Status: ${status}` };
    }
    case 'subscription.suspended':
      return {
        title: 'Subscription ended',
        body: 'Renew to keep going online when the paywall is on.',
      };
    default:
      return { title: 'Hebir', body: event.replace(/[._]/g, ' ') };
  }
}

export function loadFcmServiceAccount(
  config: ConfigService,
): GoogleServiceAccount | null {
  const inline = config.get<string>('FCM_SERVICE_ACCOUNT_JSON')?.trim();
  if (inline) {
    try {
      return JSON.parse(inline) as GoogleServiceAccount;
    } catch {
      return null;
    }
  }
  const path = config.get<string>('GOOGLE_APPLICATION_CREDENTIALS')?.trim();
  if (!path) return null;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8')) as GoogleServiceAccount;
  } catch {
    return null;
  }
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
      out[key] = String(value);
    }
  }
  return out;
}
