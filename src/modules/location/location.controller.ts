import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Body,
  ServiceUnavailableException,
  UseGuards,
  Inject,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user-account.entity';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdateLocationDto } from './dto/update-location.dto';
import { DriverLocationHistory } from './entities/driver-location-history.entity';
import {
  DriverProfile,
  DriverStatus,
} from '../rides/entities/driver-profile.entity';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { RedisRateLimitGuard } from '../../common/rate-limit/redis-rate-limit.guard';
import {
  RateLimit,
  RateLimitPresets,
} from '../../common/rate-limit/rate-limit.decorator';
import { LocationSvcClient } from '../../common/location-svc/location-svc.client';
import { SubscriptionService } from '../subscription/subscription.service';

/**
 * Thin authenticated proxy so Flutter apps talk only to api-core.
 * Live GPS → Redis (location-svc). History → Postgres on a throttle.
 */
@Controller()
export class LocationController {
  private readonly logger = new Logger(LocationController.name);
  /** Flush at most once per driver every N seconds (90s default for 10k fleet). */
  private readonly historyFlushSeconds: number;
  /**
   * Cache the subscription-active gate off the GPS hot path. The value changes
   * ~once per billing cycle, so a short TTL removes thousands of per-ping DB
   * reads at fleet scale. The go-online presence path checks fresh, so a newly
   * paid driver is still indexed immediately on toggle.
   */
  private readonly subActiveCacheSeconds: number;

  constructor(
    private readonly config: ConfigService,
    private readonly locationSvc: LocationSvcClient,
    private readonly subscriptionService: SubscriptionService,
    @InjectRepository(DriverLocationHistory)
    private readonly history: Repository<DriverLocationHistory>,
    @InjectRepository(DriverProfile)
    private readonly driverProfiles: Repository<DriverProfile>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.historyFlushSeconds = Number(
      this.config.get<string>('GPS_HISTORY_FLUSH_SECONDS') ?? 90,
    );
    this.subActiveCacheSeconds = Number(
      this.config.get<string>('SUBSCRIPTION_ACTIVE_CACHE_SECONDS') ?? 30,
    );
  }

  /** Redis-cached subscription gate to keep the GPS ping path off the DB. */
  private async isSubscribedCached(driverId: string): Promise<boolean> {
    const key = `sub:active:${driverId}`;
    const cached = await this.redis.get(key);
    if (cached !== null) return cached === '1';
    const active = await this.subscriptionService.isActive(driverId);
    await this.redis.set(
      key,
      active ? '1' : '0',
      'EX',
      this.subActiveCacheSeconds,
    );
    return active;
  }

  @UseGuards(JwtAuthGuard, RolesGuard, RedisRateLimitGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @RateLimit(RateLimitPresets.gps)
  @Post('drivers/location')
  async updateLocation(
    @CurrentUser() user: { userId: string },
    @Body() body: UpdateLocationDto,
  ) {
    const profile = await this.driverProfiles.findOne({
      where: { userId: user.userId },
    });
    const status = profile?.status ?? DriverStatus.OFFLINE;

    // The subscription gate only matters for ONLINE drivers; ON_TRIP/RESERVED
    // are always tracked and everyone else is removed from geo regardless. So
    // only pay for the (cached) subscription check when it can change the outcome.
    const subscribed =
      status === DriverStatus.ONLINE
        ? !this.subscriptionService.isEnforced() ||
          (await this.isSubscribedCached(user.userId))
        : false;

    // Dispatchable pins: online + active sub. Tracking pins: reserved/on_trip
    // so the rider map can follow the car. Everyone else is removed from geo.
    const indexInGeo =
      status === DriverStatus.ON_TRIP ||
      status === DriverStatus.RESERVED ||
      (status === DriverStatus.ONLINE && subscribed);

    // `indexed` must reflect reality: if the geo write fails (or the
    // breaker is open), the driver is NOT in the dispatch index and the
    // client should know.
    let indexed = false;
    if (this.locationSvc.enabled && !this.locationSvc.isOpen) {
      try {
        if (indexInGeo) {
          await this.locationSvc.post('/drivers/location', {
            driverId: user.userId,
            location: { lat: body.lat, lng: body.lng },
          });
          indexed = true;
        } else {
          await this.locationSvc.post(
            '/drivers/offline',
            { driverId: user.userId },
            1000,
          );
        }
      } catch (error) {
        this.logger.warn(
          `location-svc update failed: ${(error as Error).message}`,
        );
      }
    }

    // Batch-flush to Postgres for history (never every ping).
    const throttleKey = `driver:loc:flush:${user.userId}`;
    const acquired = await this.redis.set(
      throttleKey,
      '1',
      'EX',
      this.historyFlushSeconds,
      'NX',
    );
    if (acquired === 'OK') {
      try {
        await this.history.save(
          this.history.create({
            driverId: user.userId,
            lat: body.lat,
            lng: body.lng,
            heading: body.heading ?? null,
            speed: body.speed ?? null,
          }),
        );
      } catch (error) {
        this.logger.warn(`Location history flush failed: ${error.message}`);
      }
    }

    return { ok: true, indexed };
  }

  /**
   * Rider GPS ping for street-hail proximity checks. Stored briefly in Redis
   * so a driver can only look up a rider's phone when within ~300 m.
   */
  @UseGuards(JwtAuthGuard, RolesGuard, RedisRateLimitGuard)
  @Roles(UserRole.RIDER, UserRole.ADMIN)
  @RateLimit(RateLimitPresets.gps)
  @Post('riders/location')
  async updateRiderLocation(
    @CurrentUser() user: { userId: string },
    @Body() body: UpdateLocationDto,
  ) {
    await this.redis.set(
      `rider:loc:${user.userId}`,
      `${body.lat},${body.lng}`,
      'EX',
      180,
    );
    return { ok: true };
  }

  /**
   * Busy-area demand grid for map heat / bluish surge tint (Uber/Lyft-style).
   * GET /demand/grid?minLat=&minLng=&maxLat=&maxLng=
   */
  @UseGuards(JwtAuthGuard, RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.demand)
  @Get('demand/grid')
  async demandGrid(
    @Query('minLat') minLat: string,
    @Query('minLng') minLng: string,
    @Query('maxLat') maxLat: string,
    @Query('maxLng') maxLng: string,
  ) {
    const bbox = {
      minLat: Number(minLat),
      minLng: Number(minLng),
      maxLat: Number(maxLat),
      maxLng: Number(maxLng),
    };
    if (
      ![bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng].every(Number.isFinite) ||
      bbox.minLat >= bbox.maxLat ||
      bbox.minLng >= bbox.maxLng
    ) {
      throw new BadRequestException(
        'minLat, minLng, maxLat, maxLng are required and must form a valid bbox',
      );
    }
    return this.locationSvc.get('/demand/grid', bbox, 2500);
  }

  /**
   * Live driver pins for the rider map. Proxies location-svc so Flutter never
   * talks to the geo service (which is token-gated and unpublished in prod).
   */
  @UseGuards(JwtAuthGuard, RolesGuard, RedisRateLimitGuard)
  @Roles(UserRole.RIDER, UserRole.DRIVER, UserRole.ADMIN)
  @RateLimit(RateLimitPresets.nearbyDrivers)
  @Get('drivers/locations')
  async listDriverLocations(
    @Query('lat') latRaw: string,
    @Query('lng') lngRaw: string,
    @Query('radiusKm') radiusRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new BadRequestException('lat and lng query params are required');
    }
    const radiusKm = Number(radiusRaw);
    const limit = Number(limitRaw);
    if (!this.locationSvc.enabled || this.locationSvc.isOpen) {
      throw new ServiceUnavailableException('location-svc unavailable');
    }
    return this.locationSvc.get(
      '/drivers/locations',
      {
        lat,
        lng,
        radiusKm: Number.isFinite(radiusKm) ? radiusKm : 4,
        limit: Number.isFinite(limit) ? limit : 24,
      },
      2500,
    );
  }
}
