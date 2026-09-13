import { PgHarness, describePg, race, succeeded, failed, PG, codeOf, hasPg } from '../pg';

/**
 * THE HARNESS TESTS ITSELF FIRST.
 *
 * Everything in R1 will be judged by this code. If `race()` does not actually
 * create contention, or `tx()` does not actually pin a connection, then every
 * concurrency test built on it is decoration — it would report that the wallet
 * is safe whether or not it is.
 *
 * So before trusting it to judge the wallet, it is made to demonstrate on
 * known-correct and known-broken SQL that it can tell the two apart.
 */
describePg('integration harness', () => {
  const pg = new PgHarness('harness');

  beforeAll(() =>
    pg.setup([
      `CREATE TABLE acct (id int PRIMARY KEY, balance numeric(18,4) NOT NULL)`,
      `CREATE TABLE charge (id serial PRIMARY KEY, acct_id int NOT NULL, ref text NOT NULL)`,
    ]),
  );
  afterAll(() => pg.teardown());
  beforeEach(async () => {
    await pg.query('TRUNCATE acct, charge');
    // TRUNCATE empties tables; it does not drop indexes. Without this line the
    // "without the index" case below inherited `charge_uq` from the case above
    // and reported 1 insert instead of 20 — a false PASS for the very
    // behaviour it exists to demonstrate. Found by running it.
    await pg.query('DROP INDEX IF EXISTS charge_uq');
    await pg.query('INSERT INTO acct VALUES (1, 100)');
  });

  it('connects to a real PostgreSQL, not a mock', async () => {
    expect(await pg.scalar<string>('SELECT version()')).toMatch(/PostgreSQL/);
  });

  it('isolates each suite in its own schema', async () => {
    expect(await pg.scalar<string>('SELECT current_schema()')).toBe(pg.schema);
  });

  // ── the harness must be able to SEE a race ──────────────────────────────
  /**
   * This is the load-bearing test. It reproduces finding S-04 in SQL — read
   * the balance, check it, then decrement — and asserts the harness catches
   * the overspend. If this ever passes with a correct final balance, `race()`
   * has stopped creating contention and every concurrency result in this
   * repository has become meaningless.
   */
  it('DETECTS a lost update: check-then-write lets the balance go negative', async () => {
    const results = await race(10, async (_i, sync) => {
      const cur = Number(await pg.scalar('SELECT balance FROM acct WHERE id = 1'));
      await sync(); // every worker has now read 100 — the lost-update condition
      if (cur < 20) throw new Error('insufficient');
      await pg.query('UPDATE acct SET balance = balance - 20 WHERE id = 1');
      return true;
    });

    const balance = Number(await pg.scalar('SELECT balance FROM acct WHERE id = 1'));
    // All ten read 100, all ten judged 20 affordable, all ten decremented.
    expect(succeeded(results).length).toBe(10);
    expect(balance).toBe(-100);
  });

  /**
   * And the same operation done correctly must come out exact. Without this
   * pair the test above proves only that the harness can fail things.
   */
  it('and CONFIRMS the fix: one pinned transaction per spend keeps it exact', async () => {
    const results = await race(10, async () =>
      pg.tx(async (c) => {
        // No barrier here: FOR UPDATE serialises these by design, so a
        // rendezvous inside the lock would deadlock the test. That the two
        // cases need different treatment IS the finding — one has a lock and
        // one only appears to.
        const r = await c.query('SELECT balance FROM acct WHERE id = 1 FOR UPDATE');
        if (Number(r.rows[0].balance) < 20) throw new Error('insufficient');
        await c.query('UPDATE acct SET balance = balance - 20 WHERE id = 1');
        return true;
      }),
    );

    expect(succeeded(results).length).toBe(5);
    expect(failed(results).length).toBe(5);
    expect(Number(await pg.scalar('SELECT balance FROM acct WHERE id = 1'))).toBe(0);
  });

  // ── unique constraints under concurrency ────────────────────────────────
  /**
   * The R1 fix for the subscriber wallet is a unique index on
   * (subscriberId, reference). This proves the mechanism does what that fix
   * depends on: exactly one winner, and the losers fail with 23505 — a code
   * the application can catch and treat as "already charged" rather than an
   * error to surface.
   */
  it('a unique index admits exactly one of N identical concurrent inserts', async () => {
    await pg.query('CREATE UNIQUE INDEX charge_uq ON charge (acct_id, ref)');

    const results = await race(20, () =>
      pg.query('INSERT INTO charge (acct_id, ref) VALUES (1, $1)', ['RENEWAL-2026-09-13']),
    );

    expect(succeeded(results).length).toBe(1);
    expect(failed(results).every((f) => codeOf(f.error) === PG.UNIQUE_VIOLATION)).toBe(true);
    expect(Number(await pg.scalar('SELECT count(*) FROM charge'))).toBe(1);
  });

  it('without the index, all 20 duplicates are stored — which is today', async () => {
    const results = await race(20, () =>
      pg.query('INSERT INTO charge (acct_id, ref) VALUES (1, $1)', ['RENEWAL-2026-09-13']),
    );
    expect(succeeded(results).length).toBe(20);
    expect(Number(await pg.scalar('SELECT count(*) FROM charge'))).toBe(20);
  });

  // ── sequences, for A5 ───────────────────────────────────────────────────
  it('a sequence gives 500 concurrent callers 500 distinct values', async () => {
    await pg.query('CREATE SEQUENCE inv_seq');
    const results = await race(500, () => pg.scalar<string>("SELECT nextval('inv_seq')"));
    const values = succeeded(results).map((r) => r.value);
    expect(values.length).toBe(500);
    expect(new Set(values).size).toBe(500);
  });

  /**
   * COUNT(*)+1 is the current scheme. Shown failing here so the replacement is
   * justified by a demonstration rather than by assertion.
   */
  it('COUNT(*)+1 hands the same number to concurrent callers', async () => {
    await pg.query('CREATE TABLE inv (id serial PRIMARY KEY, no text)');
    const results = await race(20, async (_i, sync) => {
      const n = Number(await pg.scalar('SELECT count(*) FROM inv'));
      await sync(); // all twenty have now counted the same empty table
      await pg.query('INSERT INTO inv (no) VALUES ($1)', [`INV-2026-${String(n + 1).padStart(5, '0')}`]);
      return n + 1;
    });
    const distinct = Number(await pg.scalar('SELECT count(DISTINCT no) FROM inv'));
    expect(succeeded(results).length).toBe(20);
    expect(distinct).toBeLessThan(20); // collisions, exactly as invoices.service.ts:199 would
  });
});

// Fails the run if someone deletes TEST_DATABASE_URL from CI and expects green.
describe('integration harness wiring', () => {
  it('reports clearly whether a database was available', () => {
    if (process.env.CI && !hasPg) {
      throw new Error('CI must provide TEST_DATABASE_URL — integration tests cannot be skipped in CI.');
    }
    if (!hasPg) {
      // Printed from a test body rather than a describe body on purpose: jest
      // buffers console output during collection, so a warning emitted while
      // building the suite is swallowed and the developer sees a silent green
      // run. Here it always reaches the terminal.
      // eslint-disable-next-line no-console
      console.warn(
        '\n  NO DATABASE — every integration test above was SKIPPED, not passed.\n' +
          '  To run them:\n' +
          '    docker run -d --name jbpg -p 5433:5432 -e POSTGRES_PASSWORD=test postgres:16\n' +
          '    TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:integration\n',
      );
    }
    expect(typeof hasPg).toBe('boolean');
  });
});
