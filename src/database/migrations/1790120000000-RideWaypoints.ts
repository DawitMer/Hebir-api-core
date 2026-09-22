import { MigrationInterface, QueryRunner } from 'typeorm';

export class RideWaypoints1790120000000 implements MigrationInterface {
  name = 'RideWaypoints1790120000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      ADD COLUMN IF NOT EXISTS "waypoints" jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
      DROP COLUMN IF EXISTS "waypoints"
    `);
  }
}
