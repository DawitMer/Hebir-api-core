import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Self-serve advertising: advertiser accounts, campaign review/payment
 * lifecycle, interest targeting, delivery counters and a Chapa payment
 * ledger. Additive only — existing house campaigns keep running.
 */
export class AdvertiserSelfServe1789800000000 implements MigrationInterface {
  name = 'AdvertiserSelfServe1789800000000';

  public async up(q: QueryRunner): Promise<void> {
    // New lifecycle states. ADD VALUE IF NOT EXISTS is idempotent on PG ≥ 12.
    for (const value of ['pending_review', 'approved', 'rejected']) {
      await q.query(
        `ALTER TYPE "ad_campaigns_state_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }

    await q.query(`
      ALTER TABLE "ad_campaigns"
        ADD COLUMN IF NOT EXISTS "interests" varchar[] NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS "advertiserId" uuid,
        ADD COLUMN IF NOT EXISTS "purchasedViews" int NOT NULL DEFAULT 0 CHECK ("purchasedViews" >= 0),
        ADD COLUMN IF NOT EXISTS "paidMinor" bigint NOT NULL DEFAULT 0 CHECK ("paidMinor" >= 0),
        ADD COLUMN IF NOT EXISTS "paymentTxRef" varchar(96),
        ADD COLUMN IF NOT EXISTS "paidAt" timestamptz,
        ADD COLUMN IF NOT EXISTS "reviewNote" text,
        ADD COLUMN IF NOT EXISTS "reviewedBy" uuid,
        ADD COLUMN IF NOT EXISTS "reviewedAt" timestamptz,
        ADD COLUMN IF NOT EXISTS "impressions" int NOT NULL DEFAULT 0 CHECK ("impressions" >= 0),
        ADD COLUMN IF NOT EXISTS "ctaClicks" int NOT NULL DEFAULT 0 CHECK ("ctaClicks" >= 0)
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ad_campaigns_advertiser" ON "ad_campaigns" ("advertiserId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ad_campaigns_state_window" ON "ad_campaigns" ("state", "startsAt", "endsAt")`,
    );

    // The reward is now env-tunable; keep a sane floor instead of a literal.
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "ad_campaigns" DROP CONSTRAINT IF EXISTS "ad_campaigns_rewardMinor_check";
        ALTER TABLE "ad_reward_events" DROP CONSTRAINT IF EXISTS "ad_reward_events_rewardMinor_check";
      EXCEPTION WHEN undefined_object THEN NULL; END $$;
    `);
    await q.query(
      `ALTER TABLE "ad_campaigns" ADD CONSTRAINT "CHK_ad_campaigns_reward_floor" CHECK ("rewardMinor" >= 100)`,
    );
    await q.query(
      `ALTER TABLE "ad_reward_events" ADD CONSTRAINT "CHK_ad_reward_events_reward_floor" CHECK ("rewardMinor" >= 100)`,
    );

    await q.query(`
      ALTER TABLE "rider_ad_profiles"
        ADD COLUMN IF NOT EXISTS "interests" varchar[] NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS "area" varchar(48)
    `);
    await q.query(`
      ALTER TABLE "ad_view_sessions"
        ADD COLUMN IF NOT EXISTS "ctaClickedAt" timestamptz
    `);

    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "advertisers_status_enum" AS ENUM ('active','suspended');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "advertisers" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "email" varchar(160) NOT NULL,
        "companyName" varchar(120) NOT NULL,
        "contactName" varchar(120) NOT NULL,
        "phone" varchar(20),
        "tinNumber" varchar(20),
        "website" varchar(2048),
        "passwordHash" varchar(100) NOT NULL,
        "status" "advertisers_status_enum" NOT NULL DEFAULT 'active',
        "lastLoginAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_advertisers_email" ON "advertisers" ("email")`,
    );
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "ad_campaigns"
          ADD CONSTRAINT "FK_ad_campaigns_advertiser"
          FOREIGN KEY ("advertiserId") REFERENCES "advertisers"("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "advertiser_payments_status_enum" AS ENUM ('initialized','paid','failed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "advertiser_payments" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "advertiserId" uuid NOT NULL REFERENCES "advertisers"("id"),
        "campaignId" uuid NOT NULL REFERENCES "ad_campaigns"("id"),
        "txRef" varchar(96) NOT NULL,
        "views" int NOT NULL CHECK ("views" > 0),
        "amountMinor" bigint NOT NULL CHECK ("amountMinor" > 0),
        "provider" varchar(16) NOT NULL DEFAULT 'chapa',
        "status" "advertiser_payments_status_enum" NOT NULL DEFAULT 'initialized',
        "providerPayload" jsonb,
        "paidAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_advertiser_payments_txref" ON "advertiser_payments" ("txRef")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_advertiser_payments_campaign" ON "advertiser_payments" ("campaignId")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "advertiser_payments"`);
    await q.query(`DROP TYPE IF EXISTS "advertiser_payments_status_enum"`);
    await q.query(
      `ALTER TABLE "ad_campaigns" DROP CONSTRAINT IF EXISTS "FK_ad_campaigns_advertiser"`,
    );
    await q.query(`DROP TABLE IF EXISTS "advertisers"`);
    await q.query(`DROP TYPE IF EXISTS "advertisers_status_enum"`);
    await q.query(
      `ALTER TABLE "ad_view_sessions" DROP COLUMN IF EXISTS "ctaClickedAt"`,
    );
    await q.query(
      `ALTER TABLE "rider_ad_profiles" DROP COLUMN IF EXISTS "interests", DROP COLUMN IF EXISTS "area"`,
    );
    await q.query(`DROP INDEX IF EXISTS "IDX_ad_campaigns_state_window"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_ad_campaigns_advertiser"`);
    await q.query(`
      ALTER TABLE "ad_campaigns"
        DROP COLUMN IF EXISTS "interests",
        DROP COLUMN IF EXISTS "advertiserId",
        DROP COLUMN IF EXISTS "purchasedViews",
        DROP COLUMN IF EXISTS "paidMinor",
        DROP COLUMN IF EXISTS "paymentTxRef",
        DROP COLUMN IF EXISTS "paidAt",
        DROP COLUMN IF EXISTS "reviewNote",
        DROP COLUMN IF EXISTS "reviewedBy",
        DROP COLUMN IF EXISTS "reviewedAt",
        DROP COLUMN IF EXISTS "impressions",
        DROP COLUMN IF EXISTS "ctaClicks"
    `);
    // Enum values cannot be removed in PostgreSQL; they are harmless to keep.
  }
}
