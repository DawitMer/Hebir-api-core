import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Campaign lifecycle.
 *
 * Self-serve (advertiser) campaigns:
 *   pending_review → approved (awaiting payment) → active → ended
 *                  ↘ rejected (editable, resubmits as pending_review)
 * House campaigns created by ops skip payment: pending_review → active.
 * paused is reversible by ops or the advertiser; ended is terminal.
 */
export enum CampaignState {
  DRAFT = 'draft',
  PENDING_REVIEW = 'pending_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  ACTIVE = 'active',
  PAUSED = 'paused',
  ENDED = 'ended',
}
export enum ViewState {
  STARTED = 'started',
  COMPLETED = 'completed',
  EXPIRED = 'expired',
}
export enum CashoutState {
  REQUESTED = 'requested',
  PROCESSING = 'processing',
  PAID = 'paid',
  REJECTED = 'rejected',
  FAILED = 'failed',
}

@Entity('ad_campaigns')
export class AdCampaign {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ length: 80 }) slug: string;
  @Column({ length: 120 }) sponsorName: string;
  @Column({ length: 160 }) title: string;
  @Column({ type: 'text' }) message: string;
  @Column({ type: 'varchar', length: 2048, nullable: true }) assetUrl:
    string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) ctaLabel:
    string | null;
  @Column({ type: 'varchar', length: 2048, nullable: true }) ctaUrl:
    string | null;
  @Column({ type: 'varchar', array: true, default: '{}' }) ageBands: string[];
  @Column({ type: 'varchar', array: true, default: '{}' })
  workCategories: string[];
  /** Empty = any interest. Matched against RiderAdProfile.interests. */
  @Column({ type: 'varchar', array: true, default: '{}' }) interests: string[];
  @Column({ type: 'enum', enum: CampaignState, default: CampaignState.DRAFT })
  state: CampaignState;
  @Column({ type: 'timestamptz' }) startsAt: Date;
  @Column({ type: 'timestamptz' }) endsAt: Date;
  @Column({ type: 'int', default: 15 }) requiredViewSeconds: number;
  @Column({ type: 'int', default: 300 }) rewardMinor: number;
  /** Rider-reward budget (rewardMinor × purchased views). */
  @Column({ type: 'bigint', default: 0 }) budgetMinor: string;
  /** Rider-reward budget already granted; never decremented. */
  @Column({ type: 'bigint', default: 0 }) reservedMinor: string;
  @Column({ type: 'int', default: 100 }) deliveryWeight: number;

  // --- self-serve advertiser fields ---
  @Index()
  @Column({ type: 'uuid', nullable: true })
  advertiserId: string | null;
  /** Verified views the advertiser bought (budgetMinor / rewardMinor). */
  @Column({ type: 'int', default: 0 }) purchasedViews: number;
  /** What the advertiser paid Hebir, in ETB minor units. */
  @Column({ type: 'bigint', default: 0 }) paidMinor: string;
  @Column({ type: 'varchar', length: 96, nullable: true }) paymentTxRef:
    string | null;
  @Column({ type: 'timestamptz', nullable: true }) paidAt: Date | null;
  @Column({ type: 'text', nullable: true }) reviewNote: string | null;
  @Column({ type: 'uuid', nullable: true }) reviewedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) reviewedAt: Date | null;

  // --- delivery counters (reporting) ---
  /** Sessions started (creative shown). */
  @Column({ type: 'int', default: 0 }) impressions: number;
  /** CTA taps recorded via POST sessions/:id/click. */
  @Column({ type: 'int', default: 0 }) ctaClicks: number;

  @Column({ type: 'uuid', nullable: true }) createdBy: string | null;
  @Column({ type: 'uuid', nullable: true }) updatedBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('rider_ad_profiles')
@Index(['riderId'], { unique: true })
export class RiderAdProfile {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) riderId: string;
  @Column({ length: 16 }) ageBand: string;
  @Column({ length: 32 }) workCategory: string;
  /** Broad, self-declared interests used only for sponsor matching. */
  @Column({ type: 'varchar', array: true, default: '{}' }) interests: string[];
  /** Sub-city / area the rider mostly travels in (optional, coarse). */
  @Column({ type: 'varchar', length: 48, nullable: true }) area: string | null;
  @Column({ default: false }) consented: boolean;
  @Column({ length: 32, nullable: true }) consentVersion: string | null;
  @Column({ type: 'timestamptz', nullable: true }) consentedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) withdrawnAt: Date | null;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

@Entity('ad_view_sessions')
@Index(['tokenHash'], { unique: true })
@Index(['riderId', 'state'])
export class AdViewSession {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) riderId: string;
  @Column({ type: 'uuid' }) rideId: string;
  @Column({ type: 'uuid' }) campaignId: string;
  @Column({ length: 128 }) tokenHash: string;
  @Column({ type: 'enum', enum: ViewState, default: ViewState.STARTED })
  state: ViewState;
  @Column({ type: 'int' }) requiredViewSeconds: number;
  @Column({ type: 'int', default: 0 }) verifiedSeconds: number;
  @Column({ type: 'int', default: 0 }) lastSequence: number;
  @Column({ type: 'timestamptz' }) expiresAt: Date;
  @Column({ type: 'timestamptz' }) lastHeartbeatAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) completedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) ctaClickedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

@Entity('ad_reward_events')
@Index(['riderId', 'campaignId'], { unique: true })
@Index(['sessionId'], { unique: true })
export class AdRewardEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) riderId: string;
  @Column({ type: 'uuid' }) rideId: string;
  @Column({ type: 'uuid' }) campaignId: string;
  @Column({ type: 'uuid' }) sessionId: string;
  @Column({ type: 'int' }) rewardMinor: number;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

@Entity('ride_ad_settlements')
@Index(['rideId'], { unique: true })
export class RideAdSettlement {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) rideId: string;
  @Column({ type: 'uuid' }) driverId: string;
  @Column({ type: 'int' }) grossFareMinor: number;
  @Column({ type: 'int', default: 0 }) appliedDiscountMinor: number;
  @Column({ type: 'int' }) riderCashDueMinor: number;
  @Column({ type: 'int', default: 0 }) driverHebirCreditMinor: number;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

@Entity('driver_wallet_entries')
@Index(['rideId'], { unique: true, where: '"rideId" IS NOT NULL' })
export class DriverWalletEntry {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) driverId: string;
  @Column({ type: 'uuid', nullable: true }) rideId: string | null;
  @Column({ type: 'uuid', nullable: true }) cashoutId: string | null;
  @Column({ type: 'int' }) amountMinor: number;
  @Column({ length: 24 }) type: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

@Entity('driver_cashout_requests')
export class DriverCashoutRequest {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) driverId: string;
  @Column({ type: 'int' }) amountMinor: number;
  @Column({ type: 'enum', enum: CashoutState, default: CashoutState.REQUESTED })
  state: CashoutState;
  @Column({ length: 128, nullable: true }) paymentReference: string | null;
  @Column({ type: 'uuid', nullable: true }) reviewedBy: string | null;
  @Column({ type: 'text', nullable: true }) reviewNote: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
