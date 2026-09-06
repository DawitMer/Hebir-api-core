import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { TripGpsPoint } from '../trip-route-recorder.service';

/** Authoritative metering checkpoint; Redis is only a disposable mirror. */
@Entity('ride_route_checkpoints')
export class RideRouteCheckpoint {
  @PrimaryColumn('uuid')
  rideId: string;

  @Column({ type: 'int', default: 0 })
  totalDistanceM: number;

  @Column({ type: 'jsonb' })
  lastFix: TripGpsPoint;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  points: TripGpsPoint[];

  @Column({ default: false })
  hasGaps: boolean;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
