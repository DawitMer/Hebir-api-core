import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserAccount } from '../../auth/entities/user-account.entity';

export enum MonthlyExpenseStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  UNDER_REVIEW = 'under_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CHANGES_REQUIRED = 'changes_required',
}

@Entity('driver_monthly_expense_reports')
@Index('IDX_monthly_expense_driver_month', ['driverId', 'reportingMonth'], {
  unique: true,
})
export class DriverMonthlyExpenseReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @ManyToOne(() => UserAccount, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'driverId' })
  driver?: UserAccount;

  /** Format: YYYY-MM (e.g. '2026-08') */
  @Column({ type: 'varchar', length: 7 })
  @Index('IDX_monthly_expense_month')
  reportingMonth: string;

  @Column({
    type: 'varchar',
    length: 32,
    default: MonthlyExpenseStatus.SUBMITTED,
  })
  @Index('IDX_monthly_expense_status')
  status: MonthlyExpenseStatus;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: '0.00' })
  fuelAmount: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: '0.00' })
  maintenanceAmount: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: '0.00' })
  insuranceAmount: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: '0.00' })
  tollsAmount: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: '0.00' })
  otherAmount: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: '0.00' })
  totalAmount: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'text', array: true, nullable: true })
  supportingDocUrls: string[] | null;

  @Column({ type: 'uuid', nullable: true })
  reviewerId: string | null;

  @ManyToOne(() => UserAccount, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewerId' })
  reviewer?: UserAccount | null;

  @Column({ type: 'text', nullable: true })
  reviewerNotes: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
