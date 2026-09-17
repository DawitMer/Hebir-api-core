import { MigrationInterface, QueryRunner } from 'typeorm';

export class CleanupUnwantedData1788886000000 implements MigrationInterface {
  name = 'CleanupUnwantedData1788886000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Purge unwanted future test rows (e.g., 2026-11)
    await queryRunner.query(`
      DELETE FROM "driver_monthly_expense_reports"
      WHERE "reportingMonth" > '2026-09';
    `);

    // 2. Drop the legacy unwanted per-expense table
    await queryRunner.query(`
      DROP TABLE IF EXISTS "driver_expenses" CASCADE;
    `);
  }

  async down(): Promise<void> {
    // Down migration intentionally keeps modern monthly table structure
  }
}
