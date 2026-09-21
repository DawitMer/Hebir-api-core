import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The promotions table was created before maxTotalUsage existed.
 * CREATE TABLE IF NOT EXISTS left the live table without that column,
 * so GET /promotions failed with 42703.
 */
export class PromotionMaxTotalUsage1789940000000 implements MigrationInterface {
  name = 'PromotionMaxTotalUsage1789940000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "promotions"
        ADD COLUMN IF NOT EXISTS "maxTotalUsage" integer
    `);
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "promotions"
          ADD CONSTRAINT "CHK_promotions_max_total_usage"
          CHECK ("maxTotalUsage" IS NULL OR "maxTotalUsage" > 0);
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "promotions"
        DROP CONSTRAINT IF EXISTS "CHK_promotions_max_total_usage"
    `);
    await q.query(`
      ALTER TABLE "promotions" DROP COLUMN IF EXISTS "maxTotalUsage"
    `);
  }
}
