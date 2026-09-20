import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GovLegalRequest } from './gov-legal-request.entity';

@Entity('gov_legal_request_events')
@Index('IDX_gov_legal_request_events_request', ['requestId', 'occurredAt'])
export class GovLegalRequestEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  requestId: string;

  @ManyToOne(() => GovLegalRequest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requestId' })
  request?: GovLegalRequest;

  @Column({ type: 'uuid' })
  actorId: string;

  @Column({ type: 'varchar', length: 64 })
  action: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'occurredAt' })
  occurredAt: Date;
}
