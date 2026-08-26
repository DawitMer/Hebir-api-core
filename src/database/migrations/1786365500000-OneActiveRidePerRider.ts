import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * Enforces the application rule "one live ride per rider" at the database
 * level. The pre-insert SELECT in requestRide() alone cannot stop two
 * concurrent taps from both inserting a searching ride.
 */
export class OneActiveRidePerRider1786365500000 implements MigrationInterface {
  name = 'OneActiveRidePerRider1786365500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_rides_one_active_per_rider"
        ON "rides" ("riderId")
        WHERE "status" IN (
          'requested',
          'searching',
          'offered',
          'matched',
          'accepted',
          'arriving',
          'in_progress'
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_rides_one_active_per_rider"`,
    );
  }
}
