import { MigrationInterface, QueryRunner } from 'typeorm';

export class KycReviewMessages1789920000000 implements MigrationInterface {
  name = 'KycReviewMessages1789920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kyc_review_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "verificationId" uuid NOT NULL,
        "senderId" uuid NOT NULL,
        "senderRole" character varying(20) NOT NULL,
        "body" text NOT NULL,
        "clientMessageId" character varying(64),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_kyc_review_messages" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_kyc_review_messages_verification_created"
      ON "kyc_review_messages" ("verificationId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_kyc_review_messages_client"
      ON "kyc_review_messages" ("verificationId", "senderId", "clientMessageId")
      WHERE "clientMessageId" IS NOT NULL
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "kyc_review_messages"
          ADD CONSTRAINT "FK_kyc_review_messages_verificationId"
          FOREIGN KEY ("verificationId") REFERENCES "driver_verifications"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "kyc_review_messages"
          ADD CONSTRAINT "FK_kyc_review_messages_senderId"
          FOREIGN KEY ("senderId") REFERENCES "user_accounts"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "kyc_review_messages" DROP CONSTRAINT IF EXISTS "FK_kyc_review_messages_senderId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "kyc_review_messages" DROP CONSTRAINT IF EXISTS "FK_kyc_review_messages_verificationId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_kyc_review_messages_client"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_kyc_review_messages_verification_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "kyc_review_messages"`);
  }
}
