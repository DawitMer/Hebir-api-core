import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * `@CreateDateColumn()` / `@UpdateDateColumn()` default to `timestamp without
 * time zone`, while every explicitly-declared date column is `timestamptz`.
 * The two mixed freely on the same row (rides."createdAt" naive vs
 * rides."requestedAt" aware), so `createdAt - requestedAt` silently depended
 * on the session TimeZone: correct while the app and database agree, off by
 * the UTC offset as soon as they do not (deploying to a UTC database with a
 * non-UTC app host, or across a DST boundary).
 *
 * Existing naive values were written as the app host's wall clock, which is
 * also how Postgres already interpreted them whenever they were compared with
 * a timestamptz. Converting with the session TimeZone therefore preserves
 * every value exactly as queries see it today.
 */
const NAIVE_TIMESTAMP_COLUMNS: Array<[table: string, column: string]> = [
  ['audit_trails', 'occurredAt'],
  ['bookings', 'createdAt'],
  ['bookings', 'updatedAt'],
  ['compliance_alerts', 'raisedAt'],
  ['configuration', 'updatedAt'],
  ['document_submissions', 'submittedAt'],
  ['driver_earnings', 'createdAt'],
  ['driver_expenses', 'submittedAt'],
  ['driver_profiles', 'createdAt'],
  ['driver_profiles', 'updatedAt'],
  ['driver_subscriptions', 'createdAt'],
  ['driver_subscriptions', 'updatedAt'],
  ['driver_verifications', 'submittedAt'],
  ['driver_verifications', 'updatedAt'],
  ['fares', 'createdAt'],
  ['gov_access_logs', 'accessedAt'],
  ['payment_events', 'receivedAt'],
  ['payments', 'createdAt'],
  ['payments', 'updatedAt'],
  ['ratings', 'createdAt'],
  ['rider_requests', 'queuedAt'],
  ['rides', 'createdAt'],
  ['rides', 'updatedAt'],
  ['subscription_status_history', 'occurredAt'],
  ['tips', 'createdAt'],
  ['trips', 'createdAt'],
  ['trips', 'updatedAt'],
  ['user_accounts', 'createdAt'],
  ['user_accounts', 'updatedAt'],
  ['vehicles', 'createdAt'],
  ['vehicles', 'updatedAt'],
];

export class TimestamptzEverywhere1786365300000 implements MigrationInterface {
  name = 'TimestamptzEverywhere1786365300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    for (const [table, column] of NAIVE_TIMESTAMP_COLUMNS) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ALTER COLUMN "${column}" TYPE TIMESTAMP WITH TIME ZONE
        USING "${column}" AT TIME ZONE current_setting('TimeZone')
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of [...NAIVE_TIMESTAMP_COLUMNS].reverse()) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ALTER COLUMN "${column}" TYPE TIMESTAMP WITHOUT TIME ZONE
        USING "${column}" AT TIME ZONE current_setting('TimeZone')
      `);
    }
  }
}
