import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * Dispatch capacity filtering does `findOne({ driverId })` on vehicles —
 * multiple rows per driver made that nondeterministic. Keep the most
 * recently updated vehicle per driver and enforce uniqueness from now on.
 */
export class UniqueVehiclePerDriver1786380000000 implements MigrationInterface {
  name = 'UniqueVehiclePerDriver1786380000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      DELETE FROM vehicles v
      USING vehicles newer
      WHERE v."driverId" = newer."driverId"
        AND (v."updatedAt", v.id) < (newer."updatedAt", newer.id)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_vehicles_driverId"
      ON vehicles ("driverId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_vehicles_driverId"`);
  }
}
