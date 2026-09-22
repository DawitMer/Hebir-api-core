import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { FareRates } from '../../fare/fare-rates';

export type PricingVersionStatus =
  | 'draft'
  | 'review'
  | 'published'
  | 'active'
  | 'archived';

export type VehicleMultipliers = Record<string, number>;

@Entity('pricing_versions')
export class PricingVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 64 })
  versionLabel: string;

  @Index()
  @Column({ length: 32, default: 'draft' })
  status: PricingVersionStatus;

  @Column({ length: 8, default: 'ETB' })
  currency: string;

  /** Locked FareRates snapshot for this version. */
  @Column({ type: 'jsonb' })
  rates: FareRates;

  /** Relative multipliers by vehicleType (sedan=1). */
  @Column({ type: 'jsonb', default: {} })
  vehicleMultipliers: VehicleMultipliers;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  effectiveFrom: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  archivedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;

  @Column({ type: 'uuid', nullable: true })
  publishedById: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

@Entity('fare_adjustments')
export class FareAdjustment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  rideId: string;

  @Column({ type: 'uuid' })
  staffUserId: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  originalTotal: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  adjustedTotal: string;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'text', nullable: true })
  internalNote: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
