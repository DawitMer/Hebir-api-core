import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export interface GeoPoint {
  lat: number;
  lng: number;
}

@Entity('trips')
@Index(['inMatchingPool'])
export class Trip {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'jsonb' })
  startPoint: GeoPoint;

  @Column({ type: 'jsonb' })
  destination: GeoPoint;

  /**
   * Full planned route as an ordered path, not just the two endpoints.
   * Stored as GeoJSON LineString coordinates; a PostGIS geography column
   * (`route_geom`) is added via migration for spatial corridor queries.
   */
  @Column({ type: 'jsonb' })
  routePath: GeoPoint[];

  @Column({ type: 'timestamptz' })
  departureTime: Date;

  @Column({ type: 'int' })
  totalSeats: number;

  @Column({ type: 'int' })
  remainingSeats: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  pricePerSeat: string;

  @Column({ default: true })
  inMatchingPool: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
