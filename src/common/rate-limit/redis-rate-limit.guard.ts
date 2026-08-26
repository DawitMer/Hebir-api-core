import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { RATE_LIMIT_KEY, RateLimitOptions } from './rate-limit.decorator';

@Injectable()
export class RedisRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RedisRateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.get<string>('RATE_LIMIT_ENABLED') === 'false') {
      return true;
    }

    const options = this.reflector.getAllAndOverride<
      RateLimitOptions | undefined
    >(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (!options) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: { userId?: string } }>();
    const res = context.switchToHttp().getResponse<Response>();

    const identity = this.resolveIdentity(req, options);
    const limit = this.resolveLimit(options);
    const windowSec = options.windowSec;
    const bucket = `${options.prefix}:${identity}`;

    let count: number;
    try {
      // Atomic INCR + EXPIRE so a crash cannot leave a permanent ban key.
      const result = await this.redis.eval(
        `
        local c = redis.call('INCR', KEYS[1])
        if c == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        return c
        `,
        1,
        bucket,
        String(windowSec),
      );
      count = Number(result);
    } catch (error) {
      const failClosed =
        options.prefix === 'rl:auth' ||
        options.prefix === 'rl:auth-refresh' ||
        options.prefix === 'rl:webhook' ||
        options.failClosed === true;
      this.logger.error(
        `Rate limit bucket ${options.prefix} unavailable: ${(error as Error).message}`,
      );
      if (failClosed) {
        throw new HttpException(
          {
            statusCode: HttpStatus.SERVICE_UNAVAILABLE,
            message: 'Rate limiter unavailable — try again shortly',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      return true;
    }

    const remaining = Math.max(0, limit - count);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Window', String(windowSec));

    if (count > limit) {
      const ttl = await this.redis.ttl(bucket);
      const retryAfter = ttl > 0 ? ttl : windowSec;
      res.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests — slow down and retry',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private resolveLimit(options: RateLimitOptions): number {
    const envKey = `RATE_LIMIT_${options.prefix.replace(/^rl:/, '').replace(/-/g, '_').toUpperCase()}`;
    // e.g. rl:auth → RATE_LIMIT_AUTH, rl:auth-refresh → RATE_LIMIT_AUTH_REFRESH
    const override = this.config.get<string>(envKey);
    if (override !== undefined && override !== '') {
      const n = Number(override);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return options.limit;
  }

  private resolveIdentity(
    req: Request & { user?: { userId?: string } },
    options: RateLimitOptions,
  ): string {
    const keyBy = options.keyBy ?? 'ip';
    const ip = this.clientIp(req);
    const userId = req.user?.userId;

    if (keyBy === 'user') {
      return userId ?? ip;
    }
    if (keyBy === 'both') {
      return userId ? `u:${userId}` : `ip:${ip}`;
    }
    return ip;
  }

  private clientIp(req: Request): string {
    // With Express trust proxy configured, req.ip is the client address.
    // Do not trust a raw client-supplied X-Forwarded-For as the sole identity.
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }
}
