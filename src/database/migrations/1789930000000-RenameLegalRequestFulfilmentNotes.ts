import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The intake table was created with "fulfilNotes". The entity and API
 * read "fulfilmentNotes", so listing requests failed with 42703.
 */
export class RenameLegalRequestFulfilmentNotes1789930000000
  implements MigrationInterface
{
  name = 'RenameLegalRequestFulfilmentNotes1789930000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'gov_legal_requests'
            AND column_name = 'fulfilNotes'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'gov_legal_requests'
            AND column_name = 'fulfilmentNotes'
        ) THEN
          ALTER TABLE "gov_legal_requests"
            RENAME COLUMN "fulfilNotes" TO "fulfilmentNotes";
        ELSIF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'gov_legal_requests'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'gov_legal_requests'
            AND column_name = 'fulfilmentNotes'
        ) THEN
          ALTER TABLE "gov_legal_requests"
            ADD COLUMN "fulfilmentNotes" text;
        END IF;
      END $$;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'gov_legal_requests'
            AND column_name = 'fulfilmentNotes'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'gov_legal_requests'
            AND column_name = 'fulfilNotes'
        ) THEN
          ALTER TABLE "gov_legal_requests"
            RENAME COLUMN "fulfilmentNotes" TO "fulfilNotes";
        END IF;
      END $$;
    `);
  }
}
