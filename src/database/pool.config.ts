/**
 * Postgres client pool limits for TypeORM / node-pg.
 *
 * Behind PgBouncer or Neon’s `-pooler` host, keep client `max` small —
 * the proxy already multiplexes to Postgres. Migrations should use
 * DATABASE_DIRECT_URL (non-pooler) when available.
 */

export type PoolEnv = {
  DATABASE_URL?: string;
  DATABASE_DIRECT_URL?: string;
  DB_USE_PGBOUNCER?: string;
  DB_POOL_MAX?: string | number;
  DB_POOL_MIN?: string | number;
  DB_POOL_IDLE_TIMEOUT_MS?: string | number;
  DB_POOL_CONNECTION_TIMEOUT_MS?: string | number;
  DB_APPLICATION_NAME?: string;
};

export type ResolvedPool = {
  /** True when URL looks like Neon/PgBouncer or flag is set. */
  behindPooler: boolean;
  poolSize: number;
  connectTimeoutMS: number;
  applicationName: string;
  extra: {
    max: number;
    min: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    allowExitOnIdle: boolean;
  };
};

function parsePositiveInt(
  raw: string | number | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Neon pooled hosts include `-pooler`; local compose uses port 6432. */
export function isBehindPooler(url: string | undefined, flag?: string): boolean {
  if (flag === 'true') return true;
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.port === '6432') return true;
    if (/-pooler\./i.test(u.hostname)) return true;
    if (/^pgbouncer$/i.test(u.hostname)) return true;
  } catch {
    return /pooler|:6432\b/i.test(url);
  }
  return false;
}

export function resolvePoolOptions(env: PoolEnv = process.env): ResolvedPool {
  const runtimeUrl = env.DATABASE_URL?.trim();
  const behindPooler = isBehindPooler(runtimeUrl, env.DB_USE_PGBOUNCER);

  // Small client pools behind a pooler; larger when talking to Postgres directly.
  const defaultMax = behindPooler ? 10 : 20;
  const poolSize = Math.max(1, parsePositiveInt(env.DB_POOL_MAX, defaultMax));
  const min = parsePositiveInt(env.DB_POOL_MIN, 0);
  const idleTimeoutMillis = parsePositiveInt(env.DB_POOL_IDLE_TIMEOUT_MS, 30_000);
  const connectTimeoutMS = parsePositiveInt(
    env.DB_POOL_CONNECTION_TIMEOUT_MS,
    10_000,
  );

  return {
    behindPooler,
    poolSize,
    connectTimeoutMS,
    applicationName: env.DB_APPLICATION_NAME?.trim() || 'api-core',
    extra: {
      max: poolSize,
      min,
      idleTimeoutMillis,
      connectionTimeoutMillis: connectTimeoutMS,
      allowExitOnIdle: true,
    },
  };
}

/**
 * Prefer direct (non-pooled) URL for CLI migrations / DDL.
 * Falls back to DATABASE_URL when unset.
 */
export function resolveMigrationDatabaseUrl(env: PoolEnv = process.env): string | undefined {
  const direct = env.DATABASE_DIRECT_URL?.trim();
  if (direct) return direct;
  return env.DATABASE_URL?.trim() || undefined;
}
