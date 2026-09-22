import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GeoPoint } from '../../matching/entities/trip.entity';
import type { FareRates } from '../../fare/fare-rates';

export enum RideStatus {
  REQUESTED = 'requested',
  SEARCHING = 'searching',
  OFFERED = 'offered',
  MATCHED = 'matched',
  ACCEPTED = 'accepted',
  ARRIVING = 'arriving',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  UNMATCHED = 'unmatched',
}

/** How the completion fare was chosen. Null on incomplete rides. */
export enum RideSettlementStatus {
  METERED = 'metered',
  ESTIMATED = 'estimated',
}

/**
 * On-demand ride (blueprint "Phase 0" on-demand rides module).
 * A ride is created immediately as `searching` and progresses through the
 * dispatch queue (DispatchQueueService) toward `matched`/`accepted`,
 * or `unmatched` if no driver is found within the dispatch window.
 */
@Entity('rides')
@Index(['status'])
export class Ride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  riderId: string;

  @Column({ type: 'uuid', nullable: true })
  driverId: string | null;

  @Column({ type: 'enum', enum: RideStatus, default: RideStatus.REQUESTED })
  status: RideStatus;

  @Column({ type: 'jsonb' })
  pickup: GeoPoint;

  @Column({ type: 'jsonb' })
  dropoff: GeoPoint;

  /**
   * Ordered intermediate stops between pickup and dropoff.
   * Empty/null = direct trip. Each entry: { lat, lng, address?, sequence }.
   */
  @Column({ type: 'jsonb', nullable: true })
  waypoints: Array<{
    lat: number;
    lng: number;
    address?: string | null;
    sequence: number;
  }> | null;

  @Column({ nullable: true })
  pickupAddress: string | null;

  @Column({ nullable: true })
  dropoffAddress: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  requestedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  matchedAt: Date | null;

  /** Driver marked arrived at pickup (wait clock starts here). */
  @Column({ type: 'timestamptz', nullable: true })
  arrivedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  distanceM: number | null;

  @Column({ type: 'int', nullable: true })
  durationS: number | null;

  @Column({ nullable: true, default: 'any' })
  vehicleType: string | null;

  /**
   * Surge locked at request time so rider quote, driver offer, and final
   * charge all use the same multiplier for this ride.
   */
  @Column({ type: 'double precision', nullable: true })
  quotedSurgeMultiplier: number | null;

  /** Fare policy snapshot; later operations edits cannot reprice an active trip. */
  @Column({ type: 'jsonb', nullable: true })
  quotedFareRates: FareRates | null;

  /** Driver currently holding the live offer (cleared once resolved). */
  @Column({ type: 'uuid', nullable: true })
  offerDriverId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  offerExpiresAt: Date | null;

  /**
   * Street-hail PIN gate. Postgres is the source of truth so a Redis flush
   * cannot let the driver skip the rider code. Redis only caches plaintext
   * for the rider UI.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  startCodeHash: string | null;

  @Column({ type: 'int', default: 0 })
  startCodeAttempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  startCodeExpiresAt: Date | null;

  @Column({ type: 'int', nullable: true })
  actualDistanceM: number | null;

  @Column({ type: 'int', nullable: true })
  actualDurationS: number | null;

  @Column({ type: 'jsonb', nullable: true })
  actualRoute: GeoPoint[] | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  fare: string | null;

  @Column({ type: 'jsonb', nullable: true })
  fareBreakdown: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  pricingVersion: string | null;

  /** FK to pricing_versions — durable link for audit after rates change. */
  @Column({ type: 'uuid', nullable: true })
  pricingVersionId: string | null;

  /** `metered` when GNSS was continuous; `estimated` when quote-capped. */
  @Column({
    type: 'enum',
    enum: RideSettlementStatus,
    enumName: 'rides_settlement_status_enum',
    nullable: true,
  })
  settlementStatus: RideSettlementStatus | null;

  /** Ops incident case opened for estimated settlements. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  settlementReviewCaseNumber: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  cancellationType: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  cancellationReason: string | null;

  @Column({ type: 'uuid', nullable: true })
  cancelledBy: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  cancelledByRole: string | null;

  @Column({ type: 'text', nullable: true })
  adminNotes: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
