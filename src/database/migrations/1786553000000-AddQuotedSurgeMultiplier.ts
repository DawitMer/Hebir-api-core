import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * Persist the surge the rider was quoted so driver offers and completion
 * charge the same amount when demand is high.
 */
export class AddQuotedSurgeMultiplier1786553000000 implements MigrationInterface {
  name = 'AddQuotedSurgeMultiplier1786553000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "quotedSurgeMultiplier" double precision
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP COLUMN IF EXISTS "quotedSurgeMultiplier"
    `);
  }
}
