import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, QueryFailedError, Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import {
  DriverSubscription,
  SubscriptionState,
} from './entities/driver-subscription.entity';
import { PaymentEvent, PaymentProvider } from './entities/payment-event.entity';
import { SubscriptionStatusHistory } from './entities/status-history.entity';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';
import { ConfigurationService } from './configuration.service';
import { Trip } from '../matching/entities/trip.entity';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { ChapaClient } from '../payments/chapa.client';

const EXPIRY_JOB_LOCK_KEY = 'lock:subscription-expiry-job';
const EXPIRY_JOB_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes, safely longer than one run
/** Rows processed per query page (avoids loading the full table). */
const EXPIRY_PAGE_SIZE = 500;
/** Serializes concurrent PSP retries of the same providerReference. */
const WEBHOOK_LOCK_PREFIX = 'lock:payhook:';
const WEBHOOK_LOCK_TTL_MS = 15_000;
const WEBHOOK_LOCK_WAIT_MS = 8_000;

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    @InjectRepository(DriverSubscription)
    private readonly subscriptions: Repository<DriverSubscription>,
    @InjectRepository(PaymentEvent)
    private readonly paymentEvents: Repository<PaymentEvent>,
    @InjectRepository(SubscriptionStatusHistory)
    private readonly history: Repository<SubscriptionStatusHistory>,
    @InjectRepository(Trip)
    private readonly trips: Repository<Trip>,
    private readonly configuration: ConfigurationService,
    private readonly notifications: NotificationsGateway,
    private readonly config: ConfigService,
    private readonly chapa: ChapaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Paid-plan marketplace gate. Off by default until live collections exist.
   * Set REQUIRE_DRIVER_SUBSCRIPTION=true to restore the paywall.
   */
  isEnforced(): boolean {
    return this.config.get<string>('REQUIRE_DRIVER_SUBSCRIPTION') === 'true';
  }

  async createChapaCheckout(driverId: string) {
    const amountEtb = this.configuration.get<number>('subscription_fee_etb');
    return this.chapa.initializeSubscriptionCheckout({ driverId, amountEtb });
  }

  /**
   * After Chapa verify API confirms success. Does not trust the webhook body
   * amount/status — only the verify response.
   */
  async applyVerifiedChapaCharge(txRef: string) {
    const verified = await this.chapa.verifyTxRef(txRef);
    if (verified.status !== 'success') {
      return { activated: false, reason: 'not_paid', status: verified.status };
    }
    if (verified.currency && verified.currency.toUpperCase() !== 'ETB') {
      return { activated: false, reason: 'currency' };
    }
    return this.handleConfirmedPayment({
      provider: PaymentProvider.CHAPA,
      providerReference: verified.txRef,
      driverId: verified.driverId,
      amount: verified.amountEtb,
      rawPayload: verified.raw,
    });
  }

  /**
   * Handles a confirmed payment notification from a provider.
   *
   * Signature verification of the raw provider payload must happen in the
   * controller/provider-specific adapter BEFORE this method is called —
   * an unverified request must never reach here (blueprint section 15).
   */
  async handleConfirmedPayment(dto: PaymentWebhookDto) {
    const lockKey = `${WEBHOOK_LOCK_PREFIX}${dto.providerReference}`;
    const locked = await this.acquireWebhookLock(lockKey);
    if (!locked) {
      const raced = await this.paymentEvents.findOne({
        where: { providerReference: dto.providerReference },
      });
      if (raced?.processed) {
        return { alreadyProcessed: true };
      }
      this.logger.warn(
        `Webhook lock timeout for ${dto.providerReference} — ask the provider to retry`,
      );
      return { activated: false, reason: 'busy' };
    }

    try {
      return await this.processConfirmedPayment(dto);
    } finally {
      await this.redis.del(lockKey);
    }
  }

  /**
   * Step 3 of blueprint 5.2: an already-PROCESSED reference is a no-op,
   * always acknowledged, never re-processed. An unprocessed row (e.g. a
   * prior underpayment) does NOT burn the reference — a retry re-runs the
   * amount check so it can still activate.
   *
   * Callers must hold `lock:payhook:{providerReference}` — unique-index
   * catch-up alone still lets N workers activate() before processed=true.
   */
  private async processConfirmedPayment(dto: PaymentWebhookDto) {
    const existing = await this.paymentEvents.findOne({
      where: { providerReference: dto.providerReference },
    });
    if (existing?.processed) {
      this.logger.log(
        `Duplicate payment notification ignored: ${dto.providerReference}`,
      );
      return { alreadyProcessed: true };
    }

    let event = existing;
    if (!event) {
      try {
        event = await this.paymentEvents.save(
          this.paymentEvents.create({
            provider: dto.provider,
            providerReference: dto.providerReference,
            driverId: dto.driverId,
            amount: dto.amount,
            rawPayload: dto.rawPayload,
          }),
        );
      } catch (error) {
        // Concurrent insert won — re-load and continue only if not yet processed.
        // Never ACK "alreadyProcessed" unless processed === true (paid-but-
        // inactive risk if the winner crashed mid-activate).
        if (this.isUniqueViolation(error)) {
          const raced = await this.paymentEvents.findOne({
            where: { providerReference: dto.providerReference },
          });
          if (!raced) throw error;
          if (raced.processed) {
            this.logger.log(
              `Concurrent duplicate payment notification ignored: ${dto.providerReference}`,
            );
            return { alreadyProcessed: true };
          }
          event = raced;
        } else {
          throw error;
        }
      }
    }

    if (event.driverId !== dto.driverId) {
      this.logger.warn(
        `Webhook driverId mismatch for ${dto.providerReference}: body=${dto.driverId} event=${event.driverId}`,
      );
      return { activated: false, reason: 'driver_mismatch' };
    }

    const requiredFee = this.configuration.get<number>('subscription_fee_etb');
    if (Number(dto.amount) < requiredFee) {
      this.logger.warn(
        `Underpayment from driver ${dto.driverId}: ${dto.amount} < ${requiredFee}`,
      );
      return { activated: false, reason: 'underpayment' };
    }

    const outcome = await this.activate(event.driverId, event);
    if (outcome === 'duplicate') {
      return { alreadyProcessed: true };
    }
    return { activated: true };
  }

  private async acquireWebhookLock(lockKey: string): Promise<boolean> {
    const deadline = Date.now() + WEBHOOK_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      const acquired = await this.redis.set(
        lockKey,
        '1',
        'PX',
        WEBHOOK_LOCK_TTL_MS,
        'NX',
      );
      if (acquired) return true;
      const existing = await this.paymentEvents.findOne({
        where: {
          providerReference: lockKey.slice(WEBHOOK_LOCK_PREFIX.length),
        },
      });
      if (existing?.processed) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error as QueryFailedError & { driverError?: { code?: string } })
        .driverError?.code === '23505'
    );
  }

  private async activate(
    driverId: string,
    event: PaymentEvent,
  ): Promise<'applied' | 'duplicate'> {
    let subscription = await this.subscriptions.findOne({
      where: { driverId },
    });
    if (
      subscription?.lastPaymentReference === event.providerReference &&
      subscription.state === SubscriptionState.ACTIVE
    ) {
      await this.paymentEvents.update(event.id, { processed: true });
      return 'duplicate';
    }
    const fromState = subscription?.state ?? SubscriptionState.INACTIVE;

    const cycleDays = this.configuration.get<number>('cycle_length_days');
    const graceHours = this.configuration.get<number>('grace_period_hours');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + cycleDays * 24 * 60 * 60 * 1000);
    const gracePeriodEndsAt = new Date(
      expiresAt.getTime() + graceHours * 60 * 60 * 1000,
    );

    if (!subscription) {
      subscription = this.subscriptions.create({ driverId });
    }

    subscription.state = SubscriptionState.ACTIVE;
    subscription.activatedAt = now;
    subscription.expiresAt = expiresAt;
    subscription.gracePeriodEndsAt = gracePeriodEndsAt;
    subscription.lastAmountPaid = event.amount;
    subscription.lastPaymentReference = event.providerReference;
    await this.subscriptions.save(subscription);

    await this.history.save(
      this.history.create({
        driverId,
        fromState,
        toState: SubscriptionState.ACTIVE,
        cause: `payment:${event.providerReference}`,
        paymentEventId: event.id,
      }),
    );

    // Restore any trips withdrawn during a previous suspension.
    await this.trips.update(
      { driverId, inMatchingPool: false },
      { inMatchingPool: true },
    );

    await this.paymentEvents.update(event.id, { processed: true });
    await this.invalidateActiveCache(driverId);
    return 'applied';
  }

  /** Drop the GPS-path Redis gate so a fresh activation is indexed immediately. */
  private async invalidateActiveCache(driverId: string): Promise<void> {
    await this.redis.del(`sub:active:${driverId}`);
  }

  async getStatus(driverId: string) {
    const subscription = await this.subscriptions.findOne({
      where: { driverId },
    });
    return (
      subscription ?? {
        driverId,
        state: SubscriptionState.INACTIVE,
        activatedAt: null,
        expiresAt: null,
        gracePeriodEndsAt: null,
      }
    );
  }

  /**
   * Development-only activation (no payment provider). Used by Flutter
   * "Renew subscription" and local demos so drivers can publish trips.
   */
  async devActivate(driverId: string) {
    const event = await this.paymentEvents.save(
      this.paymentEvents.create({
        provider: PaymentProvider.CHAPA,
        providerReference: `dev-${driverId}-${Date.now()}`,
        driverId,
        amount: String(this.configuration.get<number>('subscription_fee_etb')),
        rawPayload: { source: 'dev-activate' },
      }),
    );
    await this.activate(driverId, event);
    return this.getStatus(driverId);
  }

  /**
   * The access gate (blueprint 5.4). Any driver action that affects the
   * marketplace must call this first.
   */
  async isActive(driverId: string): Promise<boolean> {
    const subscription = await this.subscriptions.findOne({
      where: { driverId },
    });
    return subscription?.state === SubscriptionState.ACTIVE;
  }

  /** True when the driver may go online / publish / receive offers. */
  async mayAccessMarketplace(driverId: string): Promise<boolean> {
    if (!this.isEnforced()) return true;
    return this.isActive(driverId);
  }

  /** Batch subscription gate for nearby-driver filtering (avoids N+1 at dispatch). */
  async filterActiveDriverIds(driverIds: string[]): Promise<Set<string>> {
    const active = new Set<string>();
    if (!driverIds.length) return active;
    const rows = await this.subscriptions.find({
      where: { driverId: In(driverIds), state: SubscriptionState.ACTIVE },
      select: { driverId: true },
    });
    for (const row of rows) active.add(row.driverId);
    return active;
  }

  /** Same as [filterActiveDriverIds], but skips the paywall when it is off. */
  async filterMarketplaceDriverIds(driverIds: string[]): Promise<Set<string>> {
    if (!this.isEnforced()) return new Set(driverIds);
    return this.filterActiveDriverIds(driverIds);
  }

  /**
   * Expiry processing (blueprint 5.3). Runs frequently; a Redis lock
   * ensures only one server instance executes it per interval, even
   * when multiple API instances are deployed behind the load balancer.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async runExpiryCheckIfLeader() {
    try {
      const acquired = await this.redis.set(
        EXPIRY_JOB_LOCK_KEY,
        '1',
        'PX',
        EXPIRY_JOB_LOCK_TTL_MS,
        'NX',
      );
      if (!acquired) return;

      // Lock is intentionally left to expire via TTL; releasing early could
      // let a second server run the same interval's check twice.
      await this.processExpirations();
    } catch (error) {
      // A rejection escaping a @Cron handler is an unhandled rejection and
      // would take the process down; the next minute's tick retries.
      this.logger.error(
        `Subscription expiry check failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Filter by deadline in SQL, page through results, batch state/history
   * (and trip withdraw + notify for suspensions).
   */
  private async processExpirations() {
    const now = new Date();
    const pastDueCount = await this.markExpiredActivePagewise(now);
    const suspendedCount = await this.suspendPastGracePagewise(now);
    if (pastDueCount > 0 || suspendedCount > 0) {
      this.logger.log(
        `Subscription expiry: ${pastDueCount} → past_due, ${suspendedCount} → suspended`,
      );
    }
  }

  /** ACTIVE with expiresAt <= now → PAST_DUE (batched). */
  private async markExpiredActivePagewise(now: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const page = await this.subscriptions.find({
        where: {
          state: SubscriptionState.ACTIVE,
          expiresAt: LessThanOrEqual(now),
        },
        order: { id: 'ASC' },
        take: EXPIRY_PAGE_SIZE,
      });
      if (page.length === 0) break;

      const ids = page.map((s) => s.id);
      await this.subscriptions.update(
        { id: In(ids) },
        { state: SubscriptionState.PAST_DUE },
      );
      await this.history.insert(
        page.map((sub) => ({
          driverId: sub.driverId,
          fromState: SubscriptionState.ACTIVE,
          toState: SubscriptionState.PAST_DUE,
          cause: 'cycle-expired',
          paymentEventId: null,
        })),
      );
      if (page.length) {
        await this.redis.del(...page.map((s) => `sub:active:${s.driverId}`));
      }
      total += page.length;
      if (page.length < EXPIRY_PAGE_SIZE) break;
    }
    return total;
  }

  /** PAST_DUE with gracePeriodEndsAt <= now → SUSPENDED (batched). */
  private async suspendPastGracePagewise(now: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const page = await this.subscriptions.find({
        where: {
          state: SubscriptionState.PAST_DUE,
          gracePeriodEndsAt: LessThanOrEqual(now),
        },
        order: { id: 'ASC' },
        take: EXPIRY_PAGE_SIZE,
      });
      if (page.length === 0) break;

      const ids = page.map((s) => s.id);
      const driverIds = page.map((s) => s.driverId);

      await this.subscriptions.update(
        { id: In(ids) },
        { state: SubscriptionState.SUSPENDED },
      );
      await this.history.insert(
        page.map((sub) => ({
          driverId: sub.driverId,
          fromState: SubscriptionState.PAST_DUE,
          toState: SubscriptionState.SUSPENDED,
          cause: 'grace-period-closed',
          paymentEventId: null,
        })),
      );

      // One UPDATE for all drivers in the page.
      await this.trips
        .createQueryBuilder()
        .update(Trip)
        .set({ inMatchingPool: false })
        .where('driverId IN (:...driverIds)', { driverIds })
        .execute();

      await Promise.all(
        driverIds.map((driverId) =>
          this.notifications.notify(driverId, 'subscription.suspended', {
            reason: 'grace-period-closed',
          }),
        ),
      );
      if (driverIds.length) {
        await this.redis.del(...driverIds.map((id) => `sub:active:${id}`));
      }

      total += page.length;
      if (page.length < EXPIRY_PAGE_SIZE) break;
    }
    return total;
  }
}
