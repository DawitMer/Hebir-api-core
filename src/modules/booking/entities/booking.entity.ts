import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum BookingStatus {
  HELD = 'held',
  CONFIRMED = 'confirmed',
  DECLINED = 'declined',
  EXPIRED = 'expired',
}

@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tripId: string;

  @Column({ type: 'uuid' })
  riderRequestId: string;

  @Column({ type: 'int' })
  seats: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  agreedPricePerSeat: string;

  /**
   * Fare calculated by the fare module (distance + time + surge).
   * Displayed to rider/driver; settlement is cash/bank transfer for now
   * (payment gateway integration is a future feature).
   */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  calculatedFare: string;

  @Column({ type: 'enum', enum: BookingStatus, default: BookingStatus.HELD })
  status: BookingStatus;

  @Column({ type: 'timestamptz' })
  holdExpiresAt: Date;

  @Column({ default: false })
  driverConfirmed: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
