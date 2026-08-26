import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum VerificationStatus {
  PENDING = 'pending',
  IN_REVIEW = 'in_review',
  ESCALATED = 'escalated',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@Entity('driver_verifications')
export class DriverVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @Column()
  licenseNumber: string;

  @Column()
  region: string;

  @Column()
  vehicleType: string;

  @Column({ type: 'int' })
  vehicleYear: number;

  @Column({
    type: 'enum',
    enum: VerificationStatus,
    default: VerificationStatus.PENDING,
  })
  status: VerificationStatus;

  @Column({ type: 'uuid', nullable: true })
  assignedToId: string | null;

  @Column({ default: false })
  missingId: boolean;

  @Column({ default: false })
  missingInsurance: boolean;

  @Column({ nullable: true })
  escalationReason: string | null;

  @Column({ type: 'uuid', nullable: true })
  escalatedToId: string | null;

  @Column({ nullable: true })
  rejectionReason: string | null;

  /** True while a replacement car is waiting on ops — current vehicle stays live. */
  @Column({ default: false })
  vehicleChangePending: boolean;

  @Column({ nullable: true })
  pendingVehicleMake: string | null;

  @Column({ nullable: true })
  pendingVehicleModel: string | null;

  @Column({ nullable: true })
  pendingVehiclePlate: string | null;

  @Column({ nullable: true })
  pendingVehicleColor: string | null;

  @Column({ type: 'int', nullable: true })
  pendingVehicleYear: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  submittedAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
