import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum SupportThreadStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

@Entity('support_threads')
@Index('IDX_support_threads_user_status', ['userId', 'status'])
@Index('IDX_support_threads_last_message', ['lastMessageAt'])
export class SupportThread {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  /** rider | driver — so agents know which app the person is on. */
  @Column({ type: 'varchar', length: 20 })
  userRole: string;

  @Column({ type: 'varchar', length: 20, default: SupportThreadStatus.OPEN })
  status: SupportThreadStatus;

  @Column({ type: 'uuid', nullable: true })
  assignedAgentId: string | null;

  @Column({ type: 'timestamptz' })
  lastMessageAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
