import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Trip } from './entities/trip.entity';
import {
  RiderRequest,
  RiderRequestStatus,
} from './entities/rider-request.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { SubmitRiderRequestDto } from './dto/submit-request.dto';
import { PublishTripDto } from './dto/publish-trip.dto';
import { ConfigurationService } from '../subscription/configuration.service';
import { FareService } from '../fare/fare.service';
import { SubscriptionService } from '../subscription/subscription.service';
import {
  angularDifference,
  bearing,
  estimateDetourMinutes,
  localBearingAtPickup,
  zoneIdFor,
} from './geo/geo.util';
import { computeMatchScore } from './scoring/match-score';
import { MetricsService } from '../../observability/metrics.service';
import { LocationSvcClient } from '../../common/location-svc/location-svc.client';

export interface RankedMatch {
  trip: Trip;
  detourMinutes: number;
  priceDifference: number;
  score: number;
  estimatedFare: number;
  surgeMultiplier: number;
  zoneId: string;
}

export interface ShareAvailability {
  sharedAvailable: boolean;
  waitingRiders: number;
  openTrips: number;
}

/** How far away a co-rider / carpool trip can be and still count as "nearby". */
const SHARE_RADIUS_KM = 4;
/** A queued request older than this no longer signals live shared demand. */
const SHARE_DEMAND_WINDOW_MS = 15 * 60 * 1000;
/** Trips that departed more than this long ago cannot be joined. */
const TRIP_DEPARTURE_GRACE_MS = 15 * 60 * 1000;

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(RiderRequest)
    private readonly riderRequests: Repository<RiderRequest>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    private readonly configuration: ConfigurationService,
    private readonly fareService: FareService,
    private readonly subscriptionService: SubscriptionService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly locationSvc: LocationSvcClient,
  ) {}

  /**
   * Publish or amend a trip. Requires an active subscription — enforced
   * by SubscriptionAccessGuard at the controller level, and re-checked
   * here since this is the point of entry into the matching pool.
   */
  async publishTrip(driverId: string, dto: PublishTripDto) {
    const mayDrive =
      await this.subscriptionService.mayAccessMarketplace(driverId);
    if (!mayDrive) {
      throw new ForbiddenException(
        'Active subscription required to publish a trip',
      );
    }

    const trip = await this.trips.save(
      this.trips.create({
        driverId,
        startPoint: dto.startPoint,
        destination: dto.destination,
        routePath: dto.routePath,
        departureTime: new Date(dto.departureTime),
        totalSeats: dto.totalSeats,
        remainingSeats: dto.totalSeats,
        pricePerSeat: String(dto.pricePerSeat),
        inMatchingPool: true,
      }),
    );

    await this.notifyLocationSvcOfNewTrip(trip);
    return trip;
  }

  private async notifyLocationSvcOfNewTrip(trip: Trip) {
    if (!this.locationSvc.enabled || this.locationSvc.isOpen) return;
    try {
      await this.locationSvc.post('/trips/index', trip, 1000);
    } catch (error) {
      this.logger.error(
        `Failed to index new trip with location-svc: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Uber-Pool-style gate: the Shared option is only offered when there is
   * real shared demand near the pickup — either other riders currently
   * queued for a shared match, or driver-published carpool trips with free
   * seats. Never invents availability.
   */
  async shareAvailability(
    riderId: string,
    pickup: { lat: number; lng: number },
  ): Promise<ShareAvailability> {
    const latDelta = SHARE_RADIUS_KM / 111;
    const lngDelta =
      SHARE_RADIUS_KM /
      (111 * Math.max(0.1, Math.cos((pickup.lat * Math.PI) / 180)));
    const bbox = {
      minLat: pickup.lat - latDelta,
      maxLat: pickup.lat + latDelta,
      minLng: pickup.lng - lngDelta,
      maxLng: pickup.lng + lngDelta,
    };

    const [waitingRiders, openTrips] = await Promise.all([
      this.riderRequests
        .createQueryBuilder('r')
        .where('r.status = :queued', { queued: RiderRequestStatus.QUEUED })
        .andWhere('r."queuedAt" > :since', {
          since: new Date(Date.now() - SHARE_DEMAND_WINDOW_MS),
        })
        .andWhere('r."riderId" != :riderId', { riderId })
        .andWhere(`(r.pickup->>'lat')::float BETWEEN :minLat AND :maxLat`, bbox)
        .andWhere(`(r.pickup->>'lng')::float BETWEEN :minLng AND :maxLng`, bbox)
        .getCount(),
      this.trips
        .createQueryBuilder('t')
        .where('t."inMatchingPool" = true')
        .andWhere('t."remainingSeats" > 0')
        .andWhere('t."departureTime" > :cutoff', {
          cutoff: new Date(Date.now() - TRIP_DEPARTURE_GRACE_MS),
        })
        .andWhere(
          `(t."startPoint"->>'lat')::float BETWEEN :minLat AND :maxLat`,
          bbox,
        )
        .andWhere(
          `(t."startPoint"->>'lng')::float BETWEEN :minLng AND :maxLng`,
          bbox,
        )
        .getCount(),
    ]);

    return {
      sharedAvailable: waitingRiders > 0 || openTrips > 0,
      waitingRiders,
      openTrips,
    };
  }

  async submitRequest(riderId: string, dto: SubmitRiderRequestDto) {
    const request = await this.riderRequests.save(
      this.riderRequests.create({
        riderId,
        pickup: dto.pickup,
        dropoff: dto.dropoff,
        earliestDeparture: new Date(dto.earliestDeparture),
        latestDeparture: new Date(dto.latestDeparture),
        seatsNeeded: dto.seatsNeeded,
        priceCeiling: String(dto.priceCeiling),
        status: RiderRequestStatus.QUEUED,
      }),
    );
    return request;
  }

  /**
   * Advanced ride-share match pipeline (Layers 1–6).
   * See docs/MATCHING.md and matching/README.md.
   */
  async findMatches(
    riderRequestId: string,
    riderId?: string,
  ): Promise<RankedMatch[]> {
    const endTimer = this.metrics.matchDuration.startTimer();
    let resultLabel = 'error';
    try {
      const matches = await this.findMatchesInner(riderRequestId, riderId);
      resultLabel = matches.length === 0 ? 'empty' : 'ok';
      return matches;
    } finally {
      endTimer({ result: resultLabel });
    }
  }

  private async findMatchesInner(
    riderRequestId: string,
    riderId?: string,
  ): Promise<RankedMatch[]> {
    const request = await this.riderRequests.findOne({
      where: { id: riderRequestId },
    });
    if (!request) throw new NotFoundException('Rider request not found');
    // Match results carry other users' trips, fares and scores, so only the
    // rider who submitted the request may read them.
    if (riderId && request.riderId !== riderId) {
      throw new ForbiddenException('This request belongs to another rider');
    }

    const candidateTripIds = await this.corridorSearch(request);
    // Same-destination / nearby OD fallback when corridor geo is empty or down.
    const tripIds =
      candidateTripIds.length > 0
        ? candidateTripIds
        : await this.samePlaceTripSearch(request);
    if (tripIds.length === 0) return [];

    const trips = await this.trips.find({
      where: { id: In(tripIds), inMatchingPool: true },
    });

    const directionTolerance = this.configuration.get<number>(
      'direction_tolerance_degrees',
    );
    const departureTolerance = this.configuration.get<number>(
      'departure_tolerance_minutes',
    );
    const waitWeight = this.configuration.get<number>('waiting_time_weight');
    const detourWeight = this.configuration.get<number>('detour_weight');
    const priceWeight = this.configuration.get<number>('price_weight');
    const surgeRankWeight = this.configuration.get<number>('surge_rank_weight');
    const maxResults = this.configuration.get<number>('max_results_returned');

    const zoneId = zoneIdFor(request.pickup);
    // One GROUP BY query for all candidates (was N held-seat lookups).
    const heldByTrip = await this.heldSeatsByTripIds(trips.map((t) => t.id));

    // Pickup-zone fare/surge is identical for every candidate on this request.
    const { distanceKm, durationMinutes } = this.fareService.quotedTripMetrics(
      request.pickup,
      request.dropoff,
    );
    const fare = await this.fareService.calculate({
      distanceKm,
      durationMinutes,
      zoneId,
    });

    const waitingMinutes = (Date.now() - request.queuedAt.getTime()) / 60000;
    const survivors: RankedMatch[] = [];

    for (const trip of trips) {
      // Layer 3: chord + local segment bearing alignment.
      const driverBearing = localBearingAtPickup(
        trip.routePath ?? [],
        trip.startPoint,
        trip.destination,
        request.pickup,
      );
      const riderBearing = bearing(request.pickup, request.dropoff);
      const angleDiff = angularDifference(driverBearing, riderBearing);
      if (angleDiff > directionTolerance) continue;

      // Layer 4: hard constraints.
      const heldSeats = heldByTrip.get(trip.id) ?? 0;
      const availableSeats = trip.remainingSeats - heldSeats;
      if (availableSeats < request.seatsNeeded) continue;
      if (Number(trip.pricePerSeat) > Number(request.priceCeiling)) continue;

      const departureDiffMinutes =
        Math.abs(
          trip.departureTime.getTime() - request.earliestDeparture.getTime(),
        ) / 60000;
      const withinWindow =
        trip.departureTime >= request.earliestDeparture &&
        trip.departureTime <= request.latestDeparture;
      if (!withinWindow && departureDiffMinutes > departureTolerance) continue;

      // Layer 5–6: rank with cached pickup-zone fare/surge.
      const detourMinutes = estimateDetourMinutes(
        trip.startPoint,
        trip.destination,
        request.pickup,
        request.dropoff,
      );
      const priceDifference =
        Number(request.priceCeiling) - Number(trip.pricePerSeat);

      const score = computeMatchScore({
        waitingMinutes,
        detourMinutes,
        priceDifference,
        surgeMultiplier: fare.surgeMultiplier,
        waitWeight,
        detourWeight,
        priceWeight,
        surgeRankWeight,
      });

      survivors.push({
        trip,
        detourMinutes,
        priceDifference,
        score,
        estimatedFare: fare.total,
        surgeMultiplier: fare.surgeMultiplier,
        zoneId,
      });
    }

    return survivors.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  private async corridorSearch(request: RiderRequest): Promise<string[]> {
    if (!this.locationSvc.enabled || this.locationSvc.isOpen) return [];
    const corridorWidthKm = this.configuration.get<number>('corridor_width_km');

    try {
      const data = await this.locationSvc.post<{ tripIds: string[] }>(
        '/corridor-search',
        {
          pickup: request.pickup,
          dropoff: request.dropoff,
          corridorWidthKm,
        },
        1000,
      );
      return data.tripIds ?? [];
    } catch (error) {
      this.logger.error(`Corridor search failed: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Fallback when corridor geo is empty: open trips going to roughly the same
   * place (destination near rider dropoff), with start near enough for pickup.
   */
  private async samePlaceTripSearch(request: RiderRequest): Promise<string[]> {
    const destRadiusKm = 3.5;
    const startRadiusKm = 8;
    const destLatDelta = destRadiusKm / 111;
    const startLatDelta = startRadiusKm / 111;
    const destLngDelta =
      destRadiusKm /
      (111 * Math.max(0.1, Math.cos((request.dropoff.lat * Math.PI) / 180)));
    const startLngDelta =
      startRadiusKm /
      (111 * Math.max(0.1, Math.cos((request.pickup.lat * Math.PI) / 180)));

    const rows = await this.trips
      .createQueryBuilder('t')
      .select('t.id', 'id')
      .where('t."inMatchingPool" = true')
      .andWhere('t."remainingSeats" > 0')
      .andWhere('t."departureTime" > :cutoff', {
        cutoff: new Date(Date.now() - TRIP_DEPARTURE_GRACE_MS),
      })
      // Same place they're going
      .andWhere(
        `(t.destination->>'lat')::float BETWEEN :dMinLat AND :dMaxLat`,
        {
          dMinLat: request.dropoff.lat - destLatDelta,
          dMaxLat: request.dropoff.lat + destLatDelta,
        },
      )
      .andWhere(
        `(t.destination->>'lng')::float BETWEEN :dMinLng AND :dMaxLng`,
        {
          dMinLng: request.dropoff.lng - destLngDelta,
          dMaxLng: request.dropoff.lng + destLngDelta,
        },
      )
      // Driver start close enough that the rider can meet / be picked up
      .andWhere(
        `(t."startPoint"->>'lat')::float BETWEEN :pMinLat AND :pMaxLat`,
        {
          pMinLat: request.pickup.lat - startLatDelta,
          pMaxLat: request.pickup.lat + startLatDelta,
        },
      )
      .andWhere(
        `(t."startPoint"->>'lng')::float BETWEEN :pMinLng AND :pMaxLng`,
        {
          pMinLng: request.pickup.lng - startLngDelta,
          pMaxLng: request.pickup.lng + startLngDelta,
        },
      )
      .orderBy('t."departureTime"', 'ASC')
      .take(40)
      .getRawMany<{ id: string }>();

    return rows.map((r) => r.id);
  }

  /**
   * Active HELD seats per trip in one round-trip (avoids N+1 in findMatches).
   */
  private async heldSeatsByTripIds(
    tripIds: string[],
  ): Promise<Map<string, number>> {
    const heldByTrip = new Map<string, number>();
    if (tripIds.length === 0) return heldByTrip;

    const rows = await this.bookings
      .createQueryBuilder('b')
      .select('b.tripId', 'tripId')
      .addSelect('COALESCE(SUM(b.seats), 0)', 'held')
      .where('b.tripId IN (:...tripIds)', { tripIds })
      .andWhere('b.status = :status', { status: BookingStatus.HELD })
      .andWhere('b.holdExpiresAt > :now', { now: new Date() })
      .groupBy('b.tripId')
      .getRawMany<{ tripId: string; held: string }>();

    for (const row of rows) {
      heldByTrip.set(row.tripId, Number(row.held) || 0);
    }
    return heldByTrip;
  }
}
