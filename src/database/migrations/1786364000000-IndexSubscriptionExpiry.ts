import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * Speeds subscription expiry cron filters:
 *   ACTIVE  WHERE expiresAt <= now
 *   PAST_DUE WHERE gracePeriodEndsAt <= now
 */
export class IndexSubscriptionExpiry1786364000000 implements MigrationInterface {
  name = 'IndexSubscriptionExpiry1786364000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_subscriptions_active_expires"
        ON "driver_subscriptions" ("state", "expiresAt")
        WHERE "expiresAt" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_driver_subscriptions_past_due_grace"
        ON "driver_subscriptions" ("state", "gracePeriodEndsAt")
        WHERE "gracePeriodEndsAt" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_driver_subscriptions_past_due_grace"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_driver_subscriptions_active_expires"`,
    );
  }
}
