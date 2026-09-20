import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { treatAsProductionFromEnv } from './public-api-host';

const DEV_DEFAULT_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5174',
  'http://localhost:5174',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
];

const PUBLIC_HEBIR_ORIGINS = [
  'https://ops.hebirtaxi.com',
  'https://gov.hebirtaxi.com',
  'https://hebirtaxi.com',
  'https://www.hebirtaxi.com',
];

/**
 * Comma-separated allowlist, e.g.
 * CORS_ORIGINS=https://ops.hebirtaxi.com,https://gov.hebirtaxi.com
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function resolveAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = parseCorsOrigins(env.CORS_ORIGINS);
  const productionLike = treatAsProductionFromEnv(env);
  const allowLocal = !productionLike && env.CORS_ALLOW_LOCAL !== 'false';
  const devOrigins = allowLocal ? DEV_DEFAULT_ORIGINS : [];

  if (configured.length > 0) {
    return productionLike
      ? configured
      : Array.from(new Set([...configured, ...devOrigins]));
  }
  if (productionLike) {
    return PUBLIC_HEBIR_ORIGINS;
  }
  return DEV_DEFAULT_ORIGINS;
}

type OriginCallback = (err: Error | null, allow?: boolean | string) => void;

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, '');
}

/** Shared allowlist check for HTTP CORS and Socket.IO. */
export function corsOriginDelegate(
  origin: string | undefined,
  callback: OriginCallback,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!origin) {
    callback(null, true);
    return;
  }
  const allowed = new Set(resolveAllowedOrigins(env).map(normalizeOrigin));
  const normalized = normalizeOrigin(origin);
  if (allowed.has(normalized)) {
    callback(null, origin);
    return;
  }
  callback(null, false);
}

export function buildCorsOptions(
  env: NodeJS.ProcessEnv = process.env,
): CorsOptions {
  return {
    origin: (origin: string | undefined, callback: OriginCallback) =>
      corsOriginDelegate(origin, callback, env),
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'X-Requested-With',
      'X-Webhook-Signature',
    ],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Window',
      'Retry-After',
    ],
    maxAge: 86400,
  };
}

/** Socket.IO gateway `cors` option. */
export function buildSocketCors(env: NodeJS.ProcessEnv = process.env) {
  return {
    origin: (origin: string | undefined, callback: OriginCallback) =>
      corsOriginDelegate(origin, callback, env),
    credentials: true,
  };
}
