import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum KycReviewSenderRole {
  ADMIN = 'admin',
  DRIVER = 'driver',
}

@Entity('kyc_review_messages')
@Index('IDX_kyc_review_messages_verification_created', [
  'verificationId',
  'createdAt',
])
export class KycReviewMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  verificationId: string;

  @Column({ type: 'uuid' })
  senderId: string;

  @Column({ type: 'varchar', length: 20 })
  senderRole: KycReviewSenderRole;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  clientMessageId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
