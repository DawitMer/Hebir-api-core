import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  Inject,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Ride, RideStatus } from './entities/ride.entity';
import { RideStatusEvent } from './entities/ride-status-event.entity';
import { DriverProfile, DriverStatus } from './entities/driver-profile.entity';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { DispatchQueueService } from './dispatch/dispatch.queue.service';
import { clearLiveTrack } from './ride-live-track';
import { REDIS_CLIENT } from '../../redis/redis.module';
import Redis from 'ioredis';
import { PromotionsService } from '../promotions/promotions.service';
import { LocationSvcClient } from '../../common/location-svc/location-svc.client';

@Injectable()
export class AdminRidesService {
  private readonly logger = new Logger(AdminRidesService.name);

  constructor(
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    @InjectRepository(DriverProfile)
    private readonly driverProfiles: Repository<DriverProfile>,
    private readonly notifications: NotificationsGateway,
    private readonly dispatchQueue: DispatchQueueService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Optional() private readonly promotionsService?: PromotionsService,
    @Optional() private readonly locationSvc?: LocationSvcClient,
  ) {}

  async forceCancelRide(
    rideId: string,
    actorId: string,
    actorRole: string,
    reason: string,
    adminNotes?: string,
  ): Promise<Ride> {
    const result = await this.rides.manager.transaction(async (manager) => {
      // Locking the canonical row makes a force-cancel mutually exclusive with
      // start, complete, accept, and rider/driver cancellation transitions.
      const ride = await manager.findOne(Ride, {
        where: { id: rideId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!ride) throw new NotFoundException('Ride not found');

      if (
        ride.status === RideStatus.COMPLETED ||
        ride.status === RideStatus.CANCELLED ||
        ride.status === RideStatus.UNMATCHED
      ) {
        throw new ConflictException(`Ride is already ${ride.status}`);
      }

      const heldDriverId = ride.driverId ?? ride.offerDriverId;
      ride.status = RideStatus.CANCELLED;
      ride.driverId = null;
      ride.offerDriverId = null;
      ride.offerExpiresAt = null;
      ride.cancellationType = 'admin_force_cancel';
      ride.cancellationReason = reason;
      ride.cancelledBy = actorId;
      ride.cancelledByRole = actorRole;
      ride.adminNotes = adminNotes ?? null;
      const cancelledRide = await manager.save(Ride, ride);

      await manager.save(
        RideStatusEvent,
        manager.create(RideStatusEvent, {
          rideId,
          status: RideStatus.CANCELLED,
          note: `Force cancelled by ${actorRole} (${actorId}). Reason: ${reason}`,
        }),
      );

      if (heldDriverId) {
        await manager.update(
          DriverProfile,
          {
            userId: heldDriverId,
            status: In([DriverStatus.RESERVED, DriverStatus.ON_TRIP]),
          },
          { status: DriverStatus.ONLINE, idleSince: new Date() },
        );
      }

      if (this.promotionsService) {
        await this.promotionsService.refundPromotion(manager, rideId);
      }

      return { cancelledRide, heldDriverId, riderId: ride.riderId };
    });

    // Redis contains accelerators only. The transaction above is the source
    // of truth; cleanup and notification failures are logged and safe to
    // retry without mutating a terminal ride again.
    const cleanup: Array<Promise<unknown>> = [
      this.dispatchQueue.clearState(rideId),
      clearLiveTrack(this.redis, result.heldDriverId, rideId),
      // Must match RidesService START_CODE_PREFIX (`ride:startcode:`).
      this.redis.del(`ride:startcode:${rideId}`),
    ];
    if (result.heldDriverId) {
      cleanup.push(this.redis.del(`ride:offer:driver:${result.heldDriverId}`));
    }
    if (this.locationSvc?.enabled && !this.locationSvc.isOpen) {
      cleanup.push(
        this.locationSvc.post('/demand/release', { riderId: result.riderId }, 1000),
      );
    }
    const cleanupResults = await Promise.allSettled(cleanup);
    cleanupResults.forEach((cleanupResult) => {
      if (cleanupResult.status === 'rejected') {
        this.logger.error(
          `Force-cancel cache cleanup failed: ${cleanupResult.reason}`,
        );
      }
    });

    const updatedAt = new Date().toISOString();
    const payload = {
      rideId,
      reason: 'Ride was cancelled by an authorized operator.',
      updatedAt,
      status: RideStatus.CANCELLED,
      cancelledBy: 'admin',
    };
    const notifications = [
      this.notifications.notify(
        result.cancelledRide.riderId,
        'ride.cancelled',
        payload,
      ),
      this.notifications.notify(
        result.cancelledRide.riderId,
        'ride.status_changed',
        { rideId, status: RideStatus.CANCELLED, updatedAt },
      ),
    ];
    if (result.heldDriverId) {
      notifications.push(
        this.notifications.notify(result.heldDriverId, 'ride.cancelled', payload),
        this.notifications.notify(result.heldDriverId, 'ride.status_changed', {
          rideId,
          status: RideStatus.CANCELLED,
          updatedAt,
        }),
      );
    }
    const notificationResults = await Promise.allSettled(notifications);
    notificationResults.forEach((notificationResult) => {
      if (notificationResult.status === 'rejected') {
        this.logger.error(
          `Force-cancel notification failed: ${notificationResult.reason}`,
        );
      }
    });

    this.logger.warn(
      `Ride ${rideId} force cancelled by ${actorRole} ${actorId}. Reason: ${reason}`,
    );
    return result.cancelledRide;
  }
}
