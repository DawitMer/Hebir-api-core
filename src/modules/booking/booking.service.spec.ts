import { ConflictException, ForbiddenException } from '@nestjs/common';
import { BookingService } from './booking.service';
import { Booking, BookingStatus } from './entities/booking.entity';
import { Trip } from '../matching/entities/trip.entity';

/**
 * Seat oversell guard: confirm uses a conditional UPDATE
 * (`remainingSeats >= seats`) inside a transaction. Concurrent winners must
 * leave remainingSeats never negative.
 */
describe('BookingService seat oversell', () => {
  let service: BookingService;
  let bookings: {
    findOne: jest.Mock;
    save: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let trips: { findOne: jest.Mock };
  let riderRequests: { findOne: jest.Mock; update: jest.Mock };
  let metrics: { seatConflictTotal: { inc: jest.Mock } };

  const driverId = 'driver-1';
  const trip: Trip = {
    id: 'trip-1',
    driverId,
    remainingSeats: 1,
    inMatchingPool: true,
  } as Trip;

  const heldBooking: Booking = {
    id: 'booking-1',
    tripId: trip.id,
    riderRequestId: 'req-1',
    seats: 1,
    status: BookingStatus.HELD,
    holdExpiresAt: new Date(Date.now() + 60_000),
    driverConfirmed: false,
  } as Booking;

  function mockTransaction(tripExecute: () => Promise<{ affected: number }>) {
    const tripQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      execute: jest.fn().mockImplementation(tripExecute),
    };
    const em = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(tripQb),
      findOne: jest.fn().mockResolvedValue({ ...trip, remainingSeats: 0 }),
    };
    bookings.manager.transaction.mockImplementation(async (cb: (em: any) => Promise<void>) =>
      cb(em),
    );
    return { em, tripQb };
  }

  beforeEach(() => {
    bookings = {
      findOne: jest.fn().mockResolvedValue({ ...heldBooking, status: BookingStatus.CONFIRMED }),
      save: jest.fn(async (b: Booking) => b),
      manager: { transaction: jest.fn() },
    };
    trips = {
      findOne: jest.fn().mockResolvedValue({ ...trip }),
    };
    riderRequests = {
      findOne: jest.fn().mockResolvedValue({ id: 'req-1', riderId: 'rider-1' }),
      update: jest.fn(),
    };
    metrics = { seatConflictTotal: { inc: jest.fn() } };

    service = new BookingService(
      bookings as never,
      trips as never,
      riderRequests as never,
      { get: jest.fn().mockReturnValue(2) } as never,
      {} as never,
      { notify: jest.fn() } as never,
      metrics as never,
      { enabled: false, isOpen: false, post: jest.fn() } as never,
    );
  });

  it('confirms when conditional decrement affects a row', async () => {
    mockTransaction(async () => ({ affected: 1 }));
    bookings.findOne
      .mockResolvedValueOnce({ ...heldBooking })
      .mockResolvedValueOnce({ ...heldBooking, status: BookingStatus.CONFIRMED });

    const result = await service.driverRespond(driverId, heldBooking.id, 'accept');

    expect(result.status).toBe(BookingStatus.CONFIRMED);
    expect(metrics.seatConflictTotal.inc).not.toHaveBeenCalled();
  });

  it('rejects confirm when no seats remain (affected = 0) and records conflict', async () => {
    mockTransaction(async () => ({ affected: 0 }));
    bookings.findOne.mockResolvedValueOnce({ ...heldBooking });

    await expect(
      service.driverRespond(driverId, heldBooking.id, 'accept'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(metrics.seatConflictTotal.inc).toHaveBeenCalledTimes(1);
  });

  it('allows only one of two concurrent confirms for a single seat', async () => {
    let remaining = 1;
    mockTransaction(async () => {
      if (remaining >= 1) {
        remaining -= 1;
        return { affected: 1 };
      }
      return { affected: 0 };
    });

    bookings.findOne.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === 'b1' || where.id === 'b2') {
        return { ...heldBooking, id: where.id };
      }
      return { ...heldBooking, id: where.id, status: BookingStatus.CONFIRMED };
    });

    const outcomes = await Promise.allSettled([
      service.driverRespond(driverId, 'b1', 'accept'),
      service.driverRespond(driverId, 'b2', 'accept'),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe('rejected');
    if (rejected[0].status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    }
    expect(remaining).toBe(0);
    expect(metrics.seatConflictTotal.inc).toHaveBeenCalledTimes(1);
  });

  it('forbids another driver from accepting', async () => {
    mockTransaction(async () => ({ affected: 1 }));
    bookings.findOne.mockResolvedValueOnce({ ...heldBooking });

    await expect(
      service.driverRespond('other-driver', heldBooking.id, 'accept'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
