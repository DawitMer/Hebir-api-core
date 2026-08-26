import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import * as express from 'express';
import helmet from 'helmet';
import { loadSecretsIntoEnv } from './config/secrets/load-secrets';
import {
  buildCorsOptions,
  resolveAllowedOrigins,
} from './config/security.config';
import { startTracingIfEnabled } from './observability/tracing';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AppModule } from './app.module';

async function bootstrap() {
  await loadSecretsIntoEnv();
  await startTracingIfEnabled();

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService);
  const logger = app.get(Logger);

  // Parse raw binary payloads for KYC document uploads up to 15MB
  app.use(
    express.raw({
      type: ['image/*', 'application/pdf', 'application/octet-stream'],
      limit: '15mb',
    }),
  );

  // Trust the first reverse-proxy hop so req.ip / rate limits use the real client.
  const trustProxy = config.get<string>('TRUST_PROXY') ?? '1';
  if (trustProxy !== 'false' && trustProxy !== '0') {
    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.set(
      'trust proxy',
      trustProxy === 'true' ? 1 : Number(trustProxy) || 1,
    );
  }

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
      hsts:
        config.get<string>('NODE_ENV') === 'production'
          ? { maxAge: 15552000, includeSubDomains: true, preload: false }
          : false,
    }),
  );

  const cors = buildCorsOptions(process.env);
  app.enableCors(cors);
  const origins = resolveAllowedOrigins(process.env);
  logger.log(
    origins.length > 0
      ? `CORS allowlist (${origins.length}): ${origins.join(', ')}`
      : 'CORS allowlist empty — browser Origins denied (set CORS_ORIGINS)',
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableShutdownHooks();

  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port);
  logger.log(`api-core listening on :${port}`);

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received — shutting down`);
    const httpServer = app.getHttpServer();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      setTimeout(resolve, 10_000).unref();
    });
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
bootstrap();
