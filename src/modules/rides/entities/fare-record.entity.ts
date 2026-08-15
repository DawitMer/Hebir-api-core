import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Immutable fare snapshot for a completed ride. `platformFee` is always
 * `'0'` for the current business model (blueprint: platform_fee on rides
 * is zero; the driver keeps the full fare plus any tips).
 */
@Entity('fares')
export class FareRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  rideId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  baseFare: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  distanceFare: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  timeFare: string;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 1 })
  surgeMultiplier: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  platformFee: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  total: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
