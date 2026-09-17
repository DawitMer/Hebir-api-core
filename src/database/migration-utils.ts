import { QueryRunner } from 'typeorm';

/**
 * True when this database was bootstrapped by the InitialSchema baseline
 * migration (fresh install). Legacy migrations predate the baseline and are
 * already folded into it, so they must skip themselves in that case.
 */
export async function bootstrappedFromBaseline(
  queryRunner: QueryRunner,
): Promise<boolean> {
  const reg: Array<{ t: string | null }> = await queryRunner.query(
    "SELECT to_regclass('public.schema_bootstrap') AS t",
  );
  if (!reg[0]?.t) return false;
  const rows: Array<{ cnt: string }> = await queryRunner.query(
    'SELECT count(*)::text AS cnt FROM public.schema_bootstrap WHERE id = 1',
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

