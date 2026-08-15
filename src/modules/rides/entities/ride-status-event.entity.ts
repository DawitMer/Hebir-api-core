import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { RideStatus } from './ride.entity';

/**
 * Immutable audit trail of every status transition a ride goes through.
 * Written alongside every state change in RidesService — never mutated.
 */
@Entity('ride_status_events')
@Index(['rideId'])
export class RideStatusEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  rideId: string;

  @Column({ type: 'enum', enum: RideStatus })
  status: RideStatus;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  changedAt: Date;

  @Column({ nullable: true })
  note: string | null;
}
