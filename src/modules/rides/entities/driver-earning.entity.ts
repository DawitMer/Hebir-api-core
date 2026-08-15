import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum EarningSourceType {
  RIDE = 'ride',
  TIP = 'tip',
}

export enum PayoutStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
}

/** One row per amount owed to a driver — from a completed ride or a tip. */
@Entity('driver_earnings')
export class DriverEarning {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'enum', enum: EarningSourceType })
  sourceType: EarningSourceType;

  /** id of the ride or tip that produced this earning. */
  @Column({ type: 'uuid' })
  sourceId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: string;

  @Column({ type: 'enum', enum: PayoutStatus, default: PayoutStatus.PENDING })
  payoutStatus: PayoutStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
