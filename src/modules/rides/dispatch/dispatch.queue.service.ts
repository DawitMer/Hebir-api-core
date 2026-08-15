import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Interval } from '@nestjs/schedule';
import { In, MoreThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../redis/redis.module';
import { Ride, RideStatus } from '../entities/ride.entity';
import { RidesService } from '../rides.service';
import { MetricsService } from '../../../observability/metrics.service';
import {
  DISPATCH_DRAIN_LOCK,
  DISPATCH_DUE_KEY,
  DISPATCH_JOB_PREFIX,
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_POLL_MS,
  DISPATCH_REAP_LOCK,
  DISPATCH_REAP_MS,
  DISPATCH_STATE_PREFIX,
  DispatchJob,
  DispatchState,
  INITIAL_RADIUS_KM,
  MAX_DISPATCH_MS,
} from './dispatch.types';

/**
 * Redis delayed-job queue for ride dispatch.
 * Jobs survive process restarts; each tick / offer_check is one short worker unit
 * (no in-process while loops holding event-loop time for the full search window).
 */
@Injectable()
export class DispatchQueueService implements OnModuleInit {
  private readonly logger = new Logger(DispatchQueueService.name);
  private draining = false;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    @Inject(forwardRef(() => RidesService))
    private readonly ridesService: RidesService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit() {
    // Re-queue active searches after deploy / crash (DB is source of truth).
    try {
      await this.recoverOrphanedDispatches();
    } catch (error) {
      this.logger.warn(`Dispatch recovery skipped: ${error.message}`);
    }
  }

  /** Start (or restart) expanding-radius search for a ride. */
  async enqueueDispatch(rideId: string, delayMs = 0): Promise<void> {
    const state: DispatchState = {
      startedAt: Date.now(),
      radiusKm: INITIAL_RADIUS_KM,
      triedDriverIds: [],
    };
    await this.saveState(rideId, state);
    await this.scheduleJob(
      {
        id: randomUUID(),
        type: 'tick',
        rideId,
        ...state,
      },
      delayMs,
    );
  }

  /** Continue search after a decline / timeout (keeps tried drivers + radius). */
  async enqueueContinue(rideId: string, delayMs = 0): Promise<void> {
    const state = (await this.loadState(rideId)) ?? {
      startedAt: Date.now(),
      radiusKm: INITIAL_RADIUS_KM,
      triedDriverIds: [],
    };
    await this.scheduleJob(
      {
        id: randomUUID(),
        type: 'tick',
        rideId,
        ...state,
      },
      delayMs,
    );
  }

  async enqueueOfferCheck(
    rideId: string,
    offerDriverId: string,
    delayMs: number,
  ): Promise<void> {
    const state = (await this.loadState(rideId)) ?? {
      startedAt: Date.now(),
      radiusKm: INITIAL_RADIUS_KM,
      triedDriverIds: [],
    };
    await this.scheduleJob(
      {
        id: randomUUID(),
        type: 'offer_check',
        rideId,
        offerDriverId,
        ...state,
      },
      delayMs,
    );
  }

  async saveState(rideId: string, state: DispatchState): Promise<void> {
    const ttlSec = Math.ceil(MAX_DISPATCH_MS / 1000) + 120;
    await this.redis.set(
      `${DISPATCH_STATE_PREFIX}${rideId}`,
      JSON.stringify(state),
      'EX',
      ttlSec,
    );
  }

  async loadState(rideId: string): Promise<DispatchState | null> {
    const raw = await this.redis.get(`${DISPATCH_STATE_PREFIX}${rideId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DispatchState;
    } catch {
      return null;
    }
  }

  async clearState(rideId: string): Promise<void> {
    await this.redis.del(`${DISPATCH_STATE_PREFIX}${rideId}`);
  }

  private async scheduleJob(job: DispatchJob, delayMs: number): Promise<void> {
    const runAt = Date.now() + Math.max(0, delayMs);
    const ttlSec = Math.ceil(MAX_DISPATCH_MS / 1000) + 300;
    await this.redis.set(
      `${DISPATCH_JOB_PREFIX}${job.id}`,
      JSON.stringify(job),
      'EX',
      ttlSec,
    );
    await this.redis.zadd(DISPATCH_DUE_KEY, runAt, job.id);
  }

  /**
   * Multi-instance safe drain: short lock + ZREM claim per job id.
   */
  @Interval(DISPATCH_POLL_MS)
  async drainDueJobs(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drainOnce();
    } catch (error) {
      // A rejection escaping a scheduled interval is an unhandled rejection,
      // which terminates the process on Node's default settings. A Redis blip
      // must only cost us this tick.
      this.logger.error(`Dispatch drain failed: ${error.message}`);
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(): Promise<void> {
    const locked = await this.redis.set(
      DISPATCH_DRAIN_LOCK,
      '1',
      'PX',
      DISPATCH_POLL_MS,
      'NX',
    );
    if (!locked) return;

    const now = Date.now();
    const ids = await this.redis.zrangebyscore(
      DISPATCH_DUE_KEY,
      0,
      now,
      'LIMIT',
      0,
      25,
    );
    for (const jobId of ids) {
      const claimed = await this.redis.zrem(DISPATCH_DUE_KEY, jobId);
      if (claimed !== 1) continue;
      const raw = await this.redis.get(`${DISPATCH_JOB_PREFIX}${jobId}`);
      if (!raw) continue;
      let job: DispatchJob;
      try {
        job = JSON.parse(raw) as DispatchJob;
      } catch {
        await this.redis.del(`${DISPATCH_JOB_PREFIX}${jobId}`);
        continue;
      }
      try {
        await this.ridesService.processDispatchJob(job);
        this.metrics.dispatchJobsTotal.inc({
          type: job.type,
          outcome: 'ok',
        });
        await this.redis.del(`${DISPATCH_JOB_PREFIX}${jobId}`);
      } catch (error) {
        this.metrics.dispatchJobsTotal.inc({
          type: job.type,
          outcome: 'error',
        });
        this.logger.error(
          `Dispatch job ${job.type} ride=${job.rideId} failed: ${error.message}`,
          error.stack,
        );
        // Retry once shortly: the payload is only dropped after it either
        // succeeds or exhausts its attempts, so a transient failure mid-search
        // no longer abandons the ride.
        await this.retryOrDrop(jobId, job);
      }
    }
  }

  /** Re-queues a failed job a bounded number of times, then gives up. */
  private async retryOrDrop(jobId: string, job: DispatchJob): Promise<void> {
    const attempts = (job.attempts ?? 0) + 1;
    if (attempts > DISPATCH_MAX_ATTEMPTS) {
      await this.redis.del(`${DISPATCH_JOB_PREFIX}${jobId}`);
      this.logger.error(
        `Dispatch job ${job.type} ride=${job.rideId} dropped after ${attempts} attempts ` +
          `— the reap sweep will finish this ride`,
      );
      return;
    }
    await this.redis.del(`${DISPATCH_JOB_PREFIX}${jobId}`);
    await this.scheduleJob({ ...job, id: randomUUID(), attempts }, DISPATCH_POLL_MS);
  }

  /**
   * Single-instance safety-net sweep. Runs regardless of queue contents so a
   * ride whose job was lost (Redis flush, crash between write and enqueue)
   * still reaches a terminal state and its driver is freed.
   */
  @Interval(DISPATCH_REAP_MS)
  async reapStalledDispatch(): Promise<void> {
    try {
      const locked = await this.redis.set(
        DISPATCH_REAP_LOCK,
        '1',
        'PX',
        DISPATCH_REAP_MS,
        'NX',
      );
      if (!locked) return;
      await this.ridesService.reapStalledDispatch();
    } catch (error) {
      this.logger.warn(`Dispatch reap sweep failed: ${error.message}`);
    }
  }

  private async recoverOrphanedDispatches(): Promise<void> {
    const cutoff = new Date(Date.now() - MAX_DISPATCH_MS);
    const active = await this.rides.find({
      where: {
        status: In([RideStatus.SEARCHING, RideStatus.OFFERED]),
        requestedAt: MoreThan(cutoff),
      },
      take: 200,
    });
    if (active.length === 0) return;

    this.logger.log(`Recovering ${active.length} in-flight dispatch ride(s)`);
    for (const ride of active) {
      const existing = await this.loadState(ride.id);
      const state: DispatchState = existing ?? {
        startedAt: ride.requestedAt?.getTime() ?? Date.now(),
        radiusKm: INITIAL_RADIUS_KM,
        triedDriverIds: ride.offerDriverId ? [ride.offerDriverId] : [],
      };
      await this.saveState(ride.id, state);

      if (
        ride.status === RideStatus.OFFERED &&
        ride.offerDriverId &&
        ride.offerExpiresAt
      ) {
        const delay = Math.max(0, ride.offerExpiresAt.getTime() - Date.now());
        await this.enqueueOfferCheck(ride.id, ride.offerDriverId, delay || 0);
      } else {
        await this.scheduleJob(
          {
            id: randomUUID(),
            type: 'tick',
            rideId: ride.id,
            ...state,
          },
          0,
        );
      }
    }
  }
}
