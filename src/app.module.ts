import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { validate } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { ObservabilityModule } from './observability/observability.module';
import { AuthModule } from './modules/auth/auth.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { FareModule } from './modules/fare/fare.module';
import { MatchingModule } from './modules/matching/matching.module';
import { BookingModule } from './modules/booking/booking.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { KycModule } from './modules/kyc/kyc.module';
import { GovModule } from './modules/gov/gov.module';
import { LocationModule } from './modules/location/location.module';
import { RidesModule } from './modules/rides/rides.module';
import { TipsModule } from './modules/tips/tips.module';
import { RatingsModule } from './modules/ratings/ratings.module';
import { UsersModule } from './modules/users/users.module';
import { AdminModule } from './modules/admin/admin.module';
import { IncidentsModule } from './modules/incidents/incidents.module';
import { SupportModule } from './modules/support/support.module';
import { HealthController } from './modules/admin/health.controller';
import { getRequestId } from './observability/request-context';
import { LocationSvcModule } from './common/location-svc/location-svc.module';
import { GeocodingModule } from './common/geocoding/geocoding.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
      // Production secrets come from Secrets Manager / mounted file — not .env on disk.
      ignoreEnvFile: process.env.NODE_ENV === 'production',
      envFilePath: ['.env'],
    }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProd = config.get<string>('NODE_ENV') === 'production';
        const level =
          config.get<string>('LOG_LEVEL') ?? (isProd ? 'info' : 'debug');
        return {
          pinoHttp: {
            level,
            genReqId: (req, res) => {
              const header = req.headers['x-request-id'];
              const id =
                typeof header === 'string' && header.trim()
                  ? header.trim()
                  : randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            customProps: () => {
              const requestId = getRequestId();
              return requestId ? { requestId } : {};
            },
            transport: !isProd
              ? {
                  target: 'pino-pretty',
                  options: { singleLine: true, colorize: true },
                }
              : undefined,
            autoLogging: {
              ignore: (req) => {
                const url = req.url ?? '';
                return url.startsWith('/healthz') || url.startsWith('/metrics');
              },
            },
            serializers: {
              req: (req) => ({
                id: req.id,
                method: req.method,
                url: req.url,
              }),
              res: (res) => ({
                statusCode: res.statusCode,
              }),
            },
          },
        };
      },
    }),
    ObservabilityModule,
    DatabaseModule,
    RedisModule,
    RateLimitModule,
    LocationSvcModule,
    GeocodingModule,
    AuthModule,
    UsersModule,
    AdminModule,
    IncidentsModule,
    SupportModule,
    SubscriptionModule,
    FareModule,
    MatchingModule,
    BookingModule,
    NotificationsModule,
    KycModule,
    GovModule,
    LocationModule,
    RidesModule,
    TipsModule,
    RatingsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
