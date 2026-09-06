import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('ride_messages')
@Index('IDX_ride_messages_ride_created', ['rideId', 'createdAt'])
@Index('UQ_ride_messages_client', ['rideId', 'senderId', 'clientMessageId'], {
  unique: true,
})
export class RideMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  rideId: string;

  @Column({ type: 'uuid' })
  senderId: string;

  @Column({ type: 'uuid', nullable: true })
  receiverId: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  senderType: string | null;

  @Column({ type: 'uuid', nullable: true })
  clientMessageId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @Column({ type: 'varchar', length: 1000 })
  body: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
