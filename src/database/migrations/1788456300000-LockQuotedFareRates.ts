import { MigrationInterface, QueryRunner } from 'typeorm';

export class LockQuotedFareRates1788456300000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE rides ADD COLUMN "quotedFareRates" jsonb');
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE rides DROP COLUMN "quotedFareRates"');
  }
}
