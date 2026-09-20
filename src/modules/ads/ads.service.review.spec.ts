import { ConfigService } from '@nestjs/config';
import { AdRewardsService } from './ads.service';
import { AdCampaign, CampaignState } from './entities/ad-rewards.entity';

/** Minimal EntityManager double: findOne with lock, save, update. */
function fakeManager(store: Map<string, AdCampaign>) {
  return {
    findOne: jest.fn(async (_entity: unknown, opts: any) => {
      return store.get(opts.where.id) ?? null;
    }),
    save: jest.fn(async (_entity: unknown, value: AdCampaign) => {
      store.set(value.id, value);
      return value;
    }),
    update: jest.fn(async (_entity: unknown, id: string, patch: any) => {
      const c = store.get(id)!;
      Object.assign(c, patch);
    }),
    count: jest.fn(async () => 0),
    create: jest.fn((_e: unknown, v: unknown) => v),
  };
}

function buildService(store: Map<string, AdCampaign>) {
  const manager = fakeManager(store);
  const campaigns = {
    manager: { transaction: (fn: (em: any) => unknown) => fn(manager) },
    findOneBy: jest.fn(async ({ id }: { id: string }) => store.get(id) ?? null),
    save: jest.fn(async (v: AdCampaign) => {
      store.set(v.id, v);
      return v;
    }),
    find: jest.fn(async () => Array.from(store.values())),
    increment: jest.fn(),
  };
  const noop = {} as any;
  const service = new AdRewardsService(
    campaigns as any,
    noop,
    noop,
    { count: jest.fn(async () => 0), find: jest.fn(async () => []) } as any,
    noop,
    noop,
    noop,
    noop,
    new ConfigService({}),
  );
  return { service, manager, campaigns };
}

function campaign(over: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id: 'c1',
    slug: 'adv-1',
    sponsorName: 'Sheger Coffee',
    title: 'Free espresso',
    message: 'Show this at any Sheger branch',
    assetUrl: null,
    ctaLabel: null,
    ctaUrl: null,
    ageBands: [],
    workCategories: [],
    interests: [],
    state: CampaignState.PENDING_REVIEW,
    startsAt: new Date('2026-10-01T00:00:00Z'),
    endsAt: new Date('2026-10-31T00:00:00Z'),
    requiredViewSeconds: 15,
    rewardMinor: 300,
    budgetMinor: '0',
    reservedMinor: '0',
    deliveryWeight: 100,
    advertiserId: 'adv-1',
    purchasedViews: 0,
    paidMinor: '0',
    paymentTxRef: null,
    paidAt: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    impressions: 0,
    ctaClicks: 0,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as AdCampaign;
}

describe('campaign review state machine', () => {
  it('approving an unpaid advertiser campaign parks it in approved (awaiting payment)', async () => {
    const store = new Map([['c1', campaign()]]);
    const { service } = buildService(store);
    const result = await service.reviewCampaign('c1', 'approve', 'ops-1');
    expect(result.state).toBe(CampaignState.APPROVED);
    expect(result.reviewedBy).toBe('ops-1');
    expect(result.reviewedAt).toBeInstanceOf(Date);
  });

  it('approving a house campaign (no advertiser) activates it immediately', async () => {
    const store = new Map([['c1', campaign({ advertiserId: null })]]);
    const { service } = buildService(store);
    const result = await service.reviewCampaign('c1', 'approve', 'ops-1');
    expect(result.state).toBe(CampaignState.ACTIVE);
  });

  it('approving an already-paid advertiser campaign activates it', async () => {
    const store = new Map([['c1', campaign({ paidMinor: '250000' })]]);
    const { service } = buildService(store);
    const result = await service.reviewCampaign('c1', 'approve', 'ops-1');
    expect(result.state).toBe(CampaignState.ACTIVE);
  });

  it('rejecting requires a note the advertiser can act on', async () => {
    const store = new Map([['c1', campaign()]]);
    const { service } = buildService(store);
    await expect(
      service.reviewCampaign('c1', 'reject', 'ops-1'),
    ).rejects.toThrow(/note is required/);
    const rejected = await service.reviewCampaign(
      'c1',
      'reject',
      'ops-1',
      'Creative shows alcohol — not allowed',
    );
    expect(rejected.state).toBe(CampaignState.REJECTED);
    expect(rejected.reviewNote).toContain('alcohol');
  });

  it('cannot review a running campaign; can still reject an approved one', async () => {
    const store = new Map([['c1', campaign({ state: CampaignState.ACTIVE })]]);
    const { service } = buildService(store);
    await expect(
      service.reviewCampaign('c1', 'approve', 'ops-1'),
    ).rejects.toThrow(/cannot be reviewed/);
    store.set('c1', campaign({ state: CampaignState.APPROVED }));
    const r = await service.reviewCampaign('c1', 'reject', 'ops-1', 'Typo');
    expect(r.state).toBe(CampaignState.REJECTED);
  });

  it('payment on an approved campaign grants budget and activates it (idempotent on txRef)', async () => {
    const store = new Map([
      ['c1', campaign({ state: CampaignState.APPROVED })],
    ]);
    const { service, manager } = buildService(store);
    const paid = await service.recordCampaignPayment(
      manager as any,
      'c1',
      500_000, // 1000 views × 5 ETB
      'a.c1.abcd',
    );
    expect(paid.state).toBe(CampaignState.ACTIVE);
    expect(paid.purchasedViews).toBe(1000);
    expect(paid.budgetMinor).toBe('300000'); // 1000 × 3 ETB rider reward
    expect(paid.paidMinor).toBe('500000');

    const again = await service.recordCampaignPayment(
      manager as any,
      'c1',
      500_000,
      'a.c1.abcd',
    );
    expect(again.purchasedViews).toBe(1000);
  });

  it('run-state transitions: active↔paused, either→ended, nothing from ended', async () => {
    const store = new Map([['c1', campaign({ state: CampaignState.ACTIVE })]]);
    const { service } = buildService(store);
    expect(
      (
        await service.setCampaignRunState(
          'c1',
          CampaignState.PAUSED,
          'adv-1',
          'adv-1',
        )
      ).state,
    ).toBe(CampaignState.PAUSED);
    expect(
      (
        await service.setCampaignRunState(
          'c1',
          CampaignState.ACTIVE,
          'adv-1',
          'adv-1',
        )
      ).state,
    ).toBe(CampaignState.ACTIVE);
    await expect(
      service.setCampaignRunState(
        'c1',
        CampaignState.PAUSED,
        'x',
        'someone-else',
      ),
    ).rejects.toThrow(/Not your campaign/);
    expect(
      (await service.setCampaignRunState('c1', CampaignState.ENDED, 'ops'))
        .state,
    ).toBe(CampaignState.ENDED);
    await expect(
      service.setCampaignRunState('c1', CampaignState.ACTIVE, 'ops'),
    ).rejects.toThrow(/Cannot move/);
  });

  it('campaign stats derive verified views and spend from the reward ledger', async () => {
    const { service } = buildService(new Map());
    const stats = await service.campaignStats(
      campaign({
        impressions: 400,
        reservedMinor: '90000', // 300 verified views
        budgetMinor: '300000',
        ctaClicks: 30,
        purchasedViews: 1000,
        paidMinor: '500000',
      }),
    );
    expect(stats.verifiedViews).toBe(300);
    expect(stats.remainingViews).toBe(700);
    expect(stats.spentMinor).toBe(150_000);
    expect(stats.completionRate).toBe(75);
    expect(stats.clickThroughRate).toBe(10);
  });
});
