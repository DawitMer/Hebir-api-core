import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * Every column that points at a uuid primary key was created as
 * `character varying` (entities declared a bare `@Column()`), so joins such as
 * `rides.id = ride_status_events."rideId"` needed an explicit cast and could
 * never use an index on both sides. This retypes them to `uuid`.
 *
 * Deliberately left as `character varying`:
 *   - driver_profiles."connectedAccountId", payments."connectedAccountId"
 *     (external payment-processor account ids, not uuids)
 *   - audit_trails."targetId", gov_access_logs."resourceId"
 *     (polymorphic audit targets that may reference non-uuid keys)
 */
const UUID_COLUMNS: Array<[table: string, column: string]> = [
  ['bookings', 'riderRequestId'],
  ['bookings', 'tripId'],
  ['compliance_alerts', 'driverId'],
  ['document_submissions', 'driverVerificationId'],
  ['driver_earnings', 'driverId'],
  ['driver_earnings', 'sourceId'],
  ['driver_expenses', 'driverId'],
  ['driver_location_history', 'driverId'],
  ['driver_profiles', 'userId'],
  ['driver_verifications', 'driverId'],
  ['driver_verifications', 'assignedToId'],
  ['driver_verifications', 'escalatedToId'],
  ['fares', 'rideId'],
  ['gov_access_logs', 'officerId'],
  ['incidents', 'reporterId'],
  ['incidents', 'assignedToId'],
  ['incidents', 'relatedUserId'],
  ['incidents', 'rideId'],
  ['payment_events', 'driverId'],
  ['payments', 'userId'],
  ['payments', 'rideId'],
  ['ratings', 'rideId'],
  ['ratings', 'ratedBy'],
  ['ratings', 'ratedUser'],
  ['ride_status_events', 'rideId'],
  ['rider_requests', 'riderId'],
  ['rides', 'riderId'],
  ['rides', 'driverId'],
  ['rides', 'offerDriverId'],
  ['subscription_status_history', 'driverId'],
  ['subscription_status_history', 'paymentEventId'],
  ['tips', 'rideId'],
  ['tips', 'riderId'],
  ['tips', 'driverId'],
  ['tips', 'paymentId'],
  ['trips', 'driverId'],
  ['vehicles', 'driverId'],
];

export class UuidForeignKeyColumns1786365000000 implements MigrationInterface {
  name = 'UuidForeignKeyColumns1786365000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    for (const [table, column] of UUID_COLUMNS) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ALTER COLUMN "${column}" TYPE uuid
        USING NULLIF("${column}", '')::uuid
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of [...UUID_COLUMNS].reverse()) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ALTER COLUMN "${column}" TYPE character varying
        USING "${column}"::text
      `);
    }
  }
}
