import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { haversineKm, GeoPoint } from '../matching/geo/geo.util';
import { Ride, RideStatus } from './entities/ride.entity';
import { RideRouteCheckpoint } from './entities/ride-route-checkpoint.entity';

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

export function validateRouteSample(last: TripGpsPoint, sample: TripGpsPoint) {
  if (
    ![sample.lat, sample.lng, sample.timestampMs].every(Number.isFinite) ||
    Math.abs(sample.lat) > 90 ||
    Math.abs(sample.lng) > 180 ||
    (sample.accuracy != null &&
      (!Number.isFinite(sample.accuracy) || sample.accuracy < 0))
  ) {
    return { reason: 'invalid_fix', distanceM: 0 };
  }
  if (sample.timestampMs <= last.timestampMs)
    return { reason: 'out_of_order', distanceM: 0 };
  if (sample.timestampMs > Date.now() + 30_000)
    return { reason: 'future_fix', distanceM: 0 };
  if ((sample.accuracy ?? 0) > 50)
    return { reason: 'accuracy_too_poor', distanceM: 0 };
  const elapsedS = (sample.timestampMs - last.timestampMs) / 1000;
  const distanceM = Math.round(haversineKm(last, sample) * 1000);
  if (distanceM / elapsedS > 42 && distanceM > 100)
    return { reason: 'impossible_speed_jump', distanceM: 0 };
  if (distanceM < 3 && elapsedS < 10)
    return { reason: 'stationary_jitter', distanceM: 0 };
  return { distanceM, hasGap: elapsedS > 120 };
}

@Injectable()
export class TripRouteRecorderService {
  private readonly logger = new Logger(TripRouteRecorderService.name);
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectRepository(RideRouteCheckpoint)
    private readonly checkpoints: Repository<RideRouteCheckpoint>,
  ) {}

  /** ON CONFLICT leaves a concurrent/retried start's existing distance intact. */
  async startRecording(
    rideId: string,
    initialPoint: TripGpsPoint,
  ): Promise<void> {
    await this.checkpoints.manager.transaction(async (em) => {
      // All route writers lock ride -> checkpoint. Completion uses the same
      // order, preventing a late start from creating mutable metering state
      // after the ride has settled.
      const ride = await em.findOne(Ride, {
        where: { id: rideId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!ride || ride.status !== RideStatus.IN_PROGRESS) return;
      await this.ensureCheckpoint(em, rideId, initialPoint);
    });
  }

  async recordGpsPoint(
    rideId: string,
    sample: TripGpsPoint,
  ): Promise<RouteRecordingResult> {
    const result = await this.checkpoints.manager.transaction(async (em) => {
      // Lock the ride inside the same transaction as the checkpoint update.
      // A request that began before completion must re-read the status after
      // acquiring this lock and cannot append a post-settlement GPS point.
      const ride = await em.findOne(Ride, {
        where: { id: rideId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!ride || ride.status !== RideStatus.IN_PROGRESS) {
        return {
          accepted: false,
          reason: 'ride_not_in_progress',
          totalDistanceM: 0,
          latestPoint: sample,
        };
      }

      // Recovers from an API crash after starting the ride but before initialization.
      const checkpoint = await this.ensureCheckpoint(em, rideId, {
        ...ride.pickup,
        timestampMs: (ride.startedAt ?? ride.createdAt).getTime(),
      });
      const validation = validateRouteSample(checkpoint.lastFix, sample);
      if (validation.reason)
        return {
          accepted: false,
          reason: validation.reason,
          totalDistanceM: checkpoint.totalDistanceM,
          latestPoint: checkpoint.lastFix,
        };
      checkpoint.totalDistanceM += validation.distanceM;
      checkpoint.lastFix = sample;
      checkpoint.hasGaps ||= validation.hasGap ?? false;
      // Bound route payload, retaining endpoints and a decimated path for receipts.
      const lastStored = checkpoint.points[checkpoint.points.length - 1];
      if (
        !lastStored ||
        sample.timestampMs - lastStored.timestampMs >= 10_000
      ) {
        if (checkpoint.points.length >= 1000) {
          checkpoint.points = checkpoint.points.filter(
            (_, index) => index % 2 === 0,
          );
        }
        checkpoint.points.push(sample);
      }
      await em.save(checkpoint);
      return {
        accepted: true,
        totalDistanceM: checkpoint.totalDistanceM,
        latestPoint: sample,
      };
    });
    // A cache outage cannot undo a committed fare checkpoint or lose its acknowledgement.
    if (result.accepted) {
      try {
        await this.redis.set(
          `ride:dist:${rideId}`,
          String(result.totalDistanceM),
          'EX',
          86400,
        );
      } catch {
        this.logger.warn(
          `Distance cache unavailable for ride ${rideId}; PostgreSQL checkpoint retained`,
        );
      }
    }
    return result;
  }

  private async ensureCheckpoint(
    em: EntityManager,
    rideId: string,
    initialPoint: TripGpsPoint,
  ): Promise<RideRouteCheckpoint> {
    const existing = await em.findOne(RideRouteCheckpoint, {
      where: { rideId },
      lock: { mode: 'pessimistic_write' },
    });
    if (existing) return existing;
    return em.save(
      em.create(RideRouteCheckpoint, {
        rideId,
        totalDistanceM: 0,
        lastFix: initialPoint,
        points: [initialPoint],
        hasGaps: false,
      }),
    );
  }

  async getRecordedRoute(rideId: string): Promise<TripGpsPoint[]> {
    const row = await this.checkpoints.findOne({ where: { rideId } });
    if (!row) return [];
    const points = [...row.points];
    if (points[points.length - 1]?.timestampMs !== row.lastFix.timestampMs)
      points.push(row.lastFix);
    return points;
  }

  async getAccumulatedDistance(rideId: string): Promise<number> {
    return (
      (await this.checkpoints.findOne({ where: { rideId } }))?.totalDistanceM ??
      0
    );
  }

  async getSimplifiedRoute(rideId: string): Promise<GeoPoint[]> {
    return (await this.getRecordedRoute(rideId)).map(({ lat, lng }) => ({
      lat,
      lng,
    }));
  }

  /** Settlement removes caches, not the authoritative audit checkpoint. */
  async clearRoute(rideId: string): Promise<void> {
    try {
      await this.redis.del(
        `ride:route:${rideId}`,
        `ride:dist:${rideId}`,
        `ride:lastfix:${rideId}`,
      );
    } catch {
      this.logger.warn(`Route cache cleanup deferred for ${rideId}`);
    }
  }
}
