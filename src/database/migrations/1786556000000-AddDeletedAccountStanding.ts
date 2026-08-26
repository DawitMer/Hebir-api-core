import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeletedAccountStanding1786556000000 implements MigrationInterface {
  name = 'AddDeletedAccountStanding1786556000000';

  // ADD VALUE cannot run inside a failed transaction on some PG versions.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE public.user_accounts_standing_enum ADD VALUE IF NOT EXISTS 'deleted'
    `);
  }

  public async down(): Promise<void> {
    // Postgres cannot cheaply remove an enum value; leave 'deleted' in place.
  }
}
