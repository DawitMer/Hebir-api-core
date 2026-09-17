import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the promotion claim ledger and the minimum audit data needed for an
 * authorized operational cancellation. This is deliberately additive: the
 * previous generated migration rewrote unrelated production constraints and
 * indexes, which is not safe to run against a live dispatch database.
 */
export class PromotionsAndForceCancel1789657538132 implements MigrationInterface {
  name = 'PromotionsAndForceCancel1789657538132';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "promotions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "code" varchar NOT NULL UNIQUE,
        "description" varchar NOT NULL,
        "discountMinor" integer NOT NULL CHECK ("discountMinor" >= 0),
        "startsAt" timestamptz NOT NULL,
        "endsAt" timestamptz NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "maxUsagePerUser" integer NOT NULL DEFAULT 1 CHECK ("maxUsagePerUser" > 0),
        "maxTotalUsage" integer CHECK ("maxTotalUsage" IS NULL OR "maxTotalUsage" > 0),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_promotions_window" CHECK ("endsAt" >= "startsAt")
      )
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "promotion_claims_status_enum" AS ENUM ('active', 'used', 'expired');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "promotion_claims" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "riderId" uuid NOT NULL,
        "promotionId" uuid NOT NULL,
        "status" "promotion_claims_status_enum" NOT NULL DEFAULT 'active',
        "claimedAt" timestamptz NOT NULL DEFAULT now(),
        "rideId" uuid,
        "discountAppliedMinor" integer,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_promotion_claims_promotion"
          FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_promotion_claim_discount"
          CHECK ("discountAppliedMinor" IS NULL OR "discountAppliedMinor" >= 0)
      )
    `);
    // A rider may redeem a multi-use promotion more than once, but may never
    // hold two active claims. The partial unique index is the concurrency
    // boundary; the service catches a duplicate insert and returns the winner.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_promotion_claims_one_active"
      ON "promotion_claims" ("riderId", "promotionId")
      WHERE "status" = 'active'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_promotions_active_window"
      ON "promotions" ("isActive", "startsAt", "endsAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_promotion_claims_rider_status"
      ON "promotion_claims" ("riderId", "status")
    `);
    await queryRunner.query(
      'ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "maxTotalUsage" integer',
    );

    for (const column of [
      'ADD COLUMN IF NOT EXISTS "cancellationType" varchar(64)',
      'ADD COLUMN IF NOT EXISTS "cancellationReason" varchar(255)',
      'ADD COLUMN IF NOT EXISTS "cancelledBy" uuid',
      'ADD COLUMN IF NOT EXISTS "cancelledByRole" varchar(64)',
      'ADD COLUMN IF NOT EXISTS "adminNotes" text',
    ]) {
      await queryRunner.query(`ALTER TABLE "rides" ${column}`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "IDX_promotion_claims_rider_status"',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "IDX_promotions_active_window"',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "UQ_promotion_claims_one_active"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "promotion_claims"');
    await queryRunner.query('DROP TABLE IF EXISTS "promotions"');
    await queryRunner.query(
      'DROP TYPE IF EXISTS "promotion_claims_status_enum"',
    );
    for (const column of [
      '"adminNotes"',
      '"cancelledByRole"',
      '"cancelledBy"',
      '"cancellationReason"',
      '"cancellationType"',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "rides" DROP COLUMN IF EXISTS ${column}`,
      );
    }
  }
}
