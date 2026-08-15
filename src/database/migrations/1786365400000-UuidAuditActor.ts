import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * audit_trails."actorId" is always a user_accounts.id (the admin/gov officer
 * who acted), unlike "targetId" which stays polymorphic text.
 */
export class UuidAuditActor1786365400000 implements MigrationInterface {
  name = 'UuidAuditActor1786365400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      ALTER TABLE "audit_trails"
      ALTER COLUMN "actorId" TYPE uuid USING NULLIF("actorId", '')::uuid
    `);
    await queryRunner.query(`
      DELETE FROM "audit_trails"
      WHERE NOT EXISTS (
        SELECT 1 FROM "user_accounts" u WHERE u.id = "audit_trails"."actorId"
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "audit_trails"
      ADD CONSTRAINT "FK_audit_trails_actorId"
      FOREIGN KEY ("actorId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_audit_trails_target"
      ON "audit_trails" ("targetType", "targetId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_audit_trails_actor_occurred"
      ON "audit_trails" ("actorId", "occurredAt" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_trails_actor_occurred"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_trails_target"`);
    await queryRunner.query(
      `ALTER TABLE "audit_trails" DROP CONSTRAINT IF EXISTS "FK_audit_trails_actorId"`,
    );
    await queryRunner.query(`
      ALTER TABLE "audit_trails"
      ALTER COLUMN "actorId" TYPE character varying USING "actorId"::text
    `);
  }
}
