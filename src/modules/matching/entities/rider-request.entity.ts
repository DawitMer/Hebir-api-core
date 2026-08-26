import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GeoPoint } from './trip.entity';

export enum RiderRequestStatus {
  QUEUED = 'queued',
  MATCHED = 'matched',
  CANCELLED = 'cancelled',
}

@Entity('rider_requests')
export class RiderRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  riderId: string;

  @Column({ type: 'jsonb' })
  pickup: GeoPoint;

  @Column({ type: 'jsonb' })
  dropoff: GeoPoint;

  @Column({ type: 'timestamptz' })
  earliestDeparture: Date;

  @Column({ type: 'timestamptz' })
  latestDeparture: Date;

  @Column({ type: 'int' })
  seatsNeeded: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  priceCeiling: string;

  @Column({
    type: 'enum',
    enum: RiderRequestStatus,
    default: RiderRequestStatus.QUEUED,
  })
  status: RiderRequestStatus;

  /**
   * The moment the request joined the queue. Preserved across declines
   * so a rider never loses their place (blueprint 7.3).
   */
  @CreateDateColumn({ type: 'timestamptz' })
  queuedAt: Date;
}
