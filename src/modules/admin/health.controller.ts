import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { LocationSvcClient } from '../../common/location-svc/location-svc.client';

@Controller()
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly locationSvc: LocationSvcClient,
  ) {}

  /** Liveness: the process is up. Never checks dependencies. */
  @Get(['healthz', 'health'])
  healthz() {
    return {
      ok: true,
      service: 'api-core',
      ts: new Date().toISOString(),
    };
  }

  /**
   * Readiness: probes Postgres and Redis (hard dependencies) and reports
   * location-svc state (soft — dispatch has a DB fallback). Returns 503
   * when a hard dependency is down so orchestrators stop routing traffic.
   */
  @Get(['readyz', 'ready'])
  async readyz() {
    const checks = {
      postgres: false,
      redis: false,
      locationSvc: this.locationSvc.enabled ? !this.locationSvc.isOpen : null,
    };

    try {
      await this.dataSource.query('SELECT 1');
      checks.postgres = true;
    } catch {
      // reported below
    }
    try {
      checks.redis = (await this.redis.ping()) === 'PONG';
    } catch {
      // reported below
    }

    const body = {
      ok: checks.postgres && checks.redis,
      service: 'api-core',
      checks,
      ts: new Date().toISOString(),
    };
    if (!body.ok) throw new ServiceUnavailableException(body);
    return body;
  }
}
