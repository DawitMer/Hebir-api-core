import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

function retryStrategy(times: number) {
  return Math.min(times * 50, 2_000);
}

@Injectable()
class RedisLifecycleService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisLifecycleService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(signal?: string) {
    this.logger.log(`Closing Redis (${signal ?? 'shutdown'})`);
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('Redis');
        const common = {
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          retryStrategy,
        };
        const redisUrl = config.get<string>('REDIS_URL');
        const client = redisUrl
          ? new Redis(redisUrl, common)
          : new Redis({
              host: config.get<string>('REDIS_HOST'),
              port: config.get<number>('REDIS_PORT'),
              ...common,
            });
        client.on('error', (error) => {
          logger.warn(`Redis error: ${error.message}`);
        });
        return client;
      },
    },
    RedisLifecycleService,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
