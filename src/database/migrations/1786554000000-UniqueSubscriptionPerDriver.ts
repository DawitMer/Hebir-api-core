import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * The subscription gate filters `WHERE "driverId" = ?` (isActive, getStatus,
 * activate) — called on presence toggles, trip publishing, and the GPS hot
 * path. Existing indexes lead with `state`, so none serves an equality on
 * `driverId` alone. driver_subscriptions is OneToOne, so make it a UNIQUE
 * index: dedupe any stray rows first, then enforce one subscription per driver.
 */
export class UniqueSubscriptionPerDriver1786554000000 implements MigrationInterface {
  name = 'UniqueSubscriptionPerDriver1786554000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      DELETE FROM driver_subscriptions s
      USING driver_subscriptions newer
      WHERE s."driverId" = newer."driverId"
        AND (s."updatedAt", s.id) < (newer."updatedAt", newer.id)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_driver_subscriptions_driverId"
      ON driver_subscriptions ("driverId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_driver_subscriptions_driverId"`,
    );
  }
}
