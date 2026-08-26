import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import * as path from 'path';
import { resolvePoolOptions } from './pool.config';

/**
 * Schema changes go through TypeORM migrations only.
 * Local emergency: set TYPEORM_SYNCHRONIZE=true (never in production).
 *
 * Runtime uses DATABASE_URL (prefer Neon/PgBouncer pooler) with explicit pool caps.
 * Run DDL via CLI against DATABASE_DIRECT_URL when available.
 */
function resolveSynchronize(config: ConfigService): boolean {
  if (config.get<string>('NODE_ENV') === 'production') return false;
  return config.get<string>('TYPEORM_SYNCHRONIZE') === 'true';
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => {
        const databaseUrl = config.get<string>('DATABASE_URL');
        const migrationsDir = path.join(__dirname, 'migrations', '*.{ts,js}');
        const pool = resolvePoolOptions({
          DATABASE_URL: databaseUrl,
          DB_USE_PGBOUNCER: config.get<string>('DB_USE_PGBOUNCER'),
          DB_POOL_MAX: config.get<string>('DB_POOL_MAX'),
          DB_POOL_MIN: config.get<string>('DB_POOL_MIN'),
          DB_POOL_IDLE_TIMEOUT_MS: config.get<string>(
            'DB_POOL_IDLE_TIMEOUT_MS',
          ),
          DB_POOL_CONNECTION_TIMEOUT_MS: config.get<string>(
            'DB_POOL_CONNECTION_TIMEOUT_MS',
          ),
          DB_APPLICATION_NAME: config.get<string>('DB_APPLICATION_NAME'),
        });

        const common: TypeOrmModuleOptions = {
          type: 'postgres',
          autoLoadEntities: true,
          synchronize: resolveSynchronize(config),
          migrations: [migrationsDir],
          // Prefer `npm run migration:run` with DATABASE_DIRECT_URL in prod.
          // Boot-time run is OK for Neon session/pooler on simple DDL.
          migrationsRun:
            config.get<string>('TYPEORM_MIGRATIONS_RUN') !== 'false',
          migrationsTableName: 'migrations',
          migrationsTransactionMode: 'each',
          poolSize: pool.poolSize,
          connectTimeoutMS: pool.connectTimeoutMS,
          applicationName: pool.applicationName,
          extra: pool.extra,
        };

        if (databaseUrl) {
          return {
            ...common,
            url: databaseUrl,
            // Verify server certs by default; DB_SSL_REJECT_UNAUTHORIZED=false
            // is an explicit opt-out for providers with self-signed chains.
            ssl: databaseUrl.includes('sslmode=require')
              ? config.get<string>('DB_SSL_REJECT_UNAUTHORIZED') === 'false'
                ? { rejectUnauthorized: false }
                : true
              : undefined,
          };
        }

        return {
          ...common,
          host: config.get<string>('DB_HOST'),
          port: config.get<number>('DB_PORT'),
          username: config.get<string>('DB_USERNAME'),
          password: config.get<string>('DB_PASSWORD'),
          database: config.get<string>('DB_NAME'),
        };
      },
    }),
  ],
})
export class DatabaseModule {}
