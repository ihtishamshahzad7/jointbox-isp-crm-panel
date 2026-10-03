import { NotFoundException } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { ScopeService } from '../common/scope.service';

/**
 * VOUCHERS TENANCY — staff redemption (POST /vouchers/redeem).
 *
 * A card is bearer value. With an actor, the target subscriber must be the
 * caller's AND the card must belong to the caller's company: created by the
 * caller, an ancestor (the ISP that printed the stock) or a descendant.
 * Everything else is "Voucher not found", decided BEFORE the PIN is looked at.
 *
 *   1 SUPER_ADMIN (platform owner)
 *   ├─ 10 ADMIN  company A ── 11 RESELLER  (subscriber 100)
 *   └─ 20 ADMIN  company B ── 21 RESELLER  (subscriber 200)
 */
const USERS = [
  { id: 1, parentId: null as number | null },
  { id: 10, parentId: 1 },
  { id: 11, parentId: 10 },
  { id: 20, parentId: 1 },
  { id: 21, parentId: 20 },
];
const SUB_OWNER: Record<number, number> = { 100: 11, 200: 21 };
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ADMIN_B = { sub: 20, role: 'ADMIN' };
const RESELLER_B = { sub: 21, role: 'RESELLER' };

function treeQuery(strings: TemplateStringsArray, ...vals: any[]) {
  const q = strings.join('?');
  const id = Number(vals[0]);
  if (q.includes('WITH RECURSIVE sub')) {
    const out = USERS.some((u) => u.id === id) ? [id] : [];
    for (let i = 0; i < out.length; i++) USERS.filter((u) => u.parentId === out[i]).forEach((u) => out.push(u.id));
    return out.map((x) => ({ id: x }));
  }
  if (q.includes('WITH RECURSIVE up')) {
    const out: Array<{ id: number }> = [];
    for (let u = USERS.find((x) => x.id === id); u; u = USERS.find((x) => x.id === u!.parentId)) out.push({ id: u.id });
    return out;
  }
  return [];
}

function make(card: { createdBy: number | null }) {
  const voucher = { id: 3, code: 'ABCD-EFGH-JKLM', pin: '123456', status: 'UNUSED', expireDate: null, ...card };
  const prisma: any = {
    $queryRaw: jest.fn(async (s: any, ...v: any[]) => treeQuery(s, ...v)),
    user: { findUnique: jest.fn() },
    subscriber: {
      findUnique: jest.fn(async ({ where }: any) =>
        SUB_OWNER[where.id] ? { id: where.id, userId: SUB_OWNER[where.id] } : null,
      ),
    },
    voucher: {
      findUnique: jest.fn().mockResolvedValue(voucher),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  return { prisma, svc: new VouchersService(prisma, new ScopeService(prisma), {} as any) };
}

describe('vouchers tenancy — redeem', () => {
  it("(i) another company's ADMIN cannot redeem onto a subscriber it does not own", async () => {
    const { svc, prisma } = make({ createdBy: 20 });
    await expect(svc.redeemVoucher('ABCD-EFGH-JKLM', '123456', 100, ADMIN_B)).rejects.toThrow(
      new NotFoundException('Subscriber not found'),
    );
    expect(prisma.voucher.findUnique).not.toHaveBeenCalled();
    expect(prisma.voucher.updateMany).not.toHaveBeenCalled();
  });

  it("(i) another company's card is 'not found' — even with a wrong PIN, so PINs cannot be probed", async () => {
    const { svc, prisma } = make({ createdBy: 10 });
    await expect(svc.redeemVoucher('ABCD-EFGH-JKLM', '123456', 200, ADMIN_B)).rejects.toThrow(
      new NotFoundException('Voucher not found'),
    );
    await expect(svc.redeemVoucher('ABCD-EFGH-JKLM', 'wrong', 200, ADMIN_B)).rejects.toThrow(
      new NotFoundException('Voucher not found'),
    );
    expect(prisma.voucher.updateMany).not.toHaveBeenCalled();
  });

  it('a card with no recorded creator cannot be attributed to a company, so only the owner may spend it', async () => {
    await expect(make({ createdBy: null }).svc.redeemVoucher('ABCD-EFGH-JKLM', '123456', 200, ADMIN_B)).rejects.toThrow(
      new NotFoundException('Voucher not found'),
    );
    await expect(make({ createdBy: null }).svc.redeemVoucher('ABCD-EFGH-JKLM', '123456', 200, OWNER)).resolves.toBeTruthy();
  });

  it("a company's own cards redeem: created by an ancestor, by itself, or by a descendant", async () => {
    // Dealer 21 selling stock its company (20) printed.
    const up = make({ createdBy: 20 });
    await expect(up.svc.redeemVoucher('ABCD-EFGH-JKLM', '123456', 200, RESELLER_B)).resolves.toBeTruthy();
    // Company 20 redeeming a card its dealer printed.
    const down = make({ createdBy: 21 });
    await expect(down.svc.redeemVoucher('ABCD-EFGH-JKLM', '123456', 200, ADMIN_B)).resolves.toBeTruthy();
    expect(down.prisma.voucher.updateMany.mock.calls[0][0].data.usedBy).toBe(200);
  });

  it('(ii) the platform owner passes for any company', async () => {
    const { svc, prisma } = make({ createdBy: 10 });
    await expect(svc.redeemVoucher('ABCD-EFGH-JKLM', '123456', 100, OWNER)).resolves.toBeTruthy();
    expect(prisma.voucher.updateMany).toHaveBeenCalled();
  });

  it('the customer-portal path (no actor) is unchanged', async () => {
    const { svc, prisma } = make({ createdBy: 10 });
    await expect(svc.redeemVoucher('ABCD-EFGH-JKLM', '123456', 200)).resolves.toBeTruthy();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('(iii) the voucher list passes a subtree-scoped where', async () => {
    const { svc, prisma } = make({ createdBy: 20 });
    await svc.findAll(ADMIN_B);
    expect(prisma.voucher.findMany.mock.calls[0][0].where.OR).toContainEqual({ createdBy: { in: [20, 21] } });
  });
});
