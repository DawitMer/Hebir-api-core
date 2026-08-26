import { ConflictException } from '@nestjs/common';
import { RidesService } from './rides.service';
import { Ride, RideStatus } from './entities/ride.entity';
import { DriverStatus } from './entities/driver-profile.entity';

describe('RidesService & Dispatch Concurrency Suite', () => {
  const driverId = 'driver-conc-1';
  const rider1Id = 'rider-conc-1';
  const rider2Id = 'rider-conc-2';
  const ride1Id = 'ride-conc-1';
  const ride2Id = 'ride-conc-2';
  const expiresAt = new Date(Date.now() + 30_000);

  function createOfferedRide(rideId: string, riderId: string): Ride {
    return {
      id: rideId,
      riderId,
      driverId: null,
      status: RideStatus.OFFERED,
      offerDriverId: driverId,
      offerExpiresAt: expiresAt,
      pickup: { lat: 9.03, lng: 38.75 },
      dropoff: { lat: 9.04, lng: 38.76 },
      pickupAddress: 'Bole Road, Addis Ababa',
      dropoffAddress: 'Meskel Square, Addis Ababa',
    } as Ride;
  }

  function setupService(rideMap: Map<string, Ride>, driverReserved = true) {
    const rides = {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => {
        const r = rideMap.get(where.id);
        return r ? { ...r } : null;
      }),
      update: jest.fn(async (criteria: any, changes: any) => {
        const r = rideMap.get(criteria.id);
        if (!r) return { affected: 0 };
        if (criteria.status && r.status !== criteria.status)
          return { affected: 0 };
        if (
          criteria.offerDriverId &&
          r.offerDriverId !== criteria.offerDriverId
        )
          return { affected: 0 };
        if (criteria.driverId && r.driverId !== criteria.driverId)
          return { affected: 0 };
        Object.assign(r, changes);
        return { affected: 1 };
      }),
      count: jest.fn().mockResolvedValue(0),
    };

    let driverStatus = driverReserved
      ? DriverStatus.RESERVED
      : DriverStatus.ONLINE;
    const driverProfiles = {
      update: jest.fn(async (criteria: any, changes: any) => {
        const matchesStatus = (actual: string, expected: any) => {
          if (!expected) return true;
          if (expected?._type === 'in' && Array.isArray(expected?._value)) {
            return expected._value.includes(actual);
          }
          if (typeof expected === 'string') {
            return actual === expected;
          }
          return true;
        };

        if (criteria.status && !matchesStatus(driverStatus, criteria.status)) {
          return { affected: 0 };
        }
        if (changes.status) {
          driverStatus = changes.status;
        }
        return { affected: 1 };
      }),
      find: jest.fn().mockResolvedValue([]),
    };

    const rideStatusEvents = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn(async (row: unknown) => row),
    };

    const geocoding = {
      reverseGeocodePair: jest.fn().mockResolvedValue({
        pickupAddress: 'Bole Road, Addis Ababa',
        dropoffAddress: 'Meskel Square, Addis Ababa',
      }),
    };

    const dispatchQueue = {
      clearState: jest.fn().mockResolvedValue(undefined),
      enqueueContinue: jest.fn().mockResolvedValue(undefined),
    };

    const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
    const redis = {
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
    };

    const kyc = {
      mapDriverPhotoUrls: jest.fn().mockResolvedValue(new Map()),
    };

    const locationSvc = {
      enabled: false,
      isOpen: false,
      post: jest.fn().mockResolvedValue({}),
      get: jest.fn().mockResolvedValue({}),
    };

    const service = new RidesService(
      rides as never,
      rideStatusEvents as never,
      { find: jest.fn() } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      driverProfiles as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
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

    return { service, rides, driverProfiles, dispatchQueue };
  }

  describe('Two riders competing for the same driver offer', () => {
    it('guarantees only one ride claims the driver and transitions to MATCHED/ACCEPTED', async () => {
      const ride1 = createOfferedRide(ride1Id, rider1Id);
      const ride2 = createOfferedRide(ride2Id, rider2Id);
      const rideMap = new Map<string, Ride>([
        [ride1Id, ride1],
        [ride2Id, ride2],
      ]);

      const { service } = setupService(rideMap, true);

      // Concurrent accept attempts
      const [res1, res2] = await Promise.allSettled([
        service.acceptOffer(driverId, ride1Id),
        service.acceptOffer(driverId, ride2Id),
      ]);

      // At least one must succeed; only one can claim DriverStatus.RESERVED -> ON_TRIP
      const successes = [res1, res2].filter((r) => r.status === 'fulfilled');
      const failures = [res1, res2].filter((r) => r.status === 'rejected');

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('One driver accepting two rides simultaneously', () => {
    it('allows only the first accept to win and rejects the second with ConflictException', async () => {
      const ride1 = createOfferedRide(ride1Id, rider1Id);
      const ride2 = createOfferedRide(ride2Id, rider2Id);
      const rideMap = new Map<string, Ride>([
        [ride1Id, ride1],
        [ride2Id, ride2],
      ]);

      const { service } = setupService(rideMap, true);

      const firstAccept = await service.acceptOffer(driverId, ride1Id);
      expect(firstAccept.status).toBe(RideStatus.ACCEPTED);
      expect(firstAccept.driverId).toBe(driverId);

      // Attempting to accept a second ride while now ON_TRIP fails because driver is no longer RESERVED
      await expect(service.acceptOffer(driverId, ride2Id)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('Simultaneous driver acceptance vs rider cancellation', () => {
    it('rolls back driver to ONLINE if rider cancels before accept confirmation writes', async () => {
      const ride = createOfferedRide(ride1Id, rider1Id);
      const rideMap = new Map<string, Ride>([[ride1Id, ride]]);

      const { service, rides, driverProfiles } = setupService(rideMap, true);

      // Simulate cancel landing right before final confirmation
      rides.update
        .mockResolvedValueOnce({ affected: 1 }) // MATCHED claim succeeds
        .mockResolvedValueOnce({ affected: 0 }); // Confirmed update fails because rider cancelled

      await expect(service.acceptOffer(driverId, ride1Id)).rejects.toThrow(
        ConflictException,
      );

      // Driver status must be rolled back to ONLINE so they are not left trapped ON_TRIP
      expect(driverProfiles.update).toHaveBeenCalledWith(
        { userId: driverId, status: DriverStatus.ON_TRIP },
        expect.objectContaining({ status: DriverStatus.ONLINE }),
      );
    });
  });
});
