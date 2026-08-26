import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, LessThanOrEqual, Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Booking, BookingStatus } from './entities/booking.entity';
import { Trip } from '../matching/entities/trip.entity';
import {
  RiderRequest,
  RiderRequestStatus,
} from '../matching/entities/rider-request.entity';
import { SelectMatchDto } from './dto/select-match.dto';
import { ConfigurationService } from '../subscription/configuration.service';
import { FareService } from '../fare/fare.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { haversineKm, zoneIdFor } from '../matching/geo/geo.util';
import { MetricsService } from '../../observability/metrics.service';
import { LocationSvcClient } from '../../common/location-svc/location-svc.client';

export type DriverDecision = 'accept' | 'decline';

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(RiderRequest)
    private readonly riderRequests: Repository<RiderRequest>,
    private readonly configuration: ConfigurationService,
    private readonly fareService: FareService,
    private readonly notifications: NotificationsGateway,
    private readonly metrics: MetricsService,
    private readonly locationSvc: LocationSvcClient,
  ) {}

  /**
   * Step 1 of the booking flow (blueprint 7.1). This is a courtesy hold:
   * nothing is deducted, and seats simply become invisible to other
   * riders in search results (matching's batched held-seat query) while it is
   * live. If it lapses unanswered, seats return automatically — no
   * manual intervention needed.
   */
  async selectMatch(riderId: string, dto: SelectMatchDto) {
    const trip = await this.trips.findOne({ where: { id: dto.tripId } });
    if (!trip || !trip.inMatchingPool) {
      throw new NotFoundException('Trip is no longer available');
    }

    const riderRequest = await this.riderRequests.findOne({
      where: { id: dto.riderRequestId, riderId },
    });
    if (!riderRequest) {
      throw new NotFoundException('Rider request not found');
    }

    const holdMinutes = this.configuration.get<number>(
      'seat_hold_duration_minutes',
    );
    const holdExpiresAt = new Date(Date.now() + holdMinutes * 60 * 1000);

    const { distanceKm, durationMinutes } = this.fareService.quotedTripMetrics(
      riderRequest.pickup,
      riderRequest.dropoff,
    );
    const fare = await this.fareService.calculate({
      distanceKm,
      durationMinutes,
      zoneId: zoneIdFor(riderRequest.pickup),
    });

    // Advisory lock per trip serializes concurrent holds: the availability
    // check and the insert are one critical section, so two riders can no
    // longer both pass the check and oversubscribe the hold pool.
    const booking = await this.bookings.manager.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [trip.id]);

      // Re-read under the lock — the pre-lock trip snapshot can be stale vs
      // concurrent confirms that already decremented remainingSeats.
      const lockedTrip = await em.findOne(Trip, {
        where: { id: trip.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedTrip || !lockedTrip.inMatchingPool) {
        throw new ConflictException('Trip is no longer available');
      }

      const heldSeats = await this.sumHeldSeats(dto.tripId, em);
      if (lockedTrip.remainingSeats - heldSeats < dto.seats) {
        throw new ConflictException('Not enough seats remain on this trip');
      }

      return em.save(
        em.create(Booking, {
          tripId: trip.id,
          riderRequestId: riderRequest.id,
          seats: dto.seats,
          agreedPricePerSeat: trip.pricePerSeat,
          calculatedFare: String(fare.total * dto.seats),
          status: BookingStatus.HELD,
          holdExpiresAt,
        }),
      );
    });

    // Driver must be alerted within 5 seconds of selection (blueprint 14).
    await this.notifications.notify(trip.driverId, 'booking.hold_created', {
      bookingId: booking.id,
      tripId: trip.id,
      seats: dto.seats,
      holdExpiresAt,
    });
    return booking;
  }

  /**
   * Step 3/4 of the booking flow. The database check here is the real
   * guarantee — it holds even if Redis is completely unavailable and no
   * holds exist at all (blueprint 7.2).
   */
  async driverRespond(
    driverId: string,
    bookingId: string,
    decision: DriverDecision,
  ) {
    const booking = await this.bookings.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');

    const trip = await this.trips.findOne({ where: { id: booking.tripId } });
    if (!trip) throw new NotFoundException('Trip not found');

    // Ownership is checked after the subscription check (enforced by
    // SubscriptionAccessGuard on the controller), never instead of it.
    if (trip.driverId !== driverId) {
      throw new ForbiddenException('You do not own this trip');
    }

    if (
      booking.status !== BookingStatus.HELD ||
      booking.holdExpiresAt <= new Date()
    ) {
      throw new ConflictException(
        'This hold has already lapsed or been resolved',
      );
    }

    if (decision === 'decline') {
      return this.decline(booking);
    }
    return this.confirm(booking, trip);
  }

  /** Participants only: the rider who holds the seat or the trip's driver. */
  async getBookingForParticipant(userId: string, bookingId: string) {
    const booking = await this.bookings.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    const [request, trip] = await Promise.all([
      this.riderRequests.findOne({ where: { id: booking.riderRequestId } }),
      this.trips.findOne({ where: { id: booking.tripId } }),
    ]);
    if (request?.riderId !== userId && trip?.driverId !== userId) {
      throw new ForbiddenException('You are not a participant on this booking');
    }
    return booking;
  }

  private async decline(booking: Booking) {
    // Conditional so a concurrent expiry/confirm is never overwritten.
    const declined = await this.bookings.update(
      { id: booking.id, status: BookingStatus.HELD },
      { status: BookingStatus.DECLINED },
    );
    if (!declined.affected) {
      throw new ConflictException(
        'This hold has already lapsed or been resolved',
      );
    }
    await this.notifyRider(booking, 'booking.declined');
    // The rider's original queuedAt is untouched — a decline never costs
    // the rider their place in the queue (blueprint 7.3).
    return (
      (await this.bookings.findOne({ where: { id: booking.id } })) ?? booking
    );
  }

  private async confirm(booking: Booking, trip: Trip) {
    // Claim + seat decrement happen in one transaction with conditional
    // WHEREs: the expiry cron can never flip a just-confirmed booking back
    // to EXPIRED, and a failed seat decrement rolls the claim back so no
    // seats leak.
    await this.bookings.manager.transaction(async (em) => {
      const claimed = await em.update(
        Booking,
        { id: booking.id, status: BookingStatus.HELD },
        { status: BookingStatus.CONFIRMED, driverConfirmed: true },
      );
      if (!claimed.affected) {
        throw new ConflictException(
          'This hold has already lapsed or been resolved',
        );
      }

      // Atomic, conditional decrement — the single guarantee that makes
      // overselling impossible, independent of the Redis hold above.
      const result = await em
        .createQueryBuilder()
        .update(Trip)
        .set({ remainingSeats: () => `"remainingSeats" - :seats` })
        .where('id = :tripId AND "remainingSeats" >= :seats', {
          tripId: trip.id,
          seats: booking.seats,
        })
        .setParameter('seats', booking.seats)
        .execute();

      if (result.affected === 0) {
        this.metrics.seatConflictTotal.inc();
        throw new ConflictException(
          'Seats were taken by another booking first',
        );
      }

      await em.update(RiderRequest, booking.riderRequestId, {
        status: RiderRequestStatus.MATCHED,
      });

      const updatedTrip = await em.findOne(Trip, { where: { id: trip.id } });
      if (updatedTrip && updatedTrip.remainingSeats <= 0) {
        // Withdraw immediately so the trip stops appearing in search
        // (blueprint 7.3) — no delay, no separate refresh needed.
        await em.update(Trip, trip.id, { inMatchingPool: false });
      }
    });

    const after = await this.bookings.findOne({ where: { id: booking.id } });
    const seatsLeft = await this.trips.findOne({
      where: { id: trip.id },
      select: { id: true, remainingSeats: true, inMatchingPool: true },
    });
    if (seatsLeft && !seatsLeft.inMatchingPool) {
      await this.removeTripFromLocationIndex(trip.id);
    }

    await this.notifyRider(booking, 'booking.confirmed');
    return after ?? booking;
  }

  private async removeTripFromLocationIndex(tripId: string): Promise<void> {
    if (!this.locationSvc.enabled || this.locationSvc.isOpen) return;
    try {
      await this.locationSvc.post('/trips/remove', { tripId }, 1000);
    } catch (error) {
      this.logger.warn(
        `Failed to remove trip ${tripId} from location-svc: ${(error as Error).message}`,
      );
    }
  }

  /** The rider must hear the driver's decision without polling. */
  private async notifyRider(booking: Booking, event: string): Promise<void> {
    try {
      const request = await this.riderRequests.findOne({
        where: { id: booking.riderRequestId },
      });
      if (!request) return;
      await this.notifications.notify(request.riderId, event, {
        bookingId: booking.id,
        tripId: booking.tripId,
        seats: booking.seats,
      });
    } catch (error) {
      this.logger.warn(
        `booking notify ${event} failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Cleans up unanswered holds. Matching already treats an expired hold
   * as "not held" via the holdExpiresAt filter, so this job is about
   * bookkeeping/notifications, not correctness.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async expireLapsedHolds() {
    // Single conditional UPDATE — cannot overwrite a booking that a driver
    // confirmed between read and write.
    const expired = await this.bookings.update(
      {
        status: BookingStatus.HELD,
        holdExpiresAt: LessThanOrEqual(new Date()),
      },
      { status: BookingStatus.EXPIRED },
    );
    if (expired.affected) {
      this.logger.log(
        `${expired.affected} booking hold(s) expired without a response`,
      );
    }
  }

  private async sumHeldSeats(
    tripId: string,
    em?: EntityManager,
  ): Promise<number> {
    const repo = em ? em.getRepository(Booking) : this.bookings;
    const held = await repo.find({
      where: { tripId, status: BookingStatus.HELD },
    });
    return held
      .filter((b) => b.holdExpiresAt > new Date())
      .reduce((sum, b) => sum + b.seats, 0);
  }

  private approximateTripDistanceKm(trip: Trip): number {
    return haversineKm(trip.startPoint, trip.destination);
  }
}
