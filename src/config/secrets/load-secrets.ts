import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import * as fs from 'fs';
import * as path from 'path';
import {
  SECRET_ENV_KEYS,
  SecretsBackend,
} from './secrets.types';

function resolveBackend(): SecretsBackend {
  const explicit = process.env.SECRETS_BACKEND?.trim().toLowerCase();
  if (explicit === 'aws' || explicit === 'file' || explicit === 'env') {
    return explicit;
  }
  // Production defaults to AWS so a forgotten .env is not the only source.
  if (process.env.NODE_ENV === 'production') return 'aws';
  return 'env';
}

function assertProductionAllowsEnvBackend(backend: SecretsBackend) {
  if (process.env.NODE_ENV !== 'production') return;
  if (backend !== 'env') return;
  if (process.env.ALLOW_ENV_SECRETS_IN_PROD === 'true') {
    console.warn(
      '[secrets] ALLOW_ENV_SECRETS_IN_PROD=true — using process env / .env in production (not recommended)',
    );
    return;
  }
  throw new Error(
    '[secrets] Production requires SECRETS_BACKEND=aws|file (or set ALLOW_ENV_SECRETS_IN_PROD=true for emergency escape hatch). See docs/SECRETS.md',
  );
}

/** Merge secret map into process.env without clobbering already-set vars. */
export function applySecrets(
  secrets: Record<string, unknown>,
  opts: { overwrite?: boolean } = {},
): string[] {
  const applied: string[] = [];
  const overwrite = opts.overwrite === true;
  for (const [key, raw] of Object.entries(secrets)) {
    if (!key || raw === undefined || raw === null) continue;
    const value = typeof raw === 'string' ? raw : String(raw);
    if (!overwrite && process.env[key] !== undefined && process.env[key] !== '') {
      continue;
    }
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}

async function loadFromAws(): Promise<Record<string, unknown>> {
  const secretId =
    process.env.SECRETS_ARN?.trim() ||
    process.env.AWS_SECRETS_NAME?.trim() ||
    process.env.SECRETS_NAME?.trim();
  if (!secretId) {
    throw new Error(
      '[secrets] SECRETS_ARN (or AWS_SECRETS_NAME) is required when SECRETS_BACKEND=aws',
    );
  }

  const region =
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    'eu-central-1';

  const client = new SecretsManagerClient({ region });
  const out = await client.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );

  const text = out.SecretString;
  if (!text) {
    throw new Error(`[secrets] Secret ${secretId} has no SecretString (binary secrets unsupported)`);
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Secret must be a JSON object of env key → string');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `[secrets] Failed to parse AWS secret JSON: ${(error as Error).message}`,
    );
  }
}

function loadFromFile(): Record<string, unknown> {
  const filePath =
    process.env.SECRETS_FILE?.trim() ||
    path.resolve(process.cwd(), 'secrets.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`[secrets] SECRETS_FILE not found: ${filePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[secrets] SECRETS_FILE must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Load secrets into `process.env` before Nest ConfigModule validates.
 * Safe to call multiple times; existing env wins unless SECRETS_OVERWRITE=true.
 */
export async function loadSecretsIntoEnv(): Promise<{
  backend: SecretsBackend;
  applied: string[];
}> {
  const backend = resolveBackend();
  assertProductionAllowsEnvBackend(backend);

  if (backend === 'env') {
    return { backend, applied: [] };
  }

  const secrets = backend === 'aws' ? await loadFromAws() : loadFromFile();
  const applied = applySecrets(secrets, {
    overwrite: process.env.SECRETS_OVERWRITE === 'true',
  });

  const missingCritical = SECRET_ENV_KEYS.filter(
    (k) =>
      (k === 'DATABASE_URL' ||
        k === 'JWT_ACCESS_SECRET' ||
        k === 'JWT_REFRESH_SECRET' ||
        k === 'PAYMENT_WEBHOOK_SECRET' ||
        k === 'REDIS_URL') &&
      !process.env[k],
  );
  // REDIS_URL optional if REDIS_HOST set; DATABASE_URL optional if DB_* set
  const reallyMissing = missingCritical.filter((k) => {
    if (k === 'REDIS_URL' && process.env.REDIS_HOST) return false;
    if (k === 'DATABASE_URL' && process.env.DB_HOST) return false;
    if (k === 'DATABASE_DIRECT_URL') return false;
    if (k === 'DB_PASSWORD' && process.env.DATABASE_URL) return false;
    if (k === 'S3_ACCESS_KEY_ID' || k === 'S3_SECRET_ACCESS_KEY') return false;
    return !process.env[k];
  });

  if (reallyMissing.length > 0) {
    console.warn(
      `[secrets] backend=${backend} loaded ${applied.length} keys; still missing: ${reallyMissing.join(', ')}`,
    );
  } else {
    console.log(
      `[secrets] backend=${backend} applied ${applied.length} key(s)`,
    );
  }

  return { backend, applied };
}
