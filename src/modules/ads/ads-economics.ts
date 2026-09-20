import { ConfigService } from '@nestjs/config';

/**
 * Money model for sponsored rewards, all in ETB minor units (1 ETB = 100).
 *
 * - The rider earns `rewardMinor` (3 ETB) for every verified view, capped per
 *   trip and per day, and it comes off the fare at the end of the trip.
 * - The advertiser pays `pricePerViewMinor` (5 ETB) per verified view. The
 *   difference is Hebir's margin, which also reimburses the driver for the
 *   discount they carried (driver wallet credit).
 * - A campaign's rider budget is `purchasedViews × rewardMinor`; delivery
 *   stops when it is exhausted, so an advertiser can never be over-served.
 */
export interface AdEconomics {
  rewardMinor: number;
  pricePerViewMinor: number;
  maxRewardsPerTrip: number;
  maxRewardsPerDay: number;
  /** Cap on the discount applied to a single fare. */
  maxTripDiscountMinor: number;
  minPurchasedViews: number;
  maxPurchasedViews: number;
  /** Seconds after the required view time within which a claim must land. */
  claimWindowSeconds: number;
}

export const DEFAULT_AD_ECONOMICS: AdEconomics = {
  rewardMinor: 300,
  pricePerViewMinor: 500,
  maxRewardsPerTrip: 5,
  maxRewardsPerDay: 15,
  maxTripDiscountMinor: 1500,
  minPurchasedViews: 500,
  maxPurchasedViews: 200_000,
  claimWindowSeconds: 300,
};

export function loadAdEconomics(config: ConfigService): AdEconomics {
  const int = (key: string, fallback: number, min: number) => {
    const raw = config.get<string>(key);
    const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  };
  const rewardMinor = int(
    'ADS_REWARD_MINOR',
    DEFAULT_AD_ECONOMICS.rewardMinor,
    100,
  );
  return {
    rewardMinor,
    pricePerViewMinor: Math.max(
      rewardMinor,
      int(
        'ADS_PRICE_PER_VIEW_MINOR',
        DEFAULT_AD_ECONOMICS.pricePerViewMinor,
        100,
      ),
    ),
    maxRewardsPerTrip: int(
      'ADS_MAX_REWARDS_PER_TRIP',
      DEFAULT_AD_ECONOMICS.maxRewardsPerTrip,
      1,
    ),
    maxRewardsPerDay: int(
      'ADS_MAX_REWARDS_PER_DAY',
      DEFAULT_AD_ECONOMICS.maxRewardsPerDay,
      1,
    ),
    maxTripDiscountMinor: int(
      'ADS_MAX_TRIP_DISCOUNT_MINOR',
      DEFAULT_AD_ECONOMICS.maxTripDiscountMinor,
      100,
    ),
    minPurchasedViews: int(
      'ADS_MIN_PURCHASED_VIEWS',
      DEFAULT_AD_ECONOMICS.minPurchasedViews,
      1,
    ),
    maxPurchasedViews: int(
      'ADS_MAX_PURCHASED_VIEWS',
      DEFAULT_AD_ECONOMICS.maxPurchasedViews,
      1,
    ),
    claimWindowSeconds: int(
      'ADS_CLAIM_WINDOW_SECONDS',
      DEFAULT_AD_ECONOMICS.claimWindowSeconds,
      30,
    ),
  };
}

/** What an advertiser pays for `views` verified views. */
export function priceForViews(views: number, eco: AdEconomics): number {
  return Math.max(0, Math.floor(views)) * eco.pricePerViewMinor;
}

/** Rider-reward budget that `views` verified views require. */
export function riderBudgetForViews(views: number, eco: AdEconomics): number {
  return Math.max(0, Math.floor(views)) * eco.rewardMinor;
}

/** Remaining verified views a campaign can still serve. */
export function remainingViews(
  budgetMinor: string | number,
  reservedMinor: string | number,
  eco: AdEconomics,
): number {
  const remaining = Number(budgetMinor) - Number(reservedMinor);
  return remaining >= eco.rewardMinor
    ? Math.floor(remaining / eco.rewardMinor)
    : 0;
}

export interface Targetable {
  ageBands: string[];
  workCategories: string[];
  interests: string[];
}

export interface RiderTargeting {
  ageBand: string;
  workCategory: string;
  interests: string[];
}

/**
 * Empty targeting arrays mean "anyone". Interests match when at least one
 * declared rider interest is in the campaign's list.
 */
export function matchesTargeting(
  c: Targetable,
  rider: RiderTargeting,
): boolean {
  if (c.ageBands.length && !c.ageBands.includes(rider.ageBand)) return false;
  if (
    c.workCategories.length &&
    !c.workCategories.includes(rider.workCategory)
  ) {
    return false;
  }
  if (c.interests.length) {
    const declared = new Set(rider.interests ?? []);
    if (!c.interests.some((i) => declared.has(i))) return false;
  }
  return true;
}

/**
 * Weighted random pick. Weight = deliveryWeight × pacing, where pacing favours
 * campaigns that are behind schedule (little of their budget spent relative to
 * how much of their flight has elapsed) so every advertiser gets delivery
 * spread across the campaign window instead of the first day.
 */
export function pickWeighted<
  T extends {
    deliveryWeight: number;
    startsAt: Date;
    endsAt: Date;
    budgetMinor: string | number;
    reservedMinor: string | number;
  },
>(candidates: T[], now: Date, random: () => number = Math.random): T | null {
  if (!candidates.length) return null;
  const weights = candidates.map((c) => {
    const flight = Math.max(1, c.endsAt.getTime() - c.startsAt.getTime());
    const elapsed = Math.min(
      1,
      Math.max(0, (now.getTime() - c.startsAt.getTime()) / flight),
    );
    const budget = Math.max(1, Number(c.budgetMinor));
    const spent = Math.min(1, Number(c.reservedMinor) / budget);
    // 1.0 when on pace; up to 3.0 when far behind; floor 0.35 when ahead.
    const pacing = Math.min(3, Math.max(0.35, 1 + (elapsed - spent) * 2));
    return Math.max(0.001, c.deliveryWeight) * pacing;
  });
  const total = weights.reduce((n, w) => n + w, 0);
  let pick = random() * total;
  for (let i = 0; i < candidates.length; i++) {
    pick -= weights[i];
    if (pick <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/** Start of the rider's day in Addis Ababa (UTC+3, no DST). */
export function startOfAddisDay(now: Date = new Date()): Date {
  const addisOffsetMs = 3 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + addisOffsetMs);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - addisOffsetMs);
}
