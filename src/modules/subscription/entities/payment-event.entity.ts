import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum PaymentProvider {
  CHAPA = 'chapa',
  TELEBIRR = 'telebirr',
  PAYSTACK = 'paystack',
}

@Entity('payment_events')
export class PaymentEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: PaymentProvider })
  provider: PaymentProvider;

  /**
   * Unique reference from the provider. This is the field that makes
   * duplicate webhook deliveries harmless (see blueprint 5.2 step 3).
   */
  @Index({ unique: true })
  @Column()
  providerReference: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: string;

  @Column({ type: 'jsonb' })
  rawPayload: Record<string, unknown>;

  @Column({ default: false })
  processed: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date;
}
