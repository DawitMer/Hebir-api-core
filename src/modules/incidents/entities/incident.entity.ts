import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum IncidentType {
  SOS = 'sos',
  SAFETY_ALERT = 'safetyAlert',
  RIDE_DISPUTE = 'rideDispute',
  PAYMENT_FAILURE = 'paymentFailure',
  DRIVER_OFFLINE = 'driverOffline',
  SURGE_ISSUE = 'surgeIssue',
  OTHER = 'other',
}

export enum IncidentPriority {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

export enum IncidentStatus {
  OPEN = 'open',
  ASSIGNED = 'assigned',
  RESOLVED = 'resolved',
}

@Entity('incidents')
export class Incident {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column()
  caseNumber: string;

  @Column({ type: 'enum', enum: IncidentType })
  type: IncidentType;

  @Column()
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({
    type: 'enum',
    enum: IncidentPriority,
    default: IncidentPriority.MEDIUM,
  })
  priority: IncidentPriority;

  @Column({ type: 'enum', enum: IncidentStatus, default: IncidentStatus.OPEN })
  status: IncidentStatus;

  /** User who triggered SOS / filed the report. */
  @Column({ type: 'uuid' })
  reporterId: string;

  @Column()
  reporterRole: string;

  @Column({ type: 'uuid', nullable: true })
  rideId: string | null;

  @Column({ type: 'uuid', nullable: true })
  relatedUserId: string | null;

  @Column({ nullable: true })
  relatedName: string | null;

  @Column({ type: 'float', nullable: true })
  lat: number | null;

  @Column({ type: 'float', nullable: true })
  lng: number | null;

  @Column({ nullable: true })
  locationLabel: string | null;

  @Column({ type: 'uuid', nullable: true })
  assignedToId: string | null;

  @Column({ nullable: true })
  assignedToName: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  assignedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  reportedAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
