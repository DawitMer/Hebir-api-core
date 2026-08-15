import { QueryRunner } from 'typeorm';

/**
 * True when this database was bootstrapped by the InitialSchema baseline
 * migration (fresh install). Legacy migrations predate the baseline and are
 * already folded into it, so they must skip themselves in that case.
 */
export async function bootstrappedFromBaseline(
  queryRunner: QueryRunner,
): Promise<boolean> {
  const rows: Array<{ t: string | null }> = await queryRunner.query(
    "SELECT to_regclass('public.schema_bootstrap') AS t",
  );
  return Boolean(rows[0]?.t);
}
