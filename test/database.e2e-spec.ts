import 'reflect-metadata';
import { createHash, randomInt, randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DataSource, IsNull } from 'typeorm';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from '../src/modules/auth/auth.service';
import {
  AccountStanding,
  UserAccount,
  UserRole,
} from '../src/modules/auth/entities/user-account.entity';
import { RefreshToken } from '../src/modules/auth/entities/refresh-token.entity';
import { Ride, RideStatus } from '../src/modules/rides/entities/ride.entity';
import { RideMessage } from '../src/modules/rides/entities/ride-message.entity';
import { RideStatusEvent } from '../src/modules/rides/entities/ride-status-event.entity';
import { RideRouteCheckpoint } from '../src/modules/rides/entities/ride-route-checkpoint.entity';
import { FareRecord } from '../src/modules/rides/entities/fare-record.entity';
import { Vehicle } from '../src/modules/rides/entities/vehicle.entity';
import {
  DriverProfile,
  DriverStatus,
} from '../src/modules/rides/entities/driver-profile.entity';
import { DriverEarning } from '../src/modules/rides/entities/driver-earning.entity';
import { PaymentRecord } from '../src/modules/rides/entities/payment-record.entity';
import { Tip } from '../src/modules/tips/entities/tip.entity';
import { TipsService } from '../src/modules/tips/tips.service';
import { RidesService } from '../src/modules/rides/rides.service';
import { TripRouteRecorderService } from '../src/modules/rides/trip-route-recorder.service';
import { FareService } from '../src/modules/fare/fare.service';
import { CashPaymentProvider } from '../src/modules/payments/cash.provider';
import { DurableRideChat1788456000000 } from '../src/database/migrations/1788456000000-DurableRideChat';
import { DurableRouteCheckpoint1788456100000 } from '../src/database/migrations/1788456100000-DurableRouteCheckpoint';
import { KycService } from '../src/modules/kyc/kyc.service';
import {
  DriverVerification,
  VerificationStatus,
} from '../src/modules/kyc/entities/driver-verification.entity';
import {
  DocumentSubmission,
  DocumentReviewStatus,
  DocumentCategory,
} from '../src/modules/kyc/entities/document-submission.entity';
import { AuditTrail } from '../src/modules/kyc/entities/audit-trail.entity';
import { ComplianceAlert } from '../src/modules/kyc/entities/compliance-alert.entity';
import { ReviewDecision } from '../src/modules/kyc/dto/review-decision.dto';
import { PushService } from '../src/modules/push/push.service';
import { DeviceToken } from '../src/modules/push/device-token.entity';
import { GovService } from '../src/modules/gov/gov.service';
import { GovController } from '../src/modules/gov/gov.controller';
import { PromotionsService } from '../src/modules/promotions/promotions.service';
import { PromotionsController } from '../src/modules/promotions/promotions.controller';
import { GovAccessLog } from '../src/modules/gov/entities/access-log.entity';
import {
  DriverMonthlyExpenseReport,
  MonthlyExpenseStatus,
} from '../src/modules/gov/entities/driver-monthly-expense-report.entity';
import { Booking } from '../src/modules/booking/entities/booking.entity';
import { Trip } from '../src/modules/matching/entities/trip.entity';
import { RiderRequest } from '../src/modules/matching/entities/rider-request.entity';
import { DriverSubscription } from '../src/modules/subscription/entities/driver-subscription.entity';
import { SubscriptionStatusHistory } from '../src/modules/subscription/entities/status-history.entity';
import { PaymentEvent } from '../src/modules/subscription/entities/payment-event.entity';
import { Incident } from '../src/modules/incidents/entities/incident.entity';
import {
  AdCampaign,
  AdRewardEvent,
  AdViewSession,
  DriverCashoutRequest,
  DriverWalletEntry,
  RideAdSettlement,
  RiderAdProfile,
} from '../src/modules/ads/entities/ad-rewards.entity';
import {
  Promotion,
  PromotionClaim,
} from '../src/modules/promotions/entities/promotion.entity';
import { Rating } from '../src/modules/ratings/entities/rating.entity';
import { DriverExpense } from '../src/modules/gov/entities/driver-expense.entity';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { RidesController } from '../src/modules/rides/rides.controller';
import { KycController } from '../src/modules/kyc/kyc.controller';
import { KycStorageService } from '../src/modules/kyc/kyc-storage.service';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import request from 'supertest';
import { ConfigurationService } from '../src/modules/subscription/configuration.service';
import { Configuration } from '../src/modules/subscription/entities/configuration.entity';
import { SupportService } from '../src/modules/support/support.service';
import { SupportThread } from '../src/modules/support/entities/support-thread.entity';
import { SupportMessage } from '../src/modules/support/entities/support-message.entity';
import { SupportMessageIdempotency1788456200000 } from '../src/database/migrations/1788456200000-SupportMessageIdempotency';
import { LockQuotedFareRates1788456300000 } from '../src/database/migrations/1788456300000-LockQuotedFareRates';
import { LocationController } from '../src/modules/location/location.controller';
import { DriverLocationHistory } from '../src/modules/location/entities/driver-location-history.entity';
import { NotificationsGateway } from '../src/modules/notifications/notifications.gateway';
import { liveTrackKey } from '../src/modules/rides/ride-live-track';

const __dirname = dirname(fileURLToPath(import.meta.url));

const entities = [
  AdCampaign,
  AdRewardEvent,
  AdViewSession,
  AuditTrail,
  Booking,
  ComplianceAlert,
  Configuration,
  DeviceToken,
  DocumentSubmission,
  DriverCashoutRequest,
  DriverEarning,
  DriverExpense,
  DriverLocationHistory,
  DriverMonthlyExpenseReport,
  DriverProfile,
  DriverSubscription,
  DriverVerification,
  DriverWalletEntry,
  FareRecord,
  GovAccessLog,
  Incident,
  PaymentEvent,
  PaymentRecord,
  Promotion,
  PromotionClaim,
  Rating,
  RefreshToken,
  Ride,
  RideAdSettlement,
  RideMessage,
  RideRouteCheckpoint,
  RideStatusEvent,
  RiderAdProfile,
  RiderRequest,
  SubscriptionStatusHistory,
  SupportMessage,
  SupportThread,
  Tip,
  Trip,
  UserAccount,
  Vehicle,
];

// Opt-in only: no dotenv, production AppModule, external messages or PSP calls.
const databaseUrl = process.env.HEBIR_TEST_DATABASE_URL;
const redisUrl = process.env.HEBIR_TEST_REDIS_URL;
function assertIsolated(url: string, database: boolean) {
  const parsed = new URL(url);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    (database && !/^\/hebir_audit_[a-zA-Z0-9_]+$/.test(parsed.pathname)) ||
    (!database && ['6379', ''].includes(parsed.port))
  ) {
    throw new Error(
      'Integration tests require explicitly isolated loopback PostgreSQL/Redis',
    );
  }
}
if (databaseUrl) assertIsolated(databaseUrl, true);
if (redisUrl) assertIsolated(redisUrl, false);
const run = databaseUrl && redisUrl ? describe : describe.skip;

run('isolated PostgreSQL + Redis production-contract regressions', () => {
  let db: DataSource;
  let redis: Redis;
  let auth: AuthService;
  let rides: RidesService;
  let recorder: TripRouteRecorderService;
  let tips: TipsService;
  let verificationService: KycService;
  let app: INestApplication;
  let government: GovService;
  const storage = {
    storageMode: 's3',
    assertUploadedObject: jest.fn().mockResolvedValue(undefined),
    assertPendingUpload: jest.fn().mockResolvedValue(true),
    markUploaded: jest.fn().mockResolvedValue(undefined),
    createViewUrl: jest.fn(
      async (key: string) => `https://test.invalid/${key}`,
    ),
  };
  const config = new ConfigService({
    NODE_ENV: 'test',
    JWT_ACCESS_SECRET: 'isolated-test-secret-not-a-live-key',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '30d',
  });
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const geocoding = {
    reverseGeocodePair: jest
      .fn()
      .mockResolvedValue({ pickupAddress: 'A', dropoffAddress: 'B' }),
  };
  const kyc = { mapDriverPhotoUrls: jest.fn().mockResolvedValue(new Map()) };

  async function user(role = UserRole.RIDER) {
    return db.getRepository(UserAccount).save({
      phoneNumber: '+2519' + randomInt(10000000, 99999999),
      roles: [role],
      fullName: 'Isolated audit fixture',
      standing: AccountStanding.GOOD,
    });
  }
  async function ride(status = RideStatus.IN_PROGRESS) {
    const rider = await user();
    const driver = await user(UserRole.DRIVER);
    await db
      .getRepository(DriverProfile)
      .save({ userId: driver.id, status: DriverStatus.ON_TRIP });
    const trip = await db.getRepository(Ride).save({
      riderId: rider.id,
      driverId: driver.id,
      status,
      pickup: { lat: 9.03, lng: 38.75 },
      dropoff: { lat: 9.04, lng: 38.76 },
      startedAt: new Date(Date.now() - 60000),
      completedAt: status === RideStatus.COMPLETED ? new Date() : null,
      distanceM: 2000,
      quotedSurgeMultiplier: 1,
    });
    return { trip, rider, driver };
  }
  async function token(account: UserAccount) {
    const raw = randomUUID();
    const row = await db.getRepository(RefreshToken).save({
      userId: account.id,
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000),
      revokedAt: null,
    });
    return { raw, row };
  }

  beforeAll(async () => {
    db = await new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities,
      migrations: [join(__dirname, '../dist/src/database/migrations/*.js')],
      synchronize: false,
      migrationsTransactionMode: 'each',
    }).initialize();
    await db.runMigrations();
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    await redis.ping();
    const repo = <T extends import('typeorm').ObjectLiteral>(
      entity: import('typeorm').EntityTarget<T>,
    ) => db.getRepository(entity);
    auth = new AuthService(
      repo(UserAccount),
      repo(RefreshToken),
      new JwtService(),
      config,
      redis,
      {} as never,
      {} as never,
    );
    recorder = new TripRouteRecorderService(redis, repo(RideRouteCheckpoint));
    const fare = new FareService({ get: () => undefined } as never, config, {
      enabled: false,
    } as never);
    rides = new RidesService(
      repo(Ride),
      repo(RideStatusEvent),
      repo(RideMessage),
      repo(FareRecord),
      repo(Vehicle),
      repo(Tip),
      repo(UserAccount),
      repo(DriverProfile),
      repo(DriverEarning),
      repo(PaymentRecord),
      fare,
      { mayAccessMarketplace: async () => true } as never,
      kyc as never,
      notifications as never,
      config,
      { enabled: false } as never,
      geocoding as never,
      redis,
      { clearState: async () => undefined } as never,
      new CashPaymentProvider(),
      recorder,
    );
    tips = new TipsService(
      repo(Tip),
      repo(Ride),
      repo(PaymentRecord),
      repo(DriverEarning),
      config,
      notifications as never,
    );
    verificationService = new KycService(
      repo(DriverVerification),
      repo(DocumentSubmission),
      repo(AuditTrail),
      repo(ComplianceAlert),
      repo(UserAccount),
      repo(Vehicle),
      {} as never,
      storage as never,
    );
    government = new GovService(
      repo(GovAccessLog),
      repo(DriverMonthlyExpenseReport),
      repo(Booking),
      repo(DriverSubscription),
      repo(Trip),
      repo(RiderRequest),
      repo(UserAccount),
      repo(Vehicle),
      repo(Ride),
      repo(FareRecord),
      repo(DriverVerification),
      notifications as never,
      { send: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [
        RidesController,
        KycController,
        PromotionsController,
        GovController,
      ],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: config },
        { provide: AuthService, useValue: auth },
        { provide: RidesService, useValue: rides },
        { provide: GovService, useValue: government },
        {
          provide: PromotionsService,
          useValue: new PromotionsService(
            repo(Promotion),
            repo(PromotionClaim),
          ),
        },
        { provide: KycService, useValue: verificationService },
        { provide: KycStorageService, useValue: storage },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  }, 60000);

  it('serializes support thread creation, retries, reopening and cursor history', async () => {
    const account = await user();
    const agent = await user(UserRole.ADMIN);
    const service = new SupportService(
      db.getRepository(SupportThread),
      db.getRepository(SupportMessage),
      db.getRepository(UserAccount),
      notifications as never,
    );
    const threads = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.getOrCreateMine(account.id, account.roles),
      ),
    );
    expect(new Set(threads.map((row) => row.thread.id)).size).toBe(1);
    const threadId = threads[0].thread.id;
    const clientId = randomUUID();
    const messages = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.postUserMessage(
          account.id,
          account.roles,
          'Please help',
          clientId,
        ),
      ),
    );
    expect(new Set(messages.map((row) => row.id)).size).toBe(1);
    await expect(
      service.postUserMessage(account.id, account.roles, 'different', clientId),
    ).rejects.toMatchObject({ status: 409 });
    await service.updateThread(threadId, agent.id, { status: 'closed' });
    expect(
      (await service.getOrCreateMine(account.id, account.roles)).thread.status,
    ).toBe('closed');
    await service.postUserMessage(
      account.id,
      account.roles,
      'Follow-up',
      randomUUID(),
    );
    expect((await service.getThreadForStaff(threadId)).thread.status).toBe(
      'open',
    );
    for (let i = 0; i < 55; i++)
      await service.postAgentMessage(
        threadId,
        agent.id,
        'reply ' + i,
        randomUUID(),
      );
    const ids = new Set<string>();
    let before: string | undefined;
    do {
      const page = await service.getOrCreateMine(account.id, account.roles, {
        before,
        limit: 17,
      });
      for (const message of page.messages) {
        expect(ids.has(message.id)).toBe(false);
        ids.add(message.id);
      }
      before = page.nextCursor ?? undefined;
    } while (before);
    expect(ids.size).toBe(58);
    expect(
      (await service.getOrCreateMine((await user()).id, [UserRole.RIDER]))
        .thread.id,
    ).not.toBe(threadId);
  });

  it('preserves configured rates across parallel boots and refreshes other replica snapshots', async () => {
    const repository = db.getRepository(Configuration);
    await repository.upsert(
      [
        { key: 'fare_initial_fee_etb', value: 20 },
        { key: 'fare_per_meter_etb', value: 0.008 },
        { key: 'fare_per_minute_etb', value: 1 },
        { key: 'fare_minimum_etb', value: 20 },
      ],
      ['key'],
    );
    const replicas = [
      new ConfigurationService(repository),
      new ConfigurationService(repository),
    ];
    await Promise.all(replicas.map((service) => service.onModuleInit()));
    expect(replicas[0].get('fare_initial_fee_etb')).toBe(20);
    await replicas[0].setMany([
      { key: 'fare_initial_fee_etb', value: 45 },
      { key: 'fare_minimum_etb', value: 65 },
    ]);
    expect(replicas[1].get('fare_initial_fee_etb')).toBe(20);
    await replicas[1].refreshReplicaCache();
    expect(replicas[1].get('fare_initial_fee_etb')).toBe(45);
    expect(replicas[1].get('fare_minimum_etb')).toBe(65);
    // A rejected second update must roll back the entire price bundle.
    await expect(
      replicas[0].setMany([
        { key: 'fare_initial_fee_etb', value: 99 },
        { key: 'isolated_invalid_' + randomUUID(), value: undefined },
      ]),
    ).rejects.toThrow();
    await replicas[0].refreshCache();
    expect(replicas[0].get('fare_initial_fee_etb')).toBe(45);
  });

  it('ignores stale assignment caches and does not acknowledge failed metering', async () => {
    const { trip, driver, rider } = await ride();
    const formerRider = await user();
    await redis.set(
      liveTrackKey(driver.id),
      JSON.stringify({ rideId: randomUUID(), riderId: formerRider.id }),
    );
    const delivery = { notify: jest.fn().mockResolvedValue(undefined) };
    const location = new LocationController(
      config,
      { enabled: false } as never,
      {} as never,
      {} as never,
      db.getRepository(DriverLocationHistory),
      db.getRepository(DriverProfile),
      db.getRepository(Ride),
      delivery as never,
      recorder,
      redis,
    );
    await location.updateLocation(
      { userId: driver.id },
      { lat: 9.0302, lng: 38.75, accuracy: 4 },
    );
    expect(delivery.notify).toHaveBeenCalledWith(
      rider.id,
      'ride.driver_location',
      expect.objectContaining({ rideId: trip.id }),
    );
    expect(
      delivery.notify.mock.calls.some((call) => call[0] === formerRider.id),
    ).toBe(false);
    const failure = jest
      .spyOn(recorder, 'recordGpsPoint')
      .mockRejectedValueOnce(new Error('isolated injected database failure'));
    await expect(
      location.updateLocation(
        { userId: driver.id },
        { lat: 9.0303, lng: 38.75, accuracy: 4 },
      ),
    ).rejects.toMatchObject({ status: 503 });
    failure.mockRestore();
  });

  it('relays Redis events only to authenticated users and rechecks revoked/expired sockets', async () => {
    const account = await user();
    const jwt = new JwtService({ secret: config.get('JWT_ACCESS_SECRET') });
    const jti = randomUUID();
    const token = jwt.sign(
      { sub: account.id, typ: 'access', jti },
      { expiresIn: '15m' },
    );
    const gateway = new NotificationsGateway(
      redis,
      jwt,
      auth,
      { notifyEvent: async () => undefined } as never,
      config,
    );
    const subscriber = (gateway as unknown as { subscriber: Redis }).subscriber;
    await subscriber.subscribe('notifications');
    let signal: () => void = () => undefined;
    const socket = {
      id: randomUUID(),
      data: {},
      handshake: {
        auth: { token },
        query: { userId: randomUUID() },
        headers: {},
      },
      emit: jest.fn(() => signal()),
      disconnect: jest.fn(() => signal()),
    };
    gateway.server = {
      sockets: { sockets: new Map([[socket.id, socket]]) },
    } as never;
    try {
      await gateway.handleConnection(socket as never);
      const event = () =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Redis notification timeout')),
            2000,
          );
          signal = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      let received = event();
      await gateway.notify(account.id, 'test.notification', { ok: true });
      await received;
      expect(socket.emit).toHaveBeenCalledTimes(1);
      await redis.set('jwt:deny:' + jti, '1', 'EX', 60);
      received = event();
      await gateway.notify(account.id, 'test.notification', { private: true });
      await received;
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.emit).toHaveBeenCalledTimes(1);
      const expired = {
        ...socket,
        id: randomUUID(),
        data: {},
        handshake: {
          auth: { token: jwt.sign({ sub: account.id }, { expiresIn: -1 }) },
          query: {},
          headers: {},
        },
        disconnect: jest.fn(),
      };
      await gateway.handleConnection(expired as never);
      expect(expired.disconnect).toHaveBeenCalledWith(true);
    } finally {
      await gateway.onModuleDestroy();
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    if (redis) await redis.quit();
    if (db?.isInitialized) await db.destroy();
  });

  it('applies all migrations, and a second run is a no-op', async () => {
    expect(await db.runMigrations()).toHaveLength(0);
    const columns = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'ride_messages'",
    );
    expect(columns.map((r: { column_name: string }) => r.column_name)).toEqual(
      expect.arrayContaining(['receiverId', 'clientMessageId', 'readAt']),
    );
  });

  it('exercises additive migration down/up inside a rolled-back transaction', async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await new LockQuotedFareRates1788456300000().down(runner);
      await new SupportMessageIdempotency1788456200000().down(runner);
      await new DurableRouteCheckpoint1788456100000().down(runner);
      await new DurableRideChat1788456000000().down(runner);
      await new DurableRideChat1788456000000().up(runner);
      await new DurableRouteCheckpoint1788456100000().up(runner);
      await new SupportMessageIdempotency1788456200000().up(runner);
      await new LockQuotedFareRates1788456300000().up(runner);
      expect(await runner.hasTable('ride_route_checkpoints')).toBe(true);
    } finally {
      // Preserve any fixtures from previous runs, including message receipt metadata.
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('enforces chat ownership, deduplicates concurrent retries and rejects key reuse with different text', async () => {
    const { trip, rider, driver } = await ride();
    const clientId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        rides.sendRideMessage(trip.id, rider.id, 'hello', clientId),
      ),
    );
    expect(new Set(results.map((m) => m.id)).size).toBe(1);
    expect(
      await db.getRepository(RideMessage).count({ where: { rideId: trip.id } }),
    ).toBe(1);
    expect(results[0]).toMatchObject({
      senderId: rider.id,
      receiverId: driver.id,
      status: 'sent',
    });
    await expect(
      rides.sendRideMessage(trip.id, rider.id, 'changed', clientId),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      rides.listRideMessages(trip.id, (await user()).id),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('pages newest-first windows without losing equal-timestamp rows and retains old history', async () => {
    const { trip, rider, driver } = await ride();
    await db.getRepository(RideMessage).insert(
      Array.from({ length: 123 }, (_, i) => ({
        rideId: trip.id,
        senderId: rider.id,
        receiverId: driver.id,
        senderType: 'rider',
        body: String(i),
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
      })),
    );
    await db.query(
      'UPDATE ride_messages SET "createdAt" = \'2020-01-01 00:00:00.000999+00\' WHERE "rideId" = $1',
      [trip.id],
    );
    const all: string[] = [];
    let before: string | undefined;
    do {
      const page = await rides.listRideMessages(trip.id, rider.id, {
        limit: 17,
        before,
      });
      expect(page.retentionDays).toBeNull();
      all.push(...page.messages.map((m) => m.id));
      before = page.nextCursor ?? undefined;
    } while (before);
    expect(all).toHaveLength(123);
    expect(new Set(all).size).toBe(123);
  });

  it('read receipts affect only incoming messages and cannot use another ride cursor', async () => {
    const { trip, rider, driver } = await ride();
    const incoming = await rides.sendRideMessage(
      trip.id,
      rider.id,
      'read this',
      randomUUID(),
    );
    const outgoing = await rides.sendRideMessage(
      trip.id,
      driver.id,
      'reply',
      randomUUID(),
    );
    await rides.readRideMessages(trip.id, driver.id, outgoing.id);
    expect(
      (await db.getRepository(RideMessage).findOneByOrFail({ id: incoming.id }))
        .readAt,
    ).not.toBeNull();
    expect(
      (await db.getRepository(RideMessage).findOneByOrFail({ id: outgoing.id }))
        .readAt,
    ).toBeNull();
    const other = await ride();
    await expect(
      rides.listRideMessages(other.trip.id, other.rider.id, {
        before: incoming.id,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const replacement = await user(UserRole.DRIVER);
    await db.getRepository(Ride).update(trip.id, { driverId: replacement.id });
    expect(
      (await rides.listRideMessages(trip.id, replacement.id)).messages,
    ).toHaveLength(0);
  });

  it('commits expiry and closed-account revocation even though refresh rejects', async () => {
    const account = await user();
    const expired = await token(account);
    await db
      .getRepository(RefreshToken)
      .update(expired.row.id, { expiresAt: new Date(0) });
    await expect(auth.refresh(expired.raw)).rejects.toMatchObject({
      status: 401,
    });
    expect(
      (
        await db
          .getRepository(RefreshToken)
          .findOneByOrFail({ id: expired.row.id })
      ).revokedAt,
    ).not.toBeNull();
    const banned = await token(account);
    await db
      .getRepository(UserAccount)
      .update(account.id, { standing: AccountStanding.BANNED });
    await expect(auth.refresh(banned.raw)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (
        await db
          .getRepository(RefreshToken)
          .findOneByOrFail({ id: banned.row.id })
      ).revokedAt,
    ).not.toBeNull();
  });

  it('serializes concurrent rotation and revokes the family on detected reuse', async () => {
    const account = await user();
    const original = await token(account);
    const outcomes = await Promise.allSettled([
      auth.refresh(original.raw),
      auth.refresh(original.raw),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      await db
        .getRepository(RefreshToken)
        .count({ where: { userId: account.id, revokedAt: IsNull() } }),
    ).toBe(0);
  });

  it('rolls back a newly issued token when retiring the old token fails', async () => {
    const account = await user();
    const original = await token(account);
    await db.query(`CREATE FUNCTION audit_fail_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."replacedById" IS NOT NULL THEN RAISE EXCEPTION 'audit injected failure'; END IF; RETURN NEW; END $$`);
    await db.query(
      'CREATE TRIGGER audit_fail_refresh BEFORE UPDATE ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION audit_fail_refresh()',
    );
    try {
      await expect(auth.refresh(original.raw)).rejects.toThrow(
        'audit injected failure',
      );
      expect(
        await db
          .getRepository(RefreshToken)
          .count({ where: { userId: account.id } }),
      ).toBe(1);
      expect(
        (
          await db
            .getRepository(RefreshToken)
            .findOneByOrFail({ id: original.row.id })
        ).revokedAt,
      ).toBeNull();
    } finally {
      await db.query('DROP TRIGGER audit_fail_refresh ON refresh_tokens');
      await db.query('DROP FUNCTION audit_fail_refresh()');
    }
  });

  it('serializes GPS duplicates, never resets on repeated start, and restores distance after Redis loss', async () => {
    const { trip } = await ride();
    const initial = { ...trip.pickup, timestampMs: trip.startedAt!.getTime() };
    await recorder.startRecording(trip.id, initial);
    const sample = {
      ...initial,
      lat: initial.lat + 0.0045,
      timestampMs: initial.timestampMs + 30000,
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        recorder.recordGpsPoint(trip.id, sample),
      ),
    );
    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    const meters = await recorder.getAccumulatedDistance(trip.id);
    expect(meters).toBeGreaterThan(450);
    expect(meters).toBeLessThan(550);
    await recorder.startRecording(trip.id, initial);
    await redis.del(`ride:dist:${trip.id}`);
    const restarted = new TripRouteRecorderService(
      redis,
      db.getRepository(RideRouteCheckpoint),
    );
    expect(await restarted.getAccumulatedDistance(trip.id)).toBe(meters);
    expect((await restarted.recordGpsPoint(trip.id, initial)).reason).toBe(
      'out_of_order',
    );
  });

  it('concurrent completion writes one fare/payment/earning and a stable receipt', async () => {
    const { trip, driver } = await ride();
    await recorder.startRecording(trip.id, {
      ...trip.pickup,
      timestampMs: trip.startedAt!.getTime(),
    });
    await recorder.recordGpsPoint(trip.id, {
      ...trip.pickup,
      lat: trip.pickup.lat + 0.0045,
      timestampMs: trip.startedAt!.getTime() + 30000,
    });
    const completed = await Promise.all(
      Array.from({ length: 8 }, () => rides.completeRide(trip.id, driver.id)),
    );
    expect(completed.every((r) => r.status === RideStatus.COMPLETED)).toBe(
      true,
    );
    expect(new Set(completed.map((r) => r.fare)).size).toBe(1);
    expect(
      await db.getRepository(FareRecord).count({ where: { rideId: trip.id } }),
    ).toBe(1);
    expect(
      await db
        .getRepository(PaymentRecord)
        .count({ where: { rideId: trip.id } }),
    ).toBe(1);
    expect(
      await db
        .getRepository(DriverEarning)
        .count({ where: { sourceId: trip.id } }),
    ).toBe(1);
    expect(
      (
        await db
          .getRepository(DriverProfile)
          .findOneByOrFail({ userId: driver.id })
      ).totalTrips,
    ).toBe(1);
  });

  it('deduplicates concurrent tips and scopes idempotency to owner/ride/amount', async () => {
    const { trip, rider } = await ride(RideStatus.COMPLETED);
    const dto = { rideId: trip.id, amount: 10, idempotencyKey: randomUUID() };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => tips.createTip(rider.id, dto)),
    );
    expect(new Set(results.map((t) => t.id)).size).toBe(1);
    expect(
      await db.getRepository(Tip).count({ where: { rideId: trip.id } }),
    ).toBe(1);
    expect(
      await db
        .getRepository(DriverEarning)
        .count({ where: { sourceId: results[0].id } }),
    ).toBe(1);
    await expect(
      tips.createTip(rider.id, { ...dto, amount: 11 }),
    ).rejects.toMatchObject({ status: 409 });
    const other = await ride(RideStatus.COMPLETED);
    await expect(
      tips.createTip(other.rider.id, { ...dto, rideId: other.trip.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('concurrent onboarding creates one application and vehicle and cannot approve missing documents', async () => {
    const driver = await user(UserRole.DRIVER);
    const dto = {
      licenseNumber: `AUD-${randomUUID().slice(0, 8)}`,
      vehicleType: 'Toyota Test',
      region: 'Audit',
      vehicleYear: 2025,
    };
    const applications = await Promise.all(
      Array.from({ length: 8 }, () =>
        verificationService.startOrGetMyVerification(driver.id, dto),
      ),
    );
    expect(new Set(applications.map((a) => a.id)).size).toBe(1);
    expect(
      await db.getRepository(Vehicle).count({ where: { driverId: driver.id } }),
    ).toBe(1);
    await expect(
      verificationService.decide(
        applications[0].id,
        { decision: ReviewDecision.APPROVE },
        (await user(UserRole.ADMIN)).id,
        'admin',
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('KYC confirmation is idempotent, read-only GET cannot approve files, and expiry removes dispatch eligibility', async () => {
    const driver = await user(UserRole.DRIVER);
    const admin = await user(UserRole.ADMIN);
    const application = await verificationService.startOrGetMyVerification(
      driver.id,
      {
        licenseNumber: `AUD-${randomUUID().slice(0, 8)}`,
        vehicleType: 'Toyota Test',
        region: 'Audit',
      },
    );
    for (const documentType of [
      'license',
      'national_id',
      'registration',
      'insurance',
      'selfie',
    ] as const) {
      const dto = {
        storageKey: `kyc/${driver.id}/${documentType}/${randomUUID()}.jpg`,
        documentType,
        category: ['registration', 'insurance'].includes(documentType)
          ? DocumentCategory.VEHICLE
          : DocumentCategory.DRIVER,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
      const confirmations = await Promise.all([
        verificationService.confirmUpload(driver.id, dto),
        verificationService.confirmUpload(driver.id, dto),
      ]);
      expect(confirmations[0].id).toBe(confirmations[1].id);
    }
    await db
      .getRepository(DriverVerification)
      .update(application.id, { status: VerificationStatus.APPROVED });
    await verificationService.listMyDocuments(driver.id);
    expect(
      await db.getRepository(DocumentSubmission).count({
        where: {
          driverVerificationId: application.id,
          status: DocumentReviewStatus.APPROVED,
        },
      }),
    ).toBe(0);
    await db
      .getRepository(DriverVerification)
      .update(application.id, { status: VerificationStatus.IN_REVIEW });
    await verificationService.decide(
      application.id,
      { decision: ReviewDecision.APPROVE },
      admin.id,
      'admin',
    );
    expect(
      (await verificationService.filterApprovedDriverIds([driver.id])).has(
        driver.id,
      ),
    ).toBe(true);
    await db
      .getRepository(DocumentSubmission)
      .update(
        { driverVerificationId: application.id, documentType: 'insurance' },
        { expiresAt: new Date(0) },
      );
    expect(
      (await verificationService.filterApprovedDriverIds([driver.id])).has(
        driver.id,
      ),
    ).toBe(false);
  });

  it('push registration is atomic and removal cannot delete another account device', async () => {
    const account = await user();
    const other = await user();
    const push = new PushService(config, db.getRepository(DeviceToken));
    const deviceToken = randomUUID();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        push.registerToken(account.id, deviceToken, 'android'),
      ),
    );
    expect(
      await db
        .getRepository(DeviceToken)
        .count({ where: { token: deviceToken } }),
    ).toBe(1);
    await push.unregisterToken(other.id, deviceToken);
    expect(
      await db
        .getRepository(DeviceToken)
        .count({ where: { token: deviceToken } }),
    ).toBe(1);
    await push.unregisterToken(account.id, deviceToken);
    expect(
      await db
        .getRepository(DeviceToken)
        .count({ where: { token: deviceToken } }),
    ).toBe(0);
  });

  it('HTTP contracts enforce actual database roles, participant access, UUIDs and body validation', async () => {
    const { trip, rider } = await ride();
    const jwt = new JwtService({
      secret: config.get<string>('JWT_ACCESS_SECRET'),
    });
    const access = jwt.sign(
      { sub: rider.id, typ: 'access', jti: randomUUID(), roles: ['admin'] },
      { expiresIn: '15m' },
    );
    await request(app.getHttpServer())
      .get(`/rides/${trip.id}/messages`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/kyc/queue')
      .set('Authorization', `Bearer ${access}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/rides/not-a-uuid/messages')
      .set('Authorization', `Bearer ${access}`)
      .expect(400);
    await request(app.getHttpServer())
      .post(`/rides/${trip.id}/messages`)
      .set('Authorization', `Bearer ${access}`)
      .send({ body: 'hello', senderId: rider.id })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/rides/${trip.id}/messages`)
      .set('Authorization', `Bearer ${access}`)
      .send({ body: 'hello', clientMessageId: randomUUID() })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/rides/${trip.id}/messages?limit=101`)
      .set('Authorization', `Bearer ${access}`)
      .expect(400);
    const original = await token(rider);
    await auth.logoutWithAccessToken(original.raw, `Bearer ${access}`);
    await request(app.getHttpServer())
      .get(`/rides/${trip.id}/messages`)
      .set('Authorization', `Bearer ${access}`)
      .expect(401);
  });

  it('HTTP promotion claims use the authenticated rider and enforce concurrent campaign limits', async () => {
    const first = await user();
    const second = await user();
    const jwt = new JwtService({
      secret: config.get<string>('JWT_ACCESS_SECRET'),
    });
    const access = (account: UserAccount) =>
      jwt.sign(
        { sub: account.id, typ: 'access', jti: randomUUID() },
        { expiresIn: '15m' },
      );
    const firstAccess = access(first);
    const secondAccess = access(second);
    const promotion = await db.getRepository(Promotion).save({
      code: 'AUDIT-' + randomUUID(),
      description: 'Isolated campaign',
      discountMinor: 100,
      startsAt: new Date(Date.now() - 60000),
      endsAt: new Date(Date.now() + 3600000),
      maxUsagePerUser: 1,
      maxTotalUsage: 1,
      isActive: true,
    });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app.getHttpServer())
          .post('/promotions/' + promotion.id + '/claim')
          .set('Authorization', 'Bearer ' + firstAccess)
          .expect(201),
      ),
    );
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
    expect(responses[0].body.riderId).toBe(first.id);
    await request(app.getHttpServer())
      .post('/promotions/' + promotion.id + '/claim')
      .set('Authorization', 'Bearer ' + secondAccess)
      .expect(409);
    const firstList = await request(app.getHttpServer())
      .get('/promotions')
      .set('Authorization', 'Bearer ' + firstAccess)
      .expect(200);
    const secondList = await request(app.getHttpServer())
      .get('/promotions')
      .set('Authorization', 'Bearer ' + secondAccess)
      .expect(200);
    expect(
      firstList.body.find((p: { id: string }) => p.id === promotion.id).status,
    ).toBe('claimed');
    expect(
      secondList.body.find((p: { id: string }) => p.id === promotion.id).status,
    ).toBe('available');
    await request(app.getHttpServer())
      .post('/promotions/not-a-uuid/claim')
      .set('Authorization', 'Bearer ' + firstAccess)
      .expect(400);
    expect(
      await db
        .getRepository(PromotionClaim)
        .count({ where: { promotionId: promotion.id } }),
    ).toBe(1);
  });

  it('government HTTP validation rejects malformed queries and keeps roles separate', async () => {
    const officer = await user(UserRole.GOV_OFFICER);
    const admin = await user(UserRole.ADMIN);
    const jwt = new JwtService({
      secret: config.get<string>('JWT_ACCESS_SECRET'),
    });
    const access = (account: UserAccount) =>
      jwt.sign(
        { sub: account.id, typ: 'access', jti: randomUUID() },
        { expiresIn: '15m' },
      );
    const officerAccess = access(officer);
    await request(app.getHttpServer())
      .get('/gov/access-log')
      .set('Authorization', 'Bearer ' + access(admin))
      .expect(403);
    await request(app.getHttpServer())
      .get('/kyc/queue')
      .set('Authorization', 'Bearer ' + officerAccess)
      .expect(403);
    for (const path of [
      '/gov/expenses?limit=0',
      '/gov/expenses?limit=999999',
      '/gov/expenses?month=2026-99',
      '/gov/access-log?limit=NaN',
      '/gov/drivers?q[a]=x',
      '/gov/drivers/not-a-uuid',
    ]) {
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer ' + officerAccess)
        .expect(400);
    }
    for (const body of [
      { status: 42 },
      { status: 'approved', reviewerNotes: {} },
      { status: 'approved', reviewerId: admin.id },
    ]) {
      await request(app.getHttpServer())
        .patch('/gov/expenses/' + randomUUID() + '/status')
        .set('Authorization', 'Bearer ' + officerAccess)
        .send(body)
        .expect(400);
    }
    await request(app.getHttpServer())
      .get('/gov/drivers')
      .set('Authorization', 'Bearer ' + officerAccess)
      .expect(200, []);
  });

  it('government annual reports include more than 100 rows and exclude previous years', async () => {
    const { trip, rider, driver } = await ride(RideStatus.COMPLETED);
    const year = new Date().getUTCFullYear();
    const completedAt = new Date(Date.UTC(year, 1, 1));
    const saved = await db.getRepository(Ride).save(
      Array.from({ length: 101 }, () => ({
        riderId: rider.id,
        driverId: driver.id,
        status: RideStatus.COMPLETED,
        pickup: trip.pickup,
        dropoff: trip.dropoff,
        completedAt,
      })),
    );
    await db.getRepository(FareRecord).insert(
      saved.map((r) => ({
        rideId: r.id,
        baseFare: '10',
        distanceFare: '0',
        timeFare: '0',
        total: '10',
      })),
    );
    await db.getRepository(DriverMonthlyExpenseReport).save({
      driverId: driver.id,
      reportingMonth: `${year}-02`,
      status: MonthlyExpenseStatus.APPROVED,
      totalAmount: '101',
    });
    await db
      .getRepository(Ride)
      .update(trip.id, { completedAt: new Date(Date.UTC(year - 1, 1, 1)) });
    await db.getRepository(FareRecord).save({
      rideId: trip.id,
      baseFare: '999',
      distanceFare: '0',
      timeFare: '0',
      total: '999',
    });
    const report = await government.getDriverEarningsReport(driver.id);
    expect(report).toMatchObject({
      totalTrips: 101,
      grossEarnings: 1010,
      reportedExpenses: 101,
      netTaxableEarnings: 909,
      fiscalYear: year,
    });
    expect(report.monthlyBreakdown).toHaveLength(new Date().getUTCMonth() + 1);
    expect(new Set(report.monthlyBreakdown.map((row) => row.month)).size).toBe(
      report.monthlyBreakdown.length,
    );
    const disclosure = await government.getDriverTrips(driver.id);
    expect(disclosure.trips).toHaveLength(100);
    expect(disclosure.totalTrips).toBe(102);
    expect(disclosure.totalGross).toBe(2009);
    await expect(government.getDashboardStats()).resolves.toHaveProperty(
      'reportedExpensesYtd',
    );
  });
});
