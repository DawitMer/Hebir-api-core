import { MigrationInterface, QueryRunner } from 'typeorm';

export class MonthlyExpenseReports1788885000000 implements MigrationInterface {
  name = 'MonthlyExpenseReports1788885000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "driver_monthly_expense_reports" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "driverId" uuid NOT NULL,
        "reportingMonth" character varying(7) NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'submitted',
        "fuelAmount" numeric(10,2) NOT NULL DEFAULT 0.00,
        "maintenanceAmount" numeric(10,2) NOT NULL DEFAULT 0.00,
        "insuranceAmount" numeric(10,2) NOT NULL DEFAULT 0.00,
        "tollsAmount" numeric(10,2) NOT NULL DEFAULT 0.00,
        "otherAmount" numeric(10,2) NOT NULL DEFAULT 0.00,
        "totalAmount" numeric(10,2) NOT NULL DEFAULT 0.00,
        "notes" text,
        "supportingDocUrls" text[],
        "reviewerId" uuid,
        "reviewerNotes" text,
        "reviewedAt" timestamptz,
        "submittedAt" timestamptz DEFAULT now(),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_monthly_expense_driverId" FOREIGN KEY ("driverId") REFERENCES "user_accounts"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_monthly_expense_reviewerId" FOREIGN KEY ("reviewerId") REFERENCES "user_accounts"("id") ON DELETE SET NULL,
        CONSTRAINT "UQ_driver_monthly_report" UNIQUE ("driverId", "reportingMonth")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_monthly_expense_driver_month"
        ON "driver_monthly_expense_reports" ("driverId", "reportingMonth");
      CREATE INDEX IF NOT EXISTS "IDX_monthly_expense_status"
        ON "driver_monthly_expense_reports" ("status");
      CREATE INDEX IF NOT EXISTS "IDX_monthly_expense_month"
        ON "driver_monthly_expense_reports" ("reportingMonth");
    `);

    // Backfill from legacy driver_expenses if records exist
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'driver_expenses') THEN
          INSERT INTO "driver_monthly_expense_reports" (
            "id", "driverId", "reportingMonth", "status",
            "fuelAmount", "maintenanceAmount", "insuranceAmount", "tollsAmount", "otherAmount",
            "totalAmount", "notes", "reviewerNotes", "reviewedAt", "submittedAt", "createdAt", "updatedAt"
          )
          SELECT
            gen_random_uuid(),
            e."driverId",
            to_char(e."incurredAt", 'YYYY-MM') AS "reportingMonth",
            CASE
              WHEN bool_or(e."reviewStatus" = 'verified') THEN 'approved'
              WHEN bool_or(e."reviewStatus" = 'rejected') THEN 'rejected'
              WHEN bool_or(e."reviewStatus" = 'flagged') THEN 'changes_required'
              ELSE 'submitted'
            END AS "status",
            COALESCE(SUM(CASE WHEN lower(e."category") LIKE '%fuel%' THEN e."amount"::numeric ELSE 0 END), 0) AS "fuelAmount",
            COALESCE(SUM(CASE WHEN lower(e."category") LIKE '%maint%' THEN e."amount"::numeric ELSE 0 END), 0) AS "maintenanceAmount",
            COALESCE(SUM(CASE WHEN lower(e."category") LIKE '%insur%' THEN e."amount"::numeric ELSE 0 END), 0) AS "insuranceAmount",
            COALESCE(SUM(CASE WHEN lower(e."category") LIKE '%toll%' OR lower(e."category") LIKE '%park%' THEN e."amount"::numeric ELSE 0 END), 0) AS "tollsAmount",
            COALESCE(SUM(CASE WHEN lower(e."category") NOT LIKE '%fuel%' AND lower(e."category") NOT LIKE '%maint%' AND lower(e."category") NOT LIKE '%insur%' AND lower(e."category") NOT LIKE '%toll%' AND lower(e."category") NOT LIKE '%park%' THEN e."amount"::numeric ELSE 0 END), 0) AS "otherAmount",
            COALESCE(SUM(e."amount"::numeric), 0) AS "totalAmount",
            string_agg(DISTINCT e."description", '; ') AS "notes",
            NULL AS "reviewerNotes",
            max(e."submittedAt") AS "reviewedAt",
            min(e."submittedAt") AS "submittedAt",
            min(e."submittedAt") AS "createdAt",
            max(e."submittedAt") AS "updatedAt"
          FROM "driver_expenses" e
          GROUP BY e."driverId", to_char(e."incurredAt", 'YYYY-MM')
          ON CONFLICT ("driverId", "reportingMonth") DO NOTHING;
        END IF;
      END $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE IF EXISTS "driver_monthly_expense_reports"',
    );
  }
}
