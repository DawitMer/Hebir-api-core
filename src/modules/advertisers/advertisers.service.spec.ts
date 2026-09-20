import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AdvertisersService } from './advertisers.service';
import { AdvertiserStatus } from './entities/advertiser.entity';
import { CampaignState } from '../ads/entities/ad-rewards.entity';
import { DEFAULT_AD_ECONOMICS } from '../ads/ads-economics';

function repo<T extends { id?: string }>(seed: T[] = []) {
  const rows: T[] = [...seed];
  let n = 0;
  return {
    rows,
    findOne: jest.fn(
      async ({ where }: { where: Partial<T> }) =>
        rows.find((r) =>
          Object.entries(where).every(([k, v]) => (r as any)[k] === v),
        ) ?? null,
    ),
    find: jest.fn(async () => rows),
    // Mirrors the entity default the real repository would apply.
    create: jest.fn((v: T) => ({ status: 'active', ...v })),
    save: jest.fn(async (v: T) => {
      const saved = { ...v, id: v.id ?? `id-${++n}` } as T;
      const idx = rows.findIndex((r) => r.id === saved.id);
      if (idx >= 0) rows[idx] = saved;
      else rows.push(saved);
      return saved;
    }),
    update: jest.fn(async (id: string, patch: Partial<T>) => {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    }),
    manager: {
      transaction: async (fn: (em: any) => unknown) =>
        fn({
          findOne: async (_e: unknown, opts: any) =>
            rows.find((r) => r.id === opts.where.id) ?? null,
          update: async (_e: unknown, id: string, patch: Partial<T>) => {
            const r = rows.find((x) => x.id === id);
            if (r) Object.assign(r, patch);
          },
        }),
    },
  };
}

function build() {
  const advertisers = repo<any>();
  const payments = repo<any>();
  const campaigns = repo<any>();
  const ads = {
    economics: DEFAULT_AD_ECONOMICS,
    programSummary: () => ({
      interests: ['food'],
      workCategories: ['student'],
    }),
    campaignStats: jest.fn(async () => ({ impressions: 0 })),
    setCampaignRunState: jest.fn(),
    recordCampaignPayment: jest.fn(async () => ({})),
  };
  const chapa = {
    isConfigured: () => true,
    initializeCheckout: jest.fn(async ({ txRef }: { txRef: string }) => ({
      checkoutUrl: `https://checkout.chapa.co/${txRef}`,
      txRef,
    })),
    verifyTransaction: jest.fn(),
  };
  const jwt = new JwtService({ secret: 'test-secret-that-is-long-enough' });
  const service = new AdvertisersService(
    advertisers as any,
    payments as any,
    campaigns as any,
    ads as any,
    chapa as any,
    jwt,
    new ConfigService({}),
  );
  return { service, advertisers, payments, campaigns, ads, chapa, jwt };
}

const register = {
  companyName: 'Sheger Coffee',
  contactName: 'Hanna T',
  email: 'Ads@Sheger.et',
  phone: '0911223344',
  password: 'Str0ngPassw0rd!',
};

describe('AdvertisersService', () => {
  it('registers, lowercases the email, hashes the password and issues an advertiser token', async () => {
    const { service, advertisers, jwt } = build();
    const out = await service.register(register as any);
    expect(out.advertiser.email).toBe('ads@sheger.et');
    expect(advertisers.rows[0].passwordHash).not.toContain('Str0ng');
    const payload = jwt.verify(out.token) as { typ: string; sub: string };
    expect(payload.typ).toBe('advertiser');
    expect(payload.sub).toBe(out.advertiser.id);
  });

  it('rejects duplicate emails and wrong passwords with one generic message', async () => {
    const { service } = build();
    await service.register(register as any);
    await expect(service.register(register as any)).rejects.toThrow(
      /already exists/,
    );
    await expect(
      service.login({ email: register.email, password: 'nope-nope-nope' }),
    ).rejects.toThrow(/Incorrect email or password/);
    await expect(
      service.login({ email: 'ghost@x.et', password: 'nope-nope-nope' }),
    ).rejects.toThrow(/Incorrect email or password/);
    const ok = await service.login({
      email: register.email,
      password: register.password,
    });
    expect(ok.token).toBeTruthy();
  });

  it('suspended advertisers cannot sign in', async () => {
    const { service, advertisers } = build();
    await service.register(register as any);
    advertisers.rows[0].status = AdvertiserStatus.SUSPENDED;
    await expect(
      service.login({ email: register.email, password: register.password }),
    ).rejects.toThrow(/suspended/);
  });

  it('a new campaign is queued for review with zero budget and a price quote', async () => {
    const { service } = build();
    const { advertiser } = await service.register(register as any);
    const view = await service.createCampaign(advertiser.id, {
      title: 'Free espresso',
      message: 'Show this screen at any Sheger branch for a free espresso.',
      ageBands: ['25-34'],
      workCategories: [],
      interests: ['food'],
      startsAt: '2026-10-01T00:00:00Z',
      endsAt: '2026-10-31T00:00:00Z',
      requiredViewSeconds: 15,
      views: 1000,
    });
    expect(view.state).toBe(CampaignState.PENDING_REVIEW);
    expect(view.sponsorName).toBe('Sheger Coffee');
    expect(view.quoteMinor).toBe(500_000);
    expect(view.canPay).toBe(false);
    expect(view.canEdit).toBe(true);
  });

  it('validates flight dates and purchase size', async () => {
    const { service } = build();
    const { advertiser } = await service.register(register as any);
    const base = {
      title: 'Free espresso',
      message: 'Show this screen at any Sheger branch for a free espresso.',
      ageBands: [],
      workCategories: [],
      requiredViewSeconds: 15,
      views: 1000,
    };
    await expect(
      service.createCampaign(advertiser.id, {
        ...base,
        startsAt: '2026-10-02T00:00:00Z',
        endsAt: '2026-10-01T00:00:00Z',
      }),
    ).rejects.toThrow(/after start/);
    await expect(
      service.createCampaign(advertiser.id, {
        ...base,
        startsAt: '2026-10-01T00:00:00Z',
        endsAt: '2026-10-31T00:00:00Z',
        views: 10,
      }),
    ).rejects.toThrow(/Minimum purchase/);
  });

  it('checkout is blocked before approval and creates a Chapa order after', async () => {
    const { service, campaigns, payments, chapa } = build();
    const { advertiser } = await service.register(register as any);
    const created = await service.createCampaign(advertiser.id, {
      title: 'Free espresso',
      message: 'Show this screen at any Sheger branch for a free espresso.',
      ageBands: [],
      workCategories: [],
      startsAt: '2026-10-01T00:00:00Z',
      endsAt: '2026-10-31T00:00:00Z',
      requiredViewSeconds: 15,
      views: 1000,
    });
    await expect(
      service.checkout(advertiser.id, created.id, 1000),
    ).rejects.toThrow(/not been approved/);

    campaigns.rows[0].state = CampaignState.APPROVED;
    const order = await service.checkout(advertiser.id, created.id, 1000);
    expect(order.amountMinor).toBe(500_000);
    expect(order.txRef).toMatch(/^a\.[0-9a-z]+\.[0-9a-f]{8}$/);
    expect(order.checkoutUrl).toContain('chapa');
    expect(payments.rows[0].status).toBe('initialized');
    expect(chapa.initializeCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        amountEtb: 5000,
        meta: expect.objectContaining({ kind: 'ad_campaign' }),
      }),
    );
  });

  it('verifies a payment once, rejects short payments, and is idempotent', async () => {
    const { service, campaigns, payments, chapa, ads } = build();
    const { advertiser } = await service.register(register as any);
    const created = await service.createCampaign(advertiser.id, {
      title: 'Free espresso',
      message: 'Show this screen at any Sheger branch for a free espresso.',
      ageBands: [],
      workCategories: [],
      startsAt: '2026-10-01T00:00:00Z',
      endsAt: '2026-10-31T00:00:00Z',
      requiredViewSeconds: 15,
      views: 1000,
    });
    campaigns.rows[0].state = CampaignState.APPROVED;
    const order = await service.checkout(advertiser.id, created.id, 1000);

    chapa.verifyTransaction.mockResolvedValueOnce({
      status: 'success',
      amountEtb: '4000.00',
      currency: 'ETB',
      meta: {},
      raw: {},
    });
    await expect(service.applyVerifiedPayment(order.txRef)).rejects.toThrow(
      /does not match/,
    );

    chapa.verifyTransaction.mockResolvedValue({
      status: 'success',
      amountEtb: '5000.00',
      currency: 'ETB',
      meta: {},
      raw: { ref: 'x' },
    });
    const first = await service.applyVerifiedPayment(order.txRef);
    expect(first.status).toBe('paid');
    expect(payments.rows[0].status).toBe('paid');
    expect(ads.recordCampaignPayment).toHaveBeenCalledTimes(1);

    const second = await service.applyVerifiedPayment(order.txRef);
    expect(second.status).toBe('paid');
    expect(ads.recordCampaignPayment).toHaveBeenCalledTimes(1);
    expect(chapa.verifyTransaction).toHaveBeenCalledTimes(2);
  });

  it('editing a campaign sends it back to review; running campaigns are locked', async () => {
    const { service, campaigns } = build();
    const { advertiser } = await service.register(register as any);
    const created = await service.createCampaign(advertiser.id, {
      title: 'Free espresso',
      message: 'Show this screen at any Sheger branch for a free espresso.',
      ageBands: [],
      workCategories: [],
      startsAt: '2026-10-01T00:00:00Z',
      endsAt: '2026-10-31T00:00:00Z',
      requiredViewSeconds: 15,
      views: 1000,
    });
    campaigns.rows[0].state = CampaignState.REJECTED;
    campaigns.rows[0].reviewNote = 'fix';
    const edited = await service.updateCampaign(advertiser.id, created.id, {
      title: 'Free macchiato',
    });
    expect(edited.state).toBe(CampaignState.PENDING_REVIEW);
    expect(edited.reviewNote).toBeNull();

    campaigns.rows[0].state = CampaignState.ACTIVE;
    await expect(
      service.updateCampaign(advertiser.id, created.id, { title: 'x' }),
    ).rejects.toThrow(/cannot be edited/);
  });
});
