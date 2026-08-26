/**
 * The generated Prisma client provides `Prisma.sql` / `.join` / `.empty` as
 * template tags. This suite asserts OUR grouping, ordering and privacy logic,
 * not Prisma's SQL tagging, so they are stubbed with structure-preserving
 * equivalents — which also lets a test inspect the parameters that were bound.
 */
jest.mock('@prisma/client', () => {
  const actual = jest.requireActual('@prisma/client');
  const tag = (strings: any, ...values: any[]) => ({ strings: [...strings], values });
  return {
    ...actual,
    Prisma: {
      ...(actual.Prisma ?? {}),
      sql: tag,
      join: (arr: any[]) => ({ join: arr }),
      empty: { strings: [''], values: [] },
    },
  };
});

import { ResellerPricingService } from './reseller-pricing.service';

/**
 * MARGIN CHAIN — per-sale, per-tier margin reporting.
 *
 * WHY THIS REPORT EXISTS
 * profitReport() only ever returns the caller's OWN margin line, so a margin
 * being absorbed by one tier — a franchise reselling at near cost, a package
 * whose ladder leaves the ISP almost nothing — was invisible without reading
 * the ledger row by row. ProfitEntry already stores every tier's row under a
 * shared `reference`, so this is a query, not new bookkeeping.
 *
 * What must never regress:
 *   1. PRIVACY. A reseller sees itself and its descendants; NEVER a tier
 *      above it. A parent's margin is the child's own buy price, so leaking it
 *      hands a reseller its supplier's pricing. Admins see everything.
 *   2. NO SILENT TRUNCATION. When tiers are withheld, `hiddenTiers` says how
 *      many — a short chain must never read as a complete one.
 *   3. CHAINS ARE NOT SPLIT BY PAGINATION. The limit applies to sales, not to
 *      tier rows; slicing mid-chain would understate a tier's margin as zero.
 *   4. Tier columns are ordered by ladder depth (ISP → Franchise → Dealer),
 *      not by insertion order.
 */
describe('ResellerPricingService.marginChain', () => {
  /**
   * One sale, three tiers, under a single reference:
   *   ISP(1) earns 300, Franchise(2) earns 200, Dealer(3) earns 100.
   * The customer paid 2000 (the bottom of the chain's sale figure).
   */
  const SALE = [
    { id: 1, reference: 'SUB#500', userId: 1, fromUserId: 3, subscriberId: 500, packageId: 7,
      saleAmount: 1500, costAmount: 1200, profitAmount: 300, at: new Date('2026-08-01T10:00:00Z'),
      note: null, subscriber: { id: 500, fullName: 'Customer A', username: 'custa' } },
    { id: 2, reference: 'SUB#500', userId: 2, fromUserId: 3, subscriberId: 500, packageId: 7,
      saleAmount: 1800, costAmount: 1500, profitAmount: 200, at: new Date('2026-08-01T10:00:01Z'),
      note: null, subscriber: { id: 500, fullName: 'Customer A', username: 'custa' } },
    { id: 3, reference: 'SUB#500', userId: 3, fromUserId: 3, subscriberId: 500, packageId: 7,
      saleAmount: 2000, costAmount: 1800, profitAmount: 100, at: new Date('2026-08-01T10:00:02Z'),
      note: null, subscriber: { id: 500, fullName: 'Customer A', username: 'custa' } },
  ];

  const USERS = [
    { id: 1, name: 'TEZNET', role: 'ADMIN' },
    { id: 2, name: 'Quetta Franchise', role: 'RESELLER' },
    { id: 3, name: 'Jinnah Town Dealer', role: 'SUB_RESELLER' },
  ];

  function makeService(opts: {
    isAdmin?: boolean;
    descendants?: number[];
    entries?: any[];
    refRows?: any[];
  } = {}) {
    const entries = opts.entries ?? SALE;
    const refRows = opts.refRows ?? [{ reference: 'SUB#500', at: new Date('2026-08-01T10:00:02Z') }];

    const prisma: any = {
      // $queryRaw is used only for the reference (sales) selection.
      $queryRaw: jest.fn().mockResolvedValue(refRows),
      profitEntry: { findMany: jest.fn().mockResolvedValue(entries) },
      user: { findMany: jest.fn().mockResolvedValue(USERS) },
      package: { findMany: jest.fn().mockResolvedValue([{ id: 7, name: 'TezPlus-8' }]) },
    };
    const scope: any = {
      isAdmin: jest.fn().mockReturnValue(opts.isAdmin ?? true),
      rootId: jest.fn().mockResolvedValue(opts.isAdmin === false ? 2 : 1),
      descendantIds: jest.fn().mockResolvedValue(opts.descendants ?? [1, 2, 3]),
    };
    const svc = new ResellerPricingService(prisma, scope);
    return { prisma, scope, svc };
  }

  // ─────────────────────────────────────────────────────────────
  // The whole point: every tier, side by side.
  // ─────────────────────────────────────────────────────────────
  describe('as the ISP (admin)', () => {
    it('returns one row per SALE, not one per tier', async () => {
      const { svc } = makeService();
      const res = await svc.marginChain({ role: 'ADMIN', sub: 1 } as any);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].tiers).toHaveLength(3);
    });

    it('shows what every tier took on that sale', async () => {
      const { svc } = makeService();
      const res = await svc.marginChain({ role: 'ADMIN', sub: 1 } as any);
      const byName = Object.fromEntries(res.rows[0].tiers.map((t: any) => [t.name, t.profit]));
      expect(byName).toEqual({
        TEZNET: 300,
        'Quetta Franchise': 200,
        'Jinnah Town Dealer': 100,
      });
    });

    it('orders tiers by ladder depth: ISP → Franchise → Dealer', async () => {
      const { svc } = makeService({
        // Deliberately shuffled so insertion order cannot be what sorts them.
        entries: [SALE[2], SALE[0], SALE[1]],
      });
      const res = await svc.marginChain({ role: 'ADMIN', sub: 1 } as any);
      expect(res.rows[0].tiers.map((t: any) => t.roleLabel)).toEqual(['ISP', 'Franchise', 'Dealer']);
    });

    it('reports what the customer actually paid (the bottom of the chain)', async () => {
      const { svc } = makeService();
      const res = await svc.marginChain({ role: 'ADMIN', sub: 1 } as any);
      expect(res.rows[0].customerPaid).toBe(2000);
    });

    it('exposes the tier columns present in the result, in ladder order', async () => {
      const { svc } = makeService();
      const res = await svc.marginChain({ role: 'ADMIN', sub: 1 } as any);
      expect(res.tiers.map((t: any) => t.label)).toEqual(['ISP', 'Franchise', 'Dealer']);
    });

    it('totals the full chain margin', async () => {
      const { svc } = makeService();
      const res = await svc.marginChain({ role: 'ADMIN', sub: 1 } as any);
      expect(res.totals).toMatchObject({ count: 1, sales: 2000, profit: 600 });
    });

    it('hides nothing from an admin', async () => {
      const { svc } = makeService();
      const res = await svc.marginChain({ role: 'ADMIN', sub: 1 } as any);
      expect(res.rows[0].hiddenTiers).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // PRIVACY — the commercially critical rule.
  // ─────────────────────────────────────────────────────────────
  describe('as a franchise (non-admin)', () => {
    // Franchise id 2; its subtree is itself + the dealer below it.
    const asFranchise = () => makeService({ isAdmin: false, descendants: [2, 3] });

    it('NEVER reveals the margin of a tier above it', async () => {
      const { svc } = asFranchise();
      const res = await svc.marginChain({ role: 'RESELLER', sub: 2 } as any);
      const names = res.rows[0].tiers.map((t: any) => t.name);
      // The ISP's 300 is this franchise's own buy price — must not appear.
      expect(names).not.toContain('TEZNET');
      expect(res.rows[0].tiers.find((t: any) => t.profit === 300)).toBeUndefined();
    });

    it('still shows its own margin and its downline', async () => {
      const { svc } = asFranchise();
      const res = await svc.marginChain({ role: 'RESELLER', sub: 2 } as any);
      expect(res.rows[0].tiers.map((t: any) => t.name)).toEqual([
        'Quetta Franchise',
        'Jinnah Town Dealer',
      ]);
    });

    it('says how many tiers were withheld instead of truncating silently', async () => {
      const { svc } = asFranchise();
      const res = await svc.marginChain({ role: 'RESELLER', sub: 2 } as any);
      expect(res.rows[0].hiddenTiers).toBe(1);
    });

    it('totals only what it can see — never the full chain margin', async () => {
      const { svc } = asFranchise();
      const res = await svc.marginChain({ role: 'RESELLER', sub: 2 } as any);
      expect(res.rows[0].chainProfit).toBe(300); // 200 + 100, not 600
      expect(res.totals.profit).toBe(300);
    });

    it('scopes the SQL selection to its own subtree', async () => {
      const { svc, prisma, scope } = asFranchise();
      await svc.marginChain({ role: 'RESELLER', sub: 2 } as any);
      expect(scope.descendantIds).toHaveBeenCalledWith(2);
      // The reference query must carry a visibility restriction.
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Correctness details that quietly misreport money.
  // ─────────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('returns an empty result set rather than throwing when there are no sales', async () => {
      const { svc, prisma } = makeService({ refRows: [] });
      const res = await svc.marginChain({ role: 'ADMIN', sub: 1 } as any);
      expect(res).toEqual({ rows: [], tiers: [], totals: { sales: 0, profit: 0, count: 0 } });
      // No point querying tiers for nothing.
      expect(prisma.profitEntry.findMany).not.toHaveBeenCalled();
    });

    it('fetches tiers by reference, so a chain is never split by the row limit', async () => {
      const { svc, prisma } = makeService();
      await svc.marginChain({ role: 'ADMIN', sub: 1 } as any, );
      const where = prisma.profitEntry.findMany.mock.calls[0][0].where;
      // Selected by reference — NOT by take/skip over tier rows.
      expect(where.reference.in).toEqual(['SUB#500']);
      expect(prisma.profitEntry.findMany.mock.calls[0][0].take).toBeUndefined();
    });

    it('flags a reversal so a credit note is not read as a sale', async () => {
      const reversal = SALE.map((e) => ({
        ...e,
        reference: 'REV#SUB#500',
        saleAmount: -e.saleAmount,
        profitAmount: -e.profitAmount,
      }));
      const { svc } = makeService({
        entries: reversal,
        refRows: [{ reference: 'REV#SUB#500', at: new Date('2026-08-02T10:00:00Z') }],
      });
      const res = await svc.marginChain({ role: 'ADMIN', sub: 1 } as any);
      expect(res.rows[0].isReversal).toBe(true);
      expect(res.rows[0].chainProfit).toBe(-600);
    });

    it('caps the limit so a caller cannot request an unbounded scan', async () => {
      const { svc, prisma } = makeService();
      await svc.marginChain({ role: 'ADMIN', sub: 1 } as any, { limit: 99999 });
      // The cap lands in the parameterised SQL, not in a string.
      const sql = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
      expect(sql).toContain('1000');
      expect(sql).not.toContain('99999');
    });

    it('carries the seller and package through for filtering context', async () => {
      const { svc } = makeService();
      const res = await svc.marginChain({ role: 'ADMIN', sub: 1 } as any);
      expect(res.rows[0]).toMatchObject({
        seller: 'Jinnah Town Dealer',
        sellerRole: 'Dealer',
        packageName: 'TezPlus-8',
        subscriber: 'Customer A',
      });
    });
  });
});
