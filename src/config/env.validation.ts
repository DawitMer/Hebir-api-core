import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  @IsIn(['development', 'production', 'test', 'staging'])
  NODE_ENV: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number;

  /** Neon/Supabase style URL (prefer pooled / PgBouncer). */
  @IsOptional()
  @IsString()
  DATABASE_URL?: string;

  /** Direct Postgres URL for migrations (bypass pooler). */
  @IsOptional()
  @IsString()
  DATABASE_DIRECT_URL?: string;

  /** Force pooler-aware defaults even without `-pooler` / :6432 in URL. */
  @IsOptional()
  @IsIn(['true', 'false'])
  DB_USE_PGBOUNCER?: string;

  /** node-pg pool max (default 10 behind pooler, else 20). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  DB_POOL_MAX?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  DB_POOL_MIN?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  DB_POOL_IDLE_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  DB_POOL_CONNECTION_TIMEOUT_MS?: number;

  @IsOptional()
  @IsString()
  DB_APPLICATION_NAME?: string;

  @ValidateIf((o: EnvironmentVariables) => !o.DATABASE_URL)
  @IsString()
  DB_HOST?: string;

  @ValidateIf((o: EnvironmentVariables) => !o.DATABASE_URL)
  @IsNumberString()
  DB_PORT?: string;

  @ValidateIf((o: EnvironmentVariables) => !o.DATABASE_URL)
  @IsString()
  DB_USERNAME?: string;

  @ValidateIf((o: EnvironmentVariables) => !o.DATABASE_URL)
  @IsString()
  DB_PASSWORD?: string;

  @ValidateIf((o: EnvironmentVariables) => !o.DATABASE_URL)
  @IsString()
  DB_NAME?: string;

  /** Upstash style URL (`rediss://...`). If set, REDIS_HOST/PORT are optional. */
  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  @ValidateIf((o: EnvironmentVariables) => !o.REDIS_URL)
  @IsString()
  REDIS_HOST?: string;

  @ValidateIf((o: EnvironmentVariables) => !o.REDIS_URL)
  @IsNumberString()
  REDIS_PORT?: string;

  @IsString()
  JWT_ACCESS_SECRET: string;

  @IsString()
  JWT_ACCESS_EXPIRES_IN: string;

  @IsString()
  JWT_REFRESH_SECRET: string;

  @IsString()
  JWT_REFRESH_EXPIRES_IN: string;

  @IsString()
  LOCATION_SVC_URL: string;

  /** Shared bearer token for location-svc (required in production). */
  @IsOptional()
  @IsString()
  LOCATION_SVC_TOKEN?: string;

  @IsString()
  PAYMENT_WEBHOOK_SECRET: string;

  /** Hours after ride completion during which tips are accepted (default 48). */
  @IsOptional()
  @IsInt()
  @Min(1)
  TIP_WINDOW_HOURS?: number;

  /** `s3` when credentials present; force `local` for disk fallback. */
  @IsOptional()
  @IsString()
  KYC_STORAGE_MODE?: string;

  @IsOptional()
  @IsString()
  S3_BUCKET?: string;

  @IsOptional()
  @IsString()
  S3_REGION?: string;

  @IsOptional()
  @IsString()
  S3_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  S3_SECRET_ACCESS_KEY?: string;

  /** Optional MinIO / custom S3 endpoint. */
  @IsOptional()
  @IsString()
  S3_ENDPOINT?: string;

  /** Public base URL for local KYC view links (Ops <img src>). */
  @IsOptional()
  @IsString()
  PUBLIC_API_BASE_URL?: string;

  /** Signs KYC document view links. Falls back to JWT_ACCESS_SECRET. */
  @IsOptional()
  @IsString()
  KYC_VIEW_SECRET?: string;

  /**
   * Local-only emergency: auto-sync schema from entities.
   * Ignored when NODE_ENV=production.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  TYPEORM_SYNCHRONIZE?: string;

  /** When not `false`, pending migrations run on Nest boot. */
  @IsOptional()
  @IsIn(['true', 'false'])
  TYPEORM_MIGRATIONS_RUN?: string;

  /** Set `false` to disable Redis rate limits (local seeds). Default on. */
  @IsOptional()
  @IsIn(['true', 'false'])
  RATE_LIMIT_ENABLED?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  RATE_LIMIT_AUTH?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  RATE_LIMIT_AUTH_REFRESH?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  RATE_LIMIT_WEBHOOK?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  RATE_LIMIT_GPS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  RATE_LIMIT_DEMAND?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  RATE_LIMIT_RIDE_REQUEST?: number;

  /**
   * Local-only: allow Socket.IO clients to declare their own userId when they
   * send no access token. Ignored when NODE_ENV=production.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  WS_ALLOW_UNAUTHENTICATED?: string;

  /** GPS history flush interval (seconds). Higher = less Postgres write load. */
  @IsOptional()
  @IsInt()
  @Min(15)
  GPS_HISTORY_FLUSH_SECONDS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  LOCATION_SVC_BREAKER_FAILURES?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  LOCATION_SVC_BREAKER_OPEN_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(500)
  LOCATION_SVC_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  LOCATION_SVC_MAX_SOCKETS?: number;

  /**
   * `env` | `aws` | `file`. Defaults to `aws` when NODE_ENV=production.
   * See docs/SECRETS.md.
   */
  @IsOptional()
  @IsIn(['env', 'aws', 'file'])
  SECRETS_BACKEND?: string;

  /** AWS Secrets Manager ARN or name (SECRETS_BACKEND=aws). */
  @IsOptional()
  @IsString()
  SECRETS_ARN?: string;

  @IsOptional()
  @IsString()
  AWS_SECRETS_NAME?: string;

  @IsOptional()
  @IsString()
  AWS_REGION?: string;

  /** JSON file path when SECRETS_BACKEND=file. */
  @IsOptional()
  @IsString()
  SECRETS_FILE?: string;

  /** Emergency: allow .env-only secrets in production. */
  @IsOptional()
  @IsIn(['true', 'false'])
  ALLOW_ENV_SECRETS_IN_PROD?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  SECRETS_OVERWRITE?: string;

  /**
   * Comma-separated browser Origin allowlist for CORS + Socket.IO.
   * Required for Ops/Gov portals in production. Flutter apps need no Origin.
   */
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  /** Pino log level: fatal|error|warn|info|debug|trace */
  @IsOptional()
  @IsString()
  LOG_LEVEL?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  METRICS_DEFAULTS?: string;

  /** When set, /metrics requires this value as a bearer token. */
  @IsOptional()
  @IsString()
  METRICS_TOKEN?: string;

  /** `twilio` or `http`. Required in production (OTP send is fail-closed). */
  @IsOptional()
  @IsString()
  SMS_PROVIDER?: string;

  @IsOptional()
  @IsString()
  TWILIO_ACCOUNT_SID?: string;

  @IsOptional()
  @IsString()
  TWILIO_AUTH_TOKEN?: string;

  @IsOptional()
  @IsString()
  TWILIO_FROM?: string;

  @IsOptional()
  @IsString()
  SMS_HTTP_URL?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  OTEL_ENABLED?: string;

  @IsOptional()
  @IsString()
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;

  @IsOptional()
  @IsString()
  OTEL_SERVICE_NAME?: string;
}

/** Secrets shipped in .env.example — refusing them stops accidental prod deploys. */
const PLACEHOLDER_SECRET = /^(change-me|changeme|secret|placeholder|todo)/i;

const PRODUCTION_SECRET_KEYS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'PAYMENT_WEBHOOK_SECRET',
] as const;

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }

  if (validatedConfig.NODE_ENV === 'production') {
    const weak = PRODUCTION_SECRET_KEYS.filter((key) => {
      const value = validatedConfig[key];
      return !value || value.length < 24 || PLACEHOLDER_SECRET.test(value);
    });
    if (weak.length > 0) {
      throw new Error(
        `Refusing to start: ${weak.join(', ')} must be at least 24 characters and not a placeholder`,
      );
    }
    if (!validatedConfig.CORS_ORIGINS?.trim()) {
      throw new Error(
        'Refusing to start: CORS_ORIGINS must be set in production (comma-separated portal origins)',
      );
    }
    if (!validatedConfig.METRICS_TOKEN?.trim() || validatedConfig.METRICS_TOKEN.length < 16) {
      throw new Error(
        'Refusing to start: METRICS_TOKEN must be set in production (≥16 chars) to protect /metrics',
      );
    }
    if (!validatedConfig.LOCATION_SVC_TOKEN?.trim()) {
      throw new Error(
        'Refusing to start: LOCATION_SVC_TOKEN must be set in production (shared secret with location-svc)',
      );
    }
  }

  return validatedConfig;
}
