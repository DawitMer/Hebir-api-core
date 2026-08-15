import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

export class AddExpenseReviewStatus1786381000000 implements MigrationInterface {
  name = 'AddExpenseReviewStatus1786381000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      ALTER TABLE "driver_expenses"
      ADD COLUMN IF NOT EXISTS "reviewStatus" character varying(32)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "driver_expenses" DROP COLUMN IF EXISTS "reviewStatus"
    `);
  }
}
