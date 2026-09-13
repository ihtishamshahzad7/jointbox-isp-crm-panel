import { PgHarness, describePg, race, succeeded, failed, PG, codeOf } from '../pg';

/**
 * R1 · A3 + A4 — MONEY MUST STAY EXACT UNDER CONCURRENCY.
 *
 * These tests model the two wallet paths in SQL rather than exercising the
 * NestJS services directly, and that is a deliberate limitation worth stating
 * plainly: what is proven here is that the PATTERN the services now use is
 * correct, and that the pattern they used before was not. Proving the wired-up
 * services behave this way needs Prisma against this database, which is a
 * later step.
 *
 * What makes these worth having anyway: every one of the four defects below
 * was invisible to the 743 unit tests, because each is a property of Postgres
 * — a lock, a constraint, a transaction boundary — and a mocked client reports
 * all three as working whether they are or not.
 */
describePg('R1: wallet concurrency', () => {
  const pg = new PgHarness('wallet');

  beforeAll(() =>
    pg.setup([
      `CREATE TABLE "User" (id int PRIMARY KEY, name text, balance numeric(18,4) NOT NULL)`,
      `CREATE TABLE "Subscriber" (id int PRIMARY KEY, username text, balance numeric(18,4) NOT NULL)`,
      `CREATE TABLE "BalanceTransaction" (
         id serial PRIMARY KEY, "subscriberId" int, type text, amount numeric(18,4),
         "balanceAfter" numeric(18,4), reference text, "createdAt" timestamptz DEFAULT now())`,
      `CREATE TABLE "UserBalanceTransaction" (
         id serial PRIMARY KEY, "userId" int, type text, amount numeric(18,4),
         "balanceAfter" numeric(18,4), reference text, "createdAt" timestamptz DEFAULT now())`,
      // The two constraints ensureMoneyConstraints() creates at boot.
      `CREATE UNIQUE INDEX balance_tx_sub_ref_uq
         ON "BalanceTransaction" ("subscriberId", reference) WHERE reference IS NOT NULL`,
      `CREATE UNIQUE INDEX user_balance_tx_ref_uq
         ON "UserBalanceTransaction" ("userId", reference) WHERE reference IS NOT NULL`,
    ]),
  );
  afterAll(() => pg.teardown());

  beforeEach(async () => {
    await pg.query('TRUNCATE "User", "Subscriber", "BalanceTransaction", "UserBalanceTransaction"');
    await pg.query(`INSERT INTO "User" VALUES (1, 'Dealer Lahore', 100)`);
    await pg.query(`INSERT INTO "Subscriber" VALUES (1, 'ihtisham01', 5000)`);
  });

  // ── A3: the subscriber wallet ───────────────────────────────────────────
  /**
   * The shape `deductBalance` now uses on EVERY path: one interactive
   * transaction, row locked before the balance is read, ledger entry written
   * inside the same transaction.
   */
  const deduct = (subscriberId: number, amount: number, reference: string) =>
    pg.tx(async (c) => {
      await c.query('SELECT id FROM "Subscriber" WHERE id = $1 FOR UPDATE', [subscriberId]);

      const seen = await c.query(
        'SELECT 1 FROM "BalanceTransaction" WHERE "subscriberId" = $1 AND reference = $2',
        [subscriberId, reference],
      );
      if (seen.rowCount) return { alreadyDeducted: true };

      const cur = await c.query('SELECT balance FROM "Subscriber" WHERE id = $1', [subscriberId]);
      if (Number(cur.rows[0].balance) < amount) throw new Error('Insufficient balance');

      const upd = await c.query(
        'UPDATE "Subscriber" SET balance = balance - $2 WHERE id = $1 RETURNING balance',
        [subscriberId, amount],
      );
      await c.query(
        `INSERT INTO "BalanceTransaction" ("subscriberId", type, amount, "balanceAfter", reference)
         VALUES ($1,'RENEWAL',$2,$3,$4)`,
        [subscriberId, -amount, upd.rows[0].balance, reference],
      );
      return { alreadyDeducted: false };
    });

  it('THE POINT: 50 replays of one charge deduct exactly once', async () => {
    // This is the cron-versus-manual-renewal collision from S-03, at a scale
    // that makes the race certain rather than occasional.
    const results = await race(50, () => deduct(1, 1500, 'Auto-renewal Home 10Mbps [2026-09-01]'));

    const charged = succeeded(results).filter((r) => !r.value.alreadyDeducted).length;
    const rows = Number(await pg.scalar('SELECT count(*) FROM "BalanceTransaction"'));
    const balance = Number(await pg.scalar('SELECT balance FROM "Subscriber" WHERE id = 1'));

    expect(charged).toBe(1);
    expect(rows).toBe(1);
    expect(balance).toBe(3500); // 5000 - 1500, once
  });

  it('different references are different charges, and all of them land', async () => {
    // The guard must not be so eager that it swallows legitimate distinct
    // charges — a wallet that silently refuses real work is its own outage.
    const results = await race(5, (i) => deduct(1, 100, `CHARGE-${i}`));
    expect(succeeded(results).length).toBe(5);
    expect(Number(await pg.scalar('SELECT count(*) FROM "BalanceTransaction"'))).toBe(5);
    expect(Number(await pg.scalar('SELECT balance FROM "Subscriber" WHERE id = 1'))).toBe(4500);
  });

  it('the ledger always sums to the balance change — no money created or destroyed', async () => {
    await race(30, (i) => deduct(1, 50, `MIX-${i % 6}`)); // 6 distinct refs, 5 replays each
    const ledger = Number(await pg.scalar('SELECT COALESCE(sum(amount),0) FROM "BalanceTransaction"'));
    const balance = Number(await pg.scalar('SELECT balance FROM "Subscriber" WHERE id = 1'));
    expect(balance).toBe(5000 + ledger);
    expect(ledger).toBe(-300); // 6 × 50, each exactly once
  });

  it('the constraint is the real backstop, even with no application check at all', async () => {
    // Bypass the read-check entirely and insert straight in. The database
    // still admits exactly one — this is what makes the fix a rule rather
    // than an agreement between well-behaved callers.
    const results = await race(20, () =>
      pg.query(
        `INSERT INTO "BalanceTransaction" ("subscriberId", type, amount, "balanceAfter", reference)
         VALUES (1,'RENEWAL',-10,0,'RAW-REPLAY')`,
      ),
    );
    expect(succeeded(results).length).toBe(1);
    expect(failed(results).every((f) => codeOf(f.error) === PG.UNIQUE_VIOLATION)).toBe(true);
  });

  it('a NULL reference is exempt — adjustments without a key are not deduplicated', async () => {
    // The index is partial for a reason: manual adjustments legitimately have
    // no idempotency key, and a total unique index would reject the second one.
    const results = await race(5, () =>
      pg.query(
        `INSERT INTO "BalanceTransaction" ("subscriberId", type, amount, "balanceAfter", reference)
         VALUES (1,'ADJUSTMENT',-5,0,NULL)`,
      ),
    );
    expect(succeeded(results).length).toBe(5);
  });

  // ── A4: the reseller wallet ─────────────────────────────────────────────
  const spend = (userId: number, amount: number) =>
    pg.tx(async (c) => {
      await c.query('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', [userId]);
      const cur = await c.query('SELECT balance FROM "User" WHERE id = $1', [userId]);
      if (Number(cur.rows[0].balance) < amount) throw new Error('Insufficient balance');
      const upd = await c.query(
        'UPDATE "User" SET balance = balance - $2 WHERE id = $1 RETURNING balance',
        [userId, amount],
      );
      await c.query(
        `INSERT INTO "UserBalanceTransaction" ("userId", type, amount, "balanceAfter")
         VALUES ($1,'DEDUCT',$2,$3)`,
        [userId, -amount, upd.rows[0].balance],
      );
      return Number(upd.rows[0].balance);
    });

  it('THE POINT: a reseller wallet cannot be overdrawn by concurrent spends', async () => {
    // 100 balance, 20 callers wanting 20 each. Exactly five are affordable.
    const results = await race(20, () => spend(1, 20));

    expect(succeeded(results).length).toBe(5);
    expect(failed(results).length).toBe(15);
    expect(failed(results).every((f) => /Insufficient/.test(f.error.message))).toBe(true);
    expect(Number(await pg.scalar('SELECT balance FROM "User" WHERE id = 1'))).toBe(0);
  });

  it('never goes negative, at any concurrency', async () => {
    await race(40, () => spend(1, 7));
    const balance = Number(await pg.scalar('SELECT balance FROM "User" WHERE id = 1'));
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance).toBe(100 - 14 * 7); // 14 affordable spends of 7, then 2 left
  });

  it('every successful spend left exactly one ledger row', async () => {
    const results = await race(20, () => spend(1, 20));
    const rows = Number(await pg.scalar('SELECT count(*) FROM "UserBalanceTransaction"'));
    expect(rows).toBe(succeeded(results).length);
    // And a rolled-back spend leaves NO ledger row — the two writes are atomic.
    const ledger = Number(await pg.scalar('SELECT COALESCE(sum(amount),0) FROM "UserBalanceTransaction"'));
    expect(Number(await pg.scalar('SELECT balance FROM "User" WHERE id = 1'))).toBe(100 + ledger);
  });

  /**
   * THE REGRESSION GUARD. This is the code that was in `users.service.ts`
   * before A4 — read, check, decrement, with no transaction. It is kept here,
   * running, so the difference between the two is a measured fact in this
   * repository rather than a claim in a commit message.
   */
  it('and the OLD pattern still overdraws, which is why A4 exists', async () => {
    const results = await race(20, async (_i, sync) => {
      const cur = Number(await pg.scalar('SELECT balance FROM "User" WHERE id = 1'));
      await sync();
      if (cur < 20) throw new Error('Insufficient balance');
      await pg.query('UPDATE "User" SET balance = balance - 20 WHERE id = 1');
      return true;
    });
    expect(succeeded(results).length).toBe(20);
    expect(Number(await pg.scalar('SELECT balance FROM "User" WHERE id = 1'))).toBe(-300);
  });
});
