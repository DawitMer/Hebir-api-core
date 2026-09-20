import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { AdCampaign, CampaignState } from '../ads/entities/ad-rewards.entity';
import { AdRewardsService } from '../ads/ads.service';
import { priceForViews } from '../ads/ads-economics';
import { ChapaClient } from '../payments/chapa.client';
import { ADVERTISER_TOKEN_TYPE } from './advertiser-auth.guard';
import {
  AdvertiserCampaignDto,
  AdvertiserCampaignUpdateDto,
  AdvertiserLoginDto,
  AdvertiserRegisterDto,
} from './dto/advertiser.dto';
import {
  Advertiser,
  AdvertiserPayment,
  AdvertiserPaymentStatus,
  AdvertiserStatus,
} from './entities/advertiser.entity';

const BCRYPT_ROUNDS = 12;
const TX_PREFIX = 'a';
/** States in which the advertiser may still edit the creative/targeting. */
const EDITABLE = new Set<CampaignState>([
  CampaignState.DRAFT,
  CampaignState.PENDING_REVIEW,
  CampaignState.REJECTED,
]);

@Injectable()
export class AdvertisersService {
  private readonly logger = new Logger(AdvertisersService.name);

  constructor(
    @InjectRepository(Advertiser)
    private readonly advertisers: Repository<Advertiser>,
    @InjectRepository(AdvertiserPayment)
    private readonly payments: Repository<AdvertiserPayment>,
    @InjectRepository(AdCampaign)
    private readonly campaigns: Repository<AdCampaign>,
    private readonly ads: AdRewardsService,
    private readonly chapa: ChapaClient,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ----------------------------------------------------------------- auth

  async register(dto: AdvertiserRegisterDto) {
    const email = dto.email.trim().toLowerCase();
    if (await this.advertisers.findOne({ where: { email } })) {
      throw new ConflictException('An account with this email already exists');
    }
    const advertiser = await this.advertisers.save(
      this.advertisers.create({
        email,
        companyName: dto.companyName.trim(),
        contactName: dto.contactName.trim(),
        phone: dto.phone?.trim() || null,
        tinNumber: dto.tinNumber?.trim() || null,
        website: dto.website?.trim() || null,
        passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
        lastLoginAt: new Date(),
      }),
    );
    return this.session(advertiser);
  }

  async login(dto: AdvertiserLoginDto) {
    const email = dto.email.trim().toLowerCase();
    const advertiser = await this.advertisers.findOne({ where: { email } });
    // Same message and comparable timing whether or not the email exists.
    const ok = advertiser
      ? await bcrypt.compare(dto.password, advertiser.passwordHash)
      : await bcrypt.compare(dto.password, DUMMY_HASH).then(() => false);
    if (!advertiser || !ok) {
      throw new UnauthorizedException('Incorrect email or password');
    }
    if (advertiser.status !== AdvertiserStatus.ACTIVE) {
      throw new ForbiddenException(
        'This advertiser account is suspended. Contact ads@hebirtaxi.com.',
      );
    }
    await this.advertisers.update(advertiser.id, { lastLoginAt: new Date() });
    return this.session(advertiser);
  }

  private session(advertiser: Advertiser) {
    const token = this.jwt.sign(
      {
        sub: advertiser.id,
        email: advertiser.email,
        typ: ADVERTISER_TOKEN_TYPE,
      },
      { expiresIn: '12h' },
    );
    return { token, advertiser: this.publicAdvertiser(advertiser) };
  }

  async me(advertiserId: string) {
    return this.publicAdvertiser(await this.requireAdvertiser(advertiserId));
  }

  private async requireAdvertiser(id: string) {
    const a = await this.advertisers.findOne({ where: { id } });
    if (!a) throw new UnauthorizedException('Advertiser not found');
    if (a.status !== AdvertiserStatus.ACTIVE)
      throw new ForbiddenException('This advertiser account is suspended');
    return a;
  }

  private publicAdvertiser(a: Advertiser) {
    return {
      id: a.id,
      email: a.email,
      companyName: a.companyName,
      contactName: a.contactName,
      phone: a.phone,
      tinNumber: a.tinNumber,
      website: a.website,
      status: a.status,
      createdAt: a.createdAt,
    };
  }

  // -------------------------------------------------------------- pricing

  /** Public: what the site shows before sign-up. */
  pricing() {
    const eco = this.ads.economics;
    return {
      currency: 'ETB',
      pricePerViewMinor: eco.pricePerViewMinor,
      riderRewardMinor: eco.rewardMinor,
      minViews: eco.minPurchasedViews,
      maxViews: eco.maxPurchasedViews,
      minBudgetMinor: priceForViews(eco.minPurchasedViews, eco),
      requiredViewSecondsRange: [5, 60],
      paymentProvider: this.chapa.isConfigured() ? 'chapa' : null,
      targeting: {
        ageBands: ['18-24', '25-34', '35-44', '45-54', '55+'],
        workCategories: this.ads.programSummary().workCategories,
        interests: this.ads.programSummary().interests,
      },
    };
  }

  // ------------------------------------------------------------ campaigns

  async listCampaigns(advertiserId: string) {
    const rows = await this.campaigns.find({
      where: { advertiserId },
      order: { updatedAt: 'DESC' },
    });
    return Promise.all(rows.map((c) => this.view(c)));
  }

  async getCampaign(advertiserId: string, id: string) {
    const c = await this.campaigns.findOne({ where: { id, advertiserId } });
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
  }

  async createCampaign(advertiserId: string, dto: AdvertiserCampaignDto) {
    const advertiser = await this.requireAdvertiser(advertiserId);
    this.validateFlight(dto.startsAt, dto.endsAt);
    this.validateViews(dto.views);
    const eco = this.ads.economics;
    const campaign = await this.campaigns.save(
      this.campaigns.create({
        slug: `adv-${randomBytes(8).toString('hex')}`,
        advertiserId,
        sponsorName: (dto.sponsorName ?? advertiser.companyName).trim(),
        title: dto.title.trim(),
        message: dto.message.trim(),
        assetUrl: dto.assetUrl ?? null,
        ctaLabel: dto.ctaLabel?.trim() || null,
        ctaUrl: dto.ctaUrl ?? null,
        ageBands: dto.ageBands,
        workCategories: dto.workCategories,
        interests: dto.interests ?? [],
        state: CampaignState.PENDING_REVIEW,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        requiredViewSeconds: dto.requiredViewSeconds,
        rewardMinor: eco.rewardMinor,
        // Budget is granted on payment, not on submission.
        budgetMinor: '0',
        purchasedViews: 0,
        deliveryWeight: 100,
      }),
    );
    return this.view(campaign, dto.views);
  }

  async updateCampaign(
    advertiserId: string,
    id: string,
    dto: AdvertiserCampaignUpdateDto,
  ) {
    const c = await this.getCampaign(advertiserId, id);
    if (!EDITABLE.has(c.state)) {
      throw new ConflictException(
        'Approved or running campaigns cannot be edited — pause or end it and create a new one',
      );
    }
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : c.startsAt;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : c.endsAt;
    this.validateFlight(startsAt.toISOString(), endsAt.toISOString());
    if (dto.views !== undefined) this.validateViews(dto.views);
    const { views, ...rest } = dto;
    const clean = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    const saved = await this.campaigns.save({
      ...c,
      ...clean,
      startsAt,
      endsAt,
      // Any edit goes back through review.
      state: CampaignState.PENDING_REVIEW,
      reviewNote: null,
    });
    return this.view(saved, views);
  }

  async setRunState(
    advertiserId: string,
    id: string,
    next: CampaignState.PAUSED | CampaignState.ACTIVE | CampaignState.ENDED,
  ) {
    const saved = await this.ads.setCampaignRunState(
      id,
      next,
      advertiserId,
      advertiserId,
    );
    return this.view(saved);
  }

  private validateFlight(startsAt: string, endsAt: string) {
    const s = Date.parse(startsAt);
    const e = Date.parse(endsAt);
    if (!Number.isFinite(s) || !Number.isFinite(e))
      throw new BadRequestException('Invalid campaign dates');
    if (e <= s) throw new BadRequestException('End date must be after start');
    if (e - s < 24 * 3600 * 1000)
      throw new BadRequestException('A campaign must run for at least a day');
    if (e - s > 180 * 24 * 3600 * 1000)
      throw new BadRequestException(
        'A campaign cannot run longer than 180 days',
      );
  }

  private validateViews(views: number) {
    const eco = this.ads.economics;
    if (views < eco.minPurchasedViews)
      throw new BadRequestException(
        `Minimum purchase is ${eco.minPurchasedViews} verified views`,
      );
    if (views > eco.maxPurchasedViews)
      throw new BadRequestException(
        `Maximum purchase is ${eco.maxPurchasedViews} verified views per campaign`,
      );
  }

  // -------------------------------------------------------------- payment

  /**
   * Starts a Chapa checkout for `views` verified views. Allowed once the
   * creative is approved (so nobody pays for something we will reject).
   */
  async checkout(advertiserId: string, id: string, views: number) {
    const advertiser = await this.requireAdvertiser(advertiserId);
    const c = await this.getCampaign(advertiserId, id);
    if (
      ![
        CampaignState.APPROVED,
        CampaignState.ACTIVE,
        CampaignState.PAUSED,
      ].includes(c.state)
    ) {
      throw new ConflictException(
        'This campaign has not been approved yet — payment opens after review',
      );
    }
    this.validateViews(views);
    const eco = this.ads.economics;
    const amountMinor = priceForViews(views, eco);
    const txRef = `${TX_PREFIX}.${c.id.replace(/-/g, '')}.${randomBytes(4).toString('hex')}`;
    const names = advertiser.contactName.trim().split(/\s+/);
    const siteBase = (
      this.config.get<string>('ADVERTISER_SITE_URL') ?? 'https://hebirtaxi.com'
    ).replace(/\/$/, '');

    const payment = await this.payments.save(
      this.payments.create({
        advertiserId,
        campaignId: c.id,
        txRef,
        views,
        amountMinor: String(amountMinor),
        status: AdvertiserPaymentStatus.INITIALIZED,
      }),
    );
    try {
      const checkout = await this.chapa.initializeCheckout({
        txRef,
        amountEtb: amountMinor / 100,
        email: advertiser.email,
        firstName: names[0] || advertiser.companyName,
        lastName: names.slice(1).join(' ') || 'Hebir',
        phone: advertiser.phone,
        title: 'Hebir Ads',
        description: `${views} sponsored views`,
        meta: { kind: 'ad_campaign', campaignId: c.id, advertiserId },
        callbackPath: '/advertisers/payments/chapa/callback',
        returnUrl: `${siteBase}/advertise?paid=${encodeURIComponent(txRef)}`,
      });
      return {
        paymentId: payment.id,
        txRef,
        amountMinor,
        views,
        checkoutUrl: checkout.checkoutUrl,
      };
    } catch (error) {
      await this.payments.update(payment.id, {
        status: AdvertiserPaymentStatus.FAILED,
      });
      throw error;
    }
  }

  /**
   * Confirms a payment with Chapa and credits the campaign. Called by the
   * webhook, the GET callback, and by the site after the return redirect —
   * all three are idempotent on txRef.
   */
  async applyVerifiedPayment(txRef: string) {
    const payment = await this.payments.findOne({ where: { txRef } });
    if (!payment) throw new NotFoundException('Unknown payment reference');
    if (payment.status === AdvertiserPaymentStatus.PAID) {
      return { status: 'paid', campaignId: payment.campaignId, txRef };
    }
    const verified = await this.chapa.verifyTransaction(txRef);
    const paidMinor = Math.round(Number(verified.amountEtb) * 100);
    if (verified.status !== 'success') {
      await this.payments.update(payment.id, {
        status: AdvertiserPaymentStatus.FAILED,
        providerPayload: verified.raw,
      });
      return {
        status: verified.status || 'failed',
        campaignId: payment.campaignId,
        txRef,
      };
    }
    if (
      verified.currency.toUpperCase() !== 'ETB' ||
      paidMinor < Number(payment.amountMinor)
    ) {
      this.logger.warn(
        `Chapa amount mismatch for ${txRef}: expected ${payment.amountMinor}, got ${paidMinor} ${verified.currency}`,
      );
      throw new ConflictException('Paid amount does not match the order');
    }
    await this.payments.manager.transaction(async (em) => {
      const locked = await em.findOne(AdvertiserPayment, {
        where: { id: payment.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || locked.status === AdvertiserPaymentStatus.PAID) return;
      await this.ads.recordCampaignPayment(
        em,
        locked.campaignId,
        Number(locked.amountMinor),
        txRef,
      );
      await em.update(AdvertiserPayment, locked.id, {
        status: AdvertiserPaymentStatus.PAID,
        paidAt: new Date(),
        providerPayload: verified.raw,
      });
    });
    return { status: 'paid', campaignId: payment.campaignId, txRef };
  }

  async listPayments(advertiserId: string) {
    return this.payments.find({
      where: { advertiserId },
      order: { createdAt: 'DESC' },
    });
  }

  // ----------------------------------------------------------------- view

  private async view(c: AdCampaign, requestedViews?: number) {
    const eco = this.ads.economics;
    const stats = await this.ads.campaignStats(c);
    return {
      id: c.id,
      sponsorName: c.sponsorName,
      title: c.title,
      message: c.message,
      assetUrl: c.assetUrl,
      ctaLabel: c.ctaLabel,
      ctaUrl: c.ctaUrl,
      ageBands: c.ageBands,
      workCategories: c.workCategories,
      interests: c.interests,
      state: c.state,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      requiredViewSeconds: c.requiredViewSeconds,
      reviewNote: c.reviewNote,
      reviewedAt: c.reviewedAt,
      paidAt: c.paidAt,
      pricePerViewMinor: eco.pricePerViewMinor,
      requestedViews: requestedViews ?? null,
      quoteMinor:
        requestedViews !== undefined
          ? priceForViews(requestedViews, eco)
          : null,
      canEdit: EDITABLE.has(c.state),
      canPay: [
        CampaignState.APPROVED,
        CampaignState.ACTIVE,
        CampaignState.PAUSED,
      ].includes(c.state),
      stats,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}

// bcrypt hash of a random string; only used to equalise login timing.
const DUMMY_HASH =
  '$2b$12$C6UzMDM.H6dfI/f/IKcEeO5PbGg3fR5OSlL9U0RZ6Q9ZcC0tQbqCu';
