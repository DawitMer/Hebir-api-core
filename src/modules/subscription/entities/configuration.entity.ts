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
  fare_initial_fee_etb: 20,
  fare_per_meter_etb: 0.008, // 8 ETB / km
  fare_per_minute_etb: 1.5,
  fare_per_wait_minute_etb: 0,
  fare_minimum_etb: 20,
  surge_max_multiplier: 2.5,
  // Legacy aliases (read by migration only; prefer fare_initial_fee / per_meter).
  fare_base_etb: 20,
  fare_per_km_etb: 8,
};
