import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds persistent actual traveled distance, duration, recorded route coordinates,
 * final authoritative fare, fare breakdown snapshot, and pricing version to rides.
 */
export class AddActualRouteAndFareToRides1786563000000
  implements MigrationInterface
{
  name = 'AddActualRouteAndFareToRides1786563000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "actualDistanceM" integer,
      ADD COLUMN IF NOT EXISTS "actualDurationS" integer,
      ADD COLUMN IF NOT EXISTS "actualRoute" jsonb,
      ADD COLUMN IF NOT EXISTS "fare" character varying(32),
      ADD COLUMN IF NOT EXISTS "fareBreakdown" jsonb,
      ADD COLUMN IF NOT EXISTS "pricingVersion" character varying(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP COLUMN IF EXISTS "pricingVersion",
      DROP COLUMN IF EXISTS "fareBreakdown",
      DROP COLUMN IF EXISTS "fare",
      DROP COLUMN IF EXISTS "actualRoute",
      DROP COLUMN IF EXISTS "actualDurationS",
      DROP COLUMN IF EXISTS "actualDistanceM"
    `);
  }
}
