import { Client } from 'pg';

/**
 * INDEX HEALTH — the checks R2 cannot be done safely without.
 *
 * R2 adds indexes online with CREATE INDEX CONCURRENTLY. That command has a
 * failure mode with no symptom: if it is interrupted — a deploy, a lock
 * timeout, a cancelled query — Postgres leaves behind an index marked
 * `indisvalid = false`. It appears in \d, it consumes disk, it is maintained
 * on every write, and **the planner never uses it**. The operator sees an
 * index named exactly what they expected and a query that is still slow.
 *
 * So "the index exists" is not the check. "The index exists AND is valid" is.
 *
 * The other two functions here exist because R2's brief says audit before
 * adding. This codebase creates indexes in two places — `schema.prisma` and
 * `database-setup.service.ts` — and they already overlap at least once
 * (`Subscriber_userId_idx` and `subscriber_owner_idx` are the same column).
 * Every duplicate is paid for on every INSERT, UPDATE and DELETE, forever.
 */

export type InvalidIndex = { schema: string; table: string; index: string };
export type DuplicateIndex = { table: string; columns: string; indexes: string[]; wastedBytes: number };
export type UnusedIndex = { table: string; index: string; sizeBytes: number; scans: number };

/** Indexes Postgres is maintaining but will never use. */
export async function findInvalidIndexes(c: Client): Promise<InvalidIndex[]> {
  const { rows } = await c.query(`
    SELECT n.nspname AS schema, t.relname AS table, i.relname AS index
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = i.relnamespace
     WHERE NOT x.indisvalid
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY 1, 2, 3`);
  return rows;
}

/**
 * Indexes covering the identical column list on the identical table.
 *
 * Deliberately exact-match rather than prefix-match. A prefix overlap — an
 * index on (a) alongside one on (a, b) — is often a legitimate trade-off, and
 * flagging it would bury the unambiguous cases in noise. Exact duplicates are
 * never intentional.
 */
export async function findDuplicateIndexes(c: Client, schema = 'public'): Promise<DuplicateIndex[]> {
  const { rows } = await c.query(
    `
    WITH idx AS (
      SELECT t.relname AS tbl,
             i.relname AS idx,
             pg_relation_size(i.oid) AS bytes,
             (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS cols
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = i.relnamespace
       WHERE n.nspname = $1 AND x.indisvalid AND NOT x.indisprimary
    )
    SELECT tbl AS table, cols AS columns,
           -- ::text is load-bearing. pg_class.relname has type "name", and
           -- array_agg over it returns name[] - for which node-postgres has no
           -- type parser, so the driver hands back the raw literal
           -- {t_a_one,t_a_two} as a STRING rather than an array. Casting to
           -- text yields text[], which parses. Found by a test calling .sort()
           -- on the result.
           array_agg(idx::text ORDER BY idx) AS indexes,
           (sum(bytes) - max(bytes))::bigint AS "wastedBytes"
      FROM idx
     WHERE cols IS NOT NULL
     GROUP BY tbl, cols
    HAVING count(*) > 1
     ORDER BY 4 DESC`,
    [schema],
  );
  return rows.map((r) => ({ ...r, wastedBytes: Number(r.wastedBytes) }));
}

/**
 * Indexes never once scanned since statistics were last reset.
 *
 * READ THIS BEFORE DROPPING ANYTHING. Zero scans does not mean useless:
 *
 *   · statistics reset on the last `pg_stat_reset()` or a restore, so a young
 *     database says everything is unused;
 *   · a unique index enforces a constraint whether or not anything reads it;
 *   · an index may serve a quarterly report that has not run yet.
 *
 * This is a list of candidates for a human to think about, never a list of
 * things to drop. `minSizeBytes` filters out the small ones, where the write
 * cost is not worth anyone's attention.
 */
export async function findUnusedIndexes(
  c: Client,
  { schema = 'public', minSizeBytes = 10 * 1024 * 1024 } = {},
): Promise<UnusedIndex[]> {
  const { rows } = await c.query(
    `
    SELECT s.relname AS table, s.indexrelname AS index,
           pg_relation_size(s.indexrelid)::bigint AS "sizeBytes",
           s.idx_scan::bigint AS scans
      FROM pg_stat_user_indexes s
      JOIN pg_index x ON x.indexrelid = s.indexrelid
     WHERE s.schemaname = $1
       AND s.idx_scan = 0
       AND NOT x.indisprimary
       AND NOT x.indisunique
       AND pg_relation_size(s.indexrelid) >= $2
     ORDER BY 3 DESC`,
    [schema, minSizeBytes],
  );
  return rows.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes), scans: Number(r.scans) }));
}

export type BuildResult = { index: string; created: boolean; valid: boolean; ms: number; error?: string };

/**
 * Build one index online, then verify it actually came out usable.
 *
 * This is the shape `DatabaseSetupService.ensureIndexes()` should adopt in R2.
 * Three things it does that a bare `$executeRawUnsafe` does not:
 *
 *   1. Times the build. An index that takes eleven minutes on production is
 *      something the operator must learn from a log line, not from a customer.
 *   2. Checks `indisvalid` afterwards, so a silently-invalid index becomes a
 *      visible failure.
 *   3. Drops and retries once when it finds one invalid — the only safe
 *      recovery, since an invalid index cannot be repaired in place.
 *
 * The statement MUST NOT be inside a transaction. CREATE INDEX CONCURRENTLY
 * is rejected outright in a transaction block, which is why this takes a raw
 * `Client` rather than anything that might wrap it.
 */
export async function buildIndexConcurrently(
  c: Client,
  indexName: string,
  sql: string,
): Promise<BuildResult> {
  const started = Date.now();
  const isValid = async () =>
    (
      await c.query(
        `SELECT x.indisvalid FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE i.relname = $1`,
        [indexName],
      )
    ).rows[0]?.indisvalid ?? null;

  try {
    // An invalid leftover from a previous interrupted attempt must go first —
    // CREATE INDEX IF NOT EXISTS would see the name, do nothing, and report
    // success while the index stayed unusable.
    if ((await isValid()) === false) {
      await c.query(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
    }
    await c.query(sql);
    const valid = (await isValid()) === true;
    return { index: indexName, created: true, valid, ms: Date.now() - started };
  } catch (e: any) {
    return {
      index: indexName,
      created: false,
      valid: (await isValid()) === true,
      ms: Date.now() - started,
      error: String(e?.message || e).split('\n')[0],
    };
  }
}
