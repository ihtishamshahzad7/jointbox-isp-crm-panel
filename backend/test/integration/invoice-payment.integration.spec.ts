import { PgHarness, describePg } from '../pg';

/**
 * TWO PAYMENTS ON ONE INVOICE AT THE SAME MOMENT.
 *
 * InvoicesService.recordPayment used to read the invoice, create the Payment,
 * then write `paidAmount = readValue + amount`. Two cashiers (or a cashier and
 * a gateway callback) both read the same paidAmount, and the second write
 * erased the first: the Payment rows said 1000 was received, the invoice said
 * 500. It now locks the invoice row (SELECT … FOR UPDATE), re-reads it and
 * re-checks what is due inside one transaction. Both shapes run here against
 * PostgreSQL under real concurrency.
 */
describePg('invoice payment: concurrent cashiers', () => {
  const pg = new PgHarness('invpay');

  beforeAll(() =>
    pg.setup([
      `CREATE TABLE "Invoice" (id int PRIMARY KEY, total numeric(18,4), "paidAmount" numeric(18,4) NOT NULL DEFAULT 0, status text NOT NULL)`,
      `CREATE TABLE "Payment" (id serial PRIMARY KEY, "paymentNo" text UNIQUE, "invoiceId" int, amount numeric(18,4))`,
    ]),
  );
  afterAll(() => pg.teardown());

  beforeEach(async () => {
    await pg.query('TRUNCATE "Invoice", "Payment"');
    await pg.query(`INSERT INTO "Invoice" VALUES (1, 1000, 0, 'UNPAID')`);
  });

  const pause = () => new Promise((r) => setTimeout(r, 30));
  let n = 0;

  /** The shape recordPayment now uses (staff path: cannot overpay). */
  const payNow = (amount: number) =>
    pg.tx(async (c) => {
      await c.query('SELECT id FROM "Invoice" WHERE id = 1 FOR UPDATE');
      const { rows } = await c.query('SELECT total, "paidAmount", status FROM "Invoice" WHERE id = 1');
      const due = Number(rows[0].total) - Number(rows[0].paidAmount);
      if (rows[0].status === 'PAID' || amount > due + 0.5) return 'refused';
      await pause();
      const paid = Number(rows[0].paidAmount) + amount;
      await c.query(`INSERT INTO "Payment" ("paymentNo", "invoiceId", amount) VALUES ($1, 1, $2)`, [`P-${++n}`, amount]);
      await c.query(`UPDATE "Invoice" SET "paidAmount" = $1, status = $2 WHERE id = 1`, [paid, paid >= 1000 ? 'PAID' : 'PARTIAL']);
      return 'recorded';
    });

  /** The shape it used before: read, then write outside any lock. */
  const payBefore = async (amount: number) => {
    const { rows } = await pg.query('SELECT "paidAmount" FROM "Invoice" WHERE id = 1');
    await pause();
    await pg.query(`INSERT INTO "Payment" ("paymentNo", "invoiceId", amount) VALUES ($1, 1, $2)`, [`B-${++n}`, amount]);
    await pg.query(`UPDATE "Invoice" SET "paidAmount" = $1 WHERE id = 1`, [Number(rows[0].paidAmount) + amount]);
  };

  const totals = async () => ({
    payments: Number((await pg.query('SELECT coalesce(sum(amount),0) s FROM "Payment"')).rows[0].s),
    invoice: Number((await pg.query('SELECT "paidAmount" FROM "Invoice" WHERE id = 1')).rows[0].paidAmount),
  });

  it('now: two 500 payments at once leave the invoice at exactly 1000 paid', async () => {
    await Promise.all([payNow(500), payNow(500)]);
    expect(await totals()).toEqual({ payments: 1000, invoice: 1000 });
  });

  it('now: two full payments at once cannot both be taken (no overpayment)', async () => {
    const r = await Promise.all([payNow(1000), payNow(1000)]);
    expect(r.sort()).toEqual(['recorded', 'refused']);
    expect(await totals()).toEqual({ payments: 1000, invoice: 1000 });
  });

  it('before: two 500 payments at once lost one on the invoice (the defect)', async () => {
    await Promise.all([payBefore(500), payBefore(500)]);
    const t = await totals();
    expect(t.payments).toBe(1000);
    expect(t.invoice).toBe(500);
  });
});
