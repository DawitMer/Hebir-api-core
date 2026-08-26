import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum TipStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

/** Rider-to-driver tip, always tied to a completed ride. Tips go 100% to the driver. */
@Entity('tips')
export class Tip {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  rideId: string;

  @Column({ type: 'uuid' })
  riderId: string;

  /** Always derived server-side from ride.driverId — never trust the client. */
  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: string;

  @Column({ type: 'uuid', nullable: true })
  paymentId: string | null;

  @Column({ type: 'enum', enum: TipStatus, default: TipStatus.PENDING })
  status: TipStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
