import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

export class AddGovAccessLogIp1786364200000 implements MigrationInterface {
  name = 'AddGovAccessLogIp1786364200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      ALTER TABLE "gov_access_logs"
      ADD COLUMN IF NOT EXISTS "ipAddress" character varying(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "gov_access_logs" DROP COLUMN IF EXISTS "ipAddress"
    `);
  }
}
