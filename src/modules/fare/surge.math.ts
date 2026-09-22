/**
 * Live marketplace surge from current demand vs available supply.
 *
 * Rules (Uber/Lyft-style):
 * - Historical busyness alone never creates surge.
 * - activeRiders === 0 ⇒ multiplier === 1.0
 * - Only online, idle drivers count as supply (caller filters).
 * - Ratio maps to stepped multipliers with optional neighbor blend + rate limit.
 */

export interface SurgeThreshold {
  /** Inclusive lower bound on demand/supply ratio. */
  minRatio: number;
  multiplier: number;
}

export interface SurgeConfig {
  maxMultiplier: number;
  /** Need at least this many distinct active riders before any surge. */
  minActiveRiders: number;
  /** Max increase per resolve (smooths spikes). */
  maxStepUp: number;
  /** Max decrease per resolve. */
  maxStepDown: number;
  /** 0..1 weight of neighbor-average when blending. */
  neighborBlend: number;
  /**
   * Ascending ratio floors → multiplier. First matching from the end wins
   * (highest minRatio that is ≤ ratio).
   */
  thresholds: SurgeThreshold[];
}

/** Defaults aligned with Neon configuration seeds. */
export const DEFAULT_SURGE_CONFIG: SurgeConfig = {
  maxMultiplier: 2.5,
  minActiveRiders: 2,
  maxStepUp: 0.2,
  maxStepDown: 0.3,
  neighborBlend: 0.35,
  thresholds: [
    { minRatio: 0, multiplier: 1.0 },
    { minRatio: 1.15, multiplier: 1.1 },
    { minRatio: 1.35, multiplier: 1.2 },
    { minRatio: 1.6, multiplier: 1.3 },
    { minRatio: 2.0, multiplier: 1.5 },
    { minRatio: 2.75, multiplier: 1.8 },
    { minRatio: 3.5, multiplier: 2.0 },
    { minRatio: 4.5, multiplier: 2.5 },
  ],
};

export interface SurgeInputs {
  /** Distinct riders currently searching / requesting in the hex. */
  activeRiders: number;
  /** Distinct online idle drivers in the hex (not on trip / offline). */
  availableDrivers: number;
  /** Prior smoothed multiplier for this hex (1.0 if unknown). */
  previousMultiplier?: number;
  /** Mean raw target of k=1 neighbors (optional smoothing). */
  neighborAverage?: number;
  config?: Partial<SurgeConfig>;
}

export interface SurgeResult {
  demandRatio: number;
  targetMultiplier: number;
  multiplier: number;
}

function mergeConfig(partial?: Partial<SurgeConfig>): SurgeConfig {
  const base = DEFAULT_SURGE_CONFIG;
  return {
    maxMultiplier: partial?.maxMultiplier ?? base.maxMultiplier,
    minActiveRiders: partial?.minActiveRiders ?? base.minActiveRiders,
    maxStepUp: partial?.maxStepUp ?? base.maxStepUp,
    maxStepDown: partial?.maxStepDown ?? base.maxStepDown,
    neighborBlend: partial?.neighborBlend ?? base.neighborBlend,
    thresholds:
      partial?.thresholds && partial.thresholds.length > 0
        ? [...partial.thresholds].sort((a, b) => a.minRatio - b.minRatio)
        : base.thresholds,
  };
}

/** riders / max(drivers, 1). Zero riders ⇒ ratio 0. */
export function demandRatio(
  activeRiders: number,
  availableDrivers: number,
): number {
  const riders = Math.max(0, Math.floor(activeRiders));
  if (riders === 0) return 0;
  const drivers = Math.max(0, Math.floor(availableDrivers));
  return riders / Math.max(drivers, 1);
}

export function multiplierForRatio(
  ratio: number,
  config: SurgeConfig = DEFAULT_SURGE_CONFIG,
): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  let chosen = 1;
  for (const step of config.thresholds) {
    if (ratio >= step.minRatio) chosen = step.multiplier;
  }
  return Math.min(Math.max(1, chosen), config.maxMultiplier);
}

/**
 * Authoritative live surge. Returns exactly 1.0 when there is no current
 * rider demand — historical busy areas must not inflate price.
 */
export function computeLiveSurge(input: SurgeInputs): SurgeResult {
  const config = mergeConfig(input.config);
  const riders = Math.max(0, Math.floor(input.activeRiders));
  const drivers = Math.max(0, Math.floor(input.availableDrivers));
  const ratio = demandRatio(riders, drivers);

  if (riders === 0 || riders < config.minActiveRiders) {
    return { demandRatio: ratio, targetMultiplier: 1, multiplier: 1 };
  }

  let target = multiplierForRatio(ratio, config);

  const neighbor = input.neighborAverage;
  if (
    Number.isFinite(neighbor) &&
    neighbor != null &&
    config.neighborBlend > 0
  ) {
    const w = Math.min(1, Math.max(0, config.neighborBlend));
    target = (1 - w) * target + w * Math.max(1, neighbor);
    target = Math.min(Math.max(1, target), config.maxMultiplier);
    // Snap blended value back onto the nearest configured step so UI/pricing
    // stay on the public ladder (1.0 / 1.1 / 1.2 / …).
    target = snapToNearestStep(target, config);
  }

  const previous = Number.isFinite(input.previousMultiplier)
    ? Math.max(1, input.previousMultiplier as number)
    : 1;
  const delta = target - previous;
  let next = target;
  if (delta > config.maxStepUp) next = previous + config.maxStepUp;
  if (delta < -config.maxStepDown) next = previous - config.maxStepDown;
  next = Math.min(Math.max(1, next), config.maxMultiplier);
  next = snapToNearestStep(next, config);

  // Final hard rule: no live riders ⇒ no surge (guards stale previous).
  if (riders === 0) next = 1;

  return {
    demandRatio: ratio,
    targetMultiplier: target,
    multiplier: roundSurge(next),
  };
}

function snapToNearestStep(value: number, config: SurgeConfig): number {
  let best = 1;
  let bestDist = Math.abs(value - 1);
  for (const step of config.thresholds) {
    const m = Math.min(step.multiplier, config.maxMultiplier);
    const d = Math.abs(value - m);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best;
}

function roundSurge(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Parse "1.0,1.1,1.2,1.3,1.5,1.8,2.0,2.5" into evenly spaced ratio thresholds. */
export function thresholdsFromMultipliers(
  multipliers: number[],
): SurgeThreshold[] {
  const unique = [...new Set(multipliers.map((m) => Math.max(1, m)))].sort(
    (a, b) => a - b,
  );
  if (unique.length === 0) return DEFAULT_SURGE_CONFIG.thresholds;
  if (unique[0] !== 1) unique.unshift(1);
  return unique.map((multiplier, i) => ({
    minRatio: i === 0 ? 0 : 1 + (i - 1) * 0.35 + 0.15,
    multiplier,
  }));
}
