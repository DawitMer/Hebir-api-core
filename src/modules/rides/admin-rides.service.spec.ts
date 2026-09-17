import { Test, TestingModule } from '@nestjs/testing';
import { AdminRidesService } from './admin-rides.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Ride, RideStatus } from './entities/ride.entity';
import { RideStatusEvent } from './entities/ride-status-event.entity';
import { DriverProfile } from './entities/driver-profile.entity';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { DispatchQueueService } from './dispatch/dispatch.queue.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PromotionsService } from '../promotions/promotions.service';

describe('AdminRidesService', () => {
  let service: AdminRidesService;
  let ridesRepo: any;
  let manager: any;
  let notificationsGateway: any;
  let dispatchQueueService: any;

  beforeEach(async () => {
    manager = {
      findOne: jest.fn(),
      save: jest.fn(async (_target, entity) => entity),
      create: jest.fn((_target, entity) => entity),
      update: jest.fn(),
    };
    ridesRepo = {
      manager: {
        transaction: jest.fn((callback) => callback(manager)),
      },
    };
    notificationsGateway = { notify: jest.fn() };
    dispatchQueueService = { clearState: jest.fn() };
    const promotionsService = { refundPromotion: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminRidesService,
        { provide: getRepositoryToken(Ride), useValue: ridesRepo },
        { provide: getRepositoryToken(DriverProfile), useValue: {} },
        { provide: NotificationsGateway, useValue: notificationsGateway },
        { provide: DispatchQueueService, useValue: dispatchQueueService },
        { provide: REDIS_CLIENT, useValue: { eval: jest.fn(), del: jest.fn().mockResolvedValue(1) } },
        { provide: PromotionsService, useValue: promotionsService },
      ],
    }).compile();

    service = module.get<AdminRidesService>(AdminRidesService);
  });

  it('rejects a missing ride inside the transaction', async () => {
    manager.findOne.mockResolvedValue(null);
    await expect(
      service.forceCancelRide('ride-123', 'admin-1', 'admin', 'test reason'),
    ).rejects.toThrow(NotFoundException);
    expect(ridesRepo.manager.transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a terminal ride without clearing cache or notifying', async () => {
    manager.findOne.mockResolvedValue({ status: RideStatus.CANCELLED });
    await expect(
      service.forceCancelRide('ride-123', 'admin-1', 'admin', 'test reason'),
    ).rejects.toThrow(ConflictException);
    expect(dispatchQueueService.clearState).not.toHaveBeenCalled();
    expect(notificationsGateway.notify).not.toHaveBeenCalled();
  });

  it('commits ride, audit event, and driver release before cache cleanup', async () => {
    manager.findOne.mockResolvedValue({
      id: 'ride-123',
      status: RideStatus.IN_PROGRESS,
      riderId: 'rider-1',
      driverId: 'driver-1',
      offerDriverId: null,
    });

    const result = await service.forceCancelRide(
      'ride-123',
      'admin-1',
      'admin',
      'safety incident',
    );

    expect(result.status).toBe(RideStatus.CANCELLED);
    expect(result.cancellationReason).toBe('safety incident');
    expect(manager.save).toHaveBeenCalledWith(
      RideStatusEvent,
      expect.objectContaining({ status: RideStatus.CANCELLED }),
    );
    expect(manager.update).toHaveBeenCalled();
    expect(dispatchQueueService.clearState).toHaveBeenCalledWith('ride-123');
    expect(notificationsGateway.notify).toHaveBeenCalledWith(
      'rider-1',
      'ride.cancelled',
      expect.any(Object),
    );
    expect(notificationsGateway.notify).toHaveBeenCalledWith(
      'driver-1',
      'ride.cancelled',
      expect.any(Object),
    );
  });
});
