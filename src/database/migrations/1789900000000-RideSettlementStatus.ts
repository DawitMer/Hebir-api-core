import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persist whether a completed ride was billed from a continuous GNSS meter
 * or from the quote-capped estimate policy (gap / stale / zero GPS).
 */
export class RideSettlementStatus1789900000000 implements MigrationInterface {
  name = 'RideSettlementStatus1789900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "rides_settlement_status_enum" AS ENUM ('metered', 'estimated');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      ALTER TABLE "rides"
        ADD COLUMN IF NOT EXISTS "settlementStatus" "rides_settlement_status_enum",
        ADD COLUMN IF NOT EXISTS "settlementReviewCaseNumber" varchar(32)
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_settlement_status"
        ON "rides" ("settlementStatus")
        WHERE "settlementStatus" IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_rides_settlement_status"`);
    await q.query(`
      ALTER TABLE "rides"
        DROP COLUMN IF EXISTS "settlementReviewCaseNumber",
        DROP COLUMN IF EXISTS "settlementStatus"
    `);
    await q.query(`DROP TYPE IF EXISTS "rides_settlement_status_enum"`);
  }
}
