import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drivers cannot edit an approved vehicle. A replacement car is stored as a
 * pending KYC vehicle-change until ops approves it.
 */
export class AddPendingVehicleChange1786558000000 implements MigrationInterface {
  name = 'AddPendingVehicleChange1786558000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "driver_verifications"
      ADD COLUMN IF NOT EXISTS "vehicleChangePending" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "driver_verifications"
      ADD COLUMN IF NOT EXISTS "pendingVehicleMake" character varying
    `);
    await queryRunner.query(`
      ALTER TABLE "driver_verifications"
      ADD COLUMN IF NOT EXISTS "pendingVehicleModel" character varying
    `);
    await queryRunner.query(`
      ALTER TABLE "driver_verifications"
      ADD COLUMN IF NOT EXISTS "pendingVehiclePlate" character varying
    `);
    await queryRunner.query(`
      ALTER TABLE "driver_verifications"
      ADD COLUMN IF NOT EXISTS "pendingVehicleColor" character varying
    `);
    await queryRunner.query(`
      ALTER TABLE "driver_verifications"
      ADD COLUMN IF NOT EXISTS "pendingVehicleYear" integer
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "driver_verifications" DROP COLUMN IF EXISTS "pendingVehicleYear"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_verifications" DROP COLUMN IF EXISTS "pendingVehicleColor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_verifications" DROP COLUMN IF EXISTS "pendingVehiclePlate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_verifications" DROP COLUMN IF EXISTS "pendingVehicleModel"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_verifications" DROP COLUMN IF EXISTS "pendingVehicleMake"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_verifications" DROP COLUMN IF EXISTS "vehicleChangePending"`,
    );
  }
}
