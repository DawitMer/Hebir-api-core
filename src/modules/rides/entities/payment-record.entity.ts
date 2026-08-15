import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PaymentType {
  SUBSCRIPTION = 'subscription',
  FARE = 'fare',
  TIP = 'tip',
}

export enum PaymentStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

/**
 * PaymentIntent-like record for the Ethiopia-first Direct Charge pattern
 * (Chapa/Telebirr/Paystack). `applicationFeeAmount` is always `'0'` for
 * rides/tips under the current business model — the platform makes money
 * from the monthly driver subscription, not from a per-ride cut. No
 * Stripe SDK is required; `connectedAccountId`/`providerReference` are
 * generic enough to slot in any of the three processors later.
 */
@Entity('payments')
export class PaymentRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid', nullable: true })
  rideId: string | null;

  @Column({ type: 'enum', enum: PaymentType })
  type: PaymentType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: string;

  @Column({ nullable: true })
  providerReference: string | null;

  @Index({ unique: true })
  @Column()
  idempotencyKey: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  /** Driver's payout account for direct-charge providers, when applicable. */
  @Column({ nullable: true })
  connectedAccountId: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  applicationFeeAmount: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
