import { MigrationInterface, QueryRunner } from 'typeorm';

export class SupportMessageIdempotency1788456200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE support_messages ADD COLUMN "clientMessageId" uuid',
    );
    await runner.query(
      'CREATE UNIQUE INDEX "UQ_support_messages_client" ON support_messages ("threadId", "senderId", "clientMessageId")',
    );
    await runner.query(
      'CREATE INDEX "IDX_support_messages_page" ON support_messages ("threadId", "createdAt" DESC, id DESC)',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX "IDX_support_messages_page"');
    await runner.query('DROP INDEX "UQ_support_messages_client"');
    await runner.query(
      'ALTER TABLE support_messages DROP COLUMN "clientMessageId"',
    );
  }
}
