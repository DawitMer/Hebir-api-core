import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('driver_expenses')
export class DriverExpense {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @Column()
  category: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: string;

  @Column({ nullable: true })
  description: string | null;

  @Column({ type: 'timestamptz' })
  incurredAt: Date;

  /** Gov officer review: pending | verified | flagged | rejected. Null = pending. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  reviewStatus: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  submittedAt: Date;
}
