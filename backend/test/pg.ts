import { Client, Pool, PoolClient } from 'pg';

/**
 * A REAL POSTGRES, FOR THE TESTS THAT CANNOT BE FAKED.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * The 743 unit tests in `src/` are good at what they do and structurally
 * incapable of catching the R1 defects. Every one of those is a property of
 * the DATABASE, not of a function:
 *
 *   · does `SELECT … FOR UPDATE` actually hold across two statements?
 *   · does a unique index stop a duplicate charge under real concurrency?
 *   · does a sequence hand out distinct numbers to 1,000 parallel callers?
 *   · did `CREATE INDEX CONCURRENTLY` leave behind an invalid index?
 *
 * A mocked Prisma client answers all four wrongly, and cheerfully. Postgres
 * answers them correctly or not at all.
 *
 * ── Why `pg` and not Prisma ──────────────────────────────────────────────
 * `pg` is already a dependency (`radius-sync.service.ts` uses it), so this
 * harness adds nothing to install. More importantly it gives what these tests
 * actually need and Prisma hides: a connection you can PIN, so a transaction
 * really is one session, and two clients really are two sessions racing. With
 * a pooled ORM you cannot tell whether a lock held or the pool simply handed
 * you the same connection twice.
 *
 * ── Skipping is loud, never silent ───────────────────────────────────────
 * Without TEST_DATABASE_URL these suites SKIP with a printed reason. They do
 * not pass. A green run that quietly proved nothing is how the queue-options
 * bug survived — a suite must never report success for work it did not do.
 * CI always sets the variable, so in CI they always run.
 */

export const TEST_DB_URL = process.env.TEST_DATABASE_URL || '';
export const hasPg = TEST_DB_URL.length > 0;

/**
 * Use in place of `describe`. Runs the suite when a database is configured,
 * and otherwise skips it with a reason a human can act on.
 */
export const describePg: jest.Describe = (() => {
  if (hasPg) return describe;
  const skipped: any = (name: string, fn: any) => {
    // eslint-disable-next-line no-console
    console.warn(
      `\n  SKIPPED: ${name}\n` +
        `  These tests require a real PostgreSQL. Set TEST_DATABASE_URL, e.g.\n` +
        `    docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=test postgres:16\n` +
        `    TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:integration\n` +
        `  They did NOT pass — they did not run.\n`,
    );
    return describe.skip(name, fn);
  };
  skipped.each = describe.skip.each;
  skipped.only = describe.skip;
  skipped.skip = describe.skip;
  return skipped;
})();

/**
 * A private schema per suite.
 *
 * Every suite gets its own namespace, so suites cannot see or clobber each
 * other's rows and jest may run them in parallel. Dropping the schema at the
 * end is a single statement, which is faster and more complete than
 * truncating tables one by one — and it cannot miss a table someone added.
 */
export class PgHarness {
  private pool!: Pool;
  readonly schema: string;

  constructor(name: string) {
    // Schema names are identifiers, so they are sanitised rather than escaped.
    this.schema = `t_${name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}_${process.pid}`;
  }

  async setup(ddl: string[] = []): Promise<void> {
    const admin = new Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${this.schema}`);
    await admin.end();

    this.pool = new Pool({
      connectionString: TEST_DB_URL,
      // Sized for the concurrency tests: `race()` below opens one client per
      // worker, and a pool smaller than the race would serialise the very
      // contention the test exists to create — producing a false pass.
      max: 30,
      options: `-c search_path=${this.schema}`,
    });
    for (const stmt of ddl) await this.pool.query(stmt);
  }

  async teardown(): Promise<void> {
    await this.pool?.end();
    const admin = new Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
    await admin.end();
  }

  query<T extends Record<string, any> = any>(sql: string, params: any[] = []) {
    return this.pool.query<T>(sql, params);
  }

  /** One value from one row — the common shape in an assertion. */
  async scalar<T = any>(sql: string, params: any[] = []): Promise<T> {
    const r = await this.pool.query(sql, params);
    return r.rows[0] ? (Object.values(r.rows[0])[0] as T) : (undefined as any);
  }

  /**
   * Run `fn` inside one transaction on ONE pinned connection.
   *
   * The pinning is the point. A row lock belongs to a transaction, and a
   * transaction belongs to a connection. Code that takes `FOR UPDATE` on a
   * pooled client and then writes through the pool has not locked anything —
   * that is finding S-03 exactly, and this helper is how a test can tell the
   * difference between holding a lock and appearing to.
   */
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

/** What one worker in a race did. Errors are recorded, never thrown. */
export type RaceOutcome<T> = { ok: true; value: T } | { ok: false; error: Error };

/**
 * Run `n` copies of an operation as simultaneously as this runtime allows, and
 * report every outcome.
 *
 * ── Why errors are captured rather than thrown ───────────────────────────
 * In a correct concurrent design most workers are SUPPOSED to fail. Nine of
 * ten spends hitting "insufficient balance", or 999 of 1,000 inserts hitting a
 * unique violation, is the system working. `Promise.all` rejects on the first
 * of those and hides the other 999, so the test learns nothing about the
 * distribution — which is the only thing worth measuring.
 *
 * ── On "simultaneously" ──────────────────────────────────────────────────
 * Node is single-threaded, so these start in the same tick and then interleave
 * at every await. That is enough to expose read-modify-write races and lock
 * behaviour, because the window in those bugs is an await, not a CPU
 * instruction. It is NOT a substitute for load testing across processes, and
 * a green result here is not proof of behaviour under real production
 * parallelism.
 */
export async function race<T>(
  n: number,
  op: (i: number, sync: Barrier) => Promise<T>,
): Promise<RaceOutcome<T>[]> {
  const sync = makeBarrier(n);
  const started = Array.from({ length: n }, (_, i) =>
    op(i, sync).then(
      (value): RaceOutcome<T> => ({ ok: true, value }),
      (error): RaceOutcome<T> => ({ ok: false, error: error as Error }),
    ),
  );
  return Promise.all(started);
}

/** Await it to wait until every worker in the race has reached the same point. */
export type Barrier = () => Promise<void>;

/**
 * A RENDEZVOUS, BECAUSE A TIMING-DEPENDENT TEST IS WORSE THAN NO TEST.
 *
 * The first version of the lost-update test relied on `setTimeout` to hold the
 * read-check-write window open long enough for the workers to overlap. It
 * passed, then failed on the next run with exactly 5 successes instead of 10:
 * Node's scheduling happened to let some workers finish before others read.
 *
 * A flaky demonstration of a race is useless — nobody can tell a real
 * regression from the usual noise, and within a week everyone re-runs it until
 * it goes green. So the overlap is made explicit instead of hoped for: every
 * worker reads, all of them wait here until the last one has read, and only
 * then do they write. That is precisely the condition a lost update needs, and
 * it now happens every single time.
 *
 * This does NOT weaken the test. "N callers observed the same value before any
 * of them wrote" is the definition of the bug, not an artificial setup for it.
 */
function makeBarrier(n: number): Barrier {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return () => {
    if (++arrived >= n) release();
    return gate;
  };
}

export const succeeded = <T>(rs: RaceOutcome<T>[]) => rs.filter((r): r is { ok: true; value: T } => r.ok);
export const failed = <T>(rs: RaceOutcome<T>[]) => rs.filter((r): r is { ok: false; error: Error } => !r.ok);

/** Postgres error codes these tests assert on, by name rather than number. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  CHECK_VIOLATION: '23514',
} as const;

export const codeOf = (e: any): string | undefined => e?.code;
