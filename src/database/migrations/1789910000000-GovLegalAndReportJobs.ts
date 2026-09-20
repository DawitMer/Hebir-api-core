import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Government legal-request intake (immutable event history) and
 * persistent compliance report jobs (CSV stored for MVP download).
 */
export class GovLegalAndReportJobs1789910000000 implements MigrationInterface {
  name = 'GovLegalAndReportJobs1789910000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "gov_legal_requests_type_enum" AS ENUM (
          'subpoena', 'warrant', 'court_order', 'emergency'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "gov_legal_requests_priority_enum" AS ENUM (
          'low', 'medium', 'high', 'urgent'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "gov_legal_requests_status_enum" AS ENUM (
          'received', 'in_review', 'fulfilled', 'rejected', 'withdrawn'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "gov_report_jobs_status_enum" AS ENUM (
          'queued', 'processing', 'ready', 'failed'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "gov_legal_requests" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "type" "gov_legal_requests_type_enum" NOT NULL,
        "title" character varying(240) NOT NULL,
        "requestingAuthority" character varying(240) NOT NULL,
        "caseReference" character varying(120) NOT NULL,
        "driverId" uuid,
        "driverTin" character varying(32),
        "dataScope" character varying[] NOT NULL DEFAULT '{}',
        "priority" "gov_legal_requests_priority_enum" NOT NULL DEFAULT 'medium',
        "status" "gov_legal_requests_status_enum" NOT NULL DEFAULT 'received',
        "receivedAt" timestamptz NOT NULL DEFAULT now(),
        "deadlineAt" timestamptz,
        "assignedOfficerId" uuid,
        "createdByOfficerId" uuid NOT NULL,
        "fulfilNotes" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_gov_legal_requests_status"
        ON "gov_legal_requests" ("status")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_gov_legal_requests_priority"
        ON "gov_legal_requests" ("priority")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_gov_legal_requests_driver"
        ON "gov_legal_requests" ("driverId")
      WHERE "driverId" IS NOT NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_gov_legal_requests_received"
        ON "gov_legal_requests" ("receivedAt" DESC)
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "gov_legal_request_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "requestId" uuid NOT NULL,
        "actorId" uuid NOT NULL,
        "action" character varying(64) NOT NULL,
        "note" text,
        "payload" jsonb,
        "occurredAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_gov_legal_request_events_request"
          FOREIGN KEY ("requestId") REFERENCES "gov_legal_requests"("id") ON DELETE CASCADE
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_gov_legal_request_events_request"
        ON "gov_legal_request_events" ("requestId", "occurredAt" DESC)
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "gov_report_jobs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "requestedByOfficerId" uuid NOT NULL,
        "driverId" uuid NOT NULL,
        "tin" character varying(32) NOT NULL,
        "fiscalYear" int NOT NULL,
        "format" character varying(16) NOT NULL DEFAULT 'CSV',
        "status" "gov_report_jobs_status_enum" NOT NULL DEFAULT 'queued',
        "parameters" jsonb NOT NULL DEFAULT '{}',
        "resultCsv" text,
        "rowCount" int NOT NULL DEFAULT 0,
        "grossTotal" character varying(32),
        "netTaxableTotal" character varying(32),
        "error" text,
        "legalRequestId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "completedAt" timestamptz
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_gov_report_jobs_officer"
        ON "gov_report_jobs" ("requestedByOfficerId", "createdAt" DESC)
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_gov_report_jobs_driver"
        ON "gov_report_jobs" ("driverId", "fiscalYear")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_gov_report_jobs_status"
        ON "gov_report_jobs" ("status")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_gov_report_jobs_status"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_gov_report_jobs_driver"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_gov_report_jobs_officer"`);
    await q.query(`DROP TABLE IF EXISTS "gov_report_jobs"`);

    await q.query(`DROP INDEX IF EXISTS "IDX_gov_legal_request_events_request"`);
    await q.query(`DROP TABLE IF EXISTS "gov_legal_request_events"`);

    await q.query(`DROP INDEX IF EXISTS "IDX_gov_legal_requests_received"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_gov_legal_requests_driver"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_gov_legal_requests_priority"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_gov_legal_requests_status"`);
    await q.query(`DROP TABLE IF EXISTS "gov_legal_requests"`);

    await q.query(`DROP TYPE IF EXISTS "gov_report_jobs_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "gov_legal_requests_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "gov_legal_requests_priority_enum"`);
    await q.query(`DROP TYPE IF EXISTS "gov_legal_requests_type_enum"`);
  }
}
