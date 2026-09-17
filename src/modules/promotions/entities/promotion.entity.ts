import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';

@Entity('promotions')
export class Promotion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  code: string;

  @Column()
  description: string;

  @Column({ type: 'int' })
  discountMinor: number;

  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz' })
  endsAt: Date;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'int', default: 1 })
  maxUsagePerUser: number;

  /** Null means no campaign-wide cap. */
  @Column({ type: 'int', nullable: true })
  maxTotalUsage: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

export enum PromotionClaimStatus {
  ACTIVE = 'active',
  USED = 'used',
  EXPIRED = 'expired',
}

@Entity('promotion_claims')
@Index(['riderId', 'promotionId'], {
  unique: true,
  where: `"status" = 'active'`,
})
export class PromotionClaim {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  riderId: string;

  @Column('uuid')
  promotionId: string;

  @ManyToOne(() => Promotion)
  @JoinColumn({ name: 'promotionId' })
  promotion: Promotion;

  @Column({
    type: 'enum',
    enum: PromotionClaimStatus,
    default: PromotionClaimStatus.ACTIVE,
  })
  status: PromotionClaimStatus;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  claimedAt: Date;

  @Column('uuid', { nullable: true })
  rideId: string | null;

  @Column({ type: 'int', nullable: true })
  discountAppliedMinor: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
