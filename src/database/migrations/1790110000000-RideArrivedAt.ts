import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clock for pickup waiting: driver marks arrived → trip start.
 * Used to bill per_wait_minute at completion.
 */
export class RideArrivedAt1790110000000 implements MigrationInterface {
  name = 'RideArrivedAt1790110000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
        ADD COLUMN IF NOT EXISTS "arrivedAt" TIMESTAMPTZ
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides" DROP COLUMN IF EXISTS "arrivedAt"
    `);
  }
}
