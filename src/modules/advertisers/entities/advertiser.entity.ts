import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum AdvertiserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

/** A business that buys sponsored views. Separate from rider/driver accounts. */
@Entity('advertisers')
export class Advertiser {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ length: 160 }) email: string;
  @Column({ length: 120 }) companyName: string;
  @Column({ length: 120 }) contactName: string;
  @Column({ type: 'varchar', length: 20, nullable: true }) phone: string | null;
  /** Ethiopian Tax Identification Number, for receipts. */
  @Column({ type: 'varchar', length: 20, nullable: true }) tinNumber:
    string | null;
  @Column({ type: 'varchar', length: 2048, nullable: true }) website:
    string | null;
  @Column({ length: 100 }) passwordHash: string;
  @Column({
    type: 'enum',
    enum: AdvertiserStatus,
    default: AdvertiserStatus.ACTIVE,
  })
  status: AdvertiserStatus;
  @Column({ type: 'timestamptz', nullable: true }) lastLoginAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

export enum AdvertiserPaymentStatus {
  INITIALIZED = 'initialized',
  PAID = 'paid',
  FAILED = 'failed',
}

/** One Chapa checkout for one campaign budget purchase. */
@Entity('advertiser_payments')
@Index(['campaignId'])
export class AdvertiserPayment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) advertiserId: string;
  @Column({ type: 'uuid' }) campaignId: string;
  @Index({ unique: true }) @Column({ length: 96 }) txRef: string;
  @Column({ type: 'int' }) views: number;
  @Column({ type: 'bigint' }) amountMinor: string;
  @Column({ length: 16, default: 'chapa' }) provider: string;
  @Column({
    type: 'enum',
    enum: AdvertiserPaymentStatus,
    default: AdvertiserPaymentStatus.INITIALIZED,
  })
  status: AdvertiserPaymentStatus;
  @Column({ type: 'jsonb', nullable: true }) providerPayload: Record<
    string,
    unknown
  > | null;
  @Column({ type: 'timestamptz', nullable: true }) paidAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
