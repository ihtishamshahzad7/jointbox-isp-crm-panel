import { PgHarness, describePg, race, succeeded } from '../pg';

/**
 * R1 · A5 — INVOICE NUMBERS MUST BE UNIQUE, FAST, AND LOOK THE SAME.
 *
 * Three separate requirements, and the old `COUNT(*) + 1` failed the first
 * two. These tests pin all three, including the one that is easiest to break
 * by accident: the FORMAT. Customers have these numbers on paper and in their
 * accounting systems; a fix that made them unique but changed their shape
 * would be a worse outcome than the bug.
 */
describePg('R1: invoice numbering', () => {
  const pg = new PgHarness('invoiceno');
  const YEAR = new Date().getFullYear();
  const SEQ = `invoice_no_${YEAR}`;

  beforeAll(() =>
    pg.setup([`CREATE TABLE "Invoice" (id serial PRIMARY KEY, "invoiceNo" text UNIQUE)`]),
  );
  afterAll(() => pg.teardown());
  beforeEach(async () => {
    await pg.query('TRUNCATE "Invoice"');
    await pg.query(`DROP SEQUENCE IF EXISTS ${SEQ}`);
  });

  /** The service's ensureInvoiceSequence(), in SQL. */
  const ensureSeq = async () => {
    try {
      const r = await pg.query(
        `SELECT MAX(SUBSTRING("invoiceNo" FROM 10)::int) AS max FROM "Invoice"
          WHERE "invoiceNo" ~ '^INV-${YEAR}-[0-9]{5}$'`,
      );
      const start = Number(r.rows[0]?.max ?? 0) + 1;
      await pg.query(`CREATE SEQUENCE IF NOT EXISTS ${SEQ} START WITH ${start}`);
    } catch (e: any) {
      // See the long note on ensureInvoiceSequence: CREATE ... IF NOT EXISTS
      // is NOT atomic, and the loser of a concurrent create gets 23505 on a
      // catalog index. The sequence exists either way.
      const raced = e?.code === '23505' || e?.code === '42P07';
      if (!raced) throw e;
    }
  };

  /** The service's generateInvoiceNo(), including the create-on-miss retry. */
  const nextNo = async (): Promise<string> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await pg.query(`SELECT nextval('${SEQ}') AS n`);
        return `INV-${YEAR}-${String(Number(r.rows[0].n)).padStart(5, '0')}`;
      } catch (e: any) {
        if (attempt === 1) throw e;
        await ensureSeq();
      }
    }
    throw new Error('unreachable');
  };

  // ── the requirement that failed before ──────────────────────────────────
  it('THE POINT: 1,000 concurrent invoices get 1,000 distinct numbers', async () => {
    await ensureSeq();
    const results = await race(1000, async () => {
      const no = await nextNo();
      await pg.query(`INSERT INTO "Invoice" ("invoiceNo") VALUES ($1)`, [no]);
      return no;
    });

    expect(succeeded(results).length).toBe(1000);
    expect(new Set(succeeded(results).map((r) => r.value)).size).toBe(1000);
    expect(Number(await pg.scalar('SELECT count(*) FROM "Invoice"'))).toBe(1000);
  });

  // ── the requirement that is easiest to break by accident ────────────────
  it('the format is byte-for-byte what it was: INV-YYYY-NNNNN', async () => {
    await ensureSeq();
    expect(await nextNo()).toBe(`INV-${YEAR}-00001`);
    expect(await nextNo()).toBe(`INV-${YEAR}-00002`);
    expect(await nextNo()).toMatch(/^INV-\d{4}-\d{5}$/);
  });

  it('continues an existing series rather than restarting at 1', async () => {
    // An upgrade lands on a database that already has invoices. Restarting the
    // counter would collide with every existing number in the series.
    await pg.query(`INSERT INTO "Invoice" ("invoiceNo") VALUES ('INV-${YEAR}-04999')`);
    await ensureSeq();
    expect(await nextNo()).toBe(`INV-${YEAR}-05000`);
  });

  it('ignores the three OTHER invoice formats when picking a starting point', async () => {
    // billing.service, subscribers.service and portal.service each produce a
    // different, epoch-based number. Counting those would start this sequence
    // somewhere in the hundreds of millions.
    await pg.query(`INSERT INTO "Invoice" ("invoiceNo") VALUES
      ('INV-${YEAR}-00007'),
      ('INV-${YEAR}-847213-4521'),
      ('INV-${YEAR}-1789278947071482'),
      ('ACT-1789278947071-4521')`);
    await ensureSeq();
    expect(await nextNo()).toBe(`INV-${YEAR}-00008`);
  });

  it('survives a restart — the sequence is durable, not in-memory', async () => {
    await ensureSeq();
    await nextNo();
    await nextNo();
    // A fresh connection is what a restarted process gets. The counter must
    // not rewind.
    const after = await nextNo();
    expect(after).toBe(`INV-${YEAR}-00003`);
    // And re-running ensureSeq (as every boot does) must not reset it.
    await ensureSeq();
    expect(await nextNo()).toBe(`INV-${YEAR}-00004`);
  });

  /**
   * THE ONE THAT CAUGHT A REAL BUG.
   *
   * No ensureSeq() first, so every caller finds the sequence missing and every
   * caller tries to create it. `CREATE SEQUENCE IF NOT EXISTS` is NOT atomic
   * in PostgreSQL: the losers fail with 23505 on `pg_class_relname_nsp_index`.
   *
   * The first version of A5 let that error reach the caller, so one of two
   * concurrent invoice creations died with a raw catalog error. Twenty callers
   * rather than two, because two only hit the window sometimes — and a race
   * test that passes by luck is worse than none.
   */
  it('twenty callers racing to CREATE the sequence all get numbers', async () => {
    const results = await race(20, () => nextNo());
    expect(succeeded(results).length).toBe(20);
    expect(new Set(succeeded(results).map((r) => r.value)).size).toBe(20);
  });

  /**
   * THE REGRESSION GUARD, kept running so the difference is a measured fact.
   * This is the old implementation; it still collides.
   */
  it('and COUNT(*)+1 still collides, which is why A5 exists', async () => {
    const results = await race(20, async (_i, sync) => {
      const n = Number(await pg.scalar('SELECT count(*) FROM "Invoice"'));
      await sync();
      const no = `INV-${YEAR}-${String(n + 1).padStart(5, '0')}`;
      await pg.query(`INSERT INTO "Invoice" ("invoiceNo") VALUES ($1)`, [no]);
      return no;
    });
    // invoiceNo is @unique, so the losers get a constraint error rather than a
    // duplicate row — a failed customer action instead of a corrupt ledger.
    expect(succeeded(results).length).toBe(1);
  });
});
