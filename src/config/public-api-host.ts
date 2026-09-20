const PUBLIC_API_HOSTS = new Set(['api.hebirtaxi.com', 'api.ridehebir.com']);

/**
 * True when PUBLIC_API_BASE_URL points at the real Hebir API host.
 * Used as a fail-closed overlay when NODE_ENV is mis-set on the live service.
 */
export function isPublicHebirApiHost(
  publicApiBaseUrl?: string | null,
): boolean {
  const raw = (publicApiBaseUrl ?? '').trim();
  if (!raw) return false;
  let host = '';
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return /(?:^|[/.])api\.(?:hebirtaxi|ridehebir)\.com(?:[:/]|$)/i.test(raw);
  }
  host = host.toLowerCase();
  return (
    PUBLIC_API_HOSTS.has(host) ||
    host.endsWith('.api.hebirtaxi.com') ||
    host.endsWith('.api.ridehebir.com')
  );
}

export function treatAsProductionRuntime(
  nodeEnv?: string | null,
  publicApiBaseUrl?: string | null,
): boolean {
  return nodeEnv === 'production' || isPublicHebirApiHost(publicApiBaseUrl);
}

export function treatAsProductionFromEnv(
  env: {
    NODE_ENV?: string;
    PUBLIC_API_BASE_URL?: string;
  } = process.env,
): boolean {
  return treatAsProductionRuntime(env.NODE_ENV, env.PUBLIC_API_BASE_URL);
}

/** Drivers cannot go online without APPROVED KYC on the public API. */
export function isDriverKycEnforced(opts: {
  requireDriverKyc?: string | null;
  nodeEnv?: string | null;
  publicApiBaseUrl?: string | null;
}): boolean {
  if (opts.requireDriverKyc === 'true') return true;
  if (opts.requireDriverKyc === 'false') return false;
  return treatAsProductionRuntime(opts.nodeEnv, opts.publicApiBaseUrl);
}

export function resolveTypeormSynchronize(opts: {
  nodeEnv?: string | null;
  publicApiBaseUrl?: string | null;
  typeormSynchronize?: string | null;
}): boolean {
  if (treatAsProductionRuntime(opts.nodeEnv, opts.publicApiBaseUrl)) {
    return false;
  }
  return opts.typeormSynchronize === 'true';
}
