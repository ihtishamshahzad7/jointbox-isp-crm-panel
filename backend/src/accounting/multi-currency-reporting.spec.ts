import { AccountingService } from './accounting.service';
import { InvoicesService } from '../invoices/invoices.service';

/**
 * REPORTING ACROSS CURRENCIES.
 *
 * WHY THIS IS THE DANGEROUS PART
 * Stamping a currency onto each row is the easy half. The half that actually
 * hurts people is the totals, because a cross-currency sum does not look
 * broken. Adding a 100 USD invoice to a 100 PKR one yields 200 — a plausible,
 * confident, entirely meaningless number that a human then makes a decision
 * on. There is no error, no warning, nothing to notice.
 *
 * It is worse still for a trial balance, whose ONLY job is to answer "do the
 * books balance". Summed across currencies, a 100 USD error can be cancelled
 * out by a 100 PKR error in the other direction and the books report as
 * balanced when they are not — the one question the report exists to answer,
 * answered wrongly, in the reassuring direction.
 *
 * So the rule these tests pin down is: never add two currencies together.
 * Group, label, and say plainly when a headline figure is a slice rather than
 * the whole.
 *
 * A NOTE ON THE SINGLE-CURRENCY CASE
 * Every existing deployment has exactly one currency, and must see no change
 * at all. Tests below assert that too — a correctness fix that alters the
 * numbers on everybody's dashboard would be its own kind of bug.
 */
describe('multi-currency reporting', () => {
  // ───────────────────────────────────────────────────────────────
  // Trial balance
  // ───────────────────────────────────────────────────────────────
  describe('trial balance', () => {
    function makeAccounting(groups: any[]) {
      const prisma: any = {
        ledgerEntry: {
          groupBy: jest.fn().mockResolvedValue(groups),
          count: jest.fn().mockResolvedValue(0),
        },
      };
      const cache: any = { wrap: (_k: string, _t: number, fn: any) => fn(), delPrefix: jest.fn() };
      const svc = new AccountingService(prisma, cache, {} as any, {} as any);
      return { svc, prisma };
    }

    const line = (account: string, currency: string, debit: number, credit: number) => ({
      account,
      currency,
      _sum: { debit, credit },
    });

    it('groups the ledger by currency as well as account', async () => {
      const { svc, prisma } = makeAccounting([]);
      await svc.getLedgerSummary();
      expect(prisma.ledgerEntry.groupBy.mock.calls[0][0].by).toEqual(['account', 'currency']);
    });

    it('single currency: reports exactly as before, with no "mixed" noise', async () => {
      const { svc } = makeAccounting([
        line('CASH', 'PKR', 5000, 0),
        line('REVENUE', 'PKR', 0, 5000),
      ]);
      const tb = await svc.getTrialBalance();
      expect(tb.balanced).toBe(true);
      expect(tb.mixedCurrency).toBe(false);
      expect(tb.totalDebit).toBe(5000);
      expect(tb.totalCredit).toBe(5000);
      expect(tb.message).toMatch(/Books balance/);
    });

    it('balances each currency independently', async () => {
      const { svc } = makeAccounting([
        line('CASH', 'PKR', 5000, 0),
        line('REVENUE', 'PKR', 0, 5000),
        line('CASH', 'USD', 100, 0),
        line('REVENUE', 'USD', 0, 100),
      ]);
      const tb = await svc.getTrialBalance();
      expect(tb.balanced).toBe(true);
      expect(tb.mixedCurrency).toBe(true);
      expect(tb.currencies).toEqual([
        { currency: 'PKR', totalDebit: 5000, totalCredit: 5000, difference: 0, balanced: true },
        { currency: 'USD', totalDebit: 100, totalCredit: 100, difference: 0, balanced: true },
      ]);
    });

    it('does NOT let one currency hide a real imbalance in another', async () => {
      // THE test. Cross-currency summing gives debits 5100 and credits 5100 —
      // "balanced" — while PKR is 100 short and USD is 100 over. The books are
      // genuinely broken and the old arithmetic would have said they were fine.
      const { svc } = makeAccounting([
        line('CASH', 'PKR', 4900, 0),
        line('REVENUE', 'PKR', 0, 5000),
        line('CASH', 'USD', 200, 0),
        line('REVENUE', 'USD', 0, 100),
      ]);
      const tb = await svc.getTrialBalance();

      const naiveDebit = 4900 + 200;
      const naiveCredit = 5000 + 100;
      expect(naiveDebit).toBe(naiveCredit); // the trap the old code fell into

      expect(tb.balanced).toBe(false);
      expect(tb.currencies.find((c) => c.currency === 'PKR')!.difference).toBe(-100);
      expect(tb.currencies.find((c) => c.currency === 'USD')!.difference).toBe(100);
      // The message must name the currencies, or an operator cannot act on it.
      expect(tb.message).toMatch(/PKR/);
      expect(tb.message).toMatch(/USD/);
    });

    it('never presents a cross-currency figure as the headline total', async () => {
      const { svc } = makeAccounting([
        line('CASH', 'PKR', 5000, 0),
        line('REVENUE', 'PKR', 0, 5000),
        line('CASH', 'USD', 100, 0),
        line('REVENUE', 'USD', 0, 100),
      ]);
      const tb = await svc.getTrialBalance();
      // 5100 would be the sum of both. The scalar must be one currency's own
      // total, and `currency` must say which.
      expect(tb.totalDebit).not.toBe(5100);
      expect(tb.totalDebit).toBe(5000);
      expect(tb.currency).toBe('PKR');
    });

    it('surfaces unstamped legacy rows rather than folding them into a currency', async () => {
      // Rows written before the stamp existed, on a deployment that had no ISP
      // currency configured. Quietly counting them as local money would be a
      // guess; naming them lets somebody go and fix them.
      const { svc } = makeAccounting([line('CASH', '', 500, 0)]);
      const tb = await svc.getTrialBalance();
      expect(tb.currencies[0].currency).toBe('UNSPECIFIED');
    });

    it('does not crash on an empty ledger', async () => {
      const { svc } = makeAccounting([]);
      const tb = await svc.getTrialBalance();
      expect(tb.balanced).toBe(true);
      expect(tb.totalDebit).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Invoice summary
  // ───────────────────────────────────────────────────────────────
  describe('invoice stats', () => {
    function makeInvoices(groups: any[]) {
      const prisma: any = {
        invoice: {
          count: jest.fn().mockResolvedValue(0),
          groupBy: jest.fn().mockResolvedValue(groups),
        },
      };
      const scope: any = { isAdmin: jest.fn().mockReturnValue(true) };
      const svc = new InvoicesService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        scope,
        {} as any,
        {} as any,
      );
      return { svc, prisma };
    }

    const grp = (currency: string, total: number, paid: number, due: number) => ({
      currency,
      _sum: { total, paidAmount: paid, dueAmount: due },
    });

    it('single currency: the existing headline figures are unchanged', async () => {
      const { svc } = makeInvoices([grp('PKR', 10000, 6000, 4000)]);
      const s: any = await svc.getStats();
      expect(s.totalAmount).toBe(10000);
      expect(s.totalPaid).toBe(6000);
      expect(s.totalDue).toBe(4000);
      expect(s.mixedCurrency).toBe(false);
      expect(s.currency).toBe('PKR');
    });

    it('never adds two currencies into one total', async () => {
      const { svc } = makeInvoices([
        grp('PKR', 10000, 6000, 4000),
        grp('USD', 500, 500, 0),
      ]);
      const s: any = await svc.getStats();
      expect(s.totalAmount).not.toBe(10500); // the meaningless sum
      expect(s.totalAmount).toBe(10000);
      expect(s.mixedCurrency).toBe(true);
    });

    it('leads with the largest currency by value, and lists them all', async () => {
      // If the headline must be one currency, it should be the one that
      // represents most of the business, not whichever the database returned
      // first.
      const { svc } = makeInvoices([
        grp('USD', 500, 500, 0),
        grp('PKR', 10000, 6000, 4000),
      ]);
      const s: any = await svc.getStats();
      expect(s.currency).toBe('PKR');
      expect(s.currencies.map((c: any) => c.currency)).toEqual(['PKR', 'USD']);
    });

    it('uses one grouped query rather than three separate sums', async () => {
      const { svc, prisma } = makeInvoices([grp('PKR', 1, 1, 0)]);
      await svc.getStats();
      expect(prisma.invoice.groupBy).toHaveBeenCalledTimes(1);
      const call = prisma.invoice.groupBy.mock.calls[0][0];
      expect(call.by).toEqual(['currency']);
      expect(call._sum).toEqual({ total: true, paidAmount: true, dueAmount: true });
    });

    it('does not crash when there are no invoices at all', async () => {
      const { svc } = makeInvoices([]);
      const s: any = await svc.getStats();
      expect(s.totalAmount).toBe(0);
      expect(s.currency).toBeNull();
      expect(s.mixedCurrency).toBe(false);
    });
  });
});
