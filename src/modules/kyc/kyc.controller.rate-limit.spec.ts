import 'reflect-metadata';
import { KycController } from './kyc.controller';
import {
  RATE_LIMIT_KEY,
  RateLimitOptions,
} from '../../common/rate-limit/rate-limit.decorator';
import { RedisRateLimitGuard } from '../../common/rate-limit/redis-rate-limit.guard';

/**
 * Driver document upload is the only unauthenticated-size write path a driver
 * has; it must be throttled like accept and chat so a scripted client cannot
 * fill private storage or hammer the presigner.
 */
describe('KycController upload rate limits', () => {
  /** Nest's `@UseGuards` metadata key (`GUARDS_METADATA` in @nestjs/common). */
  const GUARDS_METADATA = '__guards__';
  const uploadHandlers = ['presign', 'uploadBody', 'confirm'] as const;

  it.each(uploadHandlers)('%s is behind the Redis rate limiter', (name) => {
    const handler = KycController.prototype[name];
    const guards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    expect(guards).toContain(RedisRateLimitGuard);

    const options: RateLimitOptions | undefined = Reflect.getMetadata(
      RATE_LIMIT_KEY,
      handler,
    );
    expect(options?.prefix).toBe('rl:kyc-upload');
    expect(options?.keyBy).toBe('user');
    expect(options?.limit).toBeGreaterThan(0);
    expect(options?.limit).toBeLessThanOrEqual(30);
  });

  it('read-only document listing is not throttled by the upload limiter', () => {
    const options = Reflect.getMetadata(
      RATE_LIMIT_KEY,
      KycController.prototype.myDocuments,
    );
    expect(options).toBeUndefined();
  });
});
