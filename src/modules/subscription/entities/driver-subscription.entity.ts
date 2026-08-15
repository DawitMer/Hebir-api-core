import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserAccount } from '../../auth/entities/user-account.entity';

export enum SubscriptionState {
  INACTIVE = 'inactive',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  SUSPENDED = 'suspended',
}

@Entity('driver_subscriptions')
export class DriverSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToOne(() => UserAccount, { onDelete: 'CASCADE' })
  @JoinColumn()
  driver: UserAccount;

  @Index('UQ_driver_subscriptions_driverId', { unique: true })
  @Column()
  driverId: string;

  @Column({ type: 'enum', enum: SubscriptionState, default: SubscriptionState.INACTIVE })
  state: SubscriptionState;

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  gracePeriodEndsAt: Date | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  lastAmountPaid: string | null;

  @Column({ nullable: true })
  lastPaymentReference: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
