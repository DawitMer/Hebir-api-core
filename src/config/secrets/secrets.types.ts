/**
 * Production secrets come from a secrets manager (AWS Secrets Manager JSON)
 * or a mounted secrets file — not a long-lived checked-in `.env`.
 *
 * Local/dev keeps ConfigModule `.env` loading (SECRETS_BACKEND=env).
 */

export type SecretsBackend = 'env' | 'aws' | 'file';

/** Keys that must never live only in a committed env file in production. */
export const SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'DB_PASSWORD',
  'REDIS_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'PAYMENT_WEBHOOK_SECRET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];
