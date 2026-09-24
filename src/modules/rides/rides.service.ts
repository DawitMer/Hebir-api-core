import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  In,
  IsNull,
  LessThan,
  MoreThan,
  Not,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  isDriverKycEnforced,
  treatAsProductionRuntime,
} from '../../config/public-api-host';
import { createHash, randomInt } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { Ride, RideStatus, RideSettlementStatus } from './entities/ride.entity';
import { RideRouteCheckpoint } from './entities/ride-route-checkpoint.entity';
import { RideStatusEvent } from './entities/ride-status-event.entity';
import { RideMessage } from './entities/ride-message.entity';
import { FareRecord } from './entities/fare-record.entity';
import { Vehicle } from './entities/vehicle.entity';
import { DriverProfile, DriverStatus } from './entities/driver-profile.entity';
import {
  DriverEarning,
  EarningSourceType,
  PayoutStatus,
} from './entities/driver-earning.entity';
import { PaymentRecord, PaymentType } from './entities/payment-record.entity';
import { Tip } from '../tips/entities/tip.entity';
import {
  isMarketplaceBlocked,
  UserAccount,
  UserRole,
} from '../auth/entities/user-account.entity';
import { RequestRideDto } from './dto/request-ride.dto';
import { ListRideMessagesDto } from './dto/list-ride-messages.dto';
import { DriverInitiatedRideDto } from './dto/driver-initiated-ride.dto';
import { FareBreakdown, FareService } from '../fare/fare.service';
import { PricingVersionsService } from '../operations/pricing-versions.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { KycService } from '../kyc/kyc.service';
import { VerificationStatus } from '../kyc/entities/driver-verification.entity';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { GeoPoint } from '../matching/entities/trip.entity';
import {
  DispatchJob,
  DispatchState,
  MAX_DISPATCH_MS,
  MAX_RADIUS_KM,
  OFFER_TIMEOUT_MS,
  DISPATCH_POLL_MS,
  expandDispatchSearch,
  shouldEndEmptySearch,
} from './dispatch/dispatch.types';
import { DispatchQueueService } from './dispatch/dispatch.queue.service';
import { LocationSvcClient } from '../../common/location-svc/location-svc.client';
import { GeocodingService } from '../../common/geocoding/geocoding.service';
import { GoogleRoutesService } from '../../common/geocoding/google-routes.service';
import {
  clearLiveTrack,
  liveTrackFromRide,
  writeLiveTrack,
} from './ride-live-track';
import {
  ARRIVE_RADIUS_M,
  FARE_AT_DESTINATION_RADIUS_M,
  START_RADIUS_M,
  isWithinRadius,
  metresBetween,
} from './ride-geofence';
import { settleTripMeterDistance } from './gps-gap-settlement';
import { chooseChargedSettlement } from './settlement-policy';
import { IncidentsService } from '../incidents/incidents.service';
import {
  DRIVER_ONLY_TRANSITIONS,
  isClientRideTransitionAllowed,
} from './ride-state';
import { remainingEta } from './remaining-eta';
import {
  FARE_PAYMENT_PROVIDER,
  PaymentProvider,
} from '../payments/payment-provider';
import { hexCellsAround, haversineKm, zoneIdFor } from '../matching/geo/geo.util';

export type EnrichedRide = Omit<Ride, 'fare'> & {
  fare: FareRecord | null;
  tipAmount: number;
  /** Gross trip fare in ETB (same as fare_records.total). */
  grossFareEtb?: number | null;
  /** Cash the rider owes the driver after advertising discounts. */
  riderCashDueEtb?: number | null;
  /** Advertising discount applied to this trip (ETB). */
  advertisingDiscountEtb?: number | null;
  /** Promo-code discount applied to this trip (ETB). */
  promotionDiscountEtb?: number | null;
  /** Hebir wallet credit owed to the driver for rider discounts (ETB). */
  driverHebirCreditEtb?: number | null;
  driver: {
    fullName: string | null;
    username: string | null;
    phoneNumber?: string | null;
    rating: number;
    /** Signed / HMAC selfie URL from KYC. Null when the driver has no photo. */
    photoUrl?: string | null;
  } | null;
  vehicle: {
    make: string;
    model: string;
    makeModel: string;
    plate: string;
    color: string | null;
    capacity: number;
  } | null;
  /** Present only for the rider while a start-code gate is active. */
  startCode?: string | null;
  requiresStartCode?: boolean;
  /** Guest street-hail metadata for the driver UI (never include plaintext code). */
  isGuest?: boolean;
  smsDelivery?: 'sent' | 'failed';
  smsError?: string;
};

/** The exact server-calculated quote shown to both rider and driver. */
type FareQuotePayload = Pick<
  FareBreakdown,
  | 'total'
  | 'initialFee'
  | 'distanceCharge'
  | 'timeCharge'
  | 'waitCharge'
  | 'vehicleMultiplier'
  | 'surgeMultiplier'
  | 'platformFee'
>;

export type RequestedRide = Ride & { estimatedFare: FareQuotePayload };

type OfferOutcome = 'accepted' | 'declined' | 'timeout' | 'stale';

export type RideViewer = { userId: string; roles?: UserRole[] };

/** GPS samples older than this are not trustworthy for dispatch fallback. */
const STALE_LOCATION_SECONDS = 600;

/** Cap on the degraded (Postgres) candidate scan. */
const FALLBACK_CANDIDATE_LIMIT = 200;

/** Grace added to the offer window before a reaper treats it as abandoned. */
const REAP_GRACE_MS = 10_000;

/** Rows the reaper touches per sweep. */
const REAP_BATCH_SIZE = 100;

/**
 * MATCHED is a brief accept-window status. If accept crashes after claiming
 * MATCHED but before ACCEPTED, the ride and driver would otherwise sit forever.
 */
const STALE_MATCHED_MS = 120_000;

/** Hard cap on any ride list page. */
const MAX_RIDE_PAGE = 100;

/**
 * Street-hail phone lookup is only allowed when the driver is already next to
 * the rider (within this radius). Far-away lookups are rejected so drivers
 * cannot fish for accounts by phone from elsewhere.
 */
const STREET_HAIL_MAX_DISTANCE_KM = 0.3;

/** Redis key for a rider's last GPS ping (see POST /riders/location). */
const riderLocKey = (riderId: string) => `rider:loc:${riderId}`;

/** Candidate ids come from Redis, not the database — validate before querying. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A rider may only have one ride in these states at a time. */
const ACTIVE_RIDE_STATUSES = [
  RideStatus.REQUESTED,
  RideStatus.SEARCHING,
  RideStatus.OFFERED,
  RideStatus.MATCHED,
  RideStatus.ACCEPTED,
  RideStatus.ARRIVING,
  RideStatus.IN_PROGRESS,
];

/** Driver is assigned and the trip has not finished or cancelled. */
const LIVE_DRIVER_TRIP_STATUSES = [
  RideStatus.MATCHED,
  RideStatus.ACCEPTED,
  RideStatus.ARRIVING,
  RideStatus.IN_PROGRESS,
];

/** Privacy start-code for driver-initiated (street-hail) rides. */
const START_CODE_PREFIX = 'ride:startcode:';
/** Registered riders keep the code on-screen for the pickup wait. */
const START_CODE_TTL_SEC = 2 * 60 * 60;
/** Guest SMS codes match the SMS copy (5 minutes). */
const GUEST_START_CODE_TTL_SEC = 5 * 60;
const START_CODE_MAX_ATTEMPTS = 8;
const GUEST_START_SMS_RESEND_COOLDOWN_SEC = 30;
const GUEST_START_SMS_MAX_PER_HOUR = 8;

type StartCodeRecord = {
  hash: string;
  plain: string;
  attempts: number;
};

import { TripRouteRecorderService } from './trip-route-recorder.service';
import { AdRewardsService } from '../ads/ads.service';
import { PromotionsService } from '../promotions/promotions.service';
import { SmsService } from '../auth/sms.service';
import {
  formatKm,
  formatPaymentStatusLabel,
  guestFareCompleteSms,
  guestStartCodeSms,
  guestTripStartedSms,
  placeLabel,
  shortTripRef,
} from './guest-street-hail.sms';

type DispatchQueue = Pick<
  DispatchQueueService,
  | 'clearState'
  | 'enqueueContinue'
  | 'enqueueDispatch'
  | 'enqueueOfferCheck'
  | 'loadState'
  | 'saveState'
>;

@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

  constructor(
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    @InjectRepository(RideStatusEvent)
    private readonly rideStatusEvents: Repository<RideStatusEvent>,
    @InjectRepository(RideMessage)
    private readonly rideMessages: Repository<RideMessage>,
    @InjectRepository(FareRecord)
    private readonly fares: Repository<FareRecord>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Tip) private readonly tips: Repository<Tip>,
    @InjectRepository(UserAccount)
    private readonly users: Repository<UserAccount>,
    @InjectRepository(DriverProfile)
    private readonly driverProfiles: Repository<DriverProfile>,
    @InjectRepository(DriverEarning)
    private readonly driverEarnings: Repository<DriverEarning>,
    @InjectRepository(PaymentRecord)
    private readonly payments: Repository<PaymentRecord>,
    private readonly fareService: FareService,
    private readonly pricingVersions: PricingVersionsService,
    private readonly subscriptionService: SubscriptionService,
    private readonly kycService: KycService,
    private readonly notifications: NotificationsGateway,
    private readonly config: ConfigService,
    private readonly locationSvc: LocationSvcClient,
    private readonly geocoding: GeocodingService,
    private readonly googleRoutes: GoogleRoutesService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(forwardRef(() => DispatchQueueService))
    private readonly dispatchQueue: DispatchQueue,
    @Inject(FARE_PAYMENT_PROVIDER)
    private readonly farePayments: PaymentProvider,
    private readonly routeRecorder: TripRouteRecorderService,
    private readonly sms: SmsService,
    @Optional()
    private readonly adRewards?: AdRewardsService,
    @Optional()
    private readonly promotionsService?: PromotionsService,
    @Optional()
    private readonly incidentsService?: IncidentsService,
  ) {}

  /** Locked category multipliers for a ride's pricing version (ops-configurable). */
  private async vehicleMultipliersForRide(
    ride: Pick<Ride, 'pricingVersionId'>,
  ): Promise<Record<string, number> | null> {
    if (!ride.pricingVersionId) return null;
    try {
      const version = await this.pricingVersions.get(ride.pricingVersionId);
      return version.vehicleMultipliers ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Entry point for a rider requesting an on-demand ride. The ride is
   * persisted as `searching` immediately, then dispatch is enqueued on the
   * Redis worker queue (resumable; no in-process while loop).
   */
  async requestRide(
    riderId: string,
    dto: RequestRideDto,
  ): Promise<RequestedRide> {
    // One live ride per rider: without this a client retry storm creates a
    // ride per tap, and each one reserves a different driver.
    const active = await this.rides.findOne({
      where: { riderId, status: In(ACTIVE_RIDE_STATUSES) },
      order: { createdAt: 'DESC' },
    });
    if (active) {
      throw new ConflictException(
        `You already have a ride in progress (${active.status})`,
      );
    }

    // Addresses are derived from the coordinates rather than trusted from the
    // client, so the stored address always matches where the pin actually is.
    const { pickupAddress, dropoffAddress } =
      await this.geocoding.reverseGeocodePair(dto.pickup, dto.dropoff);

    const waypoints = this.normalizeWaypoints(dto.waypoints);

    const vehicleType = normalizeRideVehicleType(dto.vehicleType);
    const { distanceKm, durationMinutes } = this.fareService.quotedTripMetrics(
      dto.pickup,
      dto.dropoff,
      dto.distanceKm,
      dto.durationMinutes,
    );

    // Lock active pricing version + surge at request so quote, offer, and
    // final charge stay auditable even after Operations publishes new rates.
    const { rates: lockedRates, version: pricingVersion } =
      await this.pricingVersions.getActiveRates();
    const quotedFare = await this.fareService.calculate(
      {
        distanceKm,
        durationMinutes,
        zoneId: zoneIdFor(dto.pickup),
        vehicleType,
        vehicleMultipliers: pricingVersion?.vehicleMultipliers ?? null,
      },
      lockedRates,
    );

    let ride: Ride;
    try {
      ride = await this.rides.save(
        this.rides.create({
          riderId,
          pickup: dto.pickup,
          dropoff: dto.dropoff,
          waypoints: waypoints.length > 0 ? waypoints : null,
          pickupAddress: pickupAddress || dto.pickupAddress || null,
          dropoffAddress: dropoffAddress || dto.dropoffAddress || null,
          vehicleType,
          distanceM: Math.round(distanceKm * 1000),
          durationS: Math.round(durationMinutes * 60),
          quotedSurgeMultiplier: quotedFare.surgeMultiplier,
          quotedFareRates: quotedFare.rates,
          pricingVersionId: pricingVersion?.id ?? null,
          pricingVersion: pricingVersion?.versionLabel ?? pricingVersion?.id ?? null,
          status: RideStatus.SEARCHING,
          requestedAt: new Date(),
        }),
      );
    } catch (error) {
      // UQ_rides_one_active_per_rider — concurrent taps both passed the SELECT.
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('You already have a ride in progress');
      }
      throw error;
    }
    await this.logEvent(
      ride.id,
      RideStatus.SEARCHING,
      'Ride requested; dispatch starting',
    );
    this.logger.log(`Ride ${ride.id}: requested by rider ${riderId}`);
    this.recordOnDemandRequest(dto.pickup, riderId);

    try {
      await this.dispatchQueue.enqueueDispatch(ride.id);
    } catch (error) {
      // The queue lives in Redis. If it is unreachable the ride would sit in
      // `searching` with nothing scheduled to ever move it, so close it out
      // here and tell the rider instead of leaving a phantom search.
      this.logger.error(
        `Ride ${ride.id}: could not enqueue dispatch: ${(error as Error).message}`,
      );
      await this.markUnmatched(ride.id);
      throw new ServiceUnavailableException(
        'Dispatch is temporarily unavailable — please try again',
      );
    }
    // The client must render this persisted quote, not its pre-request
    // estimate. It is derived from the same locked surge and rate snapshot
    // used in the driver offer and final settlement.
    return { ...ride, estimatedFare: this.fareQuotePayload(quotedFare) };
  }

  /** Worker entry: one short tick or offer_check (no blocking while loops). */
  async processDispatchJob(job: DispatchJob): Promise<void> {
    if (job.type === 'offer_check') {
      await this.dispatchOfferCheck(job);
      return;
    }
    await this.dispatchTick(job);
  }

  /**
   * One expanding-hex-ring search step: offer to the next eligible driver or
   * expand the H3 ring / finish unmatched. Schedules the next Redis job and returns.
   */
  private async dispatchTick(job: DispatchJob): Promise<void> {
    const { rideId } = job;
    const elapsed = Date.now() - job.startedAt;
    if (elapsed >= MAX_DISPATCH_MS) {
      await this.markUnmatched(rideId);
      await this.dispatchQueue.clearState(rideId);
      return;
    }

    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) {
      await this.dispatchQueue.clearState(rideId);
      return;
    }
    if (ride.status === RideStatus.OFFERED) {
      // Offer already live — wait for offer_check / driver response.
      return;
    }
    if (ride.status !== RideStatus.SEARCHING) {
      // Cancelled, unmatched, matched, or any post-match state: a stale tick
      // must never revive the ride into OFFERED.
      await this.dispatchQueue.clearState(rideId);
      this.logger.log(`Dispatch ${rideId}: stopped — ride is ${ride.status}`);
      return;
    }

    const triedDriverIds = new Set(job.triedDriverIds);
    let hexRing = typeof job.hexRing === 'number' ? job.hexRing : 0;
    let radiusKm = job.radiusKm;

    const nearby = await this.findNearbyDrivers(ride.pickup, radiusKm, hexRing);
    let candidateIds = nearby.driverIds;
    let source = nearby.source;
    let eligible = await this.filterEligibleDrivers(
      candidateIds,
      triedDriverIds,
      ride.vehicleType,
    );

    // Geo can return stale/offline/unsubscribed members. If none survive the
    // eligibility filter, fall back to Postgres history instead of expanding
    // radius on the same polluted set.
    if (
      eligible.length === 0 &&
      (source === 'location-svc' || source === 'location-svc-hex') &&
      candidateIds.length > 0
    ) {
      const fallbackIds = await this.nearbyDriverIdsFromHistory(
        ride.pickup,
        radiusKm,
      );
      if (fallbackIds.length > 0) {
        candidateIds = fallbackIds;
        source = 'db-fallback';
        eligible = await this.filterEligibleDrivers(
          candidateIds,
          triedDriverIds,
          ride.vehicleType,
        );
        this.logger.warn(
          `Dispatch ${rideId}: location-svc candidates all ineligible; ` +
            `db-fallback yielded ${eligible.length} eligible`,
        );
      }
    }
    const ranked = await this.rankCandidatesByPickupEta(
      eligible,
      candidateIds,
      ride.pickup,
    );

    this.logger.log(
      `Dispatch ${rideId}: hexRing=${hexRing} radius=${radiusKm}km source=${source} ` +
        `nearby=${candidateIds.length} eligible=${ranked.length}`,
    );

    for (const candidate of ranked) {
      triedDriverIds.add(candidate.userId);

      const locked = await this.tryLockDriver(
        candidate.userId,
        rideId,
        OFFER_TIMEOUT_MS + 5_000,
      );
      if (!locked) continue;

      const state: DispatchState = {
        startedAt: job.startedAt,
        hexRing,
        radiusKm,
        triedDriverIds: [...triedDriverIds],
      };
      await this.dispatchQueue.saveState(rideId, state);

      const offerResult = await this.beginOfferToDriver(
        rideId,
        candidate.userId,
      );
      if (offerResult === 'busy') {
        // Stale Redis lock / driver left ONLINE between eligibility and
        // reserve — keep searching; do not clear dispatch state.
        continue;
      }
      if (offerResult === 'gone') {
        // Ride left searching (cancel / match) between the read above and
        // the offer write — drop the reservation and stop.
        await this.releaseOfferedDriver(candidate.userId, rideId);
        await this.dispatchQueue.clearState(rideId);
        return;
      }
      await this.dispatchQueue.enqueueOfferCheck(
        rideId,
        candidate.userId,
        OFFER_TIMEOUT_MS,
      );
      return;
    }

    // No offer this tick — expand one H3 ring, or end the attempt at the cap
    // so the rider sees Retry instead of waiting the full 6 minutes in an
    // empty city / exhausted local pool.
    if (shouldEndEmptySearch(radiusKm, hexRing)) {
      this.logger.log(
        `Dispatch ${rideId}: no eligible drivers at max hex ring ${hexRing} ` +
          `(~${MAX_RADIUS_KM}km) — unmatched`,
      );
      await this.markUnmatched(rideId);
      await this.dispatchQueue.clearState(rideId);
      return;
    }

    const expanded = expandDispatchSearch({
      startedAt: job.startedAt,
      hexRing,
      radiusKm,
      triedDriverIds: [...triedDriverIds],
    });
    await this.dispatchQueue.saveState(rideId, expanded);
    this.logger.log(
      `Dispatch ${rideId}: no eligible drivers, expanding hex ring ` +
        `${hexRing} → ${expanded.hexRing} (radius ${expanded.radiusKm}km)`,
    );
    // Keep live demand fresh while the rider is still searching (5 min TTL).
    this.recordOnDemandRequest(ride.pickup, ride.riderId);
    await this.dispatchQueue.enqueueContinue(rideId, DISPATCH_POLL_MS);
  }

  /**
   * Resolves a timed-out offer without polling: if still OFFERED to this
   * driver, release and continue the search.
   */
  private async dispatchOfferCheck(job: DispatchJob): Promise<void> {
    const { rideId, offerDriverId } = job;
    if (!offerDriverId) {
      await this.dispatchQueue.enqueueContinue(rideId, 0);
      return;
    }

    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) {
      await this.releaseOfferedDriver(offerDriverId, rideId);
      await this.dispatchQueue.clearState(rideId);
      return;
    }

    if (
      ride.status === RideStatus.MATCHED ||
      ride.status === RideStatus.ACCEPTED ||
      ride.status === RideStatus.COMPLETED
    ) {
      await this.releaseDriverLock(offerDriverId, rideId);
      await this.dispatchQueue.clearState(rideId);
      return;
    }

    if (ride.status === RideStatus.CANCELLED) {
      await this.releaseOfferedDriver(offerDriverId, rideId);
      await this.dispatchQueue.clearState(rideId);
      return;
    }

    // Still offered to this driver → treat as timeout and continue.
    if (
      ride.status === RideStatus.OFFERED &&
      ride.offerDriverId === offerDriverId
    ) {
      await this.finishFailedOffer(rideId, offerDriverId, 'timeout');
      return;
    }

    // Declined or already moved on — ensure we keep searching if needed.
    await this.releaseOfferedDriver(offerDriverId, rideId);
    if (ride.status === RideStatus.SEARCHING) {
      const state = await this.dispatchQueue.loadState(rideId);
      if (state && !state.triedDriverIds.includes(offerDriverId)) {
        state.triedDriverIds.push(offerDriverId);
        await this.dispatchQueue.saveState(rideId, state);
      }
      await this.dispatchQueue.enqueueContinue(rideId, 0);
    }
  }

  /**
   * Persist offer + notify; does not wait for acceptance.
   * - `offered`: ride + driver reserved; caller schedules offer_check
   * - `busy`: driver was not ONLINE (stale lock); ride rolled back to searching
   * - `gone`: ride left searching first; caller must release the lock
   */
  private async beginOfferToDriver(
    rideId: string,
    driverId: string,
  ): Promise<'offered' | 'busy' | 'gone'> {
    const offerExpiresAt = new Date(Date.now() + OFFER_TIMEOUT_MS);

    const offered = await this.rides.update(
      { id: rideId, status: RideStatus.SEARCHING },
      {
        offerDriverId: driverId,
        offerExpiresAt,
        status: RideStatus.OFFERED,
      },
    );
    if (!offered.affected) return 'gone';

    // Reserved only after the ride row is committed, and only from ONLINE so
    // we never overwrite an on_trip / reserved profile from a stale lock.
    const reserved = await this.driverProfiles.update(
      { userId: driverId, status: DriverStatus.ONLINE },
      { status: DriverStatus.RESERVED },
    );
    if (!reserved.affected) {
      await this.rides.update(
        { id: rideId, status: RideStatus.OFFERED, offerDriverId: driverId },
        {
          status: RideStatus.SEARCHING,
          offerDriverId: null,
          offerExpiresAt: null,
        },
      );
      await this.releaseDriverLock(driverId, rideId);
      return 'busy';
    }
    await this.logEvent(
      rideId,
      RideStatus.OFFERED,
      `Offered to driver ${driverId}`,
    );

    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (ride) {
      await this.notify(
        driverId,
        'ride.offer',
        await this.buildOfferPayload(ride),
      );
      await this.notify(ride.riderId, 'ride.status_changed', {
        rideId,
        status: RideStatus.OFFERED,
      });
    }
    return 'offered';
  }

  private async finishFailedOffer(
    rideId: string,
    driverId: string,
    outcome: OfferOutcome,
  ): Promise<void> {
    // Claim the row back first; only the winner of that UPDATE may touch the
    // driver, otherwise a simultaneous accept would be undone here.
    const released = await this.rides.update(
      { id: rideId, status: RideStatus.OFFERED, offerDriverId: driverId },
      {
        status: RideStatus.SEARCHING,
        offerDriverId: null,
        offerExpiresAt: null,
      },
    );
    if (!released.affected) {
      const current = await this.rides.findOne({ where: { id: rideId } });
      if (
        !current ||
        current.status === RideStatus.CANCELLED ||
        current.status === RideStatus.MATCHED ||
        current.status === RideStatus.ACCEPTED ||
        current.status === RideStatus.COMPLETED
      ) {
        await this.dispatchQueue.clearState(rideId);
        return;
      }
      // Still searching (someone else already resolved this offer) — the
      // continue below keeps the search alive.
      await this.releaseOfferedDriver(driverId, rideId);
      await this.dispatchQueue.enqueueContinue(rideId, 0);
      return;
    }

    await this.releaseOfferedDriver(driverId, rideId);
    await this.logEvent(
      rideId,
      RideStatus.SEARCHING,
      `Driver ${driverId} did not accept (${outcome}); trying next candidate`,
    );
    this.logger.log(
      `Dispatch ${rideId}: driver ${driverId} outcome=${outcome}, continuing`,
    );
    const searching = await this.rides.findOne({ where: { id: rideId } });
    if (searching?.status === RideStatus.SEARCHING) {
      await this.notify(searching.riderId, 'ride.status_changed', {
        rideId,
        status: RideStatus.SEARCHING,
        reason: outcome,
      });
      // Tell the timed-out driver to drop the offer sheet immediately.
      await this.notify(driverId, 'ride.status_changed', {
        rideId,
        status: RideStatus.SEARCHING,
        reason: outcome,
      });
    }

    const state = await this.dispatchQueue.loadState(rideId);
    if (state && !state.triedDriverIds.includes(driverId)) {
      state.triedDriverIds.push(driverId);
      await this.dispatchQueue.saveState(rideId, state);
    }

    if (Date.now() - (state?.startedAt ?? Date.now()) >= MAX_DISPATCH_MS) {
      await this.markUnmatched(rideId);
      await this.dispatchQueue.clearState(rideId);
      return;
    }

    await this.dispatchQueue.enqueueContinue(rideId, 0);
  }

  /**
   * Driver accepts a live offer. Validates ownership + expiry, then moves
   * the ride matched -> accepted and puts the driver on_trip.
   *
   * Cancel can land between the MATCHED claim and the ACCEPTED write (e.g.
   * during reverse-geocode). Every step after the claim is conditional and
   * rolls the driver back to online when the ride is no longer ours.
   */
  async acceptOffer(driverId: string, rideId: string): Promise<EnrichedRide> {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');

    if (ride.offerDriverId !== driverId || ride.status !== RideStatus.OFFERED) {
      throw new ConflictException('This ride is not currently offered to you');
    }
    await this.assertDriverMayWork(driverId);
    if (!(await this.subscriptionService.mayAccessMarketplace(driverId))) {
      try {
        await this.declineOffer(driverId, rideId);
      } catch {
        // Offer may have expired while the paywall check ran.
      }
      throw new ForbiddenException(
        'Active subscription required to accept trips',
      );
    }
    if (!ride.offerExpiresAt || ride.offerExpiresAt.getTime() <= Date.now()) {
      throw new ConflictException('This offer has expired');
    }

    // Single conditional UPDATE decides the winner: a concurrent accept, a
    // timeout sweep or a cancel can no longer half-apply on top of each other.
    const claimed = await this.rides.update(
      {
        id: rideId,
        status: RideStatus.OFFERED,
        offerDriverId: driverId,
        offerExpiresAt: MoreThan(new Date()),
      },
      {
        status: RideStatus.MATCHED,
        driverId,
        matchedAt: new Date(),
        offerDriverId: null,
        offerExpiresAt: null,
      },
    );
    if (!claimed.affected) {
      throw new ConflictException('This ride is no longer offered to you');
    }
    await this.logEvent(
      rideId,
      RideStatus.MATCHED,
      `Driver ${driverId} accepted offer`,
    );

    // Transition the driver to on_trip from RESERVED (or ONLINE).
    const onTrip = await this.driverProfiles.update(
      {
        userId: driverId,
        status: In([DriverStatus.RESERVED, DriverStatus.ONLINE]),
      },
      { status: DriverStatus.ON_TRIP },
    );
    if (!onTrip.affected) {
      await this.abortAcceptAfterCancel(rideId, driverId);
      throw new ConflictException('Ride was cancelled during accept');
    }
    await this.invalidateDriverStatusCache(driverId);
    await this.dispatchQueue.clearState(rideId);
    this.releaseOnDemandRequest(ride.riderId);

    // Refresh both addresses at acceptance so the confirmed ride carries a
    // current, coordinate-accurate pickup for the driver to navigate to.
    const { pickupAddress, dropoffAddress } =
      await this.geocoding.reverseGeocodePair(ride.pickup, ride.dropoff);

    const confirmed = await this.rides.update(
      { id: rideId, status: RideStatus.MATCHED, driverId },
      {
        status: RideStatus.ACCEPTED,
        pickupAddress: pickupAddress || ride.pickupAddress,
        dropoffAddress: dropoffAddress || ride.dropoffAddress,
      },
    );
    if (!confirmed.affected) {
      // Cancel won during geocode — do not leave the driver on_trip.
      await this.driverProfiles.update(
        { userId: driverId, status: DriverStatus.ON_TRIP },
        { status: DriverStatus.ONLINE, idleSince: new Date() },
      );
      await this.releaseDriverLock(driverId, rideId);
      throw new ConflictException('Ride was cancelled during accept');
    }

    const accepted =
      (await this.rides.findOne({ where: { id: rideId } })) ?? ride;
    await this.logEvent(
      rideId,
      RideStatus.ACCEPTED,
      `Ride confirmed with driver ${driverId} — pickup: ${accepted.pickupAddress}`,
    );

    const [enriched] = await this.enrichRides([accepted]);
    await writeLiveTrack(this.redis, driverId, liveTrackFromRide(accepted));
    const acceptedAt = new Date().toISOString();
    await this.notify(accepted.riderId, 'ride.matched', {
      rideId,
      driverId,
      pickupAddress: accepted.pickupAddress,
      dropoffAddress: accepted.dropoffAddress,
      driver: enriched.driver,
      vehicle: enriched.vehicle,
      updatedAt: acceptedAt,
      status: RideStatus.ACCEPTED,
    });
    await this.notify(accepted.riderId, 'ride.status_changed', {
      rideId,
      status: RideStatus.ACCEPTED,
      updatedAt: acceptedAt,
      previousStatus: RideStatus.MATCHED,
    });

    await this.releaseDriverLock(driverId, rideId);

    this.logger.log(
      `Ride ${rideId}: accepted by driver ${driverId} (matched -> accepted)`,
    );
    return enriched;
  }

  /**
   * Accept claimed MATCHED but the driver was already freed — usually a
   * cancel that won the profile row. Clear a leftover MATCHED row if we
   * still own it so the rider is not stuck with a phantom match.
   */
  private async abortAcceptAfterCancel(
    rideId: string,
    driverId: string,
  ): Promise<void> {
    const aborted = await this.rides.update(
      { id: rideId, status: RideStatus.MATCHED, driverId },
      {
        status: RideStatus.CANCELLED,
        driverId: null,
        offerDriverId: null,
        offerExpiresAt: null,
      },
    );
    await this.dispatchQueue.clearState(rideId);
    await this.releaseDriverLock(driverId, rideId);
    if (aborted.affected) {
      await this.logEvent(
        rideId,
        RideStatus.CANCELLED,
        'Accept aborted: driver was freed by a concurrent cancel',
      );
      const ride = await this.rides.findOne({ where: { id: rideId } });
      if (ride) {
        // The rider saw "matched" for a moment — tell them it fell through.
        await this.notify(ride.riderId, 'ride.cancelled', {
          rideId,
          reason: 'Driver became unavailable during matching',
        });
      }
    }
  }

  /** Driver declines a live offer; ride returns to searching and driver goes back online. */
  async declineOffer(driverId: string, rideId: string): Promise<Ride> {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');

    if (ride.offerDriverId !== driverId) {
      throw new ConflictException('This ride is not currently offered to you');
    }

    const released = await this.rides.update(
      { id: rideId, status: RideStatus.OFFERED, offerDriverId: driverId },
      {
        status: RideStatus.SEARCHING,
        offerDriverId: null,
        offerExpiresAt: null,
      },
    );
    if (!released.affected) {
      throw new ConflictException('This ride is no longer offered to you');
    }
    await this.logEvent(
      rideId,
      RideStatus.SEARCHING,
      `Driver ${driverId} declined offer`,
    );

    await this.releaseOfferedDriver(driverId, rideId);

    const searching = await this.rides.findOne({ where: { id: rideId } });
    if (searching) {
      await this.notify(searching.riderId, 'ride.status_changed', {
        rideId,
        status: RideStatus.SEARCHING,
        reason: 'declined',
      });
    }

    const state = await this.dispatchQueue.loadState(rideId);
    if (state && !state.triedDriverIds.includes(driverId)) {
      state.triedDriverIds.push(driverId);
      await this.dispatchQueue.saveState(rideId, state);
    }
    await this.dispatchQueue.enqueueContinue(rideId, 0);

    this.logger.log(`Ride ${rideId}: declined by driver ${driverId}`);
    return (await this.rides.findOne({ where: { id: rideId } })) ?? ride;
  }

  /**
   * Generic state-machine transition for statuses the state machine
   * doesn't route to a dedicated method. `cancelled` is delegated to
   * cancelRide() so the driver-release side effects always happen.
   */
  async transitionStatus(
    rideId: string,
    actorId: string,
    nextStatus: RideStatus,
    note?: string,
  ): Promise<Ride> {
    if (nextStatus === RideStatus.CANCELLED) {
      return this.cancelRide(rideId, actorId, note);
    }

    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');

    if (ride.riderId !== actorId && ride.driverId !== actorId) {
      throw new ForbiddenException('You are not a participant on this ride');
    }

    if (ride.status === nextStatus) {
      return ride;
    }

    if (!isClientRideTransitionAllowed(ride.status, nextStatus)) {
      throw new ConflictException(
        `Cannot transition ride from ${ride.status} to ${nextStatus}`,
      );
    }
    if (DRIVER_ONLY_TRANSITIONS.has(nextStatus) && ride.driverId !== actorId) {
      throw new ForbiddenException(
        `Only the assigned driver can move a ride to ${nextStatus}`,
      );
    }

    if (nextStatus === RideStatus.ARRIVING && ride.driverId) {
      await this.assertDriverWithin(
        ride.driverId,
        ride.pickup,
        ARRIVE_RADIUS_M,
        'mark arrived',
        'pickup',
      );
    }
    if (nextStatus === RideStatus.IN_PROGRESS && ride.driverId) {
      await this.assertDriverWithin(
        ride.driverId,
        ride.pickup,
        START_RADIUS_M,
        'start the trip',
        'pickup',
      );
    }

    // Driver-initiated trips require POST /rides/:id/start with the rider's code.
    // The gate is the ride row (Postgres), not Redis — a cache flush must not
    // let the driver PATCH past the PIN.
    if (
      nextStatus === RideStatus.IN_PROGRESS &&
      this.rideHasStartCodeGate(ride)
    ) {
      throw new ForbiddenException(
        'Enter the rider security code to start this trip',
      );
    }

    const previousStatus = ride.status;
    const patch: Partial<Ride> = { status: nextStatus };
    if (nextStatus === RideStatus.ARRIVING && !ride.arrivedAt) {
      patch.arrivedAt = new Date();
    }
    if (nextStatus === RideStatus.IN_PROGRESS && !ride.startedAt) {
      patch.startedAt = new Date();
    }
    // Guarding on the status we validated makes the transition table
    // authoritative even when two clients patch the same ride at once.
    const moved = await this.rides.update(
      { id: rideId, status: previousStatus },
      patch,
    );
    if (!moved.affected) {
      const current = await this.rides.findOne({ where: { id: rideId } });
      if (current?.status === nextStatus) {
        return current;
      }
      throw new ConflictException(
        `Ride changed state concurrently; retry from ${nextStatus === RideStatus.IN_PROGRESS ? 'arriving' : previousStatus}`,
      );
    }
    if (patch.startedAt) {
      const liveStart =
        ride.driverId != null
          ? await this.readLiveDriverPoint(ride.driverId)
          : null;
      const startPoint = liveStart ?? ride.pickup;
      await this.routeRecorder.startRecording(rideId, {
        ...startPoint,
        timestampMs: patch.startedAt.getTime(),
      });
    }
    await this.logEvent(rideId, nextStatus, `Transitioned by ${actorId}`);

    const counterpartId =
      actorId === ride.riderId ? ride.driverId : ride.riderId;
    const statusPayload = {
      rideId,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
      previousStatus,
    };
    // Notify both participants so reconnecting clients reconcile the same
    // authoritative transition (not only the counterpart).
    const recipients = new Set(
      [counterpartId, ride.riderId, ride.driverId].filter(
        (id): id is string => !!id,
      ),
    );
    for (const userId of recipients) {
      await this.notify(userId, 'ride.status_changed', statusPayload);
    }

    this.logger.log(
      `Ride ${rideId}: ${previousStatus} -> ${nextStatus} (by ${actorId})`,
    );
    const updated =
      (await this.rides.findOne({ where: { id: rideId } })) ?? ride;
    if (updated.driverId) {
      await writeLiveTrack(
        this.redis,
        updated.driverId,
        liveTrackFromRide(updated),
      );
    }
    return updated;
  }

  /**
   * Driver marks the ride finished. Computes the fare (platformFee is
   * always zero under the current business model), records the payment
   * (Direct Charge pattern, applicationFeeAmount=0) and the driver's
   * earning, and frees the driver back to online.
   */
  async completeRide(rideId: string, driverId: string): Promise<Ride> {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');
    if (ride.driverId !== driverId) {
      throw new ForbiddenException('You are not the driver on this ride');
    }
    // Idempotent: End Trip can be tapped twice / resumed after a success.
    if (ride.status === RideStatus.COMPLETED) {
      return ride;
    }
    if (ride.status !== RideStatus.IN_PROGRESS) {
      throw new ConflictException(
        `Ride must be in_progress to complete (current status: ${ride.status})`,
      );
    }

    // Status flip + fare + payment + earning + driver release are atomic:
    // a mid-flight failure rolls the ride back to in_progress so the driver
    // can simply retry completion. Locking ride -> route checkpoint matches
    // GPS ingestion's lock order, freezing one route snapshot before pricing.
    const settlement: any = await this.rides.manager.transaction(async (em) => {
      const lockedRide = await em.findOne(Ride, {
        where: { id: rideId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedRide) throw new NotFoundException('Ride not found');
      if (lockedRide.driverId !== driverId) {
        throw new ForbiddenException('You are not the driver on this ride');
      }
      if (lockedRide.status === RideStatus.COMPLETED) {
        const existingFare = await em.findOne(FareRecord, {
          where: { rideId },
        });
        return {
          fareTotal: existingFare?.total ?? lockedRide.fare ?? '0',
          actualDistanceM: lockedRide.actualDistanceM ?? 0,
          actualDurationS: lockedRide.actualDurationS ?? 0,
        };
      }
      if (lockedRide.status !== RideStatus.IN_PROGRESS) {
        throw new ConflictException(
          `Ride must be in_progress to complete (current status: ${lockedRide.status})`,
        );
      }

      const checkpoint = await em.findOne(RideRouteCheckpoint, {
        where: { rideId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!checkpoint) {
        throw new UnprocessableEntityException(
          'Trip meter is unavailable. Restore location access and record a GPS fix before completing the ride.',
        );
      }
      const recordedDistM = checkpoint.totalDistanceM;
      const routePoints = [...checkpoint.points];
      if (
        checkpoint &&
        routePoints[routePoints.length - 1]?.timestampMs !==
          checkpoint.lastFix.timestampMs
      ) {
        routePoints.push(checkpoint.lastFix);
      }
      const actualRoute = routePoints.map(({ lat, lng }) => ({ lat, lng }));

      // Early drop-off: last fix is outside the fare destination neighbourhood,
      // or the trip meter is clearly shorter than the quoted road distance.
      // Bill actual traveled meters + elapsed time via the universal fare
      // formula — never invent remaining distance to the original pin.
      const nearDropoffForFare = !!(
        checkpoint.lastFix &&
        Number.isFinite(checkpoint.lastFix.lat) &&
        Number.isFinite(checkpoint.lastFix.lng) &&
        isWithinRadius(
          checkpoint.lastFix,
          lockedRide.dropoff,
          FARE_AT_DESTINATION_RADIUS_M,
        )
      );
      const quotedM = Math.max(0, lockedRide.distanceM ?? 0);
      const clearlyShorterThanQuote =
        quotedM > 0 && recordedDistM > 0 && recordedDistM < quotedM * 0.85;
      const earlyDropoff = !nearDropoffForFare || clearlyShorterThanQuote;

      const billedMeter = settleTripMeterDistance({
        recordedDistanceM: recordedDistM,
        lastFix: checkpoint.lastFix,
        dropoff: lockedRide.dropoff,
        quotedDistanceM: lockedRide.distanceM,
        hasGaps: checkpoint.hasGaps,
        lastFixAgeMs: Date.now() - checkpoint.lastFix.timestampMs,
        fillRemainingToDropoff: !earlyDropoff,
      });

      const completedAt = new Date();
      const startedAtTime = lockedRide.startedAt
        ? lockedRide.startedAt.getTime()
        : completedAt.getTime() - 30 * 1000;
      const actualDurationS = Math.max(
        10,
        Math.round((completedAt.getTime() - startedAtTime) / 1000),
      );
      const quotedDurationMinutes = Math.max(
        1,
        (lockedRide.durationS ?? actualDurationS) / 60,
      );
      // Bill travel time from the trip clock within the documented band —
      // not raw wall-clock, which can explode if End Trip is forgotten.
      const durationMinutes = this.fareService.settledDurationMinutes(
        quotedDurationMinutes,
        lockedRide.startedAt,
        completedAt,
      );
      // Pickup wait (arrive → start), after free grace; never on the quote.
      const waitMinutes = this.fareService.settledWaitMinutes(
        lockedRide.arrivedAt,
        lockedRide.startedAt,
      );

      const lockedVehicleMultipliers = lockedRide.pricingVersionId
        ? (
            await this.pricingVersions
              .get(lockedRide.pricingVersionId)
              .catch(() => null)
          )?.vehicleMultipliers ?? null
        : null;

      const meteredFare = await this.fareService.calculate(
        {
          distanceKm: Math.max(0, billedMeter.distanceM) / 1000,
          durationMinutes,
          waitMinutes,
          zoneId: zoneIdFor(lockedRide.pickup),
          surgeMultiplier: lockedRide.quotedSurgeMultiplier ?? undefined,
          vehicleType: lockedRide.vehicleType,
          vehicleMultipliers: lockedVehicleMultipliers,
        },
        lockedRide.quotedFareRates,
      );
      const quotedFare = await this.fareService.calculate(
        {
          distanceKm: Math.max(0, lockedRide.distanceM ?? 0) / 1000,
          durationMinutes: quotedDurationMinutes,
          zoneId: zoneIdFor(lockedRide.pickup),
          surgeMultiplier: lockedRide.quotedSurgeMultiplier ?? undefined,
          vehicleType: lockedRide.vehicleType,
          vehicleMultipliers: lockedVehicleMultipliers,
        },
        lockedRide.quotedFareRates,
      );
      const charged = chooseChargedSettlement({
        meter: billedMeter,
        meteredFare,
        quotedFare,
        quotedDistanceM: lockedRide.distanceM,
        earlyDropoff,
      });
      const actualDistanceM = charged.billedDistanceM;
      const fareBreakdown = charged.fare;
      const farePayload = {
        ...fareBreakdown,
        gpsGapEstimated: charged.status === RideSettlementStatus.ESTIMATED,
        settlementStatus: charged.status,
        estimateReason: charged.estimateReason,
        earlyDropoff,
        recordedDistanceM: billedMeter.recordedDistanceM,
        billedDistanceM: charged.billedDistanceM,
        quotedFareTotal: charged.quotedFareTotal,
        uncappedFareTotal: charged.uncappedFareTotal,
        arrivedAt: lockedRide.arrivedAt?.toISOString() ?? null,
        billedWaitMinutes: waitMinutes,
        billedDurationMinutes: durationMinutes,
      };

      const completed = await em.update(
        Ride,
        { id: rideId, status: RideStatus.IN_PROGRESS, driverId },
        {
          status: RideStatus.COMPLETED,
          completedAt,
          actualDistanceM,
          actualDurationS,
          actualRoute: actualRoute.length > 0 ? actualRoute : null,
          fare: String(farePayload.total),
          fareBreakdown: farePayload as unknown as Record<string, unknown>,
          pricingVersion:
            lockedRide.pricingVersion ??
            lockedRide.pricingVersionId ??
            'locked',
          settlementStatus: charged.status,
          offerDriverId: null,
          offerExpiresAt: null,
        },
      );
      if (!completed.affected) {
        // Lost the race to another complete — treat as success if settled.
        const latest = await em.findOne(Ride, { where: { id: rideId } });
        if (latest?.status === RideStatus.COMPLETED) {
          const existingFare = await em.findOne(FareRecord, {
            where: { rideId },
          });
          return {
            fareTotal: existingFare?.total ?? latest.fare ?? '0',
            actualDistanceM: latest.actualDistanceM ?? 0,
            actualDurationS: latest.actualDurationS ?? 0,
          };
        }
        throw new ConflictException('Ride is no longer in progress');
      }
      await em.save(
        em.create(RideStatusEvent, {
          rideId,
          status: RideStatus.COMPLETED,
          note: `Completed by driver ${driverId}`,
        }),
      );

      const fareRecord = await em.save(
        em.create(FareRecord, {
          rideId,
          baseFare: String(farePayload.initialFee),
          distanceFare: String(farePayload.distanceCharge),
          timeFare: String(farePayload.timeCharge),
          surgeMultiplier: String(farePayload.surgeMultiplier),
          platformFee: String(farePayload.platformFee),
          total: String(farePayload.total),
        }),
      );

      // The rider pays only the discounted cash amount; the matching Hebir
      // wallet credit is created in this same transaction. DriverEarning stays
      // at gross fare, so the credit replaces cash rather than adding income.
      const adSettlement = this.adRewards
        ? await this.adRewards.settleRide(em, lockedRide, fareRecord.total)
        : {
            appliedDiscountMinor: 0,
            riderCashDueMinor: Math.round(Number(fareRecord.total) * 100),
            driverHebirCreditMinor: 0,
          };

      const promoSettlement =
        this.promotionsService && lockedRide.riderId
          ? await this.promotionsService.applyPromotionToRide(
              em,
              rideId,
              lockedRide.riderId,
              Math.max(
                0,
                Math.round(Number(fareRecord.total) * 100) -
                  adSettlement.appliedDiscountMinor,
              ),
            )
          : { appliedDiscountMinor: 0 };

      const promoCreditMinor =
        this.adRewards && promoSettlement.appliedDiscountMinor > 0
          ? await this.adRewards.creditPromoDiscount(
              em,
              lockedRide,
              promoSettlement.appliedDiscountMinor,
            )
          : 0;

      const combinedDiscountMinor =
        adSettlement.appliedDiscountMinor +
        promoSettlement.appliedDiscountMinor;
      const driverHebirCreditMinor =
        adSettlement.driverHebirCreditMinor + promoCreditMinor;
      const finalRiderCashDueMinor = Math.max(
        0,
        Math.round(Number(fareRecord.total) * 100) - combinedDiscountMinor,
      );

      const riderCashDue = (finalRiderCashDueMinor / 100).toFixed(2);

      const settled = await this.farePayments.settleFare({
        rideId,
        riderId: lockedRide.riderId,
        amountEtb: riderCashDue,
        idempotencyKey: `fare:${rideId}`,
      });
      await em.save(
        em.create(PaymentRecord, {
          userId: lockedRide.riderId,
          rideId,
          type: PaymentType.FARE,
          amount: riderCashDue,
          idempotencyKey: `fare:${rideId}`,
          status: settled.status,
          providerReference: settled.providerReference,
          applicationFeeAmount: '0',
        }),
      );

      await em.save(
        em.create(DriverEarning, {
          driverId,
          sourceType: EarningSourceType.RIDE,
          sourceId: rideId,
          amount: fareRecord.total,
          payoutStatus: PayoutStatus.PENDING,
        }),
      );

      // Always free this driver — don't require ON_TRIP match (partial
      // failures / resume paths can leave the profile ONLINE already).
      await em.update(
        DriverProfile,
        { userId: driverId },
        { status: DriverStatus.ONLINE, idleSince: new Date() },
      );
      await em.increment(DriverProfile, { userId: driverId }, 'totalTrips', 1);

      return {
        fareTotal: fareRecord.total,
        riderCashDue,
        adSettlement,
        promoSettlement,
        driverHebirCreditMinor,
        actualDistanceM,
        actualDurationS,
        settlementStatus: charged.status,
        estimateReason: charged.estimateReason,
        quotedFareTotal: charged.quotedFareTotal,
        uncappedFareTotal: charged.uncappedFareTotal,
        chargedFareTotal: Math.round(Number(farePayload.total)),
        riderId: lockedRide.riderId,
      };
    });
    const {
      fareTotal,
      riderCashDue,
      adSettlement,
      promoSettlement,
      driverHebirCreditMinor,
      actualDistanceM,
      actualDurationS,
      settlementStatus,
      estimateReason,
      quotedFareTotal,
      uncappedFareTotal,
      chargedFareTotal,
      riderId: settledRiderId,
    } = settlement;

    let settlementReviewCaseNumber: string | null = null;
    if (
      settlementStatus === RideSettlementStatus.ESTIMATED &&
      estimateReason &&
      this.incidentsService
    ) {
      try {
        const review = await this.incidentsService.createEstimatedSettlementReview({
          rideId,
          driverId,
          riderId: settledRiderId,
          reason: estimateReason,
          quotedFareTotal,
          uncappedFareTotal,
          chargedFareTotal,
        });
        settlementReviewCaseNumber = review.caseNumber;
        await this.rides.update(
          { id: rideId },
          { settlementReviewCaseNumber: review.caseNumber },
        );
      } catch (error) {
        this.logger.warn(
          `Ride ${rideId} settled as estimated but review case failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const settledRide =
      (await this.rides.findOne({ where: { id: rideId } })) ?? ride;
    const completionPayload = {
      rideId,
      status: RideStatus.COMPLETED,
      fare: riderCashDue,
      grossFare: fareTotal,
      riderCashDue,
      advertisingDiscount: adSettlement?.appliedDiscountMinor
        ? (adSettlement.appliedDiscountMinor / 100).toFixed(2)
        : '0.00',
      promotionDiscount: promoSettlement?.appliedDiscountMinor
        ? (promoSettlement.appliedDiscountMinor / 100).toFixed(2)
        : '0.00',
      driverHebirCredit: driverHebirCreditMinor
        ? (driverHebirCreditMinor / 100).toFixed(2)
        : '0.00',
      settlementStatus,
      settlementReviewCaseNumber:
        settlementReviewCaseNumber ?? settledRide.settlementReviewCaseNumber,
      fareBreakdown: {
        ...settledRide.fareBreakdown,
        actualDistanceKm: (settledRide.actualDistanceM ?? 0) / 1000,
        actualDurationMinutes: Math.round(
          (settledRide.actualDurationS ?? 0) / 60,
        ),
      },
      actualDistanceM: settledRide.actualDistanceM,
      actualDurationS: settledRide.actualDurationS,
    };

    await this.notify(ride.riderId, 'ride.completed', completionPayload);
    await this.notify(driverId, 'ride.completed', completionPayload);
    await this.routeRecorder.clearRoute(rideId);
    await this.invalidateDriverStatusCache(driverId);
    this.releaseOnDemandRequest(ride.riderId);
    await clearLiveTrack(this.redis, driverId, rideId).catch((error: Error) => {
      this.logger.warn(
        `Ride ${rideId} settled; live-track cleanup failed: ${error.message}`,
      );
    });

    // Guest fare SMS is best-effort and must never undo a completed settlement.
    void this.sendGuestFareSmsOnce(rideId, riderCashDue).catch(
      (error: Error) => {
        this.logger.warn(
          `Guest fare SMS failed for ${rideId}: ${error.message}`,
        );
      },
    );

    this.logger.log(
      `Ride ${rideId}: completed by driver ${driverId}, fare=${fareTotal}, distance=${actualDistanceM}m, duration=${actualDurationS}s, settlement=${settlementStatus}`,
    );
    return (await this.rides.findOne({ where: { id: rideId } })) ?? ride;
  }

  /** Either participant can cancel until the trip physically starts. */
  async cancelRide(
    rideId: string,
    actorId: string,
    reason?: string,
  ): Promise<Ride> {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');
    if (ride.riderId !== actorId && ride.driverId !== actorId) {
      throw new ForbiddenException('You are not a participant on this ride');
    }
    if (
      ride.status === RideStatus.COMPLETED ||
      ride.status === RideStatus.CANCELLED ||
      ride.status === RideStatus.UNMATCHED
    ) {
      if (
        ride.status === RideStatus.CANCELLED ||
        ride.status === RideStatus.UNMATCHED
      ) {
        return ride;
      }
      throw new ConflictException(`Ride is already ${ride.status}`);
    }
    if (ride.status === RideStatus.IN_PROGRESS) {
      // A trip that physically started must end via complete — cancelling it
      // would erase the fare and the trip record.
      throw new ConflictException(
        'A trip in progress cannot be cancelled; complete it instead',
      );
    }

    const streetHail = ride.isStreetHail || this.rideHasStartCodeGate(ride);
    const driverDropRematch =
      actorId === ride.driverId &&
      !streetHail &&
      (ride.status === RideStatus.MATCHED ||
        ride.status === RideStatus.ACCEPTED ||
        ride.status === RideStatus.ARRIVING);
    if (driverDropRematch) {
      return this.rematchAfterDriverCancel(ride, actorId, reason);
    }

    const heldDriverId = ride.driverId ?? ride.offerDriverId;

    const cancelled = await this.rides.update(
      {
        id: rideId,
        status: Not(
          In([
            RideStatus.COMPLETED,
            RideStatus.CANCELLED,
            RideStatus.UNMATCHED,
            RideStatus.IN_PROGRESS,
          ]),
        ),
      },
      {
        status: RideStatus.CANCELLED,
        driverId: null,
        offerDriverId: null,
        offerExpiresAt: null,
      },
    );
    if (!cancelled.affected) {
      const current = await this.rides.findOne({ where: { id: rideId } });
      throw new ConflictException(
        `Ride is already ${current?.status ?? 'closed'}`,
      );
    }

    if (this.promotionsService) {
      await this.rides.manager.transaction(async (em) => {
        await this.promotionsService!.refundPromotion(em, rideId);
      });
    }

    await this.logEvent(
      rideId,
      RideStatus.CANCELLED,
      reason ?? `Cancelled by ${actorId}`,
    );
    await this.clearStartCode(rideId);

    if (heldDriverId) {
      // A cancel can land while the driver is reserved (live offer) or already
      // on_trip, so both are valid states to free. Accept now guards its
      // RESERVED→ON_TRIP flip, so freeing here cannot strand a concurrent accept.
      await this.releaseDriverToOnline(heldDriverId, [
        DriverStatus.RESERVED,
        DriverStatus.ON_TRIP,
      ]);
      await this.releaseDriverLock(heldDriverId, rideId);
      await clearLiveTrack(this.redis, heldDriverId, rideId).catch(
        (error: Error) => {
          this.logger.warn(
            `clearLiveTrack on cancel failed: ${error.message}`,
          );
        },
      );
    }

    await this.dispatchQueue.clearState(rideId);

    const cancelPayload = {
      rideId,
      reason,
      updatedAt: new Date().toISOString(),
      cancelledBy: actorId === ride.riderId ? 'rider' : 'driver',
      status: RideStatus.CANCELLED,
    };
    const counterpartId =
      actorId === ride.riderId ? heldDriverId : ride.riderId;
    // Notify both participants so second devices leave matching / trip UI.
    const recipients = new Set(
      [counterpartId, ride.riderId, heldDriverId].filter(
        (id): id is string => !!id,
      ),
    );
    for (const userId of recipients) {
      await this.notify(userId, 'ride.cancelled', cancelPayload);
      await this.notify(userId, 'ride.status_changed', {
        rideId,
        status: RideStatus.CANCELLED,
        updatedAt: cancelPayload.updatedAt,
      });
    }

    this.releaseOnDemandRequest(ride.riderId);

    this.logger.log(`Ride ${rideId}: cancelled by ${actorId}`);
    return (await this.rides.findOne({ where: { id: rideId } })) ?? ride;
  }

  /**
   * Driver dropped the trip before it started. Keep the same ride id so the
   * rider stays in matching instead of booking again from scratch. Street-hail
   * (start-code) trips stay cancelled — those are not a marketplace search.
   */
  private async rematchAfterDriverCancel(
    ride: Ride,
    driverId: string,
    reason?: string,
  ): Promise<Ride> {
    const rideId = ride.id;
    const reset = await this.rides.update(
      {
        id: rideId,
        driverId,
        status: In([
          RideStatus.MATCHED,
          RideStatus.ACCEPTED,
          RideStatus.ARRIVING,
        ]),
      },
      {
        status: RideStatus.SEARCHING,
        driverId: null,
        offerDriverId: null,
        offerExpiresAt: null,
        matchedAt: null,
        // Fresh dispatch budget — reaper keys off requestedAt; without this a
        // long first search + arrive + cancel would unmatched within ~15s.
        requestedAt: new Date(),
        // Previous driver's wait clock must not apply to the next assignment.
        arrivedAt: null,
      },
    );
    if (!reset.affected) {
      const current = await this.rides.findOne({ where: { id: rideId } });
      if (
        current &&
        (current.status === RideStatus.SEARCHING ||
          current.status === RideStatus.OFFERED ||
          current.status === RideStatus.CANCELLED ||
          current.status === RideStatus.UNMATCHED)
      ) {
        return current;
      }
      throw new ConflictException(
        `Ride is already ${current?.status ?? 'closed'}`,
      );
    }

    await this.logEvent(
      rideId,
      RideStatus.SEARCHING,
      reason ?? `Driver ${driverId} cancelled; rematching`,
    );
    await this.clearStartCode(rideId);

    await this.releaseDriverToOnline(driverId, [
      DriverStatus.RESERVED,
      DriverStatus.ON_TRIP,
    ]);
    await this.releaseDriverLock(driverId, rideId);
    await clearLiveTrack(this.redis, driverId, rideId).catch((error: Error) => {
      this.logger.warn(`clearLiveTrack on rematch failed: ${error.message}`);
    });

    await this.dispatchQueue.clearState(rideId);
    try {
      await this.dispatchQueue.enqueueDispatch(rideId, 0, [driverId]);
    } catch (error) {
      this.logger.error(
        `Ride ${rideId}: rematch enqueue failed: ${(error as Error).message}`,
      );
      await this.markUnmatched(rideId);
      await this.notify(ride.riderId, 'ride.unmatched', { rideId });
      return (await this.rides.findOne({ where: { id: rideId } })) ?? ride;
    }

    await this.notify(ride.riderId, 'ride.rematching', {
      rideId,
      reason: reason ?? 'Driver cancelled',
      updatedAt: new Date().toISOString(),
      status: RideStatus.SEARCHING,
    });
    await this.notify(ride.riderId, 'ride.status_changed', {
      rideId,
      status: RideStatus.SEARCHING,
      updatedAt: new Date().toISOString(),
      previousStatus: ride.status,
    });
    // Cancelling driver must leave the trip UI immediately.
    await this.notify(driverId, 'ride.status_changed', {
      rideId,
      status: RideStatus.SEARCHING,
      updatedAt: new Date().toISOString(),
      rematched: true,
    });
    // Rider is searching again — restore live demand in the pickup hex.
    this.recordOnDemandRequest(ride.pickup, ride.riderId);

    this.logger.log(
      `Ride ${rideId}: rematching after driver ${driverId} cancelled`,
    );
    return (await this.rides.findOne({ where: { id: rideId } })) ?? ride;
  }

  /** Returns the active offer for this driver, or null when idle. */
  async getCurrentOffer(driverId: string) {
    const ride = await this.rides.findOne({
      where: {
        offerDriverId: driverId,
        status: RideStatus.OFFERED,
      },
      order: { updatedAt: 'DESC' },
    });
    if (!ride) return null;
    if (ride.offerExpiresAt && ride.offerExpiresAt.getTime() <= Date.now()) {
      return null;
    }
    return this.buildOfferPayload(ride);
  }

  /**
   * Same shape for socket `ride.offer` and `GET /rides/offers/current` so the
   * driver always sees the fare the rider was quoted (distance + vehicle + surge).
   */
  private async buildOfferPayload(ride: Ride) {
    const distanceKm = ride.distanceM
      ? ride.distanceM / 1000
      : this.fareService.quotedTripMetrics(ride.pickup, ride.dropoff)
          .distanceKm;
    const durationMinutes = ride.durationS
      ? ride.durationS / 60
      : this.fareService.estimateDurationMinutes(distanceKm);
    const vehicleMultipliers = await this.vehicleMultipliersForRide(ride);
    const fare = await this.fareService.calculate(
      {
        distanceKm,
        durationMinutes,
        zoneId: zoneIdFor(ride.pickup),
        surgeMultiplier: ride.quotedSurgeMultiplier ?? undefined,
        vehicleType: ride.vehicleType,
        vehicleMultipliers,
      },
      ride.quotedFareRates,
    );
    return {
      rideId: ride.id,
      id: ride.id,
      pickup: ride.pickup,
      dropoff: ride.dropoff,
      waypoints: ride.waypoints ?? [],
      pickupAddress: ride.pickupAddress,
      dropoffAddress: ride.dropoffAddress,
      vehicleType: ride.vehicleType,
      offerExpiresAt: ride.offerExpiresAt,
      distanceKm: Math.round(distanceKm * 1000) / 1000,
      durationMinutes: Math.round(durationMinutes * 10) / 10,
      estimatedFare: this.fareQuotePayload(fare),
    };
  }

  /** Sanitize client waypoints: max 3, finite coords, stable sequence. */
  private normalizeWaypoints(
    raw:
      | Array<{ lat: number; lng: number; address?: string; sequence?: number }>
      | undefined,
  ): Array<{ lat: number; lng: number; address: string | null; sequence: number }> {
    if (!raw?.length) return [];
    const out: Array<{
      lat: number;
      lng: number;
      address: string | null;
      sequence: number;
    }> = [];
    for (const point of raw.slice(0, 3)) {
      const lat = Number(point.lat);
      const lng = Number(point.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
      out.push({
        lat,
        lng,
        address: point.address?.trim().slice(0, 240) || null,
        sequence: out.length,
      });
    }
    return out;
  }

  private fareQuotePayload(fare: FareBreakdown): FareQuotePayload {
    return {
      total: fare.total,
      initialFee: fare.initialFee,
      distanceCharge: fare.distanceCharge,
      timeCharge: fare.timeCharge,
      waitCharge: fare.waitCharge,
      vehicleMultiplier: fare.vehicleMultiplier,
      surgeMultiplier: fare.surgeMultiplier,
      platformFee: fare.platformFee,
    };
  }

  async listRidesForRider(
    riderId: string,
    limit = 50,
  ): Promise<EnrichedRide[]> {
    const rides = await this.rides.find({
      where: {
        riderId,
        status: In([
          RideStatus.COMPLETED,
          RideStatus.CANCELLED,
          RideStatus.UNMATCHED,
        ]),
      },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(1, limit), MAX_RIDE_PAGE),
    });
    const enriched = await this.enrichRides(rides);
    return Promise.all(
      enriched.map((ride, index) =>
        this.attachStartCodeForViewer(ride, rides[index], riderId),
      ),
    );
  }

  /** Driver trip history — `GET /rides/mine` when the JWT has the driver role. */
  async listRidesForDriver(
    driverId: string,
    limit = 50,
  ): Promise<EnrichedRide[]> {
    const rides = await this.rides.find({
      where: {
        driverId,
        status: In([
          RideStatus.COMPLETED,
          RideStatus.CANCELLED,
          RideStatus.UNMATCHED,
        ]),
      },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(1, limit), MAX_RIDE_PAGE),
    });
    const enriched = await this.enrichRides(rides);
    return Promise.all(
      enriched.map((ride, index) =>
        this.attachStartCodeForViewer(ride, rides[index], driverId),
      ),
    );
  }

  /**
   * Live assigned ride for a driver (matched → in_progress). Used to resume
   * after the app is killed mid-trip so End Trip can still settle the fare.
   */
  async getActiveRideForRider(riderId: string): Promise<EnrichedRide | null> {
    const ride = await this.rides.findOne({
      where: { riderId, status: In(ACTIVE_RIDE_STATUSES) },
      order: { updatedAt: 'DESC' },
    });
    if (!ride) return null;
    const [enriched] = await this.enrichRides([ride]);
    return this.attachStartCodeForViewer(enriched, ride, riderId);
  }

  /**
   * Dual-role accounts: a driver who also requested a ride as a rider must
   * still recover the rider trip when they have no live assignment.
   */
  async getActiveRideForUser(
    userId: string,
    roles: UserRole[] = [],
  ): Promise<EnrichedRide | null> {
    if (roles.includes(UserRole.DRIVER) || roles.includes(UserRole.ADMIN)) {
      const asDriver = await this.getActiveRideForDriver(userId);
      if (asDriver) return asDriver;
      if (!roles.includes(UserRole.RIDER) && !roles.includes(UserRole.ADMIN)) {
        return null;
      }
    }
    return this.getActiveRideForRider(userId);
  }

  async getActiveRideForDriver(driverId: string): Promise<EnrichedRide | null> {
    const ride = await this.rides.findOne({
      where: {
        driverId,
        status: In(LIVE_DRIVER_TRIP_STATUSES),
      },
      order: { updatedAt: 'DESC' },
    });
    if (ride) {
      const [enriched] = await this.enrichRides([ride]);
      return this.attachStartCodeForViewer(enriched, ride, driverId);
    }
    // Mid-offer after app restart — same endpoint so the portal can resume
    // the sheet without a separate poll race.
    const offered = await this.rides.findOne({
      where: {
        offerDriverId: driverId,
        status: RideStatus.OFFERED,
      },
      order: { updatedAt: 'DESC' },
    });
    if (!offered) return null;
    if (
      offered.offerExpiresAt &&
      offered.offerExpiresAt.getTime() <= Date.now()
    ) {
      return null;
    }
    const [enriched] = await this.enrichRides([offered]);
    return this.attachStartCodeForViewer(enriched, offered, driverId);
  }

  /**
   * Participants and staff only — a ride exposes the rider's pickup address
   * and the driver's identity, so it must never be readable by ride id alone.
   */
  async getRide(id: string, viewer: RideViewer): Promise<EnrichedRide> {
    const ride = await this.rides.findOne({ where: { id } });
    if (!ride) throw new NotFoundException('Ride not found');

    const isParticipant =
      ride.riderId === viewer.userId ||
      ride.driverId === viewer.userId ||
      ride.offerDriverId === viewer.userId;
    const isStaff = (viewer.roles ?? []).some(
      (role) => role === UserRole.ADMIN || role === UserRole.GOV_OFFICER,
    );
    if (!isParticipant && !isStaff) {
      throw new ForbiddenException('You are not a participant on this ride');
    }

    const [enriched] = await this.enrichRides([ride]);
    return this.attachStartCodeForViewer(enriched, ride, viewer.userId);
  }

  /**
   * Exact phone match for street-hail: driver finds the rider who asked to
   * join. Only succeeds when the driver is within 300 m of the rider's live
   * GPS. Never returns another rider's full phone — only a display name and
   * whether they already have an active trip.
   */
  async lookupRiderByPhone(
    driverId: string,
    phoneNumber: string,
    driverLocation: GeoPoint,
  ) {
    await this.assertDriverMayWork(driverId);
    if (!(await this.subscriptionService.mayAccessMarketplace(driverId))) {
      throw new ForbiddenException(
        'Active subscription required to look up riders',
      );
    }
    if (phoneNumber.trim() === '') {
      throw new NotFoundException('Rider not found');
    }
    const rider = await this.users.findOne({ where: { phoneNumber } });
    if (!rider) {
      throw new NotFoundException('No ህብር account found for that phone number');
    }
    if (rider.id === driverId) {
      throw new ConflictException(
        'You cannot start a trip with your own account',
      );
    }

    await this.assertStreetHailProximity(rider.id, driverLocation);

    const active = await this.rides.findOne({
      where: { riderId: rider.id, status: In(ACTIVE_RIDE_STATUSES) },
      order: { createdAt: 'DESC' },
    });
    const masked = phoneNumber.replace(
      /^(\+251)(\d{2})\d{5}(\d{2})$/,
      '$1$2*****$3',
    );
    return {
      riderId: rider.id,
      displayName: rider.fullName?.trim() || 'Rider',
      phoneMasked: masked,
      hasActiveRide: !!active,
      activeRideStatus: active?.status ?? null,
      activeRideId: active?.id ?? null,
      activeRideIsYours: active?.driverId === driverId,
    };
  }

  /**
   * Street-hail phone lookup / create only when the driver is already next to
   * the rider (≤ 300 m). Far-away lookups are rejected.
   */
  private async assertStreetHailProximity(
    riderId: string,
    driverLocation: GeoPoint,
  ): Promise<void> {
    const raw = await this.redis.get(riderLocKey(riderId));
    if (!raw) {
      throw new BadRequestException(
        'Ask the rider to open ህብር nearby — we need their live location (within 300 m)',
      );
    }
    const [latStr, lngStr] = raw.split(',');
    const riderLoc: GeoPoint = {
      lat: Number(latStr),
      lng: Number(lngStr),
    };
    if (!Number.isFinite(riderLoc.lat) || !Number.isFinite(riderLoc.lng)) {
      throw new BadRequestException(
        'Ask the rider to open ህብር nearby — we need their live location (within 300 m)',
      );
    }
    const km = haversineKm(driverLocation, riderLoc);
    if (km > STREET_HAIL_MAX_DISTANCE_KM) {
      throw new BadRequestException(
        `Too far from the rider (${Math.round(km * 1000)} m). You must be within 300 m to use their phone number.`,
      );
    }
  }

  /**
   * Driver creates an already-assigned ride (skip dispatch).
   * Registered riders: in-app 4-digit code (proximity required).
   * Guests (`dto.guest`): SMS code, no account, no proximity ping.
   */
  async createDriverInitiatedRide(
    driverId: string,
    dto: DriverInitiatedRideDto,
  ): Promise<EnrichedRide> {
    await this.assertDriverMayWork(driverId);
    const mayDrive =
      await this.subscriptionService.mayAccessMarketplace(driverId);
    if (!mayDrive) {
      throw new ForbiddenException(
        'Active subscription required to start trips for riders',
      );
    }

    const phone = dto.riderPhoneNumber;
    const existingAccount = await this.users.findOne({
      where: { phoneNumber: phone },
    });
    // Unregistered phone → guest SMS path. Explicit guest=true forces SMS even
    // if an account exists (driver chose Guest). Explicit guest=false keeps
    // registered-only (404 when missing).
    const isGuest =
      dto.guest === true || (dto.guest !== false && !existingAccount);

    let rider: UserAccount | null = null;
    if (!isGuest) {
      rider = existingAccount;
      if (!rider) {
        throw new NotFoundException(
          'No ህብር account found for that phone number. Use Guest Rider to hail without an account.',
        );
      }
      if (rider.id === driverId) {
        throw new ConflictException(
          'You cannot start a trip with your own account',
        );
      }
      const riderBusy = await this.rides.findOne({
        where: { riderId: rider.id, status: In(ACTIVE_RIDE_STATUSES) },
      });
      if (riderBusy) {
        throw new ConflictException(
          `That rider already has a trip in progress (${riderBusy.status})`,
        );
      }
      await this.assertStreetHailProximity(rider.id, dto.pickup);
    } else {
      // Guests must not collide with an existing registered account's active trip
      // on the same phone, or another guest hail on that number.
      if (existingAccount) {
        const busy = await this.rides.findOne({
          where: {
            riderId: existingAccount.id,
            status: In(ACTIVE_RIDE_STATUSES),
          },
        });
        if (busy) {
          throw new ConflictException(
            'That phone already has an active Hebir trip — use Registered Rider instead',
          );
        }
      }
      const driverAccount = await this.users.findOne({
        where: { id: driverId },
      });
      if (driverAccount?.phoneNumber === phone) {
        throw new ConflictException(
          'You cannot start a guest trip with your own phone number',
        );
      }
      const guestBusy = await this.rides.findOne({
        where: {
          guestPhoneE164: phone,
          status: In(ACTIVE_RIDE_STATUSES),
        },
      });
      if (guestBusy) {
        throw new ConflictException(
          'That guest phone already has an active street pickup',
        );
      }
    }

    const driverBusy = await this.rides.findOne({
      where: { driverId, status: In(ACTIVE_RIDE_STATUSES) },
    });
    if (driverBusy) {
      throw new ConflictException('You already have an active trip');
    }

    const pendingOffer = await this.rides.findOne({
      where: { offerDriverId: driverId, status: RideStatus.OFFERED },
    });
    if (pendingOffer) {
      throw new ConflictException(
        'Decline or wait out your current offer before starting another trip',
      );
    }

    const profile = await this.driverProfiles.findOne({
      where: { userId: driverId },
    });
    if (!profile) {
      throw new ForbiddenException('Driver profile required');
    }
    if (
      profile.status === DriverStatus.RESERVED ||
      profile.status === DriverStatus.ON_TRIP
    ) {
      throw new ConflictException(
        'Finish or free your current offer/trip before starting another',
      );
    }

    const { pickupAddress, dropoffAddress } =
      await this.geocoding.reverseGeocodePair(dto.pickup, dto.dropoff);

    const vehicleType = normalizeRideVehicleType(dto.vehicleType);
    const { distanceKm, durationMinutes } = this.fareService.quotedTripMetrics(
      dto.pickup,
      dto.dropoff,
      dto.distanceKm,
      dto.durationMinutes,
    );

    const { rates: lockedRates, version: pricingVersion } =
      await this.pricingVersions.getActiveRates();
    const quotedFare = await this.fareService.calculate(
      {
        distanceKm,
        durationMinutes,
        zoneId: zoneIdFor(dto.pickup),
        vehicleType,
        vehicleMultipliers: pricingVersion?.vehicleMultipliers ?? null,
      },
      lockedRates,
    );

    const now = new Date();
    let ride: Ride;
    try {
      ride = await this.rides.manager.transaction(async (em) => {
        const flipped = await em
          .createQueryBuilder()
          .update(DriverProfile)
          .set({ status: DriverStatus.ON_TRIP, idleSince: null })
          .where('"userId" = :driverId', { driverId })
          .andWhere('status IN (:...ok)', {
            ok: [DriverStatus.OFFLINE, DriverStatus.ONLINE],
          })
          .execute();
        if (!flipped.affected) {
          throw new ConflictException(
            'Finish or free your current offer/trip before starting another',
          );
        }
        return em.save(
          em.create(Ride, {
            riderId: rider?.id ?? null,
            driverId,
            isGuest,
            isStreetHail: true,
            guestPhoneE164: isGuest ? phone : null,
            pickup: dto.pickup,
            dropoff: dto.dropoff,
            pickupAddress: pickupAddress || dto.pickupAddress || null,
            dropoffAddress: dropoffAddress || dto.dropoffAddress || null,
            vehicleType,
            distanceM: Math.round(distanceKm * 1000),
            durationS: Math.round(durationMinutes * 60),
            quotedSurgeMultiplier: quotedFare.surgeMultiplier,
            quotedFareRates: quotedFare.rates,
            pricingVersionId: pricingVersion?.id ?? null,
            pricingVersion:
              pricingVersion?.versionLabel ?? pricingVersion?.id ?? null,
            status: RideStatus.ACCEPTED,
            requestedAt: now,
            matchedAt: now,
            offerDriverId: null,
            offerExpiresAt: null,
          }),
        );
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('You already have an active trip');
      }
      throw error;
    }

    const startCode = String(randomInt(1000, 9999));
    const codeTtlSec = isGuest ? GUEST_START_CODE_TTL_SEC : START_CODE_TTL_SEC;
    await this.storeStartCode(ride.id, startCode, codeTtlSec);
    await this.logEvent(
      ride.id,
      RideStatus.ACCEPTED,
      isGuest
        ? `Guest street-hail by ${driverId}`
        : `Driver-initiated ride by ${driverId} for rider ${rider!.id}`,
    );

    const [enriched] = await this.enrichRides([ride]);
    await writeLiveTrack(this.redis, driverId, liveTrackFromRide(ride));

    if (isGuest) {
      try {
        await this.sms.send(phone, guestStartCodeSms(startCode));
        await this.rides.update(
          { id: ride.id },
          { guestStartSmsSentAt: new Date() },
        );
      } catch (error) {
        this.logger.warn(
          `Guest start SMS failed for ride ${ride.id}: ${(error as Error).message}`,
        );
        // Ride stays — driver can resend. Do not leak the code in the API.
        return {
          ...enriched,
          requiresStartCode: true,
          startCode: null,
          isGuest: true,
          smsDelivery: 'failed',
          smsError:
            'Could not send the verification SMS. Tap Resend code to try again.',
        };
      }
      this.logger.log(
        `Ride ${ride.id}: guest street-hail by ${driverId} (SMS sent)`,
      );
      return {
        ...enriched,
        requiresStartCode: true,
        startCode: null,
        isGuest: true,
        smsDelivery: 'sent',
      };
    }

    await this.notify(rider!.id, 'ride.driver_initiated', {
      rideId: ride.id,
      startCode,
      status: RideStatus.ACCEPTED,
      pickupAddress: ride.pickupAddress,
      dropoffAddress: ride.dropoffAddress,
      pickup: ride.pickup,
      dropoff: ride.dropoff,
      driver: enriched.driver,
      vehicle: enriched.vehicle,
      requiresStartCode: true,
    });
    await this.notify(rider!.id, 'ride.matched', {
      rideId: ride.id,
      driverId,
      pickupAddress: ride.pickupAddress,
      dropoffAddress: ride.dropoffAddress,
      driver: enriched.driver,
      vehicle: enriched.vehicle,
      startCode,
      requiresStartCode: true,
    });

    this.logger.log(
      `Ride ${ride.id}: driver-initiated by ${driverId} for rider ${rider!.id}`,
    );
    return {
      ...enriched,
      requiresStartCode: true,
      startCode: null,
      isGuest: false,
    };
  }

  /**
   * Resend guest street-hail verification SMS (cooldown + hourly cap).
   * Registered riders refresh via the app — this endpoint refuses them.
   */
  async resendGuestStartCode(
    rideId: string,
    driverId: string,
  ): Promise<{ ok: true; smsDelivery: 'sent' }> {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');
    if (ride.driverId !== driverId) {
      throw new ForbiddenException('You are not the driver on this ride');
    }
    if (!ride.isGuest || !ride.guestPhoneE164) {
      throw new BadRequestException(
        'Resend is only for guest street pickups — registered riders see the code in their app',
      );
    }
    if (
      ride.status !== RideStatus.ACCEPTED &&
      ride.status !== RideStatus.ARRIVING
    ) {
      throw new ConflictException(
        `Cannot resend code while ride is ${ride.status}`,
      );
    }

    const cooldownKey = `ride:guest-sms-cd:${rideId}`;
    const hourKey = `ride:guest-sms-hr:${ride.guestPhoneE164}`;
    const cd = await this.redis.set(
      cooldownKey,
      '1',
      'EX',
      GUEST_START_SMS_RESEND_COOLDOWN_SEC,
      'NX',
    );
    if (cd !== 'OK') {
      throw new BadRequestException(
        `Wait ${GUEST_START_SMS_RESEND_COOLDOWN_SEC} seconds before resending`,
      );
    }
    const sentHour = await this.redis.incr(hourKey);
    if (sentHour === 1) {
      await this.redis.expire(hourKey, 3600);
    }
    if (sentHour > GUEST_START_SMS_MAX_PER_HOUR) {
      throw new BadRequestException(
        'Too many verification SMS for this number — try again later',
      );
    }

    const startCode = String(randomInt(1000, 9999));
    await this.storeStartCode(rideId, startCode, GUEST_START_CODE_TTL_SEC);
    try {
      await this.sms.send(ride.guestPhoneE164, guestStartCodeSms(startCode));
      await this.rides.update(
        { id: rideId },
        { guestStartSmsSentAt: new Date() },
      );
    } catch (error) {
      this.logger.warn(
        `Guest start SMS resend failed for ${rideId}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'Could not send the verification SMS. Try again in a moment.',
      );
    }
    await this.logEvent(
      rideId,
      ride.status,
      `Guest start code resent by driver ${driverId}`,
    );
    return { ok: true, smsDelivery: 'sent' };
  }

  /**
   * Driver enters the code shown on the rider's phone to begin the trip.
   * Accepts `accepted` or `arriving` so street-hail can start in one step.
   */
  async startRideWithCode(
    rideId: string,
    driverId: string,
    startCode: string,
  ): Promise<EnrichedRide> {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');
    if (ride.driverId !== driverId) {
      throw new ForbiddenException('You are not the driver on this ride');
    }
    if (
      ride.status !== RideStatus.ACCEPTED &&
      ride.status !== RideStatus.ARRIVING
    ) {
      throw new ConflictException(
        `Ride must be accepted or arriving to start (current: ${ride.status})`,
      );
    }

    await this.assertDriverWithin(
      driverId,
      ride.pickup,
      START_RADIUS_M,
      'start the trip',
      'pickup',
    );

    await this.consumeStartCode(rideId, startCode);

    const now = new Date();
    if (ride.status === RideStatus.ACCEPTED) {
      await this.rides.update(
        { id: rideId, status: RideStatus.ACCEPTED },
        {
          status: RideStatus.ARRIVING,
          ...(ride.arrivedAt ? {} : { arrivedAt: now }),
        },
      );
      await this.logEvent(
        rideId,
        RideStatus.ARRIVING,
        'Arrived for start-code gate',
      );
    }

    const previous =
      ride.status === RideStatus.ACCEPTED
        ? RideStatus.ARRIVING
        : RideStatus.ARRIVING;
    const startPatch: Partial<Ride> = {
      status: RideStatus.IN_PROGRESS,
      startedAt: now,
    };
    if (!ride.arrivedAt && ride.status === RideStatus.ARRIVING) {
      // Already arriving but clock never stamped (legacy rows).
      startPatch.arrivedAt = now;
    }
    const moved = await this.rides.update(
      { id: rideId, status: previous },
      startPatch,
    );
    if (!moved.affected) {
      // Race: already started or cancelled.
      const latest = await this.rides.findOne({ where: { id: rideId } });
      if (latest?.status === RideStatus.IN_PROGRESS) {
        const [enriched] = await this.enrichRides([latest]);
        return { ...enriched, requiresStartCode: false, startCode: null };
      }
      throw new ConflictException('Could not start ride — retry');
    }
    await this.logEvent(
      rideId,
      RideStatus.IN_PROGRESS,
      `Started with rider security code by ${driverId}`,
    );

    await this.notify(ride.riderId, 'ride.status_changed', {
      rideId,
      status: RideStatus.IN_PROGRESS,
      startedAt: new Date().toISOString(),
    });

    const liveStart = await this.readLiveDriverPoint(driverId);
    const startPt = liveStart ?? ride.pickup;
    if (!startPt || !Number.isFinite(startPt.lat) || !Number.isFinite(startPt.lng)) {
      throw new UnprocessableEntityException(
        'GPS is required to start the trip. Wait for a location fix and try again.',
      );
    }
    await this.routeRecorder.startRecording(rideId, {
      lat: startPt.lat,
      lng: startPt.lng,
      timestampMs: Date.now(),
    });

    const updated =
      (await this.rides.findOne({ where: { id: rideId } })) ?? ride;
    if (updated.driverId) {
      await writeLiveTrack(
        this.redis,
        updated.driverId,
        liveTrackFromRide(updated),
      );
    }

    if (updated.isGuest && updated.guestPhoneE164) {
      void this.sendGuestTripStartedSmsOnce(updated).catch((error: Error) => {
        this.logger.warn(
          `Guest trip-start SMS failed for ${rideId}: ${error.message}`,
        );
      });
    }

    const [enriched] = await this.enrichRides([updated]);
    return { ...enriched, requiresStartCode: false, startCode: null };
  }

  private startCodeKey(rideId: string) {
    return `${START_CODE_PREFIX}${rideId}`;
  }

  private async storeStartCode(
    rideId: string,
    plain: string,
    ttlSec: number = START_CODE_TTL_SEC,
  ): Promise<void> {
    const hash = this.hashStartCode(rideId, plain);
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    await this.rides.update(
      { id: rideId },
      {
        startCodeHash: hash,
        startCodeAttempts: 0,
        startCodeExpiresAt: expiresAt,
      },
    );
    const record: StartCodeRecord = {
      hash,
      plain,
      attempts: 0,
    };
    try {
      await this.redis.setex(
        this.startCodeKey(rideId),
        ttlSec,
        JSON.stringify(record),
      );
    } catch (error) {
      this.logger.warn(
        `Start-code display cache failed for ${rideId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * One-shot route SMS when a guest trip starts (pickup / dropoff / quoted km).
   */
  private async sendGuestTripStartedSmsOnce(ride: Ride): Promise<void> {
    if (!ride.isGuest || !ride.guestPhoneE164) return;
    const lockKey = `ride:guest-trip-sms:${ride.id}`;
    const locked = await this.redis
      .set(lockKey, '1', 'EX', 86400, 'NX')
      .catch(() => null);
    if (locked !== 'OK') return;

    const distanceKm = formatKm(
      ride.distanceM != null && ride.distanceM > 0
        ? ride.distanceM
        : 0,
      true,
    );
    const body = guestTripStartedSms({
      tripRef: shortTripRef(ride.id),
      pickup: placeLabel(ride.pickupAddress, ride.pickup),
      dropoff: placeLabel(ride.dropoffAddress, ride.dropoff),
      distanceKm,
    });
    try {
      await this.sms.send(ride.guestPhoneE164, body);
    } catch (error) {
      await this.redis.del(lockKey).catch(() => undefined);
      throw error;
    }
  }

  /**
   * One-shot fare receipt SMS after guest trip completion. Includes actual km,
   * start/destination, fare, and payment status. Idempotent via
   * guestFareSmsSentAt + Redis NX.
   */
  private async sendGuestFareSmsOnce(
    rideId: string,
    fareEtb: string,
  ): Promise<void> {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride?.isGuest || !ride.guestPhoneE164) return;
    if (ride.guestFareSmsSentAt) return;

    const lockKey = `ride:guest-fare-sms:${rideId}`;
    const locked = await this.redis
      .set(lockKey, '1', 'EX', 86400, 'NX')
      .catch(() => null);
    if (locked !== 'OK') return;

    const payment = await this.payments.findOne({
      where: { rideId, type: PaymentType.FARE },
      order: { createdAt: 'DESC' },
    });
    const paymentStatus = formatPaymentStatusLabel(payment?.status ?? null);
    const actualM =
      ride.actualDistanceM != null && ride.actualDistanceM > 0
        ? ride.actualDistanceM
        : (ride.distanceM ?? 0);
    const durationMin =
      ride.actualDurationS != null && ride.actualDurationS > 0
        ? String(Math.max(1, Math.round(ride.actualDurationS / 60)))
        : ride.durationS != null && ride.durationS > 0
          ? String(Math.max(1, Math.round(ride.durationS / 60)))
          : null;

    const body = guestFareCompleteSms({
      tripRef: shortTripRef(rideId),
      pickup: placeLabel(ride.pickupAddress, ride.pickup),
      dropoff: placeLabel(ride.dropoffAddress, ride.dropoff),
      distanceKm: formatKm(actualM, true),
      durationMinutes: durationMin,
      fareEtb: String(fareEtb),
      paymentStatus,
    });

    try {
      await this.sms.send(ride.guestPhoneE164, body);
      await this.rides.update(
        { id: rideId, guestFareSmsSentAt: IsNull() },
        { guestFareSmsSentAt: new Date() },
      );
    } catch (error) {
      await this.redis.del(lockKey).catch(() => undefined);
      throw error;
    }
  }

  private rideHasStartCodeGate(
    ride: Pick<Ride, 'startCodeHash' | 'startCodeExpiresAt'>,
  ): boolean {
    if (!ride.startCodeHash) return false;
    if (
      ride.startCodeExpiresAt &&
      ride.startCodeExpiresAt.getTime() <= Date.now()
    ) {
      return false;
    }
    return true;
  }

  private async clearStartCode(rideId: string): Promise<void> {
    await this.rides.update(
      { id: rideId },
      { startCodeHash: null, startCodeAttempts: 0, startCodeExpiresAt: null },
    );
    try {
      await this.redis.del(this.startCodeKey(rideId));
    } catch (error) {
      this.logger.warn(
        `Start-code cache delete failed for ${rideId}: ${(error as Error).message}`,
      );
    }
  }

  private async readStartCode(rideId: string): Promise<StartCodeRecord | null> {
    const raw = await this.redis.get(this.startCodeKey(rideId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StartCodeRecord;
    } catch {
      return null;
    }
  }

  private async consumeStartCode(rideId: string, code: string): Promise<void> {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride || !this.rideHasStartCodeGate(ride)) {
      throw new UnauthorizedException(
        ride?.isGuest
          ? 'Security code expired — tap Resend code to send a new SMS'
          : 'Security code expired — ask the rider to reopen the app',
      );
    }
    if ((ride.startCodeAttempts ?? 0) >= START_CODE_MAX_ATTEMPTS) {
      await this.clearStartCode(rideId);
      throw new UnauthorizedException(
        'Too many incorrect codes — cancel and create the trip again',
      );
    }
    if (ride.startCodeHash !== this.hashStartCode(rideId, code)) {
      const rows: Array<{ startCodeAttempts: number }> = await this.rides.query(
        `UPDATE rides
            SET "startCodeAttempts" = "startCodeAttempts" + 1
          WHERE id = $1 AND "startCodeHash" IS NOT NULL
          RETURNING "startCodeAttempts"`,
        [rideId],
      );
      const attempts = Number(rows[0]?.startCodeAttempts ?? 0);
      if (attempts >= START_CODE_MAX_ATTEMPTS) {
        await this.clearStartCode(rideId);
        throw new UnauthorizedException(
          'Too many incorrect codes — cancel and create the trip again',
        );
      }
      throw new UnauthorizedException('Incorrect security code');
    }
    const consumed = await this.rides.update(
      { id: rideId, startCodeHash: ride.startCodeHash },
      { startCodeHash: null, startCodeAttempts: 0, startCodeExpiresAt: null },
    );
    if (!consumed.affected) {
      throw new UnauthorizedException(
        'Security code expired — ask the rider to reopen the app',
      );
    }
    try {
      await this.redis.del(this.startCodeKey(rideId));
    } catch {
      // Display cache only — the Postgres gate is already consumed.
    }
  }

  private hashStartCode(rideId: string, code: string): string {
    const pepper =
      this.config.get<string>('JWT_ACCESS_SECRET') ?? 'start-code-dev-pepper';
    return createHash('sha256')
      .update(`${pepper}:${rideId}:${code}`)
      .digest('hex');
  }

  private async attachStartCodeForViewer(
    enriched: EnrichedRide,
    ride: Ride,
    viewerId: string,
  ): Promise<EnrichedRide> {
    const gated =
      this.rideHasStartCodeGate(ride) &&
      (ride.status === RideStatus.ACCEPTED ||
        ride.status === RideStatus.ARRIVING);
    if (!gated) {
      return { ...enriched, requiresStartCode: false, startCode: null };
    }
    const record = await this.readStartCode(ride.id);
    if (viewerId === ride.riderId) {
      return {
        ...enriched,
        requiresStartCode: true,
        startCode: record?.plain ?? null,
      };
    }
    // Driver / staff: know a code is required, never see the digits.
    return { ...enriched, requiresStartCode: true, startCode: null };
  }

  /**
   * Batched enrichment — one query per related table for the whole page
   * instead of five per ride.
   */
  async invalidateDriverStatusCache(
    driverId: string | null | undefined,
  ): Promise<void> {
    if (!driverId) return;
    try {
      await this.redis.del(`driver:status:${driverId}`);
    } catch {}
  }

  private async enrichRides(rides: Ride[]): Promise<EnrichedRide[]> {
    if (rides.length === 0) return [];

    const rideIds = rides.map((ride) => ride.id);
    const driverIds = [
      ...new Set(
        rides.map((ride) => ride.driverId).filter((id): id is string => !!id),
      ),
    ];

    const [
      fares,
      tips,
      drivers,
      vehicles,
      profiles,
      photoByDriver,
      adByRide,
      walletByRide,
    ] = await Promise.all([
      this.fares.find({ where: { rideId: In(rideIds) } }),
      this.tips.find({ where: { rideId: In(rideIds) } }),
      driverIds.length
        ? this.users.find({ where: { id: In(driverIds) } })
        : Promise.resolve<UserAccount[]>([]),
      driverIds.length
        ? this.vehicles.find({ where: { driverId: In(driverIds) } })
        : Promise.resolve<Vehicle[]>([]),
      driverIds.length
        ? this.driverProfiles.find({ where: { userId: In(driverIds) } })
        : Promise.resolve<DriverProfile[]>([]),
      this.kycService.mapDriverPhotoUrls(driverIds),
      this.adRewards
        ? this.adRewards.settlementsByRideIds(rideIds)
        : Promise.resolve(new Map()),
      this.adRewards
        ? this.adRewards.walletCreditsByRideIds(rideIds)
        : Promise.resolve(new Map()),
    ]);

    const fareByRide = new Map(fares.map((fare) => [fare.rideId, fare]));
    const tipByRide = new Map(tips.map((tip) => [tip.rideId, tip]));
    const driverById = new Map(drivers.map((driver) => [driver.id, driver]));
    const vehicleByDriver = new Map(
      vehicles.map((vehicle) => [vehicle.driverId, vehicle]),
    );
    const profileByDriver = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );

    const calculatedFares = await Promise.all(
      rides.map(async (ride) => {
        const persisted = fareByRide.get(ride.id);
        if (persisted) {
          const baseFare = Number(persisted.baseFare ?? 0);
          const distanceFare = Number(persisted.distanceFare ?? 0);
          const timeFare = Number(persisted.timeFare ?? 0);
          const total = Number(
            persisted.total ?? baseFare + distanceFare + timeFare,
          );
          return {
            total,
            initialFee: baseFare,
            distanceCharge: distanceFare,
            timeCharge: timeFare,
            waitCharge: 0,
            surgeMultiplier: Number(persisted.surgeMultiplier ?? 1),
            vehicleMultiplier: 1,
            platformFee: 0,
            distanceMeters: ride.distanceM ?? 0,
            durationMinutes: ride.durationS ? ride.durationS / 60 : 0,
          };
        }
        try {
          const distanceKm = ride.distanceM
            ? ride.distanceM / 1000
            : this.fareService.quotedTripMetrics(ride.pickup, ride.dropoff)
                .distanceKm;
          const durationMinutes = ride.durationS
            ? ride.durationS / 60
            : this.fareService.estimateDurationMinutes(distanceKm);
          return await this.fareService.calculate(
            {
              distanceKm,
              durationMinutes,
              zoneId: zoneIdFor(ride.pickup),
              surgeMultiplier: ride.quotedSurgeMultiplier ?? undefined,
              vehicleType: ride.vehicleType,
              vehicleMultipliers: await this.vehicleMultipliersForRide(ride),
            },
            ride.quotedFareRates,
          );
        } catch (error) {
          this.logger.error(
            `Fare unavailable for ride ${ride.id}: ${(error as Error).message}`,
          );
          throw new ServiceUnavailableException(
            'Fare calculation unavailable — please retry',
          );
        }
      }),
    );

    return rides.map((ride, idx) => {
      const tip = tipByRide.get(ride.id);
      const driver = ride.driverId ? driverById.get(ride.driverId) : undefined;
      const vehicle = ride.driverId
        ? vehicleByDriver.get(ride.driverId)
        : undefined;
      const profile = ride.driverId
        ? profileByDriver.get(ride.driverId)
        : undefined;
      const fareRec = fareByRide.get(ride.id);
      const estFare = calculatedFares[idx];
      const storedBreakdown =
        (ride.fareBreakdown as Record<string, unknown> | null) ?? null;
      const ad = adByRide.get(ride.id);
      const wallet = walletByRide.get(ride.id);
      const grossFareEtb = fareRec
        ? Number(fareRec.total)
        : estFare.total;
      const advertisingDiscountEtb = wallet
        ? wallet.adMinor / 100
        : ad
          ? ad.appliedDiscountMinor / 100
          : 0;
      const promotionDiscountEtb = wallet ? wallet.promoMinor / 100 : 0;
      const driverHebirCreditEtb = wallet
        ? wallet.totalMinor / 100
        : ad
          ? ad.driverHebirCreditMinor / 100
          : 0;
      const riderCashDueEtb = Math.max(
        0,
        grossFareEtb - advertisingDiscountEtb - promotionDiscountEtb,
      );

      const distanceKm =
        ride.actualDistanceM != null
          ? ride.actualDistanceM / 1000
          : ride.distanceM
            ? ride.distanceM / 1000
            : Math.round(estFare.distanceMeters) / 1000;
      const durationMinutes =
        ride.actualDurationS != null
          ? Math.round(ride.actualDurationS / 60)
          : ride.durationS
            ? Math.round(ride.durationS / 60)
            : Math.round(estFare.durationMinutes);

      return {
        ...ride,
        distanceKm,
        durationMinutes,
        grossFareEtb,
        riderCashDueEtb,
        advertisingDiscountEtb,
        promotionDiscountEtb,
        driverHebirCreditEtb,
        estimatedFare: fareRec
          ? {
              total: Number(fareRec.total),
              initialFee: Number(fareRec.baseFare),
              distanceCharge: Number(fareRec.distanceFare),
              timeCharge: Number(fareRec.timeFare),
              waitCharge: 0,
              surgeMultiplier: Number(fareRec.surgeMultiplier),
              platformFee: Number(fareRec.platformFee),
              settlementStatus:
                storedBreakdown?.settlementStatus ?? ride.settlementStatus,
              estimateReason: storedBreakdown?.estimateReason ?? null,
              earlyDropoff: storedBreakdown?.earlyDropoff === true,
              gpsGapEstimated:
                storedBreakdown?.gpsGapEstimated === true ||
                ride.settlementStatus === RideSettlementStatus.ESTIMATED,
              riderCashDueEtb,
              advertisingDiscountEtb,
              promotionDiscountEtb,
              driverHebirCreditEtb,
            }
          : {
              total: estFare.total,
              initialFee: estFare.initialFee,
              distanceCharge: estFare.distanceCharge,
              timeCharge: estFare.timeCharge,
              waitCharge: estFare.waitCharge,
              surgeMultiplier: estFare.surgeMultiplier,
              vehicleMultiplier: estFare.vehicleMultiplier,
              platformFee: estFare.platformFee,
              riderCashDueEtb,
              advertisingDiscountEtb,
              promotionDiscountEtb,
              driverHebirCreditEtb,
            },
        // Internal dispatch bookkeeping — a rider must never learn which
        // driver an open offer went to before that driver accepts.
        offerDriverId: null,
        offerExpiresAt: null,
        startCodeHash: null,
        startCodeAttempts: 0,
        startCodeExpiresAt: null,
        // Never expose guest MSISDN to clients after create.
        guestPhoneE164: null,
        isGuest: ride.isGuest === true,
        isStreetHail: ride.isStreetHail === true,
        fare: fareRec ?? null,
        tipAmount: tip ? Number(tip.amount) : 0,
        driver: driver
          ? {
              fullName: driver.fullName,
              username: driver.username,
              // Exposed only after assignment so the rider can place a call
              // during an active trip (privacy: never present on open offers).
              phoneNumber: driver.phoneNumber ?? null,
              rating: Number(profile?.ratingAvg ?? 0),
              photoUrl: ride.driverId
                ? (photoByDriver.get(ride.driverId) ?? null)
                : null,
            }
          : null,
        vehicle: vehicle
          ? {
              make: vehicle.make,
              model: vehicle.model,
              makeModel: `${vehicle.make} ${vehicle.model}`.trim(),
              plate: vehicle.plate,
              color: vehicle.color,
              capacity: vehicle.capacity,
            }
          : null,
      };
    });
  }

  private async markUnmatched(rideId: string): Promise<void> {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) return;

    const closed = await this.rides.update(
      {
        id: rideId,
        status: In([
          RideStatus.SEARCHING,
          RideStatus.OFFERED,
          RideStatus.REQUESTED,
        ]),
      },
      {
        status: RideStatus.UNMATCHED,
        offerDriverId: null,
        offerExpiresAt: null,
      },
    );
    if (!closed.affected) return;
    await this.logEvent(
      rideId,
      RideStatus.UNMATCHED,
      'Dispatch window elapsed with no driver',
    );

    // The window can elapse while an offer is still open; without this the
    // driver would stay `reserved` forever and never be offered another ride.
    if (ride.offerDriverId) {
      await this.releaseOfferedDriver(ride.offerDriverId, rideId);
      await this.notify(ride.offerDriverId, 'ride.status_changed', {
        rideId,
        status: RideStatus.UNMATCHED,
        updatedAt: new Date().toISOString(),
      });
      await this.notify(ride.offerDriverId, 'ride.unmatched', { rideId });
    }

    await this.notify(ride.riderId, 'ride.unmatched', { rideId });
    await this.dispatchQueue.clearState(rideId);
    this.releaseOnDemandRequest(ride.riderId);
    this.logger.warn(
      `Ride ${rideId}: unmatched — dispatch window elapsed with no driver`,
    );
  }

  private async logEvent(
    rideId: string,
    status: RideStatus,
    note?: string,
  ): Promise<void> {
    await this.rideStatusEvents.save(
      this.rideStatusEvents.create({ rideId, status, note: note ?? null }),
    );
  }

  /**
   * Notifications are advisory: a Redis pub/sub failure must not abort a
   * dispatch job or roll a caller's state transition back.
   */
  private async notify(
    userId: string | null | undefined,
    event: string,
    payload: unknown,
  ): Promise<void> {
    if (!userId) return;
    try {
      await this.notifications.notify(userId, event, payload);
    } catch (error) {
      this.logger.warn(
        `notify ${event} → ${userId} failed: ${(error as Error).message}`,
      );
    }
  }

  /** On-demand surge: distinct rider in the pickup H3 hex while searching. */
  private recordOnDemandRequest(
    pickup: GeoPoint,
    riderId: string | null | undefined,
  ): void {
    if (!riderId) return;
    if (!this.locationSvc.enabled || this.locationSvc.isOpen) return;
    void this.locationSvc
      .post(
        '/demand/request',
        {
          location: pickup,
          riderId,
          zoneId: zoneIdFor(pickup),
        },
        1000,
      )
      .catch((error: Error) => {
        this.logger.warn(`on-demand demand signal failed: ${error.message}`);
      });
  }

  /**
   * Drop rider from live demand when their marketplace search ends.
   * Skips release when another SEARCHING/OFFERED ride already exists for the
   * same rider (Retry can race a late unmatched release).
   */
  private releaseOnDemandRequest(riderId: string | null | undefined): void {
    if (!riderId) return;
    if (!this.locationSvc.enabled || this.locationSvc.isOpen) return;
    void (async () => {
      try {
        const stillSearching = await this.rides.findOne({
          where: {
            riderId,
            status: In([
              RideStatus.REQUESTED,
              RideStatus.SEARCHING,
              RideStatus.OFFERED,
            ]),
          },
          select: { id: true },
        });
        if (stillSearching) {
          this.logger.log(
            `Demand release skipped for ${riderId}: ride ${stillSearching.id} still active`,
          );
          return;
        }
        await this.locationSvc.post('/demand/release', { riderId }, 1000);
      } catch (error) {
        this.logger.warn(
          `on-demand demand release failed: ${(error as Error).message}`,
        );
      }
    })();
  }

  /**
   * Assigned-driver GPS for reconnect. Authorization is ride membership —
   * never a raw driver id from the client.
   */
  async getAssignedDriverLocation(rideId: string, viewer: RideViewer) {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');

    const isParticipant =
      ride.riderId === viewer.userId || ride.driverId === viewer.userId;
    const isStaff = (viewer.roles ?? []).some(
      (role) => role === UserRole.ADMIN || role === UserRole.GOV_OFFICER,
    );
    if (!isParticipant && !isStaff) {
      throw new ForbiddenException('You are not a participant on this ride');
    }
    if (!ride.driverId) {
      throw new NotFoundException('No driver assigned to this ride');
    }
    if (!LIVE_DRIVER_TRIP_STATUSES.includes(ride.status)) {
      throw new ConflictException('This ride is not being tracked');
    }
    if (!this.locationSvc.enabled || this.locationSvc.isOpen) {
      throw new ServiceUnavailableException('location-svc unavailable');
    }
    try {
      const loc = await this.locationSvc.get<{
        lat?: number;
        lng?: number;
        heading?: number | null;
        speed?: number | null;
        accuracy?: number | null;
        timestampMs?: number;
      }>(`/drivers/point/${ride.driverId}`, undefined, 1500);
      const eta =
        loc?.lat != null && loc?.lng != null
          ? remainingEta({
              driver: { lat: loc.lat, lng: loc.lng },
              speedMps: loc.speed,
              pickup: ride.pickup,
              dropoff: ride.dropoff,
              status: ride.status,
              quotedDistanceM: ride.distanceM,
              quotedDurationS: ride.durationS,
            })
          : null;
      return { ...loc, ...eta };
    } catch {
      throw new NotFoundException('Driver location is not live');
    }
  }

  /**
   * Arrive and start must happen near the pin. Landmark pickups in Addis plus
   * cheap GNSS need a generous radius, not a lane-level fence. Completion is
   * intentionally not geofenced so a driver can settle an already-started trip
   * when their final GPS update is stale or unavailable.
   */
  private async assertDriverWithin(
    driverId: string,
    target: GeoPoint,
    radiusM: number,
    action: string,
    place: 'pickup' | 'destination',
  ): Promise<void> {
    const point = await this.readLiveDriverPoint(driverId);
    if (!point) {
      if (
        treatAsProductionRuntime(
          this.config.get<string>('NODE_ENV'),
          this.config.get<string>('PUBLIC_API_BASE_URL'),
        )
      ) {
        throw new UnprocessableEntityException(
          `GPS is required to ${action}. Wait for a location fix and try again.`,
        );
      }
      this.logger.warn(
        `geofence skipped for ${action}: no live GPS (non-production)`,
      );
      return;
    }
    const metres = metresBetween(point, target);
    if (metres <= radiusM) return;
    throw new UnprocessableEntityException(
      `You are ${Math.round(metres)} m from the ${place}. Move within ${radiusM} m to ${action}.`,
    );
  }

  private async readLiveDriverPoint(
    driverId: string,
  ): Promise<GeoPoint | null> {
    if (this.locationSvc.enabled && !this.locationSvc.isOpen) {
      try {
        const loc = await this.locationSvc.get<{ lat?: number; lng?: number }>(
          `/drivers/point/${driverId}`,
          undefined,
          1200,
        );
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
          return { lat: loc.lat as number, lng: loc.lng as number };
        }
      } catch {
        // Fall through to the thinned Postgres history.
      }
    }
    try {
      const rows: Array<{ lat: number; lng: number }> = await this.rides.query(
        `SELECT lat, lng
           FROM driver_location_history
          WHERE "driverId"::text = $1
            AND "recordedAt" > NOW() - interval '90 seconds'
          ORDER BY "recordedAt" DESC
          LIMIT 1`,
        [driverId],
      );
      if (rows[0] && Number.isFinite(Number(rows[0].lat))) {
        return { lat: Number(rows[0].lat), lng: Number(rows[0].lng) };
      }
    } catch (error) {
      this.logger.warn(
        `geofence history lookup failed: ${(error as Error).message}`,
      );
    }
    return null;
  }

  /**
   * Candidate drivers near a pickup. Prefer H3 hex-ring supply sets from
   * location-svc (same cells as demand heat), then Redis GEO radius, then
   * Postgres location history so dispatch degrades instead of silently
   * reporting "no drivers nearby".
   */
  private async findNearbyDrivers(
    pickup: GeoPoint,
    radiusKm: number,
    hexRing = 0,
  ): Promise<{
    driverIds: string[];
    source: 'location-svc-hex' | 'location-svc' | 'db-fallback';
  }> {
    const zoneIds = hexCellsAround(pickup, hexRing);
    if (this.locationSvc.enabled && !this.locationSvc.isOpen) {
      try {
        const hexData = await this.locationSvc.post<{ driverIds: string[] }>(
          '/drivers/nearby-zones',
          { zoneIds, pickup, radiusKm, limit: 40 },
          1500,
        );
        const hexIds = hexData.driverIds ?? [];
        if (hexIds.length > 0) {
          return { driverIds: hexIds, source: 'location-svc-hex' };
        }
      } catch (error) {
        this.logger.warn(
          `Hex nearby lookup failed (ring=${hexRing}): ${(error as Error).message}`,
        );
      }
      try {
        const data = await this.locationSvc.post<{ driverIds: string[] }>(
          '/drivers/nearby',
          { pickup, radiusKm },
          1500,
        );
        const driverIds = data.driverIds ?? [];
        // Empty geo index (Redis flush / cold start) must not look like
        // "no drivers in the city" when Postgres still has fresh samples.
        if (driverIds.length > 0) {
          return { driverIds, source: 'location-svc' };
        }
        this.logger.warn(
          `Nearby driver lookup empty from location-svc (radius=${radiusKm}km); trying db-fallback`,
        );
      } catch (error) {
        this.logger.error(
          `Nearby driver lookup failed (radius=${radiusKm}km): ${(error as Error).message}`,
        );
      }
    }
    return {
      driverIds: await this.nearbyDriverIdsFromHistory(pickup, radiusKm),
      source: 'db-fallback',
    };
  }

  /**
   * Degraded nearest-first lookup straight from `driver_location_history`.
   * Bounded by a lat/lng box and a per-driver latest sample so the scan stays
   * proportional to the online fleet in the box, not to history size.
   */
  private async nearbyDriverIdsFromHistory(
    pickup: GeoPoint,
    radiusKm: number,
  ): Promise<string[]> {
    const latDelta = radiusKm / 111;
    const lngDelta =
      radiusKm / (111 * Math.max(0.1, Math.cos((pickup.lat * Math.PI) / 180)));
    try {
      const rows: Array<{ driverId: string; lat: number; lng: number }> =
        await this.driverProfiles.query(
          `SELECT DISTINCT ON (h."driverId") h."driverId", h.lat, h.lng
             FROM driver_location_history h
             JOIN driver_profiles p ON p."userId"::text = h."driverId"::text
            WHERE p.status = $1
              AND h."recordedAt" > NOW() - ($2::text || ' seconds')::interval
              AND h.lat BETWEEN $3 AND $4
              AND h.lng BETWEEN $5 AND $6
            ORDER BY h."driverId", h."recordedAt" DESC
            LIMIT $7`,
          [
            DriverStatus.ONLINE,
            String(STALE_LOCATION_SECONDS),
            pickup.lat - latDelta,
            pickup.lat + latDelta,
            pickup.lng - lngDelta,
            pickup.lng + lngDelta,
            FALLBACK_CANDIDATE_LIMIT,
          ],
        );

      return rows
        .map((row) => ({
          driverId: row.driverId,
          distanceKm: haversineKm(pickup, {
            lat: Number(row.lat),
            lng: Number(row.lng),
          }),
        }))
        .filter(
          (row) =>
            Number.isFinite(row.distanceKm) && row.distanceKm <= radiusKm,
        )
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .map((row) => row.driverId);
    } catch (error) {
      this.logger.error(
        `Fallback nearby lookup failed (radius=${radiusKm}km): ${(error as Error).message}`,
      );
      return [];
    }
  }

  private async filterEligibleDrivers(
    driverIds: string[],
    excludeIds: Set<string>,
    vehicleType?: string | null,
  ): Promise<DriverProfile[]> {
    const malformed = driverIds.filter((id) => !UUID_PATTERN.test(id));
    if (malformed.length > 0) {
      // The geo index is a separate store that anything reaching location-svc
      // can write to. A single malformed member used to fail the whole
      // `userId IN (...)` query and stall dispatch for every ride.
      this.logger.warn(
        `Dispatch: ignored ${malformed.length} malformed candidate id(s), e.g. ${malformed[0]}`,
      );
    }
    const candidateIds = driverIds.filter(
      (id) => !excludeIds.has(id) && UUID_PATTERN.test(id),
    );
    if (candidateIds.length === 0) return [];

    const [profiles, activeIds, vehicles] = await Promise.all([
      this.driverProfiles.find({
        where: { userId: In(candidateIds), status: DriverStatus.ONLINE },
      }),
      this.subscriptionService.filterMarketplaceDriverIds(candidateIds),
      this.vehicles.find({ where: { driverId: In(candidateIds) } }),
    ]);

    const kycApproved = this.isKycEnforced()
      ? await this.kycService.filterApprovedDriverIds(
          profiles.map((profile) => profile.userId),
        )
      : null;

    const vehicleByDriver = new Map(vehicles.map((v) => [v.driverId, v]));
    const wanted = (vehicleType ?? 'any').toLowerCase().trim();

    return profiles.filter((profile) => {
      if (!activeIds.has(profile.userId)) return false;
      if (kycApproved && !kycApproved.has(profile.userId)) return false;
      if (!wanted || wanted === 'any') return true;
      const vehicle = vehicleByDriver.get(profile.userId);
      if (!vehicle) return false;
      if (!this.vehicleMatchesType(vehicle.capacity, wanted)) return false;
      // A driver with an XL vehicle can elect to accept standard trips too,
      // or turn either category off. The preference is enforced server-side
      // so an old app cannot receive an opted-out request.
      const selected = profile.acceptedVehicleTypes;
      return !selected || selected.includes(wanted);
    });
  }

  async getDriverServicePreferences(driverId: string) {
    const [profile, vehicle] = await Promise.all([
      this.driverProfiles.findOne({ where: { userId: driverId } }),
      this.vehicles.findOne({ where: { driverId } }),
    ]);
    const eligibleVehicleTypes = vehicle
      ? this.eligibleVehicleTypesForCapacity(vehicle.capacity)
      : [];
    const selected = (
      profile?.acceptedVehicleTypes ?? eligibleVehicleTypes
    ).filter((type) => eligibleVehicleTypes.includes(type));
    return { eligibleVehicleTypes, acceptedVehicleTypes: selected };
  }

  async setDriverServicePreferences(
    driverId: string,
    requestedTypes: string[],
  ) {
    const profile = await this.driverProfiles.findOne({
      where: { userId: driverId },
    });
    if (!profile) throw new NotFoundException('Driver profile not found');
    const vehicle = await this.vehicles.findOne({ where: { driverId } });
    if (!vehicle)
      throw new BadRequestException('Add an approved vehicle first');
    const eligibleVehicleTypes = this.eligibleVehicleTypesForCapacity(
      vehicle.capacity,
    );
    const acceptedVehicleTypes = [
      ...new Set(requestedTypes.map((type) => normalizeRideVehicleType(type))),
    ];
    if (
      acceptedVehicleTypes.length === 0 ||
      acceptedVehicleTypes.some((type) => !eligibleVehicleTypes.includes(type))
    ) {
      throw new BadRequestException(
        'A service preference must match your verified vehicle capacity',
      );
    }
    profile.acceptedVehicleTypes = acceptedVehicleTypes;
    await this.driverProfiles.save(profile);
    return { eligibleVehicleTypes, acceptedVehicleTypes };
  }

  private eligibleVehicleTypesForCapacity(capacity: number): string[] {
    if (capacity <= 2) return ['moto'];
    if (capacity >= 5) return ['sedan', 'suv'];
    return ['sedan'];
  }

  /** Map request vehicleType to capacity bands on seeded fleet vehicles. */
  private vehicleMatchesType(capacity: number, vehicleType: string): boolean {
    if (
      vehicleType.includes('moto') ||
      vehicleType.includes('motor') ||
      vehicleType.includes('bike')
    ) {
      return capacity <= 2;
    }
    if (
      vehicleType.includes('suv') ||
      vehicleType.includes('van') ||
      vehicleType.includes('xl')
    ) {
      return capacity >= 5;
    }
    if (vehicleType.includes('sedan') || vehicleType.includes('car')) {
      return capacity >= 3 && capacity <= 5;
    }
    return true;
  }

  /**
   * Rank by road-network pickup ETA when Directions is available, else
   * GEO/haversine order, then rating and idle time.
   */
  private async rankCandidatesByPickupEta(
    eligible: DriverProfile[],
    nearestFirstDriverIds: string[],
    pickup: GeoPoint,
  ): Promise<DriverProfile[]> {
    if (eligible.length <= 1) return eligible;

    const geoRank = new Map(
      nearestFirstDriverIds.map((id, index) => [id, index]),
    );
    const etaBudget = Math.min(8, eligible.length);
    const top = [...eligible]
      .sort(
        (a, b) =>
          (geoRank.get(a.userId) ?? Number.MAX_SAFE_INTEGER) -
          (geoRank.get(b.userId) ?? Number.MAX_SAFE_INTEGER),
      )
      .slice(0, etaBudget);

    const etaSeconds = new Map<string, number>();
    await Promise.all(
      top.map(async (profile) => {
        const point = await this.resolveDriverPoint(profile.userId);
        if (!point) return;
        const chordKm = haversineKm(point, pickup);
        if (!Number.isFinite(chordKm)) return;
        let seconds = Math.round((chordKm * 1000 * 1.25) / 6.1);
        if (this.googleRoutes.isEnabled && chordKm <= 12) {
          try {
            const route = await this.googleRoutes.getDirections(point, pickup);
            if (route?.durationS && route.durationS > 0) {
              seconds = route.durationS;
            }
          } catch {
            // Keep haversine proxy.
          }
        }
        etaSeconds.set(profile.userId, seconds);
      }),
    );

    return [...eligible].sort((a, b) => {
      const aEta =
        etaSeconds.get(a.userId) ??
        ((geoRank.get(a.userId) ?? 999) + 1) * 60;
      const bEta =
        etaSeconds.get(b.userId) ??
        ((geoRank.get(b.userId) ?? 999) + 1) * 60;
      if (aEta !== bEta) return aEta - bEta;

      const ratingDiff = Number(b.ratingAvg) - Number(a.ratingAvg);
      if (ratingDiff !== 0) return ratingDiff;

      const aIdle = a.idleSince ? a.idleSince.getTime() : 0;
      const bIdle = b.idleSince ? b.idleSince.getTime() : 0;
      return aIdle - bIdle;
    });
  }

  private async resolveDriverPoint(
    driverId: string,
  ): Promise<GeoPoint | null> {
    if (this.locationSvc.enabled && !this.locationSvc.isOpen) {
      try {
        const loc = await this.locationSvc.get<{ lat?: number; lng?: number }>(
          `/drivers/point/${driverId}`,
          undefined,
          800,
        );
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
          return { lat: Number(loc.lat), lng: Number(loc.lng) };
        }
      } catch {
        // Fall through to history.
      }
    }
    try {
      const rows: Array<{ lat: number; lng: number }> =
        await this.driverProfiles.query(
          `SELECT lat, lng FROM driver_location_history
            WHERE "driverId"::text = $1
            ORDER BY "recordedAt" DESC LIMIT 1`,
          [driverId],
        );
      if (
        rows[0] &&
        Number.isFinite(rows[0].lat) &&
        Number.isFinite(rows[0].lng)
      ) {
        return { lat: Number(rows[0].lat), lng: Number(rows[0].lng) };
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * location-svc's /drivers/nearby already returns driverIds ordered
   * nearest-first (it wraps geo.Store.NearestDrivers, which sorts by
   * haversine distance under the hood) — we don't get raw coordinates
   * back over that contract, so we treat that ordering as the ETA proxy
   * and use it as the primary sort key, then break ties by rating and
   * how long the driver has been idle.
   */
  private rankCandidates(
    eligible: DriverProfile[],
    nearestFirstDriverIds: string[],
  ): DriverProfile[] {
    const etaRank = new Map(
      nearestFirstDriverIds.map((id, index) => [id, index]),
    );

    return [...eligible].sort((a, b) => {
      const etaDiff =
        (etaRank.get(a.userId) ?? Number.MAX_SAFE_INTEGER) -
        (etaRank.get(b.userId) ?? Number.MAX_SAFE_INTEGER);
      if (etaDiff !== 0) return etaDiff;

      const ratingDiff = Number(b.ratingAvg) - Number(a.ratingAvg);
      if (ratingDiff !== 0) return ratingDiff;

      const aIdle = a.idleSince ? a.idleSince.getTime() : 0;
      const bIdle = b.idleSince ? b.idleSince.getTime() : 0;
      return aIdle - bIdle;
    });
  }

  /**
   * Safety net for dispatch state that no queue job will ever resolve —
   * a lost Redis job, a crash between "offer written" and "offer_check
   * scheduled", or a Redis flush. Without it a ride can sit in `offered`
   * forever and its driver stays `reserved`, permanently unable to work.
   * Idempotent: everything it does is a guarded conditional UPDATE.
   */
  async reapStalledDispatch(): Promise<{
    expiredOffers: number;
    unmatched: number;
    freedDrivers: number;
    staleMatched: number;
  }> {
    const now = Date.now();
    let expiredOffers = 0;
    let unmatched = 0;
    let staleMatched = 0;

    const staleOffers = await this.rides.find({
      where: [
        {
          status: RideStatus.OFFERED,
          offerExpiresAt: LessThan(new Date(now - REAP_GRACE_MS)),
        },
        {
          // NULL expiry never matched LessThan — those offers stuck forever.
          status: RideStatus.OFFERED,
          offerExpiresAt: IsNull(),
          updatedAt: LessThan(new Date(now - OFFER_TIMEOUT_MS - REAP_GRACE_MS)),
        },
      ],
      order: { updatedAt: 'ASC' },
      take: REAP_BATCH_SIZE,
    });
    for (const ride of staleOffers) {
      if (!ride.offerDriverId) continue;
      await this.finishFailedOffer(ride.id, ride.offerDriverId, 'timeout');
      expiredOffers += 1;
    }

    const overdue = await this.rides.find({
      where: {
        status: In([RideStatus.REQUESTED, RideStatus.SEARCHING]),
        requestedAt: LessThan(new Date(now - MAX_DISPATCH_MS - REAP_GRACE_MS)),
      },
      order: { requestedAt: 'ASC' },
      take: REAP_BATCH_SIZE,
    });
    for (const ride of overdue) {
      await this.markUnmatched(ride.id);
      unmatched += 1;
    }

    // Accept claimed MATCHED then crashed. Marketplace trips rematch so the
    // rider is not forced to rebook; street-hail stays cancelled.
    const hungMatched = await this.rides.find({
      where: {
        status: RideStatus.MATCHED,
        matchedAt: LessThan(new Date(now - STALE_MATCHED_MS)),
      },
      order: { matchedAt: 'ASC' },
      take: REAP_BATCH_SIZE,
    });
    for (const ride of hungMatched) {
      if (ride.driverId && !this.rideHasStartCodeGate(ride)) {
        try {
          await this.rematchAfterDriverCancel(
            ride,
            ride.driverId,
            'Matching could not be confirmed; finding another driver',
          );
          staleMatched += 1;
          continue;
        } catch (error) {
          this.logger.warn(
            `Hung MATCHED rematch failed for ${ride.id}: ${(error as Error).message}`,
          );
        }
      }
      const closed = await this.rides.update(
        { id: ride.id, status: RideStatus.MATCHED },
        {
          status: RideStatus.CANCELLED,
          driverId: null,
          offerDriverId: null,
          offerExpiresAt: null,
        },
      );
      if (!closed.affected) continue;
      await this.logEvent(
        ride.id,
        RideStatus.CANCELLED,
        'Stale matched ride reaped (accept did not reach accepted)',
      );
      if (ride.driverId) {
        await this.releaseDriverToOnline(ride.driverId, [
          DriverStatus.RESERVED,
          DriverStatus.ON_TRIP,
        ]);
        await this.releaseDriverLock(ride.driverId, ride.id);
      }
      await this.dispatchQueue.clearState(ride.id);
      if (ride.riderId) {
        await this.notify(ride.riderId, 'ride.cancelled', {
          rideId: ride.id,
          reason: 'Matching could not be confirmed',
        });
        await this.notify(ride.riderId, 'ride.status_changed', {
          rideId: ride.id,
          status: RideStatus.CANCELLED,
        });
      }
      staleMatched += 1;
    }

    const freedDrivers =
      (await this.freeAbandonedReservations()) +
      (await this.freeStuckOnTripDrivers());
    const staleOnline = await this.offlineStaleGpsDrivers();

    if (
      expiredOffers ||
      unmatched ||
      freedDrivers ||
      staleMatched ||
      staleOnline
    ) {
      this.logger.warn(
        `Dispatch reaper: ${expiredOffers} expired offer(s), ${unmatched} unmatched, ` +
          `${staleMatched} stale matched, ${freedDrivers} driver(s) freed, ` +
          `${staleOnline} stale online→offline`,
      );
    }
    return { expiredOffers, unmatched, freedDrivers, staleMatched };
  }

  /**
   * ONLINE with no fresh GPS is a lie for ops metrics and for dispatch
   * eligibility once the history fallback window elapses. Drop them offline
   * (and out of Redis geo) so the fleet count matches who can actually match.
   */
  private async offlineStaleGpsDrivers(): Promise<number> {
    const stale: Array<{ userId: string }> = await this.driverProfiles.query(
      `SELECT p."userId"
         FROM driver_profiles p
         LEFT JOIN LATERAL (
           SELECT h."recordedAt"
             FROM driver_location_history h
            WHERE h."driverId" = p."userId"
            ORDER BY h."recordedAt" DESC
            LIMIT 1
         ) latest ON true
        WHERE p.status = $1
          AND (
            latest."recordedAt" IS NULL
            OR latest."recordedAt" < NOW() - ($2::text || ' seconds')::interval
          )
        LIMIT $3`,
      [DriverStatus.ONLINE, String(STALE_LOCATION_SECONDS), REAP_BATCH_SIZE],
    );
    let flipped = 0;
    for (const row of stale) {
      const updated = await this.driverProfiles.update(
        { userId: row.userId, status: DriverStatus.ONLINE },
        { status: DriverStatus.OFFLINE, idleSince: null },
      );
      if (!updated.affected) continue;
      await this.removeDriverFromGeoIndex(row.userId);
      flipped += 1;
    }
    return flipped;
  }

  /**
   * A `reserved` driver with no live offer row is stranded: setDriverPresence
   * refuses to take them offline and dispatch refuses to offer them work.
   */
  private async freeAbandonedReservations(): Promise<number> {
    const reserved = await this.driverProfiles.find({
      where: { status: DriverStatus.RESERVED },
      take: REAP_BATCH_SIZE,
    });
    if (reserved.length === 0) return 0;

    const liveOffers = await this.rides.find({
      where: {
        status: RideStatus.OFFERED,
        offerDriverId: In(reserved.map((profile) => profile.userId)),
        offerExpiresAt: MoreThan(new Date(Date.now() - REAP_GRACE_MS)),
      },
      select: { offerDriverId: true },
    });
    const stillOffered = new Set(
      liveOffers
        .map((ride) => ride.offerDriverId)
        .filter((id): id is string => !!id),
    );

    let freed = 0;
    for (const profile of reserved) {
      if (stillOffered.has(profile.userId)) continue;
      await this.redis.del(this.lockKey(profile.userId));
      const updated = await this.driverProfiles.update(
        { userId: profile.userId, status: DriverStatus.RESERVED },
        { status: DriverStatus.ONLINE, idleSince: new Date() },
      );
      freed += updated.affected ?? 0;
    }
    return freed;
  }

  /**
   * on_trip with no live assigned ride — e.g. accept/cancel race on older
   * builds, or completeRide crashing after the status write. Without this
   * the driver can never go offline or take another offer.
   */
  private async freeStuckOnTripDrivers(): Promise<number> {
    const onTrip = await this.driverProfiles.find({
      where: { status: DriverStatus.ON_TRIP },
      take: REAP_BATCH_SIZE,
    });
    if (onTrip.length === 0) return 0;

    const liveAssignments = await this.rides.find({
      where: {
        driverId: In(onTrip.map((profile) => profile.userId)),
        status: In(LIVE_DRIVER_TRIP_STATUSES),
      },
      select: { driverId: true },
    });
    const busy = new Set(
      liveAssignments
        .map((ride) => ride.driverId)
        .filter((id): id is string => !!id),
    );

    let freed = 0;
    for (const profile of onTrip) {
      if (busy.has(profile.userId)) continue;
      await this.redis.del(this.lockKey(profile.userId));
      const updated = await this.driverProfiles.update(
        { userId: profile.userId, status: DriverStatus.ON_TRIP },
        { status: DriverStatus.ONLINE, idleSince: new Date() },
      );
      freed += updated.affected ?? 0;
    }
    return freed;
  }

  private lockKey(driverId: string): string {
    return `ride:offer:driver:${driverId}`;
  }

  /** The lock holds the ride id so only its owner can release it. */
  private async tryLockDriver(
    driverId: string,
    rideId: string,
    ttlMs: number,
  ): Promise<boolean> {
    try {
      const result = await this.redis.set(
        this.lockKey(driverId),
        rideId,
        'PX',
        ttlMs,
        'NX',
      );
      return result === 'OK';
    } catch (error) {
      this.logger.warn(
        `Driver lock unavailable for ${driverId}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Compare-and-delete: a late offer_check from an earlier ride must not
   * free a driver who has since been locked for a different one. Returns
   * true only when this ride still owned the lock.
   */
  private async releaseDriverLock(
    driverId: string,
    rideId: string,
  ): Promise<boolean> {
    const deleted = await this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`,
      1,
      this.lockKey(driverId),
      rideId,
    );
    return Number(deleted) === 1;
  }

  /**
   * Drops this ride's hold on a driver: releases the lock and, only when the
   * lock was still ours, returns the profile to online. Guarding on lock
   * ownership stops a stale offer_check from freeing a driver who has since
   * been reserved for a different ride.
   */
  private async releaseOfferedDriver(
    driverId: string,
    rideId: string,
  ): Promise<void> {
    const owned = await this.releaseDriverLock(driverId, rideId);
    if (owned) {
      await this.releaseDriverToOnline(driverId);
      return;
    }
    // The lock TTL can lapse while the offer is still live. If no ride
    // still holds this driver, their RESERVED state is orphaned — free it
    // now instead of stranding them until the reaper runs.
    const holding = await this.rides.count({
      where: [
        { offerDriverId: driverId, status: RideStatus.OFFERED },
        {
          driverId,
          status: In(LIVE_DRIVER_TRIP_STATUSES),
        },
      ],
    });
    if (holding === 0) await this.releaseDriverToOnline(driverId);
  }

  /**
   * Only frees a driver who is still in one of `from`. Without the guard a
   * timed-out offer racing a successful accept would flip an on_trip driver
   * back to online and make them eligible for a second ride.
   */
  private async releaseDriverToOnline(
    driverId: string,
    from: DriverStatus[] = [DriverStatus.RESERVED],
  ): Promise<void> {
    const released = await this.driverProfiles.update(
      { userId: driverId, status: In(from) },
      { status: DriverStatus.ONLINE, idleSince: new Date() },
    );
    if (released.affected) await this.invalidateDriverStatusCache(driverId);
    // GPS delivery rechecks the current PostgreSQL assignment; do not blindly
    // clear a cache that may already belong to a new trip.
  }

  private async driverHasLiveTrip(driverId: string): Promise<boolean> {
    const count = await this.rides.count({
      where: { driverId, status: In(LIVE_DRIVER_TRIP_STATUSES) },
    });
    return count > 0;
  }

  private async driverHasLiveOffer(driverId: string): Promise<boolean> {
    const count = await this.rides.count({
      where: {
        offerDriverId: driverId,
        status: RideStatus.OFFERED,
        offerExpiresAt: MoreThan(new Date(Date.now() - REAP_GRACE_MS)),
      },
    });
    return count > 0;
  }

  private isKycEnforced(): boolean {
    // Prefer ConfigService, but fall back to process.env — Nest validate can
    // drop or boolean-coerce optional string flags under implicit conversion.
    const requireDriverKyc =
      this.config.get<string | boolean>('REQUIRE_DRIVER_KYC') ??
      process.env.REQUIRE_DRIVER_KYC;
    return isDriverKycEnforced({
      requireDriverKyc,
      nodeEnv: this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV,
      publicApiBaseUrl:
        this.config.get<string>('PUBLIC_API_BASE_URL') ??
        process.env.PUBLIC_API_BASE_URL,
    });
  }

  private async assertDriverMayWork(driverId: string): Promise<void> {
    const account = await this.users.findOne({
      where: { id: driverId },
      select: { id: true, standing: true },
    });
    if (!account || isMarketplaceBlocked(account.standing)) {
      throw new ForbiddenException(
        'This account cannot go online or take trips',
      );
    }
  }

  private async assertKycAllowsOnline(driverId: string): Promise<void> {
    if (!this.isKycEnforced()) return;
    try {
      const verification = await this.kycService.getMyVerification(driverId);
      if (verification.status !== VerificationStatus.APPROVED) {
        throw new ForbiddenException('KYC approval required to go online');
      }
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new ForbiddenException(
          'Complete driver verification before going online',
        );
      }
      throw error;
    }
  }

  /**
   * If the profile says reserved/on_trip but no ride still holds the driver,
   * flip them online immediately (same recovery as the reaper, per driver).
   */
  private async healOrphanedDriverStatus(
    driverId: string,
    status: DriverStatus,
  ): Promise<DriverStatus> {
    if (
      status === DriverStatus.ON_TRIP &&
      !(await this.driverHasLiveTrip(driverId))
    ) {
      await this.redis.del(this.lockKey(driverId));
      await this.driverProfiles.update(
        { userId: driverId, status: DriverStatus.ON_TRIP },
        { status: DriverStatus.ONLINE, idleSince: new Date() },
      );
      this.logger.warn(`Healed stuck on_trip for driver ${driverId}`);
      return DriverStatus.ONLINE;
    }
    if (
      status === DriverStatus.RESERVED &&
      !(await this.driverHasLiveOffer(driverId))
    ) {
      await this.redis.del(this.lockKey(driverId));
      await this.driverProfiles.update(
        { userId: driverId, status: DriverStatus.RESERVED },
        { status: DriverStatus.ONLINE, idleSince: new Date() },
      );
      this.logger.warn(`Healed stuck reserved for driver ${driverId}`);
      return DriverStatus.ONLINE;
    }
    return status;
  }

  /**
   * Go online/offline for on-demand dispatch. Server-side subscription
   * check — UI toggles alone must never grant marketplace access.
   */
  async setDriverPresence(
    driverId: string,
    online: boolean,
    connectedAccountId?: string,
  ) {
    if (online) {
      await this.assertDriverMayWork(driverId);
      const mayDrive =
        await this.subscriptionService.mayAccessMarketplace(driverId);
      if (!mayDrive) {
        throw new ForbiddenException(
          'Active subscription required to go online',
        );
      }
      await this.assertKycAllowsOnline(driverId);
    }

    let profile = await this.driverProfiles.findOne({
      where: { userId: driverId },
    });
    if (!profile) {
      profile = this.driverProfiles.create({
        userId: driverId,
        status: DriverStatus.OFFLINE,
        ratingAvg: '5.00',
        totalTrips: 0,
        connectedAccountId: connectedAccountId ?? null,
        idleSince: null,
      });
    }

    // Orphaned on_trip/reserved (no live ride) must not wait for the reaper:
    // the driver app looks online / "waiting for requests" while presence
    // still refuses to go offline.
    profile.status = await this.healOrphanedDriverStatus(
      driverId,
      profile.status,
    );

    if (profile.status === DriverStatus.ON_TRIP && !online) {
      throw new ConflictException('Cannot go offline while on a trip');
    }
    if (profile.status === DriverStatus.RESERVED && !online) {
      throw new ConflictException(
        'Cannot go offline while an offer is pending',
      );
    }
    // Reconnect / toggle must never wipe a live offer or active trip back to
    // ONLINE — that made drivers re-offerable while still reserved/on trip.
    if (
      online &&
      (profile.status === DriverStatus.ON_TRIP ||
        profile.status === DriverStatus.RESERVED)
    ) {
      if (connectedAccountId) {
        profile.connectedAccountId = connectedAccountId;
        await this.driverProfiles.save(profile);
      }
      return profile;
    }

    profile.status = online ? DriverStatus.ONLINE : DriverStatus.OFFLINE;
    profile.idleSince = online ? new Date() : null;
    if (connectedAccountId) {
      profile.connectedAccountId = connectedAccountId;
    }
    await this.driverProfiles.save(profile);
    await this.invalidateDriverStatusCache(driverId);

    if (!online) {
      // Drop the live GPS pin now rather than leaving it to expire, so an
      // offline driver stops appearing as a dispatch candidate immediately.
      await this.removeDriverFromGeoIndex(driverId);
    }

    this.logger.log(
      `Driver ${driverId} presence → ${profile.status}` +
        (online ? ' (subscription verified)' : ''),
    );
    return profile;
  }

  /** Best-effort: presence must still succeed if location-svc is unreachable. */
  private async removeDriverFromGeoIndex(driverId: string): Promise<void> {
    if (!this.locationSvc.enabled || this.locationSvc.isOpen) return;
    try {
      await this.locationSvc.post('/drivers/offline', { driverId }, 1000);
    } catch (error) {
      this.logger.warn(
        `Could not remove driver ${driverId} from geo index: ${(error as Error).message}`,
      );
    }
  }

  async getDriverPresence(driverId: string) {
    const profile = await this.driverProfiles.findOne({
      where: { userId: driverId },
    });
    const subscriptionActive =
      await this.subscriptionService.isActive(driverId);
    const subscriptionRequired = this.subscriptionService.isEnforced();
    const kycRequired = this.isKycEnforced();
    const kycApproved = kycRequired
      ? (await this.kycService.filterApprovedDriverIds([driverId])).has(
          driverId,
        )
      : true;
    return {
      profile: profile ?? null,
      subscriptionActive,
      subscriptionRequired,
      kycRequired,
      kycApproved,
      canGoOnline: (!subscriptionRequired || subscriptionActive) && kycApproved,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = error.driverError as { code?: string } | undefined;
    return driverError?.code === '23505';
  }

  /** Durable history; visibility stays tied to the original message participants. */
  async listRideMessages(
    rideId: string,
    viewerId: string,
    query: ListRideMessagesDto = {},
  ) {
    await this.assertRideParticipant(rideId, viewerId);
    return this.rideChatThread(rideId, query, viewerId);
  }

  async listRideMessagesForStaff(
    rideId: string,
    query: ListRideMessagesDto = {},
  ) {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');
    return this.rideChatThread(rideId, query);
  }

  private async rideChatThread(
    rideId: string,
    query: ListRideMessagesDto,
    viewerId?: string,
  ) {
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const builder = this.rideMessages
      .createQueryBuilder('m')
      .where('m.rideId = :rideId', { rideId });
    if (viewerId)
      builder.andWhere('(m.senderId = :viewerId OR m.receiverId = :viewerId)', {
        viewerId,
      });
    if (query.before) {
      const cursor = await this.rideMessages.findOne({
        where: { id: query.before, rideId },
      });
      if (
        !cursor ||
        (viewerId &&
          cursor.senderId !== viewerId &&
          cursor.receiverId !== viewerId)
      ) {
        throw new BadRequestException('Invalid message cursor');
      }
      // Compare in PostgreSQL to preserve sub-millisecond timestamp precision.
      builder.andWhere(
        '(m."createdAt", m.id) < (SELECT "createdAt", id FROM ride_messages WHERE id = :before)',
        { before: query.before },
      );
    }
    const rows = await builder
      .orderBy('m.createdAt', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(limit + 1)
      .getMany();
    const page = rows.slice(0, limit);
    return {
      threadId: rideId,
      retentionDays: null,
      expiresAt: null,
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
      messages: page
        .reverse()
        .map((message) => this.chatMessagePayload(message)),
    };
  }

  private chatMessagePayload(message: RideMessage) {
    return {
      ...message,
      conversationId: message.rideId,
      messageType: 'text',
      status: message.readAt ? 'read' : 'sent',
    };
  }

  async sendRideMessage(
    rideId: string,
    senderId: string,
    body: string,
    clientMessageId?: string,
  ) {
    const ride = await this.assertRideParticipant(rideId, senderId);
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > 1000) {
      throw new BadRequestException(
        'Message body must contain 1–1000 characters',
      );
    }
    const receiverId = ride.riderId === senderId ? ride.driverId : ride.riderId;
    if (!receiverId)
      throw new ConflictException('A driver must be assigned before messaging');
    let message: RideMessage;
    try {
      message = await this.rideMessages.save(
        this.rideMessages.create({
          rideId,
          senderId,
          receiverId,
          senderType: ride.riderId === senderId ? 'rider' : 'driver',
          body: trimmed,
          clientMessageId: clientMessageId ?? null,
        }),
      );
    } catch (error) {
      if (!clientMessageId || !this.isUniqueViolation(error)) throw error;
      const existing = await this.rideMessages.findOne({
        where: { rideId, senderId, clientMessageId },
      });
      if (
        !existing ||
        existing.body !== trimmed ||
        existing.receiverId !== receiverId
      ) {
        throw new ConflictException('Message id has already been used');
      }
      return this.chatMessagePayload(existing);
    }
    const payload = this.chatMessagePayload(message);
    await Promise.all(
      [receiverId, senderId].map((id) =>
        this.notify(id, 'ride.chat_message', { rideId, message: payload }),
      ),
    );
    return payload;
  }

  async readRideMessages(
    rideId: string,
    viewerId: string,
    throughMessageId: string,
  ) {
    await this.assertRideParticipant(rideId, viewerId);
    const through = await this.rideMessages.findOne({
      where: { id: throughMessageId, rideId },
    });
    if (
      !through ||
      (through.senderId !== viewerId && through.receiverId !== viewerId)
    ) {
      throw new BadRequestException('Invalid message cursor');
    }
    const readAt = new Date();
    const updated = await this.rideMessages
      .createQueryBuilder()
      .update()
      .set({ readAt })
      .where(
        '"rideId" = :rideId AND "receiverId" = :viewerId AND "readAt" IS NULL',
        { rideId, viewerId },
      )
      .andWhere(
        '("createdAt", id) <= (SELECT "createdAt", id FROM ride_messages WHERE id = :throughMessageId)',
        { throughMessageId },
      )
      .returning(['senderId'])
      .execute();
    const senders = new Set(
      (updated.raw as Array<{ senderId: string }>).map((row) => row.senderId),
    );
    await Promise.all(
      [...senders].map((senderId) =>
        this.notify(senderId, 'ride.chat_read', {
          rideId,
          readerId: viewerId,
          throughMessageId,
          readAt,
        }),
      ),
    );
    return { readAt };
  }

  private async assertRideParticipant(rideId: string, userId: string) {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');
    const isParticipant = ride.riderId === userId || ride.driverId === userId;
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant on this ride');
    }
    return ride;
  }
}

/** Collapse catalog aliases (moto/xl) onto dispatch bands. */
function normalizeRideVehicleType(raw?: string | null): string {
  const wanted = (raw ?? 'any').toLowerCase().trim();
  if (!wanted || wanted === 'any') return 'any';
  if (
    wanted.includes('moto') ||
    wanted.includes('motor') ||
    wanted.includes('bike')
  ) {
    return 'motorbike';
  }
  if (
    wanted.includes('suv') ||
    wanted.includes('van') ||
    wanted.includes('xl')
  ) {
    return 'suv';
  }
  if (wanted.includes('sedan') || wanted.includes('car')) return 'sedan';
  if (wanted.includes('minivan')) return 'minivan';
  return wanted;
}
