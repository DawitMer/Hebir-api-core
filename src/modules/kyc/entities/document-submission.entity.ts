import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum DocumentCategory {
  DRIVER = 'driver',
  VEHICLE = 'vehicle',
}

export enum DocumentReviewStatus {
  QUEUED = 'queued',
  UNDER_REVIEW = 'under_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  RESUBMISSION_REQUESTED = 'resubmission_requested',
}

@Entity('document_submissions')
export class DocumentSubmission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  driverVerificationId: string;

  @Column()
  documentType: string;

  @Column({ type: 'enum', enum: DocumentCategory })
  category: DocumentCategory;

  /** S3 object key; the file itself never passes through this service. */
  @Column()
  storageKey: string;

  @Column({
    type: 'enum',
    enum: DocumentReviewStatus,
    default: DocumentReviewStatus.QUEUED,
  })
  status: DocumentReviewStatus;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** Set when ops approves this file. Drivers cannot change it afterwards. */
  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  submittedAt: Date;
}
