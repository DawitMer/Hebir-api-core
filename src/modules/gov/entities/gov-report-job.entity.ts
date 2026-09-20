import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum GovReportJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

@Entity('gov_report_jobs')
export class GovReportJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('IDX_gov_report_jobs_officer')
  requestedByOfficerId: string;

  @Column({ type: 'uuid' })
  @Index('IDX_gov_report_jobs_driver')
  driverId: string;

  @Column({ type: 'varchar', length: 32 })
  tin: string;

  @Column({ type: 'int' })
  fiscalYear: number;

  @Column({ type: 'varchar', length: 16, default: 'CSV' })
  format: string;

  @Column({
    type: 'enum',
    enum: GovReportJobStatus,
    default: GovReportJobStatus.QUEUED,
  })
  @Index('IDX_gov_report_jobs_status')
  status: GovReportJobStatus;

  @Column({ type: 'jsonb', default: {} })
  parameters: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  resultCsv: string | null;

  @Column({ type: 'int', default: 0 })
  rowCount: number;

  @Column({ type: 'varchar', length: 32, nullable: true })
  grossTotal: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  netTaxableTotal: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'uuid', nullable: true })
  legalRequestId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
