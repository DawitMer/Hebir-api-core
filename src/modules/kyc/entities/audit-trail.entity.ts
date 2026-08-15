import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Every admin/gov action that changes state is recorded here so a
 * dispute (billing, KYC decision, compliance) can be settled from the
 * record (mirrors blueprint 5.4's "status change with its cause").
 */
@Entity('audit_trails')
export class AuditTrail {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  actorId: string;

  @Column()
  actorRole: string;

  @Column()
  action: string;

  @Column()
  targetType: string;

  @Column()
  targetId: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt: Date;
}
