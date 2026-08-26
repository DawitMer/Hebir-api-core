import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFirebaseAuthFields1786562000000 implements MigrationInterface {
  name = 'AddFirebaseAuthFields1786562000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user_accounts"
      ADD COLUMN IF NOT EXISTS "firebase_uid" character varying(128),
      ADD COLUMN IF NOT EXISTS "phone_verified_at" TIMESTAMP WITH TIME ZONE;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_accounts_firebase_uid"
      ON "user_accounts" ("firebase_uid")
      WHERE "firebase_uid" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_user_accounts_firebase_uid";
    `);

    await queryRunner.query(`
      ALTER TABLE "user_accounts"
      DROP COLUMN IF EXISTS "firebase_uid",
      DROP COLUMN IF EXISTS "phone_verified_at";
    `);
  }
}
