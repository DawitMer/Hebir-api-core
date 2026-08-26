import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SubscriptionState } from './driver-subscription.entity';

@Entity('subscription_status_history')
export class SubscriptionStatusHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'enum', enum: SubscriptionState })
  fromState: SubscriptionState;

  @Column({ type: 'enum', enum: SubscriptionState })
  toState: SubscriptionState;

  @Column()
  cause: string;

  @Column({ type: 'uuid', nullable: true })
  paymentEventId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt: Date;
}
