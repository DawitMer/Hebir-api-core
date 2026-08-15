import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Post-ride star rating. `ratedUser` is derived server-side from the ride's counterpart. */
@Entity('ratings')
@Index(['rideId', 'ratedBy'], { unique: true })
export class Rating {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  rideId: string;

  @Column({ type: 'uuid' })
  ratedBy: string;

  @Column({ type: 'uuid' })
  ratedUser: string;

  @Column({ type: 'int' })
  stars: number;

  @Column({ nullable: true })
  comment: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
