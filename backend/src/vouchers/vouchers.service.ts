import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

@Injectable()
export class VouchersService {
  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /**
   * Vouchers this account may see.
   *
   * Was unscoped, which is worse here than elsewhere: an unused voucher is
   * bearer value. Reading another dealer's unredeemed codes is the same as
   * being handed their money.
   */
  async findAll(actor?: Actor) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.OR = [
        { createdBy: { in: ids } },
        // Cards ALLOCATED to this account (or its downline) are its stock, and
        // the main thing a dealer needs to see: without this clause a reseller
        // could not list the cards it was handed to sell.
        { assignedToUserId: { in: ids } },
        { subscriber: { userId: { in: ids } } },
      ];
    }
    return this.prisma.voucher.findMany({
      where,
      include: { subscriber: true, assignedTo: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: number, actor?: Actor) {
    const v = await this.prisma.voucher.findUnique({
      where: { id },
      include: { subscriber: true },
    });
    // IDOR guard — vouchers are bearer value; a reseller must not read another
    // account's voucher (code/PIN) by guessing its id.
    if (v && actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      const mine =
        (v.createdBy != null && ids.includes(v.createdBy)) ||
        (v.assignedToUserId != null && ids.includes(v.assignedToUserId));
      if (!mine) return null;
    }
    return v;
  }

  /**
   * Look up a card by its printed code.
   *
   * The PIN is NEVER returned. Code and PIN are deliberately two separate
   * secrets — the code identifies the card, the PIN proves the holder has it.
   * Returning both here would collapse that into one, letting anyone who saw a
   * code (on a printed sheet, in a support ticket, in a log) redeem the card.
   * Redemption takes the PIN as input; nothing legitimately needs to read it.
   */
  async findByCode(code: string, actor?: Actor) {
    const v = await this.prisma.voucher.findUnique({
      where: { code },
      include: { subscriber: true },
    });
    if (!v) return null;
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      const mine =
        (v.createdBy != null && ids.includes(v.createdBy)) ||
        (v.assignedToUserId != null && ids.includes(v.assignedToUserId));
      if (!mine) return null;
    }
    const { pin, ...safe } = v as any;
    return safe;
  }

  async getStats(actor?: Actor) {
    // Scope to the caller's own vouchers (createdBy in subtree) — the same
    // isolation findAll() uses. Unscoped, a dealer saw every account's voucher
    // counts and redeemed value.
    const scope: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      scope.createdBy = { in: ids.length ? ids : [-1] };
    }
    const w = (extra: any = {}) => (Object.keys(scope).length ? { AND: [scope, extra] } : extra);
    const total = await this.prisma.voucher.count({ where: w() });
    const unused = await this.prisma.voucher.count({ where: w({ status: 'UNUSED' }) });
    const used = await this.prisma.voucher.count({ where: w({ status: 'USED' }) });
    const expired = await this.prisma.voucher.count({ where: w({ status: 'EXPIRED' }) });

    const totalAmount = await this.prisma.voucher.aggregate({
      where: w({ status: 'USED' }),
      _sum: { amount: true },
    });

    return { total, unused, used, expired, totalRedeemed: totalAmount._sum.amount || 0 };
  }

  async generateVoucherCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 12; i++) {
      if (i > 0 && i % 4 === 0) code += '-';
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  async generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Generate a batch of cards.
   *
   * `createdBy` comes from the AUTHENTICATED CALLER, never from the request
   * body. It used to be read straight off `data.createdBy`, which meant a
   * client could attribute cards to any account it liked — and since every
   * visibility check in this service keys on ownership, and an unredeemed card
   * is bearer value, that let one reseller plant readable cards in another
   * account (or hide its own). The front end never sent the field, so in
   * practice ownership was simply always NULL and no reseller could see any
   * card at all.
   *
   * `assignToUserId` optionally hands the batch straight to the reseller who
   * will sell it, which is the normal case: cards are printed in order to be
   * distributed.
   */
  async createBulk(data: any, actor?: Actor) {
    const quantity = Math.floor(Number(data?.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) {
      throw new BadRequestException('Enter how many cards to generate.');
    }
    if (quantity > 5000) {
      throw new BadRequestException('Generate at most 5,000 cards per batch.');
    }
    const amount = Number(data?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter the card value.');
    }
    const validityDays = Math.floor(Number(data?.validityDays));
    if (!Number.isFinite(validityDays) || validityDays < 1) {
      throw new BadRequestException('Enter how many days the card stays valid.');
    }

    const createdBy = actor ? await this.scope.rootId(actor) : null;

    // Allocating on creation is optional, but if asked it must be an account
    // the caller is actually allowed to hand stock to.
    let assignedToUserId: number | null = null;
    if (data?.assignToUserId) {
      assignedToUserId = await this.assertCanAllocateTo(Number(data.assignToUserId), actor);
    }

    const batchNo = `BATCH-${Date.now()}`;
    const vouchers: any[] = [];

    for (let i = 0; i < quantity; i++) {
      vouchers.push({
        code: await this.generateVoucherCode(),
        pin: await this.generatePin(),
        type: data.type,
        amount,
        dataQuota: data.dataQuota,
        validityDays,
        batchId: batchNo,
        createdBy,
        assignedToUserId,
        assignedAt: assignedToUserId ? new Date() : null,
        expireDate: new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000),
      });
    }

    await this.prisma.voucher.createMany({ data: vouchers });

    return { batchNo, count: vouchers.length, assignedToUserId };
  }

  /**
   * You may only hand stock to yourself or to an account beneath you.
   *
   * Allocating upward or sideways would let a reseller push its own liability
   * onto a peer, or read a peer's stock afterwards through the ownership
   * checks above. Returns the validated id.
   */
  private async assertCanAllocateTo(userId: number, actor?: Actor): Promise<number> {
    if (!Number.isFinite(userId)) throw new BadRequestException('Choose an account to allocate to.');
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) throw new NotFoundException('That account no longer exists.');
    if (!actor || this.scope.isAdmin(actor.role)) return userId;

    const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
    if (!ids.includes(userId)) {
      throw new ForbiddenException('You can only allocate cards to your own accounts.');
    }
    return userId;
  }

  /**
   * Hand a set of UNUSED cards to a reseller (or take them back with
   * `assignToUserId: null`).
   *
   * Only unredeemed cards move: a spent card is a historical record of who
   * sold it, and reassigning it would rewrite that history. The conditional
   * `updateMany` is also what makes this safe under concurrency — a card that
   * was redeemed a moment ago simply is not matched, rather than being
   * silently moved after the fact.
   */
  async allocate(
    opts: { voucherIds?: number[]; batchId?: string; assignToUserId: number | null },
    actor?: Actor,
  ) {
    const target =
      opts.assignToUserId == null ? null : await this.assertCanAllocateTo(Number(opts.assignToUserId), actor);

    const where: any = { status: 'UNUSED' };
    if (opts.batchId) where.batchId = String(opts.batchId);
    else if (opts.voucherIds?.length) where.id = { in: opts.voucherIds.map(Number).filter(Number.isFinite) };
    else throw new BadRequestException('Choose the cards or the batch to allocate.');

    // A reseller may only move stock it already holds.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.OR = [{ createdBy: { in: ids } }, { assignedToUserId: { in: ids } }];
    }

    const res = await this.prisma.voucher.updateMany({
      where,
      data: { assignedToUserId: target, assignedAt: target ? new Date() : null },
    });
    return { moved: res.count, assignedToUserId: target };
  }

  /**
   * Card stock per account: what each reseller is holding, what it has sold,
   * and the value of the unsold cards still in its hands.
   *
   * `unusedValue` is the number that matters commercially — it is money the
   * reseller is holding on the ISP's behalf, and the figure to reconcile
   * against when they settle.
   */
  async stockByReseller(actor?: Actor) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.assignedToUserId = { in: ids.length ? ids : [-1] };
    } else {
      // Admins see every holder; unassigned cards are reported separately.
      where.assignedToUserId = { not: null };
    }

    const grouped = await this.prisma.voucher.groupBy({
      by: ['assignedToUserId', 'status'],
      where,
      _count: { _all: true },
      _sum: { amount: true },
    });

    const holderIds = [...new Set(grouped.map((g) => g.assignedToUserId).filter(Boolean))] as number[];
    const holders = holderIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: holderIds } },
          select: { id: true, name: true, role: true },
        })
      : [];
    const holderBy = new Map(holders.map((h) => [h.id, h]));

    const rows = new Map<number, any>();
    for (const g of grouped) {
      const id = g.assignedToUserId!;
      const row =
        rows.get(id) ??
        {
          userId: id,
          name: holderBy.get(id)?.name ?? `#${id}`,
          role: holderBy.get(id)?.role ?? null,
          unused: 0, used: 0, expired: 0,
          unusedValue: 0, soldValue: 0,
        };
      const n = g._count._all;
      const v = g._sum.amount ?? 0;
      if (g.status === 'UNUSED') { row.unused += n; row.unusedValue += v; }
      else if (g.status === 'USED') { row.used += n; row.soldValue += v; }
      else if (g.status === 'EXPIRED') { row.expired += n; }
      rows.set(id, row);
    }

    const list = [...rows.values()]
      .map((r) => ({
        ...r,
        unusedValue: Math.round(r.unusedValue * 100) / 100,
        soldValue: Math.round(r.soldValue * 100) / 100,
      }))
      .sort((a, b) => b.unusedValue - a.unusedValue);

    // Cards printed but not yet handed out — the ISP's own shelf.
    const isAdmin = !actor || this.scope.isAdmin(actor.role);
    const unassigned = isAdmin
      ? await this.prisma.voucher.aggregate({
          where: { assignedToUserId: null, status: 'UNUSED' },
          _count: { _all: true },
          _sum: { amount: true },
        })
      : null;

    return {
      holders: list,
      unassigned: unassigned
        ? {
            count: unassigned._count._all,
            value: Math.round((unassigned._sum.amount ?? 0) * 100) / 100,
          }
        : null,
    };
  }

  async redeemVoucher(code: string, pin: string, subscriberId: number) {
    const voucher = await this.prisma.voucher.findUnique({
      where: { code },
    });
    
    if (!voucher) {
      throw new NotFoundException('Voucher not found');
    }
    
    if (voucher.pin !== pin) {
      throw new Error('Invalid PIN');
    }
    
    if (voucher.status !== 'UNUSED') {
      throw new Error(`Voucher is already ${voucher.status}`);
    }

    if (voucher.expireDate && new Date() > voucher.expireDate) {
      await this.prisma.voucher.update({
        where: { id: voucher.id },
        data: { status: 'EXPIRED' },
      });
      throw new Error('Voucher has expired');
    }

    const subscriber = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
    });

    if (!subscriber) {
      throw new NotFoundException('Subscriber not found');
    }

    // ATOMIC CLAIM — the read above is advisory. Two concurrent redemptions can
    // both see UNUSED, so the real guard is this conditional write: only the
    // row that is STILL UNUSED (and not expired) flips to USED. Whoever loses
    // the race updates zero rows and is told the voucher is already redeemed —
    // preventing one code being spent twice.
    const claim = await this.prisma.voucher.updateMany({
      where: {
        id: voucher.id,
        status: 'UNUSED',
        OR: [{ expireDate: null }, { expireDate: { gt: new Date() } }],
      },
      data: {
        status: 'USED',
        usedBy: subscriberId,
        usedAt: new Date(),
        activatedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      throw new ConflictException('Voucher was just redeemed or expired — it is no longer available.');
    }

    return this.prisma.voucher.findUnique({ where: { id: voucher.id } });
  }

  /**
   * Destroy an unredeemed card.
   *
   * Scoped: a card is bearer value, so deleting one is destroying value. An
   * unscoped delete let any account with vouchers.write remove another
   * reseller's stock by id. A REDEEMED card is never deletable — it is the
   * record of a payment, and removing it would erase the audit trail of money
   * that actually changed hands.
   */
  async deleteVoucher(id: number, actor?: Actor) {
    const v = await this.prisma.voucher.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Card not found.');

    if (v.status === 'USED') {
      throw new BadRequestException(
        'This card has been redeemed, so it is part of the payment record and cannot be deleted.',
      );
    }

    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      const mine =
        (v.createdBy != null && ids.includes(v.createdBy)) ||
        (v.assignedToUserId != null && ids.includes(v.assignedToUserId));
      if (!mine) throw new ForbiddenException('That card belongs to another account.');
    }

    return this.prisma.voucher.delete({ where: { id } });
  }
}