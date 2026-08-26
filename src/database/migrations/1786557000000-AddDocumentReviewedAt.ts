import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ops-approval timestamp for each KYC file. Drivers keep this date on file
 * (Uber/Lyft style) and cannot replace an approved document until it expires.
 */
export class AddDocumentReviewedAt1786557000000 implements MigrationInterface {
  name = 'AddDocumentReviewedAt1786557000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "document_submissions"
      ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "document_submissions"
      DROP COLUMN IF EXISTS "reviewedAt"
    `);
  }
}
