import { Global, Module } from '@nestjs/common';
import { RedisRateLimitGuard } from './redis-rate-limit.guard';

@Global()
@Module({
  providers: [RedisRateLimitGuard],
  exports: [RedisRateLimitGuard],
})
export class RateLimitModule {}
