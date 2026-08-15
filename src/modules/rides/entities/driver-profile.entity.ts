import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum DriverStatus {
  OFFLINE = 'offline',
  ONLINE = 'online',
  ON_TRIP = 'on_trip',
  /** Held by the dispatch loop while an offer is pending (see RidesService). */
  RESERVED = 'reserved',
}

/**
 * On-demand dispatch state for a driver. Separate from DriverSubscription
 * (billing) and UserAccount (identity) — this is purely "where is this
 * driver in the marketplace right now".
 */
@Entity('driver_profiles')
export class DriverProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: DriverStatus, default: DriverStatus.OFFLINE })
  status: DriverStatus;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 5 })
  ratingAvg: string;

  @Column({ type: 'int', default: 0 })
  totalTrips: number;

  /** Payout account for future processor integration (Chapa/Telebirr/Paystack). */
  @Column({ nullable: true })
  connectedAccountId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  idleSince: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
