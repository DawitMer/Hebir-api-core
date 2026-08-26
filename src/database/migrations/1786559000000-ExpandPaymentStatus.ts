import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cash rides need distinct states from PSP pending/succeeded.
 * ADD VALUE is additive — existing `pending` rows stay as-is.
 */
export class ExpandPaymentStatus1786559000000 implements MigrationInterface {
  name = 'ExpandPaymentStatus1786559000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE public.payments_status_enum ADD VALUE IF NOT EXISTS 'authorized'`,
    );
    await queryRunner.query(
      `ALTER TYPE public.payments_status_enum ADD VALUE IF NOT EXISTS 'cash_pending'`,
    );
    await queryRunner.query(
      `ALTER TYPE public.payments_status_enum ADD VALUE IF NOT EXISTS 'cash_collected'`,
    );
    await queryRunner.query(
      `ALTER TYPE public.payments_status_enum ADD VALUE IF NOT EXISTS 'refunded'`,
    );
    await queryRunner.query(
      `ALTER TYPE public.payments_status_enum ADD VALUE IF NOT EXISTS 'partially_refunded'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot cheaply remove enum values; leave the extras in place.
  }
}
