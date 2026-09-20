import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum GovLegalRequestType {
  SUBPOENA = 'subpoena',
  WARRANT = 'warrant',
  COURT_ORDER = 'court_order',
  EMERGENCY = 'emergency',
}

export enum GovLegalRequestPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}

export enum GovLegalRequestStatus {
  RECEIVED = 'received',
  IN_REVIEW = 'in_review',
  FULFILLED = 'fulfilled',
  REJECTED = 'rejected',
  WITHDRAWN = 'withdrawn',
}

@Entity('gov_legal_requests')
export class GovLegalRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: GovLegalRequestType })
  type: GovLegalRequestType;

  @Column({ type: 'varchar', length: 240 })
  title: string;

  @Column({ type: 'varchar', length: 240 })
  requestingAuthority: string;

  @Column({ type: 'varchar', length: 120 })
  caseReference: string;

  @Column({ type: 'uuid', nullable: true })
  @Index('IDX_gov_legal_requests_driver')
  driverId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  driverTin: string | null;

  @Column({ type: 'varchar', array: true, default: '{}' })
  dataScope: string[];

  @Column({
    type: 'enum',
    enum: GovLegalRequestPriority,
    default: GovLegalRequestPriority.MEDIUM,
  })
  @Index('IDX_gov_legal_requests_priority')
  priority: GovLegalRequestPriority;

  @Column({
    type: 'enum',
    enum: GovLegalRequestStatus,
    default: GovLegalRequestStatus.RECEIVED,
  })
  @Index('IDX_gov_legal_requests_status')
  status: GovLegalRequestStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  receivedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deadlineAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  assignedOfficerId: string | null;

  @Column({ type: 'uuid' })
  createdByOfficerId: string;

  @Column({ type: 'text', nullable: true })
  fulfilmentNotes: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
