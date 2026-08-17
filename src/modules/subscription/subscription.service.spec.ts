import { SubscriptionService } from './subscription.service';
import { PaymentProvider } from './entities/payment-event.entity';
import { SubscriptionState } from './entities/driver-subscription.entity';

describe('SubscriptionService webhook idempotency', () => {
  let service: SubscriptionService;
  let paymentEvents: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  let subscriptions: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let history: { save: jest.Mock; create: jest.Mock };
  let trips: { update: jest.Mock };
  let configuration: { get: jest.Mock };
  let notifications: { notify: jest.Mock };
  let envConfig: { get: jest.Mock };
  let redis: { set: jest.Mock; del: jest.Mock };

  const dto = {
    provider: PaymentProvider.CHAPA,
    providerReference: 'chapa-ref-abc',
    driverId: '11111111-1111-1111-1111-111111111111',
    amount: '1000',
    rawPayload: { ok: true },
  };

  beforeEach(() => {
    paymentEvents = {
      findOne: jest.fn(),
      save: jest.fn(async (e) => ({ id: 'evt-1', ...e })),
      create: jest.fn((e) => e),
      update: jest.fn(),
    };
    subscriptions = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (s) => s),
      create: jest.fn((s) => s),
    };
    history = {
      save: jest.fn(async (h) => h),
      create: jest.fn((h) => h),
    };
    trips = { update: jest.fn() };
    configuration = {
      get: jest.fn((key: string) => {
        if (key === 'subscription_fee_etb') return 1000;
        if (key === 'cycle_length_days') return 30;
        if (key === 'grace_period_hours') return 24;
        return null;
      }),
    };
    notifications = { notify: jest.fn() };
    envConfig = { get: jest.fn().mockReturnValue('false') };
    redis = { set: jest.fn().mockResolvedValue('OK'), del: jest.fn() };

    service = new SubscriptionService(
      subscriptions as never,
      paymentEvents as never,
      history as never,
      trips as never,
      configuration as never,
      notifications as never,
      envConfig as never,
      redis as never,
    );
  });

  it('activates on first delivery', async () => {
    paymentEvents.findOne.mockResolvedValue(null);

    const result = await service.handleConfirmedPayment(dto);

    expect(result).toEqual({ activated: true });
    expect(paymentEvents.save).toHaveBeenCalledTimes(1);
    expect(subscriptions.save).toHaveBeenCalledWith(
      expect.objectContaining({ state: SubscriptionState.ACTIVE }),
    );
  });

  it('is a no-op on duplicate providerReference (idempotent)', async () => {
    paymentEvents.findOne.mockResolvedValue({
      id: 'evt-existing',
      providerReference: dto.providerReference,
      processed: true,
      driverId: dto.driverId,
    });

    const result = await service.handleConfirmedPayment(dto);

    expect(result).toEqual({ alreadyProcessed: true });
    expect(paymentEvents.save).not.toHaveBeenCalled();
    expect(subscriptions.save).not.toHaveBeenCalled();
  });

  it('replays of the same event never double-activate', async () => {
    paymentEvents.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: 'evt-1',
        providerReference: dto.providerReference,
        processed: true,
        driverId: dto.driverId,
      });

    const first = await service.handleConfirmedPayment(dto);
    const second = await service.handleConfirmedPayment(dto);
    const third = await service.handleConfirmedPayment(dto);

    expect(first).toEqual({ activated: true });
    expect(second).toEqual({ alreadyProcessed: true });
    expect(third).toEqual({ alreadyProcessed: true });
    expect(paymentEvents.save).toHaveBeenCalledTimes(1);
    expect(subscriptions.save).toHaveBeenCalledTimes(1);
  });

  it('continues activate when concurrent insert wins but event is not processed', async () => {
    const { QueryFailedError } = await import('typeorm');
    const uniqueErr = Object.assign(
      new QueryFailedError('INSERT', [], new Error('duplicate')),
      { driverError: { code: '23505' } },
    );

    paymentEvents.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'evt-raced',
        providerReference: dto.providerReference,
        processed: false,
        driverId: dto.driverId,
        amount: dto.amount,
      });
    paymentEvents.save.mockRejectedValueOnce(uniqueErr);

    const result = await service.handleConfirmedPayment(dto);
    expect(result).toEqual({ activated: true });
    expect(subscriptions.save).toHaveBeenCalled();
  });

  it('does not extend a cycle already paid with this reference', async () => {
    paymentEvents.findOne.mockResolvedValue({
      id: 'evt-1',
      providerReference: dto.providerReference,
      processed: false,
      driverId: dto.driverId,
      amount: dto.amount,
    });
    subscriptions.findOne.mockResolvedValue({
      driverId: dto.driverId,
      state: SubscriptionState.ACTIVE,
      lastPaymentReference: dto.providerReference,
    });

    const result = await service.handleConfirmedPayment(dto);

    expect(result).toEqual({ alreadyProcessed: true });
    expect(subscriptions.save).not.toHaveBeenCalled();
    expect(paymentEvents.update).toHaveBeenCalledWith('evt-1', {
      processed: true,
    });
  });

  it('rejects underpayment without activating', async () => {
    paymentEvents.findOne.mockResolvedValue(null);

    const result = await service.handleConfirmedPayment({
      ...dto,
      amount: '100',
    });

    expect(result).toEqual({ activated: false, reason: 'underpayment' });
    expect(subscriptions.save).not.toHaveBeenCalled();
  });
});
