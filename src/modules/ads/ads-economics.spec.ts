import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_AD_ECONOMICS,
  loadAdEconomics,
  matchesTargeting,
  pickWeighted,
  priceForViews,
  remainingViews,
  riderBudgetForViews,
  startOfAddisDay,
} from './ads-economics';

describe('ad economics', () => {
  it('uses defaults and clamps nonsense env values', () => {
    const eco = loadAdEconomics(
      new ConfigService({
        ADS_REWARD_MINOR: '300',
        ADS_PRICE_PER_VIEW_MINOR: '150', // below reward → floored to reward
        ADS_MAX_REWARDS_PER_DAY: 'abc',
      }),
    );
    expect(eco.rewardMinor).toBe(300);
    expect(eco.pricePerViewMinor).toBe(300);
    expect(eco.maxRewardsPerDay).toBe(DEFAULT_AD_ECONOMICS.maxRewardsPerDay);
  });

  it('prices views and derives the rider budget', () => {
    expect(priceForViews(1000, DEFAULT_AD_ECONOMICS)).toBe(500_000);
    expect(riderBudgetForViews(1000, DEFAULT_AD_ECONOMICS)).toBe(300_000);
    expect(remainingViews('300000', '299700', DEFAULT_AD_ECONOMICS)).toBe(1);
    expect(remainingViews('300000', '299800', DEFAULT_AD_ECONOMICS)).toBe(0);
  });

  it('start of Addis day is 21:00 UTC the previous day', () => {
    const d = startOfAddisDay(new Date('2026-09-20T19:30:00Z'));
    expect(d.toISOString()).toBe('2026-09-19T21:00:00.000Z');
    const late = startOfAddisDay(new Date('2026-09-20T22:30:00Z'));
    expect(late.toISOString()).toBe('2026-09-20T21:00:00.000Z');
  });
});

describe('matchesTargeting', () => {
  const rider = {
    ageBand: '25-34',
    workCategory: 'employed',
    interests: ['food', 'telecom'],
  };

  it('empty targeting matches everyone', () => {
    expect(
      matchesTargeting(
        { ageBands: [], workCategories: [], interests: [] },
        rider,
      ),
    ).toBe(true);
  });

  it('requires every declared dimension to match', () => {
    expect(
      matchesTargeting(
        { ageBands: ['18-24'], workCategories: [], interests: [] },
        rider,
      ),
    ).toBe(false);
    expect(
      matchesTargeting(
        { ageBands: ['25-34'], workCategories: ['student'], interests: [] },
        rider,
      ),
    ).toBe(false);
    expect(
      matchesTargeting(
        { ageBands: ['25-34'], workCategories: [], interests: ['fashion'] },
        rider,
      ),
    ).toBe(false);
    expect(
      matchesTargeting(
        {
          ageBands: ['25-34'],
          workCategories: ['employed'],
          interests: ['fashion', 'telecom'],
        },
        rider,
      ),
    ).toBe(true);
  });
});

describe('pickWeighted', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const flight = (over: Partial<Record<string, unknown>> = {}) => ({
    deliveryWeight: 100,
    startsAt: new Date('2026-09-10T00:00:00Z'),
    endsAt: new Date('2026-09-20T00:00:00Z'),
    budgetMinor: '300000',
    reservedMinor: '150000', // on pace at 50% of flight
    ...over,
  });

  it('returns null for no candidates and the only candidate otherwise', () => {
    expect(pickWeighted([], now)).toBeNull();
    const only = flight();
    expect(pickWeighted([only], now)).toBe(only);
  });

  it('favours a campaign that is behind schedule', () => {
    const onPace = flight({ reservedMinor: '150000' });
    const behind = flight({ reservedMinor: '0' });
    let behindWins = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      if (pickWeighted([onPace, behind], now, Math.random) === behind) {
        behindWins++;
      }
    }
    // behind has pacing 2.0 vs 1.0 → ~2/3 of picks.
    expect(behindWins / trials).toBeGreaterThan(0.58);
    expect(behindWins / trials).toBeLessThan(0.75);
  });

  it('respects deliveryWeight with deterministic randomness', () => {
    const heavy = flight({ deliveryWeight: 300 });
    const light = flight({ deliveryWeight: 100 });
    expect(pickWeighted([heavy, light], now, () => 0.1)).toBe(heavy);
    expect(pickWeighted([heavy, light], now, () => 0.9)).toBe(light);
  });
});
