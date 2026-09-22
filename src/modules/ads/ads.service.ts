import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, MoreThanOrEqual, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import {
  AdCampaign,
  AdRewardEvent,
  AdViewSession,
  CampaignState,
  CashoutState,
  DriverCashoutRequest,
  DriverWalletEntry,
  RiderAdProfile,
  RideAdSettlement,
  ViewState,
} from './entities/ad-rewards.entity';
import { Ride, RideStatus } from '../rides/entities/ride.entity';
import {
  AdEconomics,
  loadAdEconomics,
  matchesTargeting,
  pickWeighted,
  remainingViews,
  riderBudgetForViews,
  startOfAddisDay,
} from './ads-economics';

const ADULT = new Set(['18-24', '25-34', '35-44', '45-54', '55+']);
const tokenHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export type CampaignReviewDecision = 'approve' | 'reject';

@Injectable()
export class AdRewardsService {
  readonly economics: AdEconomics;

  constructor(
    @InjectRepository(AdCampaign) private campaigns: Repository<AdCampaign>,
    @InjectRepository(RiderAdProfile)
    private profiles: Repository<RiderAdProfile>,
    @InjectRepository(AdViewSession)
    private sessions: Repository<AdViewSession>,
    @InjectRepository(AdRewardEvent) private rewards: Repository<AdRewardEvent>,
    @InjectRepository(RideAdSettlement)
    private settlements: Repository<RideAdSettlement>,
    @InjectRepository(DriverWalletEntry)
    private wallet: Repository<DriverWalletEntry>,
    @InjectRepository(DriverCashoutRequest)
    private cashouts: Repository<DriverCashoutRequest>,
    @InjectRepository(Ride) private rides: Repository<Ride>,
    config: ConfigService,
  ) {
    this.economics = loadAdEconomics(config);
  }

  // ---------------------------------------------------------------- rider

  async profile(riderId: string) {
    return this.profiles.findOne({ where: { riderId } });
  }

  async updateProfile(riderId: string, data: Partial<RiderAdProfile>) {
    const old = await this.profile(riderId);
    const consented = !!data.consented;
    return this.profiles.save(
      this.profiles.create({
        ...old,
        ...data,
        interests: Array.from(new Set(data.interests ?? old?.interests ?? [])),
        riderId,
        consented,
        consentVersion: consented
          ? (data.consentVersion ?? old?.consentVersion ?? 'v1')
          : (old?.consentVersion ?? null),
        consentedAt: consented
          ? (old?.consentedAt ?? new Date())
          : (old?.consentedAt ?? null),
        withdrawnAt: consented ? null : new Date(),
      }),
    );
  }

  /** What the Rider app shows before asking for consent. */
  programSummary() {
    const eco = this.economics;
    return {
      rewardMinor: eco.rewardMinor,
      maxRewardsPerTrip: eco.maxRewardsPerTrip,
      maxRewardsPerDay: eco.maxRewardsPerDay,
      maxTripDiscountMinor: eco.maxTripDiscountMinor,
      requiredViewSecondsTypical: 15,
      adultOnly: true,
      interests: INTEREST_OPTIONS,
      workCategories: WORK_CATEGORY_OPTIONS,
      ageBands: Array.from(ADULT),
    };
  }

  private async eligible(rideId: string, riderId: string) {
    const ride = await this.rides.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException('Ride not found');
    if (ride.riderId !== riderId)
      throw new ForbiddenException('Ride does not belong to rider');
    if (ride.status !== RideStatus.IN_PROGRESS)
      throw new ConflictException(
        'Sponsored rewards are only available during an in-progress trip',
      );
    const p = await this.profile(riderId);
    if (!p?.consented || !ADULT.has(p.ageBand))
      throw new ForbiddenException(
        'Rider is not eligible for sponsored rewards',
      );
    return { ride, p };
  }

  private async rewardsToday(riderId: string): Promise<number> {
    return this.rewards.count({
      where: { riderId, createdAt: MoreThanOrEqual(startOfAddisDay()) },
    });
  }

  async availability(rideId: string, riderId: string) {
    const eco = this.economics;
    const { p } = await this.eligible(rideId, riderId);
    const rewardCount = await this.rewards.count({ where: { rideId } });
    const earnedMinor = rewardCount * eco.rewardMinor;
    if (rewardCount >= eco.maxRewardsPerTrip)
      return {
        available: false,
        reason: 'trip_limit',
        earnedMinor,
        remaining: 0,
      };
    if ((await this.rewardsToday(riderId)) >= eco.maxRewardsPerDay)
      return {
        available: false,
        reason: 'daily_limit',
        earnedMinor,
        remaining: eco.maxRewardsPerTrip - rewardCount,
      };
    const now = new Date();
    const done = new Set(
      (await this.rewards.find({ where: { riderId } })).map(
        (x) => x.campaignId,
      ),
    );
    const all = await this.campaigns.find({
      where: { state: CampaignState.ACTIVE },
    });
    const candidates = all.filter(
      (c) =>
        c.startsAt <= now &&
        c.endsAt > now &&
        remainingViews(c.budgetMinor, c.reservedMinor, eco) > 0 &&
        matchesTargeting(c, p) &&
        !done.has(c.id),
    );
    const campaign = pickWeighted(candidates, now);
    if (!campaign)
      return {
        available: false,
        reason: 'no_inventory',
        earnedMinor,
        remaining: eco.maxRewardsPerTrip - rewardCount,
      };
    return {
      available: true,
      earnedMinor,
      remaining: eco.maxRewardsPerTrip - rewardCount,
      campaign: this.creative(campaign),
    };
  }

  private creative(c: AdCampaign) {
    return {
      id: c.id,
      sponsorName: c.sponsorName,
      title: c.title,
      message: c.message,
      assetUrl: c.assetUrl,
      ctaLabel: c.ctaLabel,
      ctaUrl: c.ctaUrl,
      requiredViewSeconds: c.requiredViewSeconds,
      rewardMinor: this.economics.rewardMinor,
    };
  }

  async start(rideId: string, riderId: string) {
    const availability = await this.availability(rideId, riderId);
    if (!availability.available) return availability;
    const active = await this.sessions.findOne({
      where: { riderId, state: ViewState.STARTED },
    });
    if (active) {
      await this.sessions.update(active.id, { state: ViewState.EXPIRED });
    }
    const raw = randomBytes(32).toString('base64url');
    const c = availability.campaign!;
    const session = await this.sessions.save(
      this.sessions.create({
        riderId,
        rideId,
        campaignId: c.id,
        tokenHash: tokenHash(raw),
        requiredViewSeconds: c.requiredViewSeconds,
        expiresAt: new Date(
          Date.now() +
            (c.requiredViewSeconds + this.economics.claimWindowSeconds) * 1000,
        ),
        lastHeartbeatAt: new Date(),
      }),
    );
    // Impression = creative rendered. Counted once per session, never
    // re-counted on retries of the same session.
    await this.campaigns.increment({ id: c.id }, 'impressions', 1);
    return {
      available: true,
      sessionId: session.id,
      token: raw,
      campaign: c,
      requiredViewSeconds: session.requiredViewSeconds,
    };
  }

  async heartbeat(
    sessionId: string,
    riderId: string,
    token: string,
    sequence: number,
    visibleSeconds: number,
    videoPlaying = true,
  ) {
    const s = await this.sessions.findOne({
      where: { id: sessionId, riderId },
    });
    if (!s || s.tokenHash !== tokenHash(token))
      throw new ForbiddenException('Invalid viewing session');
    if (s.state !== ViewState.STARTED || s.expiresAt <= new Date())
      throw new ConflictException('Viewing session has expired');
    await this.eligible(s.rideId, riderId);
    if (sequence <= s.lastSequence)
      throw new ConflictException('Heartbeat replayed');
    const elapsed = (Date.now() - s.lastHeartbeatAt.getTime()) / 1000;
    if (visibleSeconds > Math.ceil(elapsed) + 2)
      throw new BadRequestException('Impossible viewing progress');
    const increment = videoPlaying
      ? Math.min(visibleSeconds, Math.ceil(elapsed))
      : 0;
    s.lastSequence = sequence;
    s.verifiedSeconds = Math.min(
      s.requiredViewSeconds,
      s.verifiedSeconds + increment,
    );
    s.lastHeartbeatAt = new Date();
    await this.sessions.save(s);
    return {
      verifiedSeconds: s.verifiedSeconds,
      requiredViewSeconds: s.requiredViewSeconds,
      ready: s.verifiedSeconds >= s.requiredViewSeconds,
    };
  }

  /** CTA tap. Idempotent per session; the advertiser sees it as a click. */
  async click(sessionId: string, riderId: string, token: string) {
    const s = await this.sessions.findOne({
      where: { id: sessionId, riderId },
    });
    if (!s || s.tokenHash !== tokenHash(token))
      throw new ForbiddenException('Invalid viewing session');
    if (s.ctaClickedAt) return { recorded: false };
    await this.sessions.update(s.id, { ctaClickedAt: new Date() });
    await this.campaigns.increment({ id: s.campaignId }, 'ctaClicks', 1);
    return { recorded: true };
  }

  async complete(sessionId: string, riderId: string, token: string) {
    const eco = this.economics;
    return this.sessions.manager.transaction(async (em) => {
      const s = await em.findOne(AdViewSession, {
        where: { id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!s || s.riderId !== riderId || s.tokenHash !== tokenHash(token))
        throw new ForbiddenException('Invalid viewing session');
      const existing = await em.findOne(AdRewardEvent, {
        where: { sessionId },
      });
      if (existing) return this.rewardResult(em, s.rideId, existing);
      if (
        s.state !== ViewState.STARTED ||
        s.expiresAt <= new Date() ||
        s.verifiedSeconds < Math.max(1, s.requiredViewSeconds - 1)
      )
        throw new ConflictException('Viewing duration has not been verified');
      const ride = await em.findOne(Ride, {
        where: { id: s.rideId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !ride ||
        ride.riderId !== riderId ||
        ride.status !== RideStatus.IN_PROGRESS
      )
        throw new ConflictException('Trip is no longer eligible');
      const p = await em.findOne(RiderAdProfile, {
        where: { riderId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!p?.consented || !ADULT.has(p.ageBand))
        throw new ForbiddenException('Consent is no longer active');
      const duplicate = await em.findOne(AdRewardEvent, {
        where: { riderId, campaignId: s.campaignId },
        lock: { mode: 'pessimistic_read' },
      });
      if (duplicate) {
        await em.update(AdViewSession, s.id, {
          state: ViewState.COMPLETED,
          completedAt: new Date(),
        });
        return this.rewardResult(em, s.rideId, duplicate);
      }
      const count = await em.count(AdRewardEvent, {
        where: { rideId: s.rideId },
      });
      if (count >= eco.maxRewardsPerTrip)
        throw new ConflictException('Trip reward limit reached');
      const today = await em.count(AdRewardEvent, {
        where: { riderId, createdAt: MoreThanOrEqual(startOfAddisDay()) },
      });
      if (today >= eco.maxRewardsPerDay)
        throw new ConflictException('Daily reward limit reached');
      const campaign = await em.findOne(AdCampaign, {
        where: { id: s.campaignId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !campaign ||
        campaign.state !== CampaignState.ACTIVE ||
        remainingViews(campaign.budgetMinor, campaign.reservedMinor, eco) < 1
      )
        throw new ConflictException('Campaign budget exhausted');
      const reservedAfter = Number(campaign.reservedMinor) + eco.rewardMinor;
      await em.update(AdCampaign, campaign.id, {
        reservedMinor: String(reservedAfter),
        // Last purchased view delivered → the campaign has run its course.
        ...(remainingViews(campaign.budgetMinor, reservedAfter, eco) < 1
          ? { state: CampaignState.ENDED }
          : {}),
      });
      await em.update(AdViewSession, s.id, {
        state: ViewState.COMPLETED,
        completedAt: new Date(),
      });
      const reward = await em.save(
        em.create(AdRewardEvent, {
          riderId,
          rideId: s.rideId,
          campaignId: s.campaignId,
          sessionId: s.id,
          rewardMinor: eco.rewardMinor,
        }),
      );
      return this.rewardResult(em, s.rideId, reward);
    });
  }

  private async rewardResult(
    em: EntityManager,
    rideId: string,
    reward: AdRewardEvent,
  ) {
    const eco = this.economics;
    const count = await em.count(AdRewardEvent, { where: { rideId } });
    return {
      rewardId: reward.id,
      earnedMinor: count * eco.rewardMinor,
      remaining: Math.max(0, eco.maxRewardsPerTrip - count),
    };
  }

  async savings(rideId: string, riderId: string) {
    await this.eligible(rideId, riderId);
    const n = await this.rewards.count({ where: { rideId } });
    return {
      earnedMinor: n * this.economics.rewardMinor,
      rewardCount: n,
      remaining: this.economics.maxRewardsPerTrip - n,
    };
  }

  async settleRide(em: EntityManager, ride: Ride, grossFareEtb: string) {
    const eco = this.economics;
    const old = await em.findOne(RideAdSettlement, {
      where: { rideId: ride.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (old) return old;
    const rewards = await em.count(AdRewardEvent, {
      where: { rideId: ride.id },
    });
    const gross = Math.max(0, Math.round(Number(grossFareEtb) * 100));
    const discount = Math.min(
      gross,
      rewards * eco.rewardMinor,
      eco.maxTripDiscountMinor,
    );
    const settled = await em.save(
      em.create(RideAdSettlement, {
        rideId: ride.id,
        driverId: ride.driverId!,
        grossFareMinor: gross,
        appliedDiscountMinor: discount,
        riderCashDueMinor: gross - discount,
        driverHebirCreditMinor: discount,
      }),
    );
    if (discount > 0)
      await em.save(
        em.create(DriverWalletEntry, {
          driverId: ride.driverId!,
          rideId: ride.id,
          amountMinor: discount,
          type: 'ad_discount_credit',
        }),
      );
    return settled;
  }

  /**
   * Reimburse the driver for a rider promo code. Same wallet as ad credits —
   * the rider paid less cash; Hebir owes that slice to the driver.
   */
  async creditPromoDiscount(
    em: EntityManager,
    ride: Ride,
    discountMinor: number,
  ): Promise<number> {
    const discount = Math.max(0, Math.round(discountMinor));
    if (!ride.driverId || discount <= 0) return 0;
    await em.save(
      em.create(DriverWalletEntry, {
        driverId: ride.driverId,
        rideId: ride.id,
        amountMinor: discount,
        type: 'promo_discount_credit',
      }),
    );
    return discount;
  }

  // --------------------------------------------------------------- driver

  async walletSummary(driverId: string) {
    const entries = await this.wallet.find({
      where: { driverId },
      order: { createdAt: 'DESC' },
    });
    const cashouts = await this.cashouts.find({
      where: { driverId },
      order: { createdAt: 'DESC' },
    });
    const credited = entries
      .filter((e) => e.amountMinor > 0)
      .reduce((n, e) => n + e.amountMinor, 0);
    const adCredited = entries
      .filter((e) => e.type === 'ad_discount_credit')
      .reduce((n, e) => n + e.amountMinor, 0);
    const promoCredited = entries
      .filter((e) => e.type === 'promo_discount_credit')
      .reduce((n, e) => n + e.amountMinor, 0);
    const pending = cashouts
      .filter((x) =>
        [CashoutState.REQUESTED, CashoutState.PROCESSING].includes(x.state),
      )
      .reduce((n, x) => n + x.amountMinor, 0);
    const net = entries.reduce((n, e) => n + e.amountMinor, 0);
    return {
      availableMinor: Math.max(0, net - pending),
      pendingMinor: pending,
      /** Lifetime positive credits (ads + promos) before cashouts. */
      totalCreditedMinor: credited,
      adCreditsMinor: adCredited,
      promoCreditsMinor: promoCredited,
      entries,
      cashouts,
    };
  }

  /** Batch lookup for ride enrichment (cash due vs Hebir ad credit). */
  async settlementsByRideIds(
    rideIds: string[],
  ): Promise<Map<string, RideAdSettlement>> {
    const unique = [...new Set(rideIds.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await this.settlements.find({
      where: { rideId: In(unique) },
    });
    return new Map(rows.map((row) => [row.rideId, row]));
  }

  /** Per-ride Hebir wallet credits (ads + promos) for driver/rider receipts. */
  async walletCreditsByRideIds(
    rideIds: string[],
  ): Promise<
    Map<string, { adMinor: number; promoMinor: number; totalMinor: number }>
  > {
    const unique = [...new Set(rideIds.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await this.wallet.find({
      where: {
        rideId: In(unique),
        type: In(['ad_discount_credit', 'promo_discount_credit']),
      },
    });
    const map = new Map<
      string,
      { adMinor: number; promoMinor: number; totalMinor: number }
    >();
    for (const row of rows) {
      if (!row.rideId) continue;
      const cur = map.get(row.rideId) ?? {
        adMinor: 0,
        promoMinor: 0,
        totalMinor: 0,
      };
      if (row.type === 'ad_discount_credit') cur.adMinor += row.amountMinor;
      if (row.type === 'promo_discount_credit')
        cur.promoMinor += row.amountMinor;
      cur.totalMinor = cur.adMinor + cur.promoMinor;
      map.set(row.rideId, cur);
    }
    return map;
  }

  async requestCashout(driverId: string, amountMinor: number) {
    return this.wallet.manager.transaction(async (em) => {
      const entries = await em.find(DriverWalletEntry, {
        where: { driverId },
        lock: { mode: 'pessimistic_write' },
      });
      const requests = await em.find(DriverCashoutRequest, {
        where: { driverId },
        lock: { mode: 'pessimistic_write' },
      });
      const balance =
        entries.reduce((n, e) => n + e.amountMinor, 0) -
        requests
          .filter((x) =>
            [CashoutState.REQUESTED, CashoutState.PROCESSING].includes(x.state),
          )
          .reduce((n, x) => n + x.amountMinor, 0);
      if (amountMinor > balance)
        throw new ConflictException('Insufficient available wallet balance');
      return em.save(
        em.create(DriverCashoutRequest, {
          driverId,
          amountMinor,
          state: CashoutState.REQUESTED,
        }),
      );
    });
  }

  // ------------------------------------------------------------ operations

  async listCampaigns(states?: CampaignState[]) {
    return this.campaigns.find({
      where: states?.length ? { state: In(states) } : {},
      order: { updatedAt: 'DESC' },
    });
  }

  async getCampaign(id: string) {
    const c = await this.campaigns.findOneBy({ id });
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
  }

  async listCashouts() {
    return this.cashouts.find({ order: { createdAt: 'DESC' } });
  }

  /**
   * Ops-created (house) campaign or ops edit. House campaigns are still
   * queued for review so two people look at every creative riders will see.
   */
  async upsertCampaign(
    id: string | undefined,
    data: Partial<AdCampaign>,
    actor: string,
  ) {
    if (id) {
      const c = await this.getCampaign(id);
      const clean = Object.fromEntries(
        Object.entries(data).filter(([, v]) => v !== undefined),
      );
      return this.campaigns.save({ ...c, ...clean, updatedBy: actor });
    }
    return this.campaigns.save(
      this.campaigns.create({
        ...data,
        state: data.state ?? CampaignState.PENDING_REVIEW,
        slug: `campaign-${randomBytes(8).toString('hex')}`,
        createdBy: actor,
        updatedBy: actor,
      }),
    );
  }

  /**
   * Review decision. Approving a paid-for advertiser campaign moves it to
   * `approved` (it goes live when the payment lands); approving a house
   * campaign, or an advertiser campaign that is already paid, activates it.
   */
  async reviewCampaign(
    id: string,
    decision: CampaignReviewDecision,
    actor: string,
    note?: string,
  ) {
    return this.campaigns.manager.transaction(async (em) => {
      const c = await em.findOne(AdCampaign, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!c) throw new NotFoundException('Campaign not found');
      if (
        ![CampaignState.PENDING_REVIEW, CampaignState.REJECTED].includes(
          c.state,
        ) &&
        !(decision === 'reject' && c.state === CampaignState.APPROVED)
      ) {
        throw new ConflictException(
          `Campaign in state ${c.state} cannot be reviewed`,
        );
      }
      if (decision === 'reject' && !note?.trim()) {
        throw new BadRequestException(
          'A note is required so the advertiser knows what to fix',
        );
      }
      const paidOrHouse = !c.advertiserId || Number(c.paidMinor) > 0;
      const state =
        decision === 'reject'
          ? CampaignState.REJECTED
          : paidOrHouse
            ? CampaignState.ACTIVE
            : CampaignState.APPROVED;
      return em.save(AdCampaign, {
        ...c,
        state,
        reviewNote: note?.trim() || null,
        reviewedBy: actor,
        reviewedAt: new Date(),
        updatedBy: actor,
      });
    });
  }

  /** Pause/resume/end by ops or the owning advertiser. */
  async setCampaignRunState(
    id: string,
    next: CampaignState.PAUSED | CampaignState.ACTIVE | CampaignState.ENDED,
    actor: string,
    advertiserId?: string,
  ) {
    const c = await this.getCampaign(id);
    if (advertiserId && c.advertiserId !== advertiserId)
      throw new ForbiddenException('Not your campaign');
    const allowed: Record<string, CampaignState[]> = {
      [CampaignState.PAUSED]: [CampaignState.ACTIVE],
      [CampaignState.ACTIVE]: [CampaignState.PAUSED],
      [CampaignState.ENDED]: [CampaignState.ACTIVE, CampaignState.PAUSED],
    };
    if (!allowed[next].includes(c.state))
      throw new ConflictException(`Cannot move ${c.state} → ${next}`);
    return this.campaigns.save({ ...c, state: next, updatedBy: actor });
  }

  /** Marks an advertiser campaign paid; activates it if already approved. */
  async recordCampaignPayment(
    em: EntityManager,
    campaignId: string,
    paidMinor: number,
    txRef: string,
  ) {
    const c = await em.findOne(AdCampaign, {
      where: { id: campaignId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!c) throw new NotFoundException('Campaign not found');
    if (c.paymentTxRef === txRef) return c; // webhook + verify both landed
    const views = Math.floor(paidMinor / this.economics.pricePerViewMinor);
    const state =
      c.state === CampaignState.APPROVED ? CampaignState.ACTIVE : c.state;
    return em.save(AdCampaign, {
      ...c,
      paidMinor: String(Number(c.paidMinor) + paidMinor),
      purchasedViews: c.purchasedViews + views,
      budgetMinor: String(
        Number(c.budgetMinor) + riderBudgetForViews(views, this.economics),
      ),
      paymentTxRef: txRef,
      paidAt: new Date(),
      state,
    });
  }

  async campaignStats(c: AdCampaign) {
    const eco = this.economics;
    const verifiedViews = Math.floor(Number(c.reservedMinor) / eco.rewardMinor);
    return {
      impressions: c.impressions,
      verifiedViews,
      ctaClicks: c.ctaClicks,
      purchasedViews: c.purchasedViews,
      remainingViews: remainingViews(c.budgetMinor, c.reservedMinor, eco),
      spentMinor: verifiedViews * eco.pricePerViewMinor,
      paidMinor: Number(c.paidMinor),
      completionRate: c.impressions
        ? Math.round((verifiedViews / c.impressions) * 1000) / 10
        : 0,
      clickThroughRate: verifiedViews
        ? Math.round((c.ctaClicks / verifiedViews) * 1000) / 10
        : 0,
    };
  }

  async reviewCashout(
    id: string,
    state: CashoutState,
    actor: string,
    paymentReference?: string,
    reviewNote?: string,
  ) {
    if (
      ![
        CashoutState.PROCESSING,
        CashoutState.PAID,
        CashoutState.REJECTED,
        CashoutState.FAILED,
      ].includes(state)
    )
      throw new BadRequestException('Invalid cashout review state');
    return this.cashouts.manager.transaction(async (em) => {
      const c = await em.findOne(DriverCashoutRequest, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!c) throw new NotFoundException('Cashout not found');
      if (
        [
          CashoutState.PAID,
          CashoutState.REJECTED,
          CashoutState.FAILED,
        ].includes(c.state)
      )
        throw new ConflictException('Cashout is final');
      if (state === CashoutState.PAID && !paymentReference)
        throw new BadRequestException(
          'A payment reference is required to mark a cashout paid',
        );
      const result = await em.save(DriverCashoutRequest, {
        ...c,
        state,
        reviewedBy: actor,
        paymentReference: paymentReference ?? c.paymentReference,
        reviewNote: reviewNote ?? c.reviewNote,
      });
      if (state === CashoutState.PAID)
        await em.save(
          em.create(DriverWalletEntry, {
            driverId: c.driverId,
            cashoutId: c.id,
            amountMinor: -c.amountMinor,
            type: 'cashout_paid',
          }),
        );
      return result;
    });
  }
}

/** Vocabulary shared by the Rider app, the advertiser site and ops. */
export const INTEREST_OPTIONS = [
  'food',
  'shopping',
  'telecom',
  'finance',
  'education',
  'health',
  'entertainment',
  'travel',
  'real_estate',
  'automotive',
  'fashion',
  'technology',
] as const;

export const WORK_CATEGORY_OPTIONS = [
  'student',
  'employed',
  'self_employed',
  'business_owner',
  'not_working',
  'retired',
  'other',
] as const;
