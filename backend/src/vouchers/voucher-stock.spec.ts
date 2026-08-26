import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { VouchersService } from './vouchers.service';

/**
 * PREPAID CARD STOCK — allocation to resellers, and the ownership rules.
 *
 * WHAT THIS FEATURE IS FOR
 * Cards already had batch generation, a PIN and a redeem flow, but no owner:
 * Voucher recorded who created it and who used it, with nothing in between. So
 * there was no way to hand a dealer 500 cards, see what they were holding, or
 * reconcile what they sold against what they owe — which in a prepaid,
 * dealer-distributed market is the sales channel itself.
 *
 * WHY THE RULES BELOW MATTER
 * An unredeemed card is BEARER VALUE: whoever can read its code and PIN can
 * spend it. So every rule here is a money rule, not a tidiness rule:
 *   1. Ownership is set from the AUTHENTICATED CALLER, never the request body.
 *      It used to be read off `data.createdBy`, so a client could attribute
 *      cards to any account — and since all visibility keys on ownership, that
 *      meant planting readable cards in someone else's account.
 *   2. Stock only ever moves DOWNWARD (to yourself or your own accounts).
 *      Allocating sideways would push liability onto a peer and then let you
 *      read their stock through the ownership checks.
 *   3. Only UNUSED cards move. A spent card is the record of who sold it.
 *   4. A redeemed card is never deletable — it is a payment record.
 *   5. The PIN is never returned by a lookup. Code and PIN are two separate
 *      secrets by design; returning both collapses them into one.
 *
 * NOTE ON WHAT THESE TESTS CANNOT PROVE: Prisma is mocked, so they verify the
 * service's logic, not that the new `assignedToUserId` column exists or that
 * the schema compiles. Run `npx prisma generate && npm run build` before
 * deploying — see the migration note.
 */
describe('VouchersService — reseller card stock', () => {
  const ADMIN = { role: 'ADMIN', sub: 1 } as any;
  const DEALER = { role: 'SUB_RESELLER', sub: 5 } as any;

  function makeService(opts: { descendants?: number[]; voucher?: any } = {}) {
    const prisma: any = {
      voucher: {
        findUnique: jest.fn().mockResolvedValue(opts.voucher ?? null),
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        delete: jest.fn().mockResolvedValue({}),
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: { amount: 0 } }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 9 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const scope: any = {
      isAdmin: jest.fn((r: string) => r === 'ADMIN' || r === 'SUPER_ADMIN'),
      rootId: jest.fn().mockResolvedValue(5),
      descendantIds: jest.fn().mockResolvedValue(opts.descendants ?? [5, 6, 7]),
    };
    return { prisma, scope, svc: new VouchersService(prisma, scope) };
  }

  // ───────────────────────────────────────────────────────────────
  // Rule 1 — ownership comes from the session, not the payload
  // ───────────────────────────────────────────────────────────────
  describe('createBulk()', () => {
    const good = { quantity: 3, amount: 500, validityDays: 30, type: 'PREPAID' };

    it('stamps createdBy from the authenticated caller', async () => {
      const { svc, prisma } = makeService();
      await svc.createBulk(good, DEALER);
      const rows = prisma.voucher.createMany.mock.calls[0][0].data;
      expect(rows).toHaveLength(3);
      expect(rows.every((r: any) => r.createdBy === 5)).toBe(true);
    });

    it('IGNORES a createdBy supplied in the request body', async () => {
      const { svc, prisma } = makeService();
      // A client trying to attribute its cards to account 999.
      await svc.createBulk({ ...good, createdBy: 999 }, DEALER);
      const rows = prisma.voucher.createMany.mock.calls[0][0].data;
      expect(rows.every((r: any) => r.createdBy === 5)).toBe(true);
      expect(rows.some((r: any) => r.createdBy === 999)).toBe(false);
    });

    it('can hand the batch straight to a reseller on creation', async () => {
      const { svc, prisma } = makeService();
      await svc.createBulk({ ...good, assignToUserId: 6 }, DEALER);
      const rows = prisma.voucher.createMany.mock.calls[0][0].data;
      expect(rows.every((r: any) => r.assignedToUserId === 6)).toBe(true);
      expect(rows.every((r: any) => r.assignedAt instanceof Date)).toBe(true);
    });

    it('leaves assignedAt null when the batch is not allocated', async () => {
      const { svc, prisma } = makeService();
      await svc.createBulk(good, DEALER);
      const rows = prisma.voucher.createMany.mock.calls[0][0].data;
      expect(rows.every((r: any) => r.assignedToUserId === null && r.assignedAt === null)).toBe(true);
    });

    it('refuses to allocate a new batch to an account outside the caller"s downline', async () => {
      const { svc, prisma } = makeService({ descendants: [5, 6] });
      await expect(svc.createBulk({ ...good, assignToUserId: 99 }, DEALER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // Nothing was printed — the whole batch is refused, not partly created.
      expect(prisma.voucher.createMany).not.toHaveBeenCalled();
    });

    it('validates quantity, value and validity rather than creating junk cards', async () => {
      const { svc } = makeService();
      await expect(svc.createBulk({ ...good, quantity: 0 }, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.createBulk({ ...good, amount: 0 }, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.createBulk({ ...good, validityDays: 0 }, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.createBulk({ ...good, quantity: 'abc' }, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('caps a single batch so one request cannot print unbounded value', async () => {
      const { svc } = makeService();
      await expect(svc.createBulk({ ...good, quantity: 50000 }, ADMIN)).rejects.toThrow(/at most 5,000/);
    });

    it('gives every card a distinct code and its own PIN', async () => {
      const { svc, prisma } = makeService();
      await svc.createBulk({ ...good, quantity: 50 }, ADMIN);
      const rows = prisma.voucher.createMany.mock.calls[0][0].data;
      expect(new Set(rows.map((r: any) => r.code)).size).toBe(50);
      expect(rows.every((r: any) => /^\d{6}$/.test(r.pin))).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Rules 2 & 3 — where stock may move, and which cards move
  // ───────────────────────────────────────────────────────────────
  describe('allocate()', () => {
    it('moves a whole batch to a reseller', async () => {
      const { svc, prisma } = makeService();
      prisma.voucher.updateMany.mockResolvedValue({ count: 500 });
      const res = await svc.allocate({ batchId: 'BATCH-1', assignToUserId: 6 }, ADMIN);
      expect(res).toEqual({ moved: 500, assignedToUserId: 6 });
      const call = prisma.voucher.updateMany.mock.calls[0][0];
      expect(call.where.batchId).toBe('BATCH-1');
      expect(call.data.assignedToUserId).toBe(6);
    });

    it('only ever moves UNUSED cards — a sold card records who sold it', async () => {
      const { svc, prisma } = makeService();
      await svc.allocate({ batchId: 'BATCH-1', assignToUserId: 6 }, ADMIN);
      expect(prisma.voucher.updateMany.mock.calls[0][0].where.status).toBe('UNUSED');
    });

    it('takes stock back when assignToUserId is null', async () => {
      const { svc, prisma } = makeService();
      await svc.allocate({ batchId: 'BATCH-1', assignToUserId: null }, ADMIN);
      const data = prisma.voucher.updateMany.mock.calls[0][0].data;
      expect(data.assignedToUserId).toBeNull();
      expect(data.assignedAt).toBeNull();
    });

    it('REFUSES to allocate sideways, to an account outside the caller"s downline', async () => {
      const { svc, prisma } = makeService({ descendants: [5, 6] });
      await expect(
        svc.allocate({ batchId: 'BATCH-1', assignToUserId: 99 }, DEALER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.voucher.updateMany).not.toHaveBeenCalled();
    });

    it('restricts a reseller to moving stock it already holds', async () => {
      const { svc, prisma } = makeService({ descendants: [5, 6] });
      await svc.allocate({ batchId: 'BATCH-1', assignToUserId: 6 }, DEALER);
      // The update is fenced to cards this account created or holds.
      const where = prisma.voucher.updateMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { createdBy: { in: [5, 6] } },
        { assignedToUserId: { in: [5, 6] } },
      ]);
    });

    it('places no such fence on an admin', async () => {
      const { svc, prisma } = makeService();
      await svc.allocate({ batchId: 'BATCH-1', assignToUserId: 6 }, ADMIN);
      expect(prisma.voucher.updateMany.mock.calls[0][0].where.OR).toBeUndefined();
    });

    it('requires something to allocate', async () => {
      const { svc } = makeService();
      await expect(svc.allocate({ assignToUserId: 6 }, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.allocate({ voucherIds: [], assignToUserId: 6 }, ADMIN)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects an allocation to an account that no longer exists', async () => {
      const { svc, prisma } = makeService();
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(svc.allocate({ batchId: 'B', assignToUserId: 404 }, ADMIN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Rule 4 — a redeemed card is a payment record
  // ───────────────────────────────────────────────────────────────
  describe('deleteVoucher()', () => {
    it('destroys an unused card the caller owns', async () => {
      const { svc, prisma } = makeService({
        voucher: { id: 3, status: 'UNUSED', createdBy: 5, assignedToUserId: null },
      });
      await svc.deleteVoucher(3, DEALER);
      expect(prisma.voucher.delete).toHaveBeenCalledWith({ where: { id: 3 } });
    });

    it('REFUSES to delete a redeemed card — that would erase a payment record', async () => {
      const { svc, prisma } = makeService({
        voucher: { id: 3, status: 'USED', createdBy: 5, assignedToUserId: 5 },
      });
      await expect(svc.deleteVoucher(3, DEALER)).rejects.toThrow(/redeemed/);
      expect(prisma.voucher.delete).not.toHaveBeenCalled();
    });

    it("REFUSES to delete another account's stock", async () => {
      const { svc, prisma } = makeService({
        descendants: [5, 6],
        voucher: { id: 3, status: 'UNUSED', createdBy: 99, assignedToUserId: 99 },
      });
      await expect(svc.deleteVoucher(3, DEALER)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.voucher.delete).not.toHaveBeenCalled();
    });

    it('lets an admin delete an unused card regardless of holder', async () => {
      const { svc, prisma } = makeService({
        voucher: { id: 3, status: 'UNUSED', createdBy: 99, assignedToUserId: 99 },
      });
      await svc.deleteVoucher(3, ADMIN);
      expect(prisma.voucher.delete).toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Rule 5 — the PIN is a second secret
  // ───────────────────────────────────────────────────────────────
  describe('findByCode()', () => {
    const card = { id: 3, code: 'ABCD-EFGH', pin: '123456', status: 'UNUSED', createdBy: 5, assignedToUserId: 5 };

    it('NEVER returns the PIN, even to an admin', async () => {
      const { svc } = makeService({ voucher: card });
      const res: any = await svc.findByCode('ABCD-EFGH', ADMIN);
      expect(res.code).toBe('ABCD-EFGH');
      expect(res.pin).toBeUndefined();
    });

    it("hides a card belonging to another account", async () => {
      const { svc } = makeService({
        descendants: [5, 6],
        voucher: { ...card, createdBy: 99, assignedToUserId: 99 },
      });
      expect(await svc.findByCode('ABCD-EFGH', DEALER)).toBeNull();
    });

    it('shows a card allocated TO the caller even if the ISP created it', async () => {
      const { svc } = makeService({
        descendants: [5, 6],
        voucher: { ...card, createdBy: 1, assignedToUserId: 5 },
      });
      const res: any = await svc.findByCode('ABCD-EFGH', DEALER);
      expect(res).not.toBeNull();
      expect(res.pin).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Visibility: a dealer must be able to see the stock it was handed
  // ───────────────────────────────────────────────────────────────
  describe('findAll()', () => {
    it("includes cards allocated to the caller, not just ones it created", async () => {
      const { svc, prisma } = makeService({ descendants: [5, 6] });
      await svc.findAll(DEALER);
      const or = prisma.voucher.findMany.mock.calls[0][0].where.OR;
      expect(or).toEqual(
        expect.arrayContaining([{ assignedToUserId: { in: [5, 6] } }]),
      );
    });

    it('is unfiltered for an admin', async () => {
      const { svc, prisma } = makeService();
      await svc.findAll(ADMIN);
      expect(prisma.voucher.findMany.mock.calls[0][0].where).toEqual({});
    });
  });

  // ───────────────────────────────────────────────────────────────
  // The commercial view
  // ───────────────────────────────────────────────────────────────
  describe('stockByReseller()', () => {
    it('reports unsold value per holder — the money they are holding for you', async () => {
      const { svc, prisma } = makeService();
      prisma.voucher.groupBy.mockResolvedValue([
        { assignedToUserId: 6, status: 'UNUSED', _count: { _all: 40 }, _sum: { amount: 20000 } },
        { assignedToUserId: 6, status: 'USED', _count: { _all: 10 }, _sum: { amount: 5000 } },
        { assignedToUserId: 7, status: 'UNUSED', _count: { _all: 5 }, _sum: { amount: 2500 } },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 6, name: 'Jinnah Town Dealer', role: 'SUB_RESELLER' },
        { id: 7, name: 'Bela Dealer', role: 'SUB_RESELLER' },
      ]);

      const res = await svc.stockByReseller(ADMIN);

      expect(res.holders[0]).toMatchObject({
        userId: 6, name: 'Jinnah Town Dealer',
        unused: 40, unusedValue: 20000,
        used: 10, soldValue: 5000,
      });
      // Ordered by the value at risk, biggest first.
      expect(res.holders.map((h: any) => h.userId)).toEqual([6, 7]);
    });

    it("reports the ISP's own unallocated shelf separately", async () => {
      const { svc, prisma } = makeService();
      prisma.voucher.aggregate.mockResolvedValue({ _count: { _all: 120 }, _sum: { amount: 60000 } });
      const res = await svc.stockByReseller(ADMIN);
      expect(res.unassigned).toEqual({ count: 120, value: 60000 });
    });

    it('shows a reseller only its own subtree, and no ISP shelf', async () => {
      const { svc, prisma } = makeService({ descendants: [5, 6] });
      const res = await svc.stockByReseller(DEALER);
      expect(prisma.voucher.groupBy.mock.calls[0][0].where.assignedToUserId).toEqual({ in: [5, 6] });
      expect(res.unassigned).toBeNull();
    });
  });
});
