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
import { In, Repository } from 'typeorm';
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
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { Ride, RideStatus } from '../rides/entities/ride.entity';
import {
  liveTrackFromRide,
  liveTrackKey,
  parseLiveTrack,
  writeLiveTrack,
  LIVE_TRACK_TTL_SEC,
} from '../rides/ride-live-track';
import { remainingEta } from '../rides/remaining-eta';
import { GeocodingService } from '../../common/geocoding/geocoding.service';
import { TripRouteRecorderService } from '../rides/trip-route-recorder.service';

const TRACKABLE_RIDE_STATUSES = [
  RideStatus.MATCHED,
  RideStatus.ACCEPTED,
  RideStatus.ARRIVING,
  RideStatus.IN_PROGRESS,
];

type GeoPingResult = {
  accepted?: boolean;
  lat?: number;
  lng?: number;
  heading?: number | null;
  speed?: number | null;
  accuracy?: number | null;
  timestampMs?: number;
};

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
    private readonly geocodingService: GeocodingService,
    @InjectRepository(DriverLocationHistory)
    private readonly history: Repository<DriverLocationHistory>,
    @InjectRepository(DriverProfile)
    private readonly driverProfiles: Repository<DriverProfile>,
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    private readonly notifications: NotificationsGateway,
    private readonly routeRecorder: TripRouteRecorderService,
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
    let geoAccepted = false;
    let ping: GeoPingResult | null = null;
    if (this.locationSvc.enabled && !this.locationSvc.isOpen) {
      try {
        if (indexInGeo) {
          ping = await this.locationSvc.post<GeoPingResult>(
            '/drivers/location',
            {
              driverId: user.userId,
              location: { lat: body.lat, lng: body.lng },
              heading: body.heading,
              speed: body.speed,
              accuracy: body.accuracy,
            },
          );
          geoAccepted = ping?.accepted !== false;
          indexed = geoAccepted;
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

    if (geoAccepted && status === DriverStatus.ON_TRIP) {
      void this.broadcastAssignedLocation(user.userId, body, ping);
    }

    // Batch-flush to Postgres for history (never every ping). Skip rejected
    // jumps so forensic history matches what dispatch and the rider map saw.
    if (ping?.accepted !== false) {
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
    }

    return { ok: true, indexed };
  }

  /**
   * Push the assigned car to the rider only. Fleet nearby polls still exist
   * for the home map; in-trip tracking must not depend on GEO radius/limit.
   */
  private async broadcastAssignedLocation(
    driverId: string,
    body: UpdateLocationDto,
    ping: GeoPingResult | null,
  ): Promise<void> {
    try {
      let track = parseLiveTrack(await this.redis.get(liveTrackKey(driverId)));
      if (!track || !track.pickup || !track.dropoff) {
        const ride = await this.rides.findOne({
          where: { driverId, status: In(TRACKABLE_RIDE_STATUSES) },
          order: { matchedAt: 'DESC' },
        });
        if (!ride) return;
        track = liveTrackFromRide(ride);
        await writeLiveTrack(this.redis, driverId, track);
      } else {
        await this.redis.expire(liveTrackKey(driverId), LIVE_TRACK_TTL_SEC);
      }

      const lat = ping?.lat ?? body.lat;
      const lng = ping?.lng ?? body.lng;
      const timestampMs = ping?.timestampMs ?? Date.now();
      const eta =
        track.pickup && track.dropoff
          ? remainingEta({
              driver: { lat, lng },
              speedMps: ping?.speed ?? body.speed,
              pickup: track.pickup,
              dropoff: track.dropoff,
              status: track.status ?? RideStatus.ACCEPTED,
              quotedDistanceM: track.distanceM,
              quotedDurationS: track.durationS,
            })
          : null;
      let totalTraveledM: number | null = null;
      if (track.status === RideStatus.IN_PROGRESS) {
        try {
          const recResult = await this.routeRecorder.recordGpsPoint(
            track.rideId,
            {
              lat,
              lng,
              timestampMs,
              heading: ping?.heading ?? body.heading ?? null,
              speed: ping?.speed ?? body.speed ?? null,
              accuracy: ping?.accuracy ?? body.accuracy ?? null,
            },
          );
          totalTraveledM = recResult.totalDistanceM;
        } catch (recErr) {
          this.logger.warn(`Route recording failed for ride ${track.rideId}: ${recErr}`);
        }
      }

      await this.notifications.notify(track.riderId, 'ride.driver_location', {
        rideId: track.rideId,
        driverId,
        lat,
        lng,
        heading: ping?.heading ?? body.heading ?? null,
        speed: ping?.speed ?? body.speed ?? null,
        accuracy: ping?.accuracy ?? body.accuracy ?? null,
        timestampMs,
        seq: timestampMs,
        actualDistanceM: totalTraveledM,
        remainingMetres: eta?.remainingMetres ?? null,
        etaSeconds: eta?.etaSeconds ?? null,
        etaTarget: eta?.target ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `driver location push failed: ${(error as Error).message}`,
      );
    }
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
      ![bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng].every(
        Number.isFinite,
      ) ||
      bbox.minLat >= bbox.maxLat ||
      bbox.minLng >= bbox.maxLng
    ) {
      throw new BadRequestException(
        'minLat, minLng, maxLat, maxLng are required and must form a valid bbox',
      );
    }
    if (bbox.maxLat - bbox.minLat > 1 || bbox.maxLng - bbox.minLng > 1) {
      throw new BadRequestException('Bounding box is too large');
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
    const radiusKm = Number.isFinite(Number(radiusRaw))
      ? Math.min(25, Math.max(0.5, Number(radiusRaw)))
      : 4;
    const limit = Number.isFinite(Number(limitRaw))
      ? Math.min(48, Math.max(1, Math.floor(Number(limitRaw))))
      : 24;
    if (!this.locationSvc.enabled || this.locationSvc.isOpen) {
      throw new ServiceUnavailableException('location-svc unavailable');
    }
    return this.locationSvc.get(
      '/drivers/locations',
      {
        lat,
        lng,
        radiusKm,
        limit,
      },
      2500,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('location/places/autocomplete')
  async autocompletePlaces(@Query('q') query: string) {
    if (!query || !query.trim()) return [];
    return this.geocodingService.autocompletePlaces(query);
  }

  @UseGuards(JwtAuthGuard)
  @Get('location/places/details')
  async getPlaceDetails(@Query('placeId') placeId: string) {
    if (!placeId) throw new BadRequestException('placeId is required');
    const details = await this.geocodingService.getPlaceDetails(placeId);
    if (!details) throw new BadRequestException('Place details not found');
    return details;
  }

  @UseGuards(JwtAuthGuard)
  @Get('location/places/recent')
  async getRecentPlaces(@CurrentUser() user: { userId: string }) {
    // 1. Fetch user's successful rides (as rider)
    const rides = await this.rides.find({
      where: { riderId: user.userId, status: RideStatus.COMPLETED },
      order: { completedAt: 'DESC' },
      take: 20, // get a few to filter out duplicates
    });

    const uniqueDestinations: { title: string; subtitle: string; lat: number; lng: number }[] = [];
    const seen = new Set<string>();

    for (const ride of rides) {
      if (!ride.dropoffAddress || !ride.dropoff || !ride.dropoff.lat || !ride.dropoff.lng) continue;
      
      const parts = ride.dropoffAddress.split(',').map((p) => p.trim());
      const title = parts[0] || ride.dropoffAddress;
      const subtitle = parts.slice(1).join(', ') || 'Addis Ababa';
      const key = title.toLowerCase();

      if (!seen.has(key)) {
        seen.add(key);
        uniqueDestinations.push({
          title,
          subtitle,
          lat: ride.dropoff.lat,
          lng: ride.dropoff.lng,
        });
      }

      if (uniqueDestinations.length === 5) break;
    }

    if (uniqueDestinations.length > 0) {
      return uniqueDestinations;
    }

    // Default popular places for new users
    return [
      {
        title: 'Bole International Airport',
        subtitle: 'Bole, Addis Ababa',
        lat: 8.9778,
        lng: 38.7993,
      },
      {
        title: 'Edna Mall',
        subtitle: 'Bole, Addis Ababa',
        lat: 8.9959,
        lng: 38.7891,
      },
      {
        title: 'Meskel Square',
        subtitle: 'Kirkos, Addis Ababa',
        lat: 9.0107,
        lng: 38.7612,
      },
      {
        title: 'Friendship Park',
        subtitle: 'Arada, Addis Ababa',
        lat: 9.0227,
        lng: 38.7644,
      },
      {
        title: 'Hilton Addis Ababa',
        subtitle: 'Kirkos, Addis Ababa',
        lat: 9.0152,
        lng: 38.7656,
      },
    ];
  }
}
