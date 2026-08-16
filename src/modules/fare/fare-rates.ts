/**
 * Fare rate keys — the ONLY place operational fee names are defined.
 *
 * Adjust values in Neon `configuration` (or PATCH /fare/rates).
 * Do not hardcode fee amounts in matching, booking, or Flutter UI.
 */
export const FareRateKeys = {
  /** Flat fee charged once per trip (initial / base fee). */
  initialFeeEtb: 'fare_initial_fee_etb',
  /** Distance rate in ETB per meter (independent of time / wait / surge). */
  perMeterEtb: 'fare_per_meter_etb',
  /** Time rate in ETB per minute of travel. */
  perMinuteEtb: 'fare_per_minute_etb',
  /** Waiting rate in ETB per minute. */
  perWaitMinuteEtb: 'fare_per_wait_minute_etb',
  /** Floor after summing components (before surge). */
  minimumEtb: 'fare_minimum_etb',
  /** Cap on demand-based surge multiplier. */
  surgeMaxMultiplier: 'surge_max_multiplier',
} as const;

export type FareRateKey = (typeof FareRateKeys)[keyof typeof FareRateKeys];

/**
 * Addis Ababa street-speed used when OSRM duration is missing.
 * 25 km/h was highway-optimistic; mixed traffic here is closer to 18.
 */
export const ADDIS_AVERAGE_SPEED_KMH = 18;

/**
 * Typical urban road / crow-fly ratio. Applied only when the client did
 * not send a snapped road distance (OSRM).
 */
export const URBAN_ROAD_CIRCUITY = 1.35;

/** Previous seed — used to detect "never customized" rows to migrate. */
export const LEGACY_FARE_RATE_DEFAULTS: Record<FareRateKey, number> = {
  [FareRateKeys.initialFeeEtb]: 20,
  [FareRateKeys.perMeterEtb]: 0.008,
  [FareRateKeys.perMinuteEtb]: 1.5,
  [FareRateKeys.perWaitMinuteEtb]: 0,
  [FareRateKeys.minimumEtb]: 20,
  [FareRateKeys.surgeMaxMultiplier]: 2.5,
};

/** Defaults used when a row is missing from the DB (first boot seed). */
export const FARE_RATE_DEFAULTS: Record<FareRateKey, number> = {
  // Ride/Feres-class Addis fares (2026): flag drop + ~16 ETB/km + traffic time.
  [FareRateKeys.initialFeeEtb]: 50,
  [FareRateKeys.perMeterEtb]: 0.016,
  [FareRateKeys.perMinuteEtb]: 2,
  [FareRateKeys.perWaitMinuteEtb]: 2,
  [FareRateKeys.minimumEtb]: 70,
  [FareRateKeys.surgeMaxMultiplier]: 2.5,
};

export const FARE_RATE_DESCRIPTIONS: Record<FareRateKey, string> = {
  [FareRateKeys.initialFeeEtb]: 'Flat initial fee (ETB) charged once per trip',
  [FareRateKeys.perMeterEtb]: 'Distance fee (ETB) per meter traveled',
  [FareRateKeys.perMinuteEtb]: 'Time fee (ETB) per minute of travel',
  [FareRateKeys.perWaitMinuteEtb]: 'Waiting fee (ETB) per minute',
  [FareRateKeys.minimumEtb]: 'Minimum fare (ETB) before surge',
  [FareRateKeys.surgeMaxMultiplier]: 'Maximum surge multiplier from demand',
};

export interface FareRates {
  initialFeeEtb: number;
  perMeterEtb: number;
  perMinuteEtb: number;
  perWaitMinuteEtb: number;
  minimumEtb: number;
  surgeMaxMultiplier: number;
}

/** Convenience: ETB per km derived from per-meter (read-only helper). */
export function perKmFromMeter(perMeterEtb: number): number {
  return perMeterEtb * 1000;
}
