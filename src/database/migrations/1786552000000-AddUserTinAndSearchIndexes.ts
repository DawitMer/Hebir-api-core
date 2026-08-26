import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * Driver TIN for gov/ops lookup at ~100k fleet scale.
 * Partial unique index + trigram on fullName for name search.
 */
export class AddUserTinAndSearchIndexes1786552000000 implements MigrationInterface {
  name = 'AddUserTinAndSearchIndexes1786552000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      ALTER TABLE "user_accounts"
      ADD COLUMN IF NOT EXISTS "tin" character varying(32)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_accounts_tin"
      ON "user_accounts" ("tin")
      WHERE "tin" IS NOT NULL
    `);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_accounts_fullName_trgm"
      ON "user_accounts" USING gin ("fullName" gin_trgm_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_user_accounts_fullName_trgm"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_user_accounts_tin"`);
    await queryRunner.query(
      `ALTER TABLE "user_accounts" DROP COLUMN IF EXISTS "tin"`,
    );
  }
}
