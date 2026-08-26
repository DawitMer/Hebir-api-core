import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeviceTokens1786560000000 implements MigrationInterface {
  name = 'AddDeviceTokens1786560000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "device_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "token" character varying(512) NOT NULL,
        "platform" character varying(16) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_device_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_device_tokens_token" UNIQUE ("token")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_device_tokens_userId"
      ON "device_tokens" ("userId")
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "device_tokens"
          ADD CONSTRAINT "FK_device_tokens_userId"
          FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "device_tokens" DROP CONSTRAINT IF EXISTS "FK_device_tokens_userId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "device_tokens"`);
  }
}
