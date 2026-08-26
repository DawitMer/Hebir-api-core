import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Street-hail start codes used to live only in Redis. A flush let the driver
 * skip the rider PIN via PATCH /status. Postgres is now the gate; Redis is
 * only the rider-facing display cache.
 */
export class AddRideStartCode1786561000000 implements MigrationInterface {
  name = 'AddRideStartCode1786561000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "startCodeHash" character varying(64)
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "startCodeAttempts" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "startCodeExpiresAt" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rides" DROP COLUMN IF EXISTS "startCodeExpiresAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rides" DROP COLUMN IF EXISTS "startCodeAttempts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rides" DROP COLUMN IF EXISTS "startCodeHash"`,
    );
  }
}
