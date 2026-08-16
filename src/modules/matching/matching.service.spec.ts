import { NotFoundException } from '@nestjs/common';
import { Trip } from './entities/trip.entity';
import { RiderRequest, RiderRequestStatus } from './entities/rider-request.entity';
import { MatchingService } from './matching.service';

describe('MatchingService findMatches', () => {
  let service: MatchingService;
  let trips: {
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let riderRequests: { findOne: jest.Mock };
  let bookings: { createQueryBuilder: jest.Mock };
  let configuration: { get: jest.Mock };
  let fareService: {
    calculate: jest.Mock;
    estimateDurationMinutes: jest.Mock;
    quotedTripMetrics: jest.Mock;
  };
  let metrics: {
    matchDuration: { startTimer: jest.Mock };
  };
  let locationSvc: {
    enabled: boolean;
    isOpen: boolean;
    post: jest.Mock;
    get: jest.Mock;
  };

  const bole = { lat: 8.987, lng: 38.79 };
  const kazanchis = { lat: 9.012, lng: 38.76 };

  const request: RiderRequest = {
    id: 'req-1',
    riderId: 'rider-1',
    pickup: bole,
    dropoff: kazanchis,
    earliestDeparture: new Date(Date.now() - 5 * 60_000),
    latestDeparture: new Date(Date.now() + 45 * 60_000),
    seatsNeeded: 1,
    priceCeiling: '100',
    status: RiderRequestStatus.QUEUED,
    queuedAt: new Date(Date.now() - 10 * 60_000),
  } as RiderRequest;

  function makeTrip(overrides: Partial<Trip> = {}): Trip {
    return {
      id: 'trip-1',
      driverId: 'driver-1',
      startPoint: bole,
      destination: kazanchis,
      routePath: [bole, kazanchis],
      departureTime: new Date(Date.now() + 10 * 60_000),
      totalSeats: 3,
      remainingSeats: 3,
      pricePerSeat: '50',
      inMatchingPool: true,
      ...overrides,
    } as Trip;
  }

  function mockHeldSeats(rows: Array<{ tripId: string; held: string }>) {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };
    bookings.createQueryBuilder.mockReturnValue(qb);
  }

  beforeEach(() => {
    trips = {
      find: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    riderRequests = {
      findOne: jest.fn().mockResolvedValue(request),
    };
    bookings = { createQueryBuilder: jest.fn() };
    configuration = {
      get: jest.fn((key: string) => {
        const values: Record<string, number> = {
          direction_tolerance_degrees: 90,
          departure_tolerance_minutes: 30,
          waiting_time_weight: 1,
          detour_weight: 1,
          price_weight: 1,
          surge_rank_weight: 1,
          max_results_returned: 10,
          corridor_width_km: 1.5,
        };
        return values[key];
      }),
    };
    fareService = {
      calculate: jest.fn().mockResolvedValue({
        total: 80,
        surgeMultiplier: 1,
      }),
      estimateDurationMinutes: jest.fn().mockReturnValue(15),
      quotedTripMetrics: jest.fn().mockReturnValue({
        distanceKm: 6,
        durationMinutes: 20,
      }),
    };
    const endTimer = jest.fn();
    metrics = {
      matchDuration: { startTimer: jest.fn(() => endTimer) },
    };

    // Matching talks to location-svc through LocationSvcClient (keep-alive +
    // circuit breaker), so the stub has to expose the breaker flags it checks.
    locationSvc = {
      enabled: true,
      isOpen: false,
      post: jest.fn().mockResolvedValue({ tripIds: ['trip-1'] }),
      get: jest.fn(),
    };

    service = new MatchingService(
      trips as never,
      riderRequests as never,
      bookings as never,
      configuration as never,
      fareService as never,
      {} as never,
      { get: jest.fn().mockReturnValue('http://location-svc:8090') } as never,
      metrics as never,
      locationSvc as never,
    );

    mockHeldSeats([]);
  });

  it('throws when rider request is missing', async () => {
    riderRequests.findOne.mockResolvedValue(null);
    await expect(service.findMatches('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns empty when corridor search finds nothing', async () => {
    locationSvc.post.mockResolvedValue({ tripIds: [] });
    const samePlaceQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    trips.createQueryBuilder.mockReturnValue(samePlaceQb);

    await expect(service.findMatches(request.id)).resolves.toEqual([]);
  });

  it('returns ranked matches for aligned corridor trips', async () => {
    trips.find.mockResolvedValue([makeTrip()]);

    const matches = await service.findMatches(request.id);

    expect(matches).toHaveLength(1);
    expect(matches[0].trip.id).toBe('trip-1');
    expect(matches[0].estimatedFare).toBe(80);
    expect(typeof matches[0].score).toBe('number');
  });

  it('filters trips with insufficient seats after holds', async () => {
    trips.find.mockResolvedValue([makeTrip({ remainingSeats: 2 })]);
    mockHeldSeats([{ tripId: 'trip-1', held: '2' }]);

    const matches = await service.findMatches(request.id);
    expect(matches).toHaveLength(0);
  });

  it('filters trips above price ceiling', async () => {
    trips.find.mockResolvedValue([makeTrip({ pricePerSeat: '150' })]);

    const matches = await service.findMatches(request.id);
    expect(matches).toHaveLength(0);
  });

  it('sorts lower-detour trips ahead of high-detour trips', async () => {
    const near = makeTrip({ id: 'near' });
    const far = makeTrip({
      id: 'far',
      destination: { lat: 9.25, lng: 39.05 },
      routePath: [bole, { lat: 9.25, lng: 39.05 }],
    });
    locationSvc.post.mockResolvedValue({ tripIds: ['far', 'near'] });
    trips.find.mockResolvedValue([far, near]);

    const matches = await service.findMatches(request.id);

    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].trip.id).toBe('near');
    if (matches.length > 1) {
      expect(matches[0].score).toBeGreaterThanOrEqual(matches[1].score);
    }
  });

  it('records match duration metric', async () => {
    trips.find.mockResolvedValue([makeTrip()]);
    await service.findMatches(request.id);
    expect(metrics.matchDuration.startTimer).toHaveBeenCalled();
  });
});
