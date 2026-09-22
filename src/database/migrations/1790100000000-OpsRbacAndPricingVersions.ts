import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Production ops foundation:
 * - versioned pricing configs (draft → publish → active)
 * - staff departments / roles / permissions
 * - fare adjustments with audit trail
 * - rides.pricingVersionId FK (keeps legacy pricingVersion string)
 */
export class OpsRbacAndPricingVersions1790100000000
  implements MigrationInterface
{
  name = 'OpsRbacAndPricingVersions1790100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ops_departments" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "slug" varchar(64) NOT NULL UNIQUE,
        "name" varchar(120) NOT NULL,
        "description" text,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ops_permissions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "key" varchar(96) NOT NULL UNIQUE,
        "description" varchar(255) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ops_roles" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "slug" varchar(64) NOT NULL UNIQUE,
        "name" varchar(120) NOT NULL,
        "departmentId" uuid REFERENCES "ops_departments"("id") ON DELETE SET NULL,
        "description" text,
        "isSystem" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ops_role_permissions" (
        "roleId" uuid NOT NULL REFERENCES "ops_roles"("id") ON DELETE CASCADE,
        "permissionId" uuid NOT NULL REFERENCES "ops_permissions"("id") ON DELETE CASCADE,
        PRIMARY KEY ("roleId", "permissionId")
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ops_staff_profiles" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL UNIQUE REFERENCES "user_accounts"("id") ON DELETE CASCADE,
        "staffCode" varchar(32),
        "departmentId" uuid REFERENCES "ops_departments"("id") ON DELETE SET NULL,
        "roleId" uuid REFERENCES "ops_roles"("id") ON DELETE SET NULL,
        "status" varchar(32) NOT NULL DEFAULT 'active',
        "lastLoginAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ops_staff_status" ON "ops_staff_profiles" ("status")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pricing_versions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "versionLabel" varchar(64) NOT NULL,
        "status" varchar(32) NOT NULL DEFAULT 'draft',
        "currency" varchar(8) NOT NULL DEFAULT 'ETB',
        "rates" jsonb NOT NULL,
        "vehicleMultipliers" jsonb NOT NULL DEFAULT '{}',
        "notes" text,
        "effectiveFrom" TIMESTAMPTZ,
        "activatedAt" TIMESTAMPTZ,
        "archivedAt" TIMESTAMPTZ,
        "createdById" uuid,
        "publishedById" uuid,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_pricing_versions_status" ON "pricing_versions" ("status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pricing_versions_one_active" ON "pricing_versions" ("status") WHERE status = 'active'`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "fare_adjustments" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "rideId" uuid NOT NULL REFERENCES "rides"("id") ON DELETE CASCADE,
        "staffUserId" uuid NOT NULL,
        "originalTotal" numeric(12,2) NOT NULL,
        "adjustedTotal" numeric(12,2) NOT NULL,
        "reason" text NOT NULL,
        "internalNote" text,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fare_adjustments_ride" ON "fare_adjustments" ("rideId")`,
    );

    await queryRunner.query(`
      ALTER TABLE "rides"
        ADD COLUMN IF NOT EXISTS "pricingVersionId" uuid
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "rides"
          ADD CONSTRAINT "FK_rides_pricing_version"
          FOREIGN KEY ("pricingVersionId") REFERENCES "pricing_versions"("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rides" DROP CONSTRAINT IF EXISTS "FK_rides_pricing_version"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rides" DROP COLUMN IF EXISTS "pricingVersionId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "fare_adjustments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "pricing_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ops_staff_profiles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ops_role_permissions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ops_roles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ops_permissions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ops_departments"`);
  }
}
