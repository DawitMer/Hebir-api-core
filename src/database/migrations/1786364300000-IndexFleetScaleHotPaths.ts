import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * Hot-path indexes for ~10k online drivers / concurrent dispatch + live ops.
 */
export class IndexFleetScaleHotPaths1786364300000 implements MigrationInterface {
  name = 'IndexFleetScaleHotPaths1786364300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_profiles_status"
      ON "driver_profiles" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_subscriptions_state_driver"
      ON "driver_subscriptions" ("state", "driverId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_location_history_driver_recorded"
      ON "driver_location_history" ("driverId", "recordedAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_status_updated"
      ON "rides" ("status", "updatedAt" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_status_updated"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_driver_location_history_driver_recorded"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_driver_subscriptions_state_driver"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_driver_profiles_status"`);
  }
}
