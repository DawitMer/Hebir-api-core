import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { haversineKm, GeoPoint } from '../matching/geo/geo.util';

export interface TripGpsPoint {
  lat: number;
  lng: number;
  timestampMs: number;
  heading?: number | null;
  speed?: number | null;
  accuracy?: number | null;
}

export interface RouteRecordingResult {
  accepted: boolean;
  reason?: string;
  totalDistanceM: number;
  latestPoint: TripGpsPoint;
}

const ROUTE_TTL_SEC = 24 * 60 * 60; // 24 hours
const MAX_URBAN_SPEED_MPS = 42; // ~150 km/h max speed cap to filter unrealistic GPS teleportation
const MIN_DISTANCE_DELTA_METERS = 3; // Filter stationary GPS jitter
const MAX_ACCURACY_METERS = 50; // Reject very low quality fixes

@Injectable()
export class TripRouteRecorderService {
  private readonly logger = new Logger(TripRouteRecorderService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private routeKey(rideId: string): string {
    return `ride:route:${rideId}`;
  }

  private distanceKey(rideId: string): string {
    return `ride:dist:${rideId}`;
  }

  private lastFixKey(rideId: string): string {
    return `ride:lastfix:${rideId}`;
  }

  /**
   * Initializes trip route recording with the start position when the driver starts the trip.
   */
  async startRecording(
    rideId: string,
    initialPoint: TripGpsPoint,
  ): Promise<void> {
    const rKey = this.routeKey(rideId);
    const dKey = this.distanceKey(rideId);
    const lKey = this.lastFixKey(rideId);

    const pointStr = JSON.stringify(initialPoint);
    await this.redis
      .pipeline()
      .del(rKey, dKey, lKey)
      .rpush(rKey, pointStr)
      .set(dKey, '0', 'EX', ROUTE_TTL_SEC)
      .set(lKey, pointStr, 'EX', ROUTE_TTL_SEC)
      .expire(rKey, ROUTE_TTL_SEC)
      .exec();
  }

  /**
   * Validates and records a new GPS fix during active passenger transit.
   * Returns whether the point was accepted and the updated accumulated road distance.
   */
  async recordGpsPoint(
    rideId: string,
    sample: TripGpsPoint,
  ): Promise<RouteRecordingResult> {
    const lKey = this.lastFixKey(rideId);
    const dKey = this.distanceKey(rideId);
    const rKey = this.routeKey(rideId);

    // Filter accuracy
    if (sample.accuracy && sample.accuracy > MAX_ACCURACY_METERS) {
      const currentDist = await this.getAccumulatedDistance(rideId);
      return {
        accepted: false,
        reason: 'accuracy_too_poor',
        totalDistanceM: currentDist,
        latestPoint: sample,
      };
    }

    const lastFixRaw = await this.redis.get(lKey);
    let distanceDeltaM = 0;

    if (lastFixRaw) {
      try {
        const lastFix = JSON.parse(lastFixRaw) as TripGpsPoint;
        const timeDeltaSec = Math.max(
          0.1,
          (sample.timestampMs - lastFix.timestampMs) / 1000,
        );
        const distKm = haversineKm(
          { lat: lastFix.lat, lng: lastFix.lng },
          { lat: sample.lat, lng: sample.lng },
        );
        const distM = distKm * 1000;

        // Impossible jump check
        const calculatedSpeedMps = distM / timeDeltaSec;
        if (calculatedSpeedMps > MAX_URBAN_SPEED_MPS && distM > 100) {
          this.logger.warn(
            `Ride ${rideId}: GPS jump discarded (${distM.toFixed(0)}m in ${timeDeltaSec.toFixed(1)}s = ${(calculatedSpeedMps * 3.6).toFixed(0)} km/h)`,
          );
          const currentDist = await this.getAccumulatedDistance(rideId);
          return {
            accepted: false,
            reason: 'impossible_speed_jump',
            totalDistanceM: currentDist,
            latestPoint: lastFix,
          };
        }

        // Stationary jitter filter (do not increment distance for noise under 3m within short intervals)
        if (distM < MIN_DISTANCE_DELTA_METERS && timeDeltaSec < 10) {
          const currentDist = await this.getAccumulatedDistance(rideId);
          return {
            accepted: true,
            totalDistanceM: currentDist,
            latestPoint: sample,
          };
        }

        distanceDeltaM = Math.round(distM);
      } catch (err) {
        this.logger.warn(`Could not parse last fix for ride ${rideId}: ${err}`);
      }
    }

    const sampleStr = JSON.stringify(sample);
    const pipeline = this.redis.pipeline();
    pipeline.rpush(rKey, sampleStr);
    pipeline.set(lKey, sampleStr, 'EX', ROUTE_TTL_SEC);
    pipeline.expire(rKey, ROUTE_TTL_SEC);

    if (distanceDeltaM > 0) {
      pipeline.incrby(dKey, distanceDeltaM);
      pipeline.expire(dKey, ROUTE_TTL_SEC);
    }

    await pipeline.exec();
    const totalDistanceM = await this.getAccumulatedDistance(rideId);

    return {
      accepted: true,
      totalDistanceM,
      latestPoint: sample,
    };
  }

  /**
   * Retrieves the full sequence of GPS points recorded for this ride.
   */
  async getRecordedRoute(rideId: string): Promise<TripGpsPoint[]> {
    const rawList = await this.redis.lrange(this.routeKey(rideId), 0, -1);
    const points: TripGpsPoint[] = [];
    for (const item of rawList) {
      try {
        points.push(JSON.parse(item) as TripGpsPoint);
      } catch {
        // skip corrupted point
      }
    }
    return points;
  }

  /**
   * Retrieves the current accumulated actual meters for this ride.
   */
  async getAccumulatedDistance(rideId: string): Promise<number> {
    const val = await this.redis.get(this.distanceKey(rideId));
    if (!val) return 0;
    const num = parseInt(val, 10);
    return isNaN(num) ? 0 : num;
  }

  /**
   * Exports coordinates as simplified GeoPoint array `[{ lat, lng }, ...]`.
   */
  async getSimplifiedRoute(rideId: string): Promise<GeoPoint[]> {
    const points = await this.getRecordedRoute(rideId);
    if (!points.length) return [];
    return points.map((p) => ({ lat: p.lat, lng: p.lng }));
  }

  /**
   * Clears Redis keys after ride settlement.
   */
  async clearRoute(rideId: string): Promise<void> {
    await this.redis.del(
      this.routeKey(rideId),
      this.distanceKey(rideId),
      this.lastFixKey(rideId),
    );
  }
}
