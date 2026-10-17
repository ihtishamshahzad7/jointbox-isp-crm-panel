import { PgHarness, describePg } from '../pg';

/**
 * A GATEWAY RESULT IS CREDITED ONCE, EVEN WHEN IT ARRIVES TWICE AT ONCE.
 *
 * Payment gateways deliver the browser redirect and the server-to-server IPN
 * for the same payment at the same moment. PaymentGatewaysService.handleWebhook
 * used to check `status === 'SUCCESS'` and then write: both deliveries read
 * PENDING, both created a Payment and both added the amount to the invoice.
 *
 * It now claims the row with a conditional UPDATE inside the same transaction
 * as the Payment and the invoice increment. These tests run that exact SQL
 * shape against PostgreSQL, under real concurrency, next to the old shape.
 */
describePg('gateway callback: claim once', () => {
  const pg = new PgHarness('gwcallback');

  beforeAll(() =>
    pg.setup([
      `CREATE TABLE "PaymentTransaction" (id int PRIMARY KEY, status text NOT NULL, amount numeric(18,4) NOT NULL, "invoiceId" int)`,
      `CREATE TABLE "Invoice" (id int PRIMARY KEY, total numeric(18,4), "paidAmount" numeric(18,4) NOT NULL DEFAULT 0)`,
      `CREATE TABLE "Payment" (id serial PRIMARY KEY, "invoiceId" int, amount numeric(18,4))`,
    ]),
  );
  afterAll(() => pg.teardown());

  beforeEach(async () => {
    await pg.query('TRUNCATE "PaymentTransaction", "Invoice", "Payment"');
    await pg.query(`INSERT INTO "Invoice" VALUES (99, 1500, 0)`);
    await pg.query(`INSERT INTO "PaymentTransaction" VALUES (7, 'PENDING', 1500, 99)`);
  });

  /** The shape handleWebhook now uses. */
  const settleNow = () =>
    pg.tx(async (c) => {
      const claim = await c.query(
        `UPDATE "PaymentTransaction" SET status = 'SUCCESS' WHERE id = 7 AND status NOT IN ('SUCCESS','REFUNDED')`,
      );
      if (claim.rowCount === 0) return 'already';
      await c.query(`INSERT INTO "Payment" ("invoiceId", amount) VALUES (99, 1500)`);
      await c.query(`UPDATE "Invoice" SET "paidAmount" = "paidAmount" + 1500 WHERE id = 99`);
      return 'credited';
    });

  /** The shape it used before: check, then write. */
  const settleBefore = () =>
    pg.tx(async (c) => {
      const { rows } = await c.query(`SELECT status FROM "PaymentTransaction" WHERE id = 7`);
      if (rows[0].status === 'SUCCESS') return 'already';
      await new Promise((r) => setTimeout(r, 30)); // the window a second delivery lands in
      await c.query(`UPDATE "PaymentTransaction" SET status = 'SUCCESS' WHERE id = 7`);
      const inv = await c.query(`SELECT "paidAmount" FROM "Invoice" WHERE id = 99`);
      await c.query(`INSERT INTO "Payment" ("invoiceId", amount) VALUES (99, 1500)`);
      await c.query(`UPDATE "Invoice" SET "paidAmount" = $1 WHERE id = 99`, [Number(inv.rows[0].paidAmount) + 1500]);
      return 'credited';
    });

  const state = async () => ({
    payments: Number((await pg.query('SELECT count(*) FROM "Payment"')).rows[0].count),
    paid: Number((await pg.query('SELECT "paidAmount" FROM "Invoice" WHERE id = 99')).rows[0].paidAmount),
  });

  it('now: five simultaneous deliveries create one Payment and credit 1500 once', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => settleNow()));
    expect(results.filter((r) => r === 'credited')).toHaveLength(1);
    expect(await state()).toEqual({ payments: 1, paid: 1500 });
  });

  it('before: two simultaneous deliveries created two Payments (the defect)', async () => {
    await Promise.all([settleBefore(), settleBefore()]);
    const s = await state();
    expect(s.payments).toBe(2);
  });
});
