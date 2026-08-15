import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DriverSubscription } from '../../subscription/entities/driver-subscription.entity';

export enum UserRole {
  RIDER = 'rider',
  DRIVER = 'driver',
  ADMIN = 'admin',
  GOV_OFFICER = 'gov_officer',
}

export enum AccountStanding {
  GOOD = 'good',
  FLAGGED = 'flagged',
  BANNED = 'banned',
}

@Entity('user_accounts')
export class UserAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column()
  phoneNumber: string;

  @Column({ nullable: true })
  fullName: string;

  @Index({ unique: true })
  @Column({ nullable: true })
  username: string | null;

  /**
   * Ethiopian Tax Identification Number (drivers). Nullable until KYC collects it.
   * Indexed for portal lookup at fleet scale (~100k).
   */
  @Index({ unique: true, where: '"tin" IS NOT NULL' })
  @Column({ type: 'varchar', length: 32, nullable: true })
  tin: string | null;

  /** Null for phone+OTP rider/driver accounts. Staff (admin/gov) keep a hash. */
  @Column({ nullable: true, select: false })
  passwordHash: string | null;

  @Column({ type: 'enum', enum: UserRole, array: true, default: [UserRole.RIDER] })
  roles: UserRole[];

  @Column({ type: 'enum', enum: AccountStanding, default: AccountStanding.GOOD })
  standing: AccountStanding;

  /** Rider/driver saved places (home/work/other) — persisted for Neon sync. */
  @Column({ type: 'jsonb', nullable: true })
  savedPlaces: Array<Record<string, unknown>> | null;

  @OneToOne(() => DriverSubscription, (subscription) => subscription.driver)
  subscription?: DriverSubscription;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
