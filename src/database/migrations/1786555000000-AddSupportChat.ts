import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSupportChat1786555000000 implements MigrationInterface {
  name = 'AddSupportChat1786555000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "support_threads" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "userRole" character varying(20) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'open',
        "assignedAgentId" uuid,
        "lastMessageAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_threads" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_support_threads_user_status"
      ON "support_threads" ("userId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_support_threads_last_message"
      ON "support_threads" ("lastMessageAt")
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "support_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "threadId" uuid NOT NULL,
        "senderId" uuid NOT NULL,
        "senderRole" character varying(20) NOT NULL,
        "senderName" character varying(120) NOT NULL,
        "body" character varying(2000) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_support_messages" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_support_messages_thread_created"
      ON "support_messages" ("threadId", "createdAt")
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "support_threads"
          ADD CONSTRAINT "FK_support_threads_userId"
          FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "support_messages"
          ADD CONSTRAINT "FK_support_messages_threadId"
          FOREIGN KEY ("threadId") REFERENCES "support_threads"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "support_messages" DROP CONSTRAINT IF EXISTS "FK_support_messages_threadId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_threads" DROP CONSTRAINT IF EXISTS "FK_support_threads_userId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_support_messages_thread_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "support_messages"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_support_threads_last_message"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_support_threads_user_status"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "support_threads"`);
  }
}
