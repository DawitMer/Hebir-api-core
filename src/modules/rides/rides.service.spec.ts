import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RidesService } from './rides.service';
import { Ride, RideStatus } from './entities/ride.entity';
import { DriverStatus } from './entities/driver-profile.entity';
import { UserRole } from '../auth/entities/user-account.entity';

/**
 * Dispatch offers one driver at a time. The production race is two concurrent
 * accepts of that same offer (double-tap, retry, or a stale client). The
 * winner is the first conditional UPDATE on `status = offered`.
 */
describe('RidesService.acceptOffer race', () => {
  const rideId = 'ride-1';
  const driverId = 'driver-1';
  const riderId = 'rider-1';
  const expiresAt = new Date(Date.now() + 30_000);

  function offeredRide(): Ride {
    return {
      id: rideId,
      riderId,
      driverId: null,
      status: RideStatus.OFFERED,
      offerDriverId: driverId,
      offerExpiresAt: expiresAt,
      pickup: { lat: 9.03, lng: 38.75 },
      dropoff: { lat: 9.04, lng: 38.76 },
      pickupAddress: 'Pickup',
      dropoffAddress: 'Dropoff',
    } as Ride;
  }

  function buildService(ride: Ride) {
    const rides = {
      findOne: jest.fn(async () => ({ ...ride })),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    };
    const rideStatusEvents = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn(async (row: unknown) => row),
    };
    const driverProfiles = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
    };
    const fares = { find: jest.fn().mockResolvedValue([]) };
    const tips = { find: jest.fn().mockResolvedValue([]) };
    const users = { find: jest.fn().mockResolvedValue([]) };
    const vehicles = { find: jest.fn().mockResolvedValue([]) };
    const geocoding = {
      reverseGeocodePair: jest.fn().mockResolvedValue({
        pickupAddress: 'Pickup',
        dropoffAddress: 'Dropoff',
      }),
    };
    const dispatchQueue = {
      clearState: jest.fn().mockResolvedValue(undefined),
    };
    const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
    const redis = {
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const kyc = {
      mapDriverPhotoUrls: jest.fn().mockResolvedValue(new Map()),
    };
    const locationSvc = {
      enabled: false,
      isOpen: false,
      post: jest.fn(),
      get: jest.fn(),
    };
    const service = new RidesService(
      rides as never,
      rideStatusEvents as never,
      { find: jest.fn() } as never,
      fares as never,
      vehicles as never,
      tips as never,
      users as never,
      driverProfiles as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      { get: jest.fn() } as never,
      { mayAccessMarketplace: jest.fn().mockResolvedValue(true) } as never,
      kyc as never,
      notifications as never,
      { get: jest.fn() } as never,
      locationSvc as never,
      geocoding as never,
      redis as never,
      dispatchQueue as never,
      { settleFare: jest.fn() } as never,
    );

    return { service, rides, driverProfiles, ride, locationSvc };
  }

  it('assigns the ride when the offered-row update affects one row', async () => {
    const { service, rides, ride } = buildService(offeredRide());
    rides.update.mockImplementation(
      async (where: Record<string, unknown>, patch: Partial<Ride>) => {
        if (where.status === RideStatus.OFFERED) {
          Object.assign(ride, patch);
          return { affected: 1 };
        }
        if (where.status === RideStatus.MATCHED) {
          Object.assign(ride, patch);
          return { affected: 1 };
        }
        return { affected: 1 };
      },
    );
    rides.findOne.mockImplementation(async () => ({ ...ride }));

    const result = await service.acceptOffer(driverId, rideId);

    expect(result.status).toBe(RideStatus.ACCEPTED);
    expect(result.driverId).toBe(driverId);
    const claim = rides.update.mock.calls.find(
      (call: [Record<string, unknown>]) =>
        call[0].status === RideStatus.OFFERED,
    );
    expect(claim).toBeDefined();
    expect(claim![0]).toMatchObject({
      id: rideId,
      status: RideStatus.OFFERED,
      offerDriverId: driverId,
    });
    expect(claim![0].offerExpiresAt).toBeDefined();
  });

  it('rejects a second accept when the offered row is already gone', async () => {
    const { service, rides } = buildService(offeredRide());
    rides.update.mockResolvedValue({ affected: 0 });

    await expect(service.acceptOffer(driverId, rideId)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('allows only one of two concurrent accepts to win', async () => {
    const ride = offeredRide();
    const { service, rides, driverProfiles } = buildService(ride);
    let offeredClaimed = false;

    rides.findOne.mockImplementation(async () => ({ ...ride }));
    rides.update.mockImplementation(
      async (where: Record<string, unknown>, patch: Partial<Ride>) => {
        if (where.status === RideStatus.OFFERED) {
          if (offeredClaimed || ride.status !== RideStatus.OFFERED) {
            return { affected: 0 };
          }
          offeredClaimed = true;
          Object.assign(ride, patch);
          return { affected: 1 };
        }
        if (where.status === RideStatus.MATCHED) {
          Object.assign(ride, patch);
          return { affected: 1 };
        }
        return { affected: 1 };
      },
    );
    driverProfiles.update.mockResolvedValue({ affected: 1 });

    const outcomes = await Promise.allSettled([
      service.acceptOffer(driverId, rideId),
      service.acceptOffer(driverId, rideId),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    }
    expect(ride.status).toBe(RideStatus.ACCEPTED);
    expect(ride.driverId).toBe(driverId);
  });

  it('does not flip a driver on_trip when the offered claim lost', async () => {
    const { service, rides, driverProfiles } = buildService(offeredRide());
    rides.update.mockResolvedValue({ affected: 0 });

    await expect(service.acceptOffer(driverId, rideId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(driverProfiles.update).not.toHaveBeenCalledWith(
      { userId: driverId, status: DriverStatus.RESERVED },
      expect.anything(),
    );
  });
});

describe('RidesService.transitionStatus geofence', () => {
  const rideId = 'ride-1';
  const driverId = 'driver-1';
  const riderId = 'rider-1';
  const pickup = { lat: 9.03, lng: 38.75 };

  function acceptedRide(): Ride {
    return {
      id: rideId,
      riderId,
      driverId,
      status: RideStatus.ACCEPTED,
      pickup,
      dropoff: { lat: 9.04, lng: 38.76 },
      pickupAddress: 'Pickup',
      dropoffAddress: 'Dropoff',
    } as Ride;
  }

  it('rejects arriving when the driver is kilometres from pickup', async () => {
    const ride = acceptedRide();
    const { service, rides, locationSvc } = (function build() {
      const inner = {
        findOne: jest.fn(async () => ({ ...ride })),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        count: jest.fn().mockResolvedValue(0),
        query: jest.fn().mockResolvedValue([]),
      };
      const locationSvc = {
        enabled: true,
        isOpen: false,
        post: jest.fn(),
        get: jest.fn().mockResolvedValue({ lat: 8.98, lng: 38.8 }),
      };
      const redis = { eval: jest.fn(), del: jest.fn(), set: jest.fn() };
      const service = new RidesService(
        inner as never,
        { create: jest.fn((r) => r), save: jest.fn() } as never,
        { find: jest.fn() } as never,
        { find: jest.fn() } as never,
        { find: jest.fn() } as never,
        { find: jest.fn() } as never,
        { find: jest.fn() } as never,
        { update: jest.fn(), find: jest.fn() } as never,
        { find: jest.fn() } as never,
        { find: jest.fn() } as never,
        {} as never,
        {} as never,
        { mapDriverPhotoUrls: jest.fn() } as never,
        { notify: jest.fn() } as never,
        { get: jest.fn() } as never,
        locationSvc as never,
        {} as never,
        redis as never,
        { clearState: jest.fn() } as never,
        { settleFare: jest.fn() } as never,
      );
      return { service, rides: inner, locationSvc };
    })();

    await expect(
      service.transitionStatus(rideId, driverId, RideStatus.ARRIVING),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(rides.update).not.toHaveBeenCalled();
    expect(locationSvc.get).toHaveBeenCalled();
  });

  it('allows arriving when the driver is at the pin', async () => {
    const ride = acceptedRide();
    const rides = {
      findOne: jest.fn(async () => ({ ...ride })),
      update: jest.fn(async (_where: unknown, patch: Partial<Ride>) => {
        Object.assign(ride, patch);
        return { affected: 1 };
      }),
      count: jest.fn().mockResolvedValue(0),
      query: jest.fn().mockResolvedValue([]),
    };
    const locationSvc = {
      enabled: true,
      isOpen: false,
      post: jest.fn(),
      get: jest.fn().mockResolvedValue({ lat: pickup.lat, lng: pickup.lng }),
    };
    const redis = {
      eval: jest.fn(),
      del: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const rideStatusEvents = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn(async (row: unknown) => row),
    };
    const service = new RidesService(
      rides as never,
      rideStatusEvents as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      { update: jest.fn(), find: jest.fn() } as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      { get: jest.fn() } as never,
      { mayAccessMarketplace: jest.fn().mockResolvedValue(true) } as never,
      { mapDriverPhotoUrls: jest.fn() } as never,
      { notify: jest.fn() } as never,
      { get: jest.fn() } as never,
      locationSvc as never,
      {} as never,
      redis as never,
      { clearState: jest.fn() } as never,
      { settleFare: jest.fn() } as never,
    );

    const result = await service.transitionStatus(
      rideId,
      driverId,
      RideStatus.ARRIVING,
    );
    expect(result.status).toBe(RideStatus.ARRIVING);
    expect(rides.update).toHaveBeenCalled();
  });
});

describe('RidesService.cancelRide rematch', () => {
  const rideId = 'ride-1';
  const driverId = 'driver-1';
  const riderId = 'rider-1';

  function assignedRide(status: RideStatus): Ride {
    return {
      id: rideId,
      riderId,
      driverId,
      status,
      pickup: { lat: 9.03, lng: 38.75 },
      dropoff: { lat: 9.04, lng: 38.76 },
      pickupAddress: 'Pickup',
      dropoffAddress: 'Dropoff',
    } as Ride;
  }

  function build(ride: Ride) {
    const rides = {
      findOne: jest.fn(async () => ({ ...ride })),
      update: jest.fn(async (_where: unknown, patch: Partial<Ride>) => {
        Object.assign(ride, patch);
        return { affected: 1 };
      }),
      count: jest.fn().mockResolvedValue(0),
    };
    const dispatchQueue = {
      clearState: jest.fn().mockResolvedValue(undefined),
      enqueueDispatch: jest.fn().mockResolvedValue(undefined),
    };
    const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
    const redis = {
      eval: jest.fn(),
      del: jest.fn(),
      set: jest.fn(),
      exists: jest.fn().mockResolvedValue(0),
    };
    const service = new RidesService(
      rides as never,
      { create: jest.fn((r) => r), save: jest.fn() } as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        find: jest.fn(),
      } as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      {} as never,
      { mayAccessMarketplace: jest.fn().mockResolvedValue(true) } as never,
      { mapDriverPhotoUrls: jest.fn() } as never,
      notifications as never,
      { get: jest.fn() } as never,
      {
        enabled: false,
        isOpen: false,
        post: jest.fn(),
        get: jest.fn(),
      } as never,
      {} as never,
      redis as never,
      dispatchQueue as never,
      { settleFare: jest.fn() } as never,
    );
    return { service, rides, ride, dispatchQueue, notifications, redis };
  }

  it('restarts searching when the assigned driver cancels before the trip starts', async () => {
    const { service, dispatchQueue, notifications } = build(
      assignedRide(RideStatus.ACCEPTED),
    );

    const result = await service.cancelRide(rideId, driverId, 'car issue');

    expect(result.status).toBe(RideStatus.SEARCHING);
    expect(result.driverId).toBeNull();
    expect(dispatchQueue.enqueueDispatch).toHaveBeenCalledWith(rideId, 0, [
      driverId,
    ]);
    expect(notifications.notify).toHaveBeenCalledWith(
      riderId,
      'ride.rematching',
      expect.objectContaining({ rideId }),
    );
    expect(notifications.notify).not.toHaveBeenCalledWith(
      riderId,
      'ride.cancelled',
      expect.anything(),
    );
  });

  it('keeps a rider cancel terminal', async () => {
    const { service, dispatchQueue, notifications } = build(
      assignedRide(RideStatus.ACCEPTED),
    );

    const result = await service.cancelRide(rideId, riderId, 'changed plans');

    expect(result.status).toBe(RideStatus.CANCELLED);
    expect(dispatchQueue.enqueueDispatch).not.toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith(
      driverId,
      'ride.cancelled',
      expect.objectContaining({ rideId }),
    );
  });
});

describe('RidesService authorization and start-code gate', () => {
  const rideId = 'ride-1';
  const driverId = 'driver-1';
  const riderId = 'rider-1';
  const strangerId = 'stranger-1';

  function baseRide(overrides: Partial<Ride> = {}): Ride {
    return {
      id: rideId,
      riderId,
      driverId,
      status: RideStatus.ACCEPTED,
      pickup: { lat: 9.03, lng: 38.75 },
      dropoff: { lat: 9.04, lng: 38.76 },
      pickupAddress: 'Pickup',
      dropoffAddress: 'Dropoff',
      startCodeHash: null,
      startCodeAttempts: 0,
      startCodeExpiresAt: null,
      ...overrides,
    } as Ride;
  }

  function build(ride: Ride) {
    const rides = {
      findOne: jest.fn(async () => ({ ...ride })),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn(async (_where: unknown, patch: Partial<Ride>) => {
        Object.assign(ride, patch);
        return { affected: 1 };
      }),
      count: jest.fn().mockResolvedValue(0),
      query: jest.fn().mockResolvedValue([]),
    };
    const redis = {
      eval: jest.fn(),
      del: jest.fn(),
      set: jest.fn(),
      get: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockResolvedValue(0),
    };
    const kyc = {
      mapDriverPhotoUrls: jest.fn().mockResolvedValue(new Map()),
      filterApprovedDriverIds: jest.fn().mockResolvedValue(new Set()),
    };
    const service = new RidesService(
      rides as never,
      { create: jest.fn((r) => r), save: jest.fn() } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        find: jest.fn().mockResolvedValue([]),
      } as never,
      { find: jest.fn() } as never,
      { find: jest.fn() } as never,
      {} as never,
      { mayAccessMarketplace: jest.fn().mockResolvedValue(true) } as never,
      kyc as never,
      { notify: jest.fn() } as never,
      { get: jest.fn() } as never,
      {
        enabled: false,
        isOpen: false,
        post: jest.fn(),
        get: jest.fn(),
      } as never,
      {} as never,
      redis as never,
      { clearState: jest.fn(), enqueueDispatch: jest.fn() } as never,
      { settleFare: jest.fn() } as never,
    );
    return { service, rides, ride, redis };
  }

  it("forbids a stranger from reading another rider's ride", async () => {
    const { service } = build(baseRide());
    await expect(
      service.getRide(rideId, { userId: strangerId, roles: [UserRole.RIDER] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets the rider read their own ride and strips start-code hash', async () => {
    const { service } = build(
      baseRide({ startCodeHash: 'deadbeef', startCodeAttempts: 1 }),
    );
    const result = await service.getRide(rideId, {
      userId: riderId,
      roles: [UserRole.RIDER],
    });
    expect(result.id).toBe(rideId);
    expect(result.startCodeHash).toBeNull();
  });

  it('rejects completed → in_progress', async () => {
    const { service, rides } = build(
      baseRide({ status: RideStatus.COMPLETED }),
    );
    await expect(
      service.transitionStatus(rideId, driverId, RideStatus.IN_PROGRESS),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(rides.update).not.toHaveBeenCalled();
  });

  it('rejects cancel once the trip is in progress', async () => {
    const { service } = build(baseRide({ status: RideStatus.IN_PROGRESS }));
    await expect(service.cancelRide(rideId, riderId)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects cancel from a non-participant', async () => {
    const { service } = build(baseRide());
    await expect(service.cancelRide(rideId, strangerId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects complete from anyone who is not the assigned driver', async () => {
    const { service } = build(baseRide({ status: RideStatus.IN_PROGRESS }));
    await expect(
      service.completeRide(rideId, strangerId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks PATCH to in_progress when a start-code gate is on the ride row even if Redis is empty', async () => {
    const { service, rides, redis } = build(
      baseRide({
        status: RideStatus.ARRIVING,
        startCodeHash: 'abc123',
        startCodeExpiresAt: new Date(Date.now() + 60_000),
      }),
    );

    await expect(
      service.transitionStatus(rideId, driverId, RideStatus.IN_PROGRESS),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(redis.exists).not.toHaveBeenCalled();
    expect(rides.update).not.toHaveBeenCalled();
  });

  it('returns the rider trip for a dual-role user with no live driver assignment', async () => {
    const riderTrip = baseRide({ driverId: 'other-driver' });
    const { service, rides } = build(riderTrip);
    rides.findOne.mockImplementation(async (opts?: unknown) => {
      const where = (
        opts as { where?: { driverId?: string; riderId?: string } } | undefined
      )?.where;
      if (where?.driverId) return null;
      if (where?.riderId === riderId) return { ...riderTrip };
      return null;
    });

    const result = await service.getActiveRideForUser(riderId, [
      UserRole.DRIVER,
      UserRole.RIDER,
    ]);
    expect(result?.id).toBe(rideId);
    expect(result?.riderId).toBe(riderId);
  });
});
