import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Key/value operational parameters (blueprint section 10). Values must be
 * adjustable at runtime without a release, so they live in the database
 * rather than in application code.
 */
@Entity('configuration')
export class Configuration {
  @PrimaryColumn()
  key: string;

  @Column({ type: 'jsonb' })
  value: unknown;

  @Column({ nullable: true })
  description: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

export const CONFIG_DEFAULTS: Record<string, unknown> = {
  subscription_fee_etb: 1000,
  cycle_length_days: 30,
  grace_period_hours: 24,
  expiry_check_interval_minutes: 20,
  corridor_width_km: 4,
  direction_tolerance_degrees: 45,
  departure_tolerance_minutes: 15,
  waiting_time_weight: 1.0,
  detour_weight: 1.0,
  price_weight: 0.5,
  /** Soft penalty in ranking when pickup zone is surging. */
  surge_rank_weight: 0.35,
  seat_hold_duration_minutes: 2,
  max_results_returned: 20,
  // Fare levers (also defined in fare/fare-rates.ts — keep values aligned).
  fare_initial_fee_etb: 50,
  fare_per_meter_etb: 0.016, // 16 ETB / km
  fare_per_minute_etb: 2,
  fare_per_wait_minute_etb: 2,
  fare_minimum_etb: 70,
  surge_max_multiplier: 2.5,
  /** Distinct active riders required in an H3 hex before surge can engage. */
  surge_min_active_riders: 2,
  /** Max surge increase per resolve (smooths spikes). */
  surge_max_step_up: 0.2,
  /** Max surge decrease per resolve. */
  surge_max_step_down: 0.3,
  /** Weight of neighboring hex targets when smoothing (0–1). */
  surge_neighbor_blend: 0.35,
  /**
   * When true, FareService uses override multipliers instead of live demand.
   * Rider/Driver apps cannot set this — Operations / configuration only.
   */
  surge_override_enabled: false,
  /** Global forced surge when override is enabled (clamped by max). */
  surge_override_multiplier: 1,
  /** Per-zone (H3) forced multipliers: { [zoneId]: number }. */
  surge_zone_overrides: {},
  // Legacy aliases (read by migration only; prefer fare_initial_fee / per_meter).
  fare_base_etb: 50,
  fare_per_km_etb: 16,
};
