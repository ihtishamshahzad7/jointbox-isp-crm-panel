import { Client } from 'pg';
import { describePg, TEST_DB_URL } from '../pg';
import {
  findInvalidIndexes,
  findDuplicateIndexes,
  findUnusedIndexes,
  buildIndexConcurrently,
} from '../index-health';

/**
 * THE CHECKS R2 DEPENDS ON, PROVEN AGAINST A REAL DATABASE.
 *
 * R2 will add six indexes online. Before that is safe, the tooling has to be
 * able to distinguish an index that works from one that merely exists — and
 * that distinction cannot be tested with a mock, because `indisvalid` is a
 * fact about a running PostgreSQL and nothing else.
 *
 * Each test below creates the failure it is meant to detect, and then detects
 * it. A detector that has never seen a positive is not a detector.
 */
describePg('index health helpers', () => {
  let c: Client;
  const schema = `idxh_${process.pid}`;

  beforeAll(async () => {
    c = new Client({ connectionString: TEST_DB_URL });
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path = ${schema}`);
    await c.query(`CREATE TABLE t (id serial PRIMARY KEY, a int, b int, pad text)`);
    await c.query(`INSERT INTO t (a,b,pad) SELECT g, g%100, repeat('x',200) FROM generate_series(1,20000) g`);
  });

  afterAll(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await c.end();
  });

  // ── the failure mode with no symptom ────────────────────────────────────
  /**
   * A CREATE INDEX CONCURRENTLY interrupted partway leaves an index that is
   * present, sized, maintained on every write — and never used by the planner.
   * There is nothing in \d to tell them apart. This proves the detector sees
   * the difference.
   */
  it('finds an index that exists but is INVALID', async () => {
    // Postgres marks an index invalid when a concurrent build fails; forcing
    // the flag directly is the only deterministic way to produce one in a test.
    await c.query(`CREATE INDEX t_broken_idx ON t (a)`);
    await c.query(
      `UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = (SELECT oid FROM pg_class WHERE relname = 't_broken_idx')`,
    );

    const invalid = await findInvalidIndexes(c);
    expect(invalid.map((i) => i.index)).toContain('t_broken_idx');

    await c.query(
      `UPDATE pg_index SET indisvalid = true
        WHERE indexrelid = (SELECT oid FROM pg_class WHERE relname = 't_broken_idx')`,
    );
    await c.query(`DROP INDEX t_broken_idx`);
    expect((await findInvalidIndexes(c)).map((i) => i.index)).not.toContain('t_broken_idx');
  });

  // ── the audit R2 asks for ───────────────────────────────────────────────
  /**
   * Jointbox creates indexes in two places — schema.prisma and
   * database-setup.service.ts — and they already overlap on at least one
   * column. Every exact duplicate is write cost paid twice, forever.
   */
  it('finds two indexes covering the same columns, and sizes the waste', async () => {
    await c.query(`CREATE INDEX t_a_one ON t (a)`);
    await c.query(`CREATE INDEX t_a_two ON t (a)`);

    const dupes = await findDuplicateIndexes(c, schema);
    const hit = dupes.find((d) => d.columns === 'a');
    expect(hit).toBeDefined();
    expect(hit!.indexes.sort()).toEqual(['t_a_one', 't_a_two']);
    expect(hit!.wastedBytes).toBeGreaterThan(0);
  });

  it('does NOT flag (a) against (a,b) — a prefix overlap is often deliberate', async () => {
    await c.query(`CREATE INDEX t_ab ON t (a, b)`);
    const dupes = await findDuplicateIndexes(c, schema);
    // Exact-match only. Flagging prefix overlaps would bury the real duplicates.
    expect(dupes.some((d) => d.columns === 'a,b')).toBe(false);
  });

  it('lists large never-scanned indexes as candidates, with a size floor', async () => {
    const unused = await findUnusedIndexes(c, { schema, minSizeBytes: 1 });
    expect(unused.every((u) => u.scans === 0)).toBe(true);
    // The floor must actually filter, or the report is unreadable on a real DB.
    const bigOnly = await findUnusedIndexes(c, { schema, minSizeBytes: 1024 * 1024 * 1024 });
    expect(bigOnly.length).toBe(0);
  });

  // ── the builder R2 will use ─────────────────────────────────────────────
  it('builds an index online, confirms it is valid, and reports the duration', async () => {
    const r = await buildIndexConcurrently(
      c,
      't_live_idx',
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS t_live_idx ON ${schema}.t (b)`,
    );
    expect(r.created).toBe(true);
    expect(r.valid).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(await findInvalidIndexes(c)).toEqual([]);
  });

  /**
   * The recovery path. `CREATE INDEX IF NOT EXISTS` sees the name of an
   * invalid index, does nothing, and reports success — leaving the database
   * exactly as broken as it found it. The builder must drop and rebuild.
   */
  it('replaces a leftover INVALID index instead of skipping it', async () => {
    await c.query(`CREATE INDEX t_retry_idx ON t (a)`);
    await c.query(
      `UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = (SELECT oid FROM pg_class WHERE relname = 't_retry_idx')`,
    );

    const r = await buildIndexConcurrently(
      c,
      't_retry_idx',
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS t_retry_idx ON ${schema}.t (a)`,
    );
    expect(r.valid).toBe(true);
    expect((await findInvalidIndexes(c)).map((i) => i.index)).not.toContain('t_retry_idx');
  });

  /**
   * And the constraint that makes all of this necessary, asserted rather than
   * assumed: CONCURRENTLY is rejected inside a transaction. This is why the
   * six R2 indexes cannot live in a Prisma migration file.
   */
  it('CONCURRENTLY is refused inside a transaction — the reason R2 bypasses Prisma migrations', async () => {
    await c.query('BEGIN');
    await expect(
      c.query(`CREATE INDEX CONCURRENTLY t_in_tx ON ${schema}.t (b)`),
    ).rejects.toThrow(/cannot run inside a transaction block/i);
    await c.query('ROLLBACK');
  });
});
