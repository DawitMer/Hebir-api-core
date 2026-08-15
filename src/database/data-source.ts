import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveMigrationDatabaseUrl,
  resolvePoolOptions,
} from './pool.config';

/**
 * TypeORM CLI data source (migrations generate/run).
 * Loads api-core/.env without requiring the dotenv package.
 *
 * Uses DATABASE_DIRECT_URL when set (bypass PgBouncer / Neon pooler for DDL).
 */
function loadEnvFile() {
  const envPath = path.resolve(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const databaseUrl = resolveMigrationDatabaseUrl(process.env);
const pool = resolvePoolOptions({
  ...process.env,
  // CLI migration pool can stay tiny.
  DATABASE_URL: databaseUrl,
  DB_POOL_MAX: process.env.DB_POOL_MAX ?? '2',
});

const common: Partial<DataSourceOptions> = {
  type: 'postgres',
  entities: [path.join(__dirname, '../modules/**/*.entity.{ts,js}')],
  migrations: [path.join(__dirname, './migrations/*.{ts,js}')],
  synchronize: false,
  migrationsTableName: 'migrations',
  logging: process.env.TYPEORM_LOGGING === 'true',
  poolSize: pool.poolSize,
  connectTimeoutMS: pool.connectTimeoutMS,
  applicationName: `${pool.applicationName}-migrate`,
  extra: pool.extra,
};

const options: DataSourceOptions = databaseUrl
  ? ({
      ...common,
      url: databaseUrl,
      // Verify server certs by default; DB_SSL_REJECT_UNAUTHORIZED=false is
      // an explicit opt-out for providers with self-signed chains.
      ssl: databaseUrl.includes('sslmode=require')
        ? process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false'
          ? { rejectUnauthorized: false }
          : true
        : undefined,
    } as DataSourceOptions)
  : ({
      ...common,
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'hebir',
      password: process.env.DB_PASSWORD ?? 'hebir',
      database: process.env.DB_NAME ?? 'hebir',
    } as DataSourceOptions);

export default new DataSource(options);
