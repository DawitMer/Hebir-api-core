import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

export class AddRideMessages1786382000000 implements MigrationInterface {
  name = 'AddRideMessages1786382000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ride_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "rideId" uuid NOT NULL,
        "senderId" uuid NOT NULL,
        "body" character varying(1000) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ride_messages" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ride_messages_ride_created"
      ON "ride_messages" ("rideId", "createdAt")
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "ride_messages"
          ADD CONSTRAINT "FK_ride_messages_rideId"
          FOREIGN KEY ("rideId") REFERENCES "rides"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "ride_messages"
          ADD CONSTRAINT "FK_ride_messages_senderId"
          FOREIGN KEY ("senderId") REFERENCES "user_accounts"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ride_messages" DROP CONSTRAINT IF EXISTS "FK_ride_messages_senderId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ride_messages" DROP CONSTRAINT IF EXISTS "FK_ride_messages_rideId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_ride_messages_ride_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "ride_messages"`);
  }
}
