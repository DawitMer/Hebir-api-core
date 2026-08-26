import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * One live ride per assigned driver + hot path for the stale-MATCHED reaper.
 */
export class IndexActiveDriverRideAndMatchedAt1786365600000 implements MigrationInterface {
  name = 'IndexActiveDriverRideAndMatchedAt1786365600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_rides_one_active_per_driver"
        ON "rides" ("driverId")
        WHERE "driverId" IS NOT NULL
          AND "status" IN (
            'matched',
            'accepted',
            'arriving',
            'in_progress'
          )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_status_matchedAt"
        ON "rides" ("status", "matchedAt")
        WHERE "status" = 'matched'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_rides_status_matchedAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_rides_one_active_per_driver"`,
    );
  }
}
