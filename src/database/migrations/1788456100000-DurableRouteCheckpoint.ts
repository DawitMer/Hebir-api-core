import { MigrationInterface, QueryRunner } from 'typeorm';

export class DurableRouteCheckpoint1788456100000 implements MigrationInterface {
  name = 'DurableRouteCheckpoint1788456100000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE ride_route_checkpoints (
      "rideId" uuid PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
      "totalDistanceM" integer NOT NULL DEFAULT 0 CHECK ("totalDistanceM" >= 0),
      "lastFix" jsonb NOT NULL,
      points jsonb NOT NULL DEFAULT '[]'::jsonb,
      "hasGaps" boolean NOT NULL DEFAULT false,
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE ride_route_checkpoints');
  }
}
