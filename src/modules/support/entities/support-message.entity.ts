import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum SupportSenderRole {
  USER = 'user',
  AGENT = 'agent',
  SYSTEM = 'system',
}

@Entity('support_messages')
@Index('IDX_support_messages_thread_created', ['threadId', 'createdAt'])
export class SupportMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  threadId: string;

  @Column({ type: 'uuid' })
  senderId: string;

  @Column({ type: 'varchar', length: 20 })
  senderRole: SupportSenderRole;

  /** Frozen at send time so later name changes still show who spoke. */
  @Column({ type: 'varchar', length: 120 })
  senderName: string;

  @Column({ type: 'varchar', length: 2000 })
  body: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
