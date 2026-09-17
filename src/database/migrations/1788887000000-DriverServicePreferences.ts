import { MigrationInterface, QueryRunner } from 'typeorm';

export class DriverServicePreferences1788887000000 implements MigrationInterface {
  name = 'DriverServicePreferences1788887000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "driver_profiles"
      ADD COLUMN IF NOT EXISTS "acceptedVehicleTypes" text[]
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "driver_profiles"
      DROP COLUMN IF EXISTS "acceptedVehicleTypes"
    `);
  }
}
