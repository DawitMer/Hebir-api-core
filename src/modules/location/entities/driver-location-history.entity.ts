import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Historical GPS samples. Live pings go to Redis GEOADD via location-svc;
 * api-core periodically flushes a thinned copy here for audits / disputes.
 */
@Entity('driver_location_history')
@Index(['driverId', 'recordedAt'])
export class DriverLocationHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'float' })
  lat: number;

  @Column({ type: 'float' })
  lng: number;

  @Column({ type: 'float', nullable: true })
  heading: number | null;

  @Column({ type: 'float', nullable: true })
  speed: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  recordedAt: Date;
}
