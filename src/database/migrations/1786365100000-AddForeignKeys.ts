import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * The schema had exactly one foreign key (driver_subscriptions."driverId"),
 * so nothing stopped a ride from referencing a deleted rider or a fare from
 * outliving its ride. Delete rules encode intent:
 *
 *   CASCADE   — the row is meaningless without its parent (profile, history,
 *               status events, per-ride fare).
 *   RESTRICT  — financial or audit record that must never disappear silently
 *               (payments, earnings, access logs, the ride itself).
 *   SET NULL  — optional association (assignee, replacement token, the
 *               driver slot on a ride that was cancelled before pickup).
 */
type Fk = {
  table: string;
  column: string;
  refTable: string;
  refColumn?: string;
  onDelete: 'CASCADE' | 'RESTRICT' | 'SET NULL';
};

const FOREIGN_KEYS: Fk[] = [
  // Identity-owned rows.
  { table: 'driver_profiles', column: 'userId', refTable: 'user_accounts', onDelete: 'CASCADE' },
  { table: 'vehicles', column: 'driverId', refTable: 'user_accounts', onDelete: 'CASCADE' },
  { table: 'driver_location_history', column: 'driverId', refTable: 'user_accounts', onDelete: 'CASCADE' },
  { table: 'refresh_tokens', column: 'userId', refTable: 'user_accounts', onDelete: 'CASCADE' },
  { table: 'refresh_tokens', column: 'replacedById', refTable: 'refresh_tokens', onDelete: 'SET NULL' },

  // Rides and their per-ride children.
  { table: 'rides', column: 'riderId', refTable: 'user_accounts', onDelete: 'RESTRICT' },
  { table: 'rides', column: 'driverId', refTable: 'user_accounts', onDelete: 'SET NULL' },
  { table: 'rides', column: 'offerDriverId', refTable: 'user_accounts', onDelete: 'SET NULL' },
  { table: 'ride_status_events', column: 'rideId', refTable: 'rides', onDelete: 'CASCADE' },
  { table: 'fares', column: 'rideId', refTable: 'rides', onDelete: 'CASCADE' },
  { table: 'ratings', column: 'rideId', refTable: 'rides', onDelete: 'CASCADE' },
  { table: 'ratings', column: 'ratedBy', refTable: 'user_accounts', onDelete: 'CASCADE' },
  { table: 'ratings', column: 'ratedUser', refTable: 'user_accounts', onDelete: 'CASCADE' },

  // Money.
  { table: 'payments', column: 'userId', refTable: 'user_accounts', onDelete: 'RESTRICT' },
  { table: 'payments', column: 'rideId', refTable: 'rides', onDelete: 'SET NULL' },
  { table: 'driver_earnings', column: 'driverId', refTable: 'user_accounts', onDelete: 'RESTRICT' },
  { table: 'tips', column: 'rideId', refTable: 'rides', onDelete: 'CASCADE' },
  { table: 'tips', column: 'riderId', refTable: 'user_accounts', onDelete: 'RESTRICT' },
  { table: 'tips', column: 'driverId', refTable: 'user_accounts', onDelete: 'RESTRICT' },
  { table: 'tips', column: 'paymentId', refTable: 'payments', onDelete: 'SET NULL' },

  // Subscription lifecycle.
  { table: 'payment_events', column: 'driverId', refTable: 'user_accounts', onDelete: 'RESTRICT' },
  { table: 'subscription_status_history', column: 'driverId', refTable: 'user_accounts', onDelete: 'CASCADE' },
  { table: 'subscription_status_history', column: 'paymentEventId', refTable: 'payment_events', onDelete: 'SET NULL' },

  // KYC / compliance.
  { table: 'driver_verifications', column: 'driverId', refTable: 'user_accounts', onDelete: 'CASCADE' },
  { table: 'driver_verifications', column: 'assignedToId', refTable: 'user_accounts', onDelete: 'SET NULL' },
  { table: 'driver_verifications', column: 'escalatedToId', refTable: 'user_accounts', onDelete: 'SET NULL' },
  { table: 'document_submissions', column: 'driverVerificationId', refTable: 'driver_verifications', onDelete: 'CASCADE' },
  { table: 'compliance_alerts', column: 'driverId', refTable: 'user_accounts', onDelete: 'CASCADE' },
  { table: 'driver_expenses', column: 'driverId', refTable: 'user_accounts', onDelete: 'CASCADE' },
  { table: 'gov_access_logs', column: 'officerId', refTable: 'user_accounts', onDelete: 'RESTRICT' },
  { table: 'incidents', column: 'reporterId', refTable: 'user_accounts', onDelete: 'RESTRICT' },
  { table: 'incidents', column: 'assignedToId', refTable: 'user_accounts', onDelete: 'SET NULL' },
  { table: 'incidents', column: 'relatedUserId', refTable: 'user_accounts', onDelete: 'SET NULL' },
  { table: 'incidents', column: 'rideId', refTable: 'rides', onDelete: 'SET NULL' },

  // Share-ride matching pool.
  { table: 'trips', column: 'driverId', refTable: 'user_accounts', onDelete: 'CASCADE' },
  { table: 'rider_requests', column: 'riderId', refTable: 'user_accounts', onDelete: 'CASCADE' },
  { table: 'bookings', column: 'tripId', refTable: 'trips', onDelete: 'CASCADE' },
  { table: 'bookings', column: 'riderRequestId', refTable: 'rider_requests', onDelete: 'CASCADE' },
];

const fkName = (fk: Fk) => `FK_${fk.table}_${fk.column}`;

export class AddForeignKeys1786365100000 implements MigrationInterface {
  name = 'AddForeignKeys1786365100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    for (const fk of FOREIGN_KEYS) {
      // Orphans predate the constraint (synchronize-era data); drop them so
      // the constraint can be validated instead of failing the deploy.
      const nullable = await this.isNullable(queryRunner, fk);
      if (nullable) {
        await queryRunner.query(`
          UPDATE "${fk.table}" SET "${fk.column}" = NULL
          WHERE "${fk.column}" IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM "${fk.refTable}" r
              WHERE r."${fk.refColumn ?? 'id'}" = "${fk.table}"."${fk.column}"
            )
        `);
      } else {
        await queryRunner.query(`
          DELETE FROM "${fk.table}"
          WHERE NOT EXISTS (
            SELECT 1 FROM "${fk.refTable}" r
            WHERE r."${fk.refColumn ?? 'id'}" = "${fk.table}"."${fk.column}"
          )
        `);
      }

      await queryRunner.query(`
        ALTER TABLE "${fk.table}"
        DROP CONSTRAINT IF EXISTS "${fkName(fk)}"
      `);
      await queryRunner.query(`
        ALTER TABLE "${fk.table}"
        ADD CONSTRAINT "${fkName(fk)}"
        FOREIGN KEY ("${fk.column}")
        REFERENCES "${fk.refTable}"("${fk.refColumn ?? 'id'}")
        ON DELETE ${fk.onDelete}
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const fk of [...FOREIGN_KEYS].reverse()) {
      await queryRunner.query(`
        ALTER TABLE "${fk.table}"
        DROP CONSTRAINT IF EXISTS "${fkName(fk)}"
      `);
    }
  }

  private async isNullable(queryRunner: QueryRunner, fk: Fk): Promise<boolean> {
    const rows: Array<{ is_nullable: string }> = await queryRunner.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1 AND column_name = $2`,
      [fk.table, fk.column],
    );
    return rows[0]?.is_nullable === 'YES';
  }
}
