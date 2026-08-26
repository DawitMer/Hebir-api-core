import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * Adds the incidents / SOS table.
 * Prior tables were created via synchronize; from here on schema changes are migrations-only.
 */
export class AddIncidents1786363545077 implements MigrationInterface {
  name = 'AddIncidents1786363545077';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."incidents_type_enum" AS ENUM(
          'sos',
          'safetyAlert',
          'rideDispute',
          'paymentFailure',
          'driverOffline',
          'surgeIssue',
          'other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."incidents_priority_enum" AS ENUM(
          'critical', 'high', 'medium', 'low'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."incidents_status_enum" AS ENUM(
          'open', 'assigned', 'resolved'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "incidents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "caseNumber" character varying NOT NULL,
        "type" "public"."incidents_type_enum" NOT NULL,
        "title" character varying NOT NULL,
        "description" text NOT NULL,
        "priority" "public"."incidents_priority_enum" NOT NULL DEFAULT 'medium',
        "status" "public"."incidents_status_enum" NOT NULL DEFAULT 'open',
        "reporterId" character varying NOT NULL,
        "reporterRole" character varying NOT NULL,
        "rideId" character varying,
        "relatedUserId" character varying,
        "relatedName" character varying,
        "lat" double precision,
        "lng" double precision,
        "locationLabel" character varying,
        "assignedToId" character varying,
        "assignedToName" character varying,
        "assignedAt" TIMESTAMP WITH TIME ZONE,
        "resolvedAt" TIMESTAMP WITH TIME ZONE,
        "reportedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_incidents_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_incidents_caseNumber"
        ON "incidents" ("caseNumber")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_incidents_caseNumber"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "incidents"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."incidents_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."incidents_priority_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."incidents_type_enum"`,
    );
  }
}
