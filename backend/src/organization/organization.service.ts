import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccountingService } from '../accounting/accounting.service';
import { ScopeService, Actor } from '../common/scope.service';
import { CurrencyService } from '../common/currency.service';

const RESELLER_ROLES = ['RESELLER', 'SUB_RESELLER', 'RETAILER', 'SALES'];
const round2 = (n: number) => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;

/**
 * Phase 4B: multi-tenancy (ISP → branches) + reseller economics.
 * Commission: when a payment lands, the subscriber's salesperson — and each
 * ancestor up the reseller chain — earns their own commissionPercent of it,
 * credited to their wallet with full 🔍 audit (UserBalanceTransaction + ledger).
 */
@Injectable()
export class OrganizationService {
  private readonly logger = new Logger(OrganizationService.name);

  constructor(
    private prisma: PrismaService,
    private accounting: AccountingService,
    private scope: ScopeService,
    private currency: CurrencyService,
  ) {}

  // ── ISPs ──────────────────────────────────────────────────────
  getIsps() {
    return this.prisma.isp.findMany({ include: { _count: { select: { branches: true } } }, orderBy: { id: 'asc' } });
  }
  createIsp(data: any) {
    if (!data.name?.trim()) throw new BadRequestException('Name is required');
    return this.prisma.isp.create({ data: { name: data.name.trim(), logoUrl: data.logoUrl || null } });
  }
  updateIsp(id: number, data: any) {
    return this.prisma.isp.update({ where: { id }, data: { name: data.name, logoUrl: data.logoUrl, isActive: data.isActive } });
  }
  async deleteIsp(id: number) {
    const branches = await this.prisma.branch.count({ where: { ispId: id } });
    if (branches > 0) throw new BadRequestException('Delete or move its branches first');
    return this.prisma.isp.delete({ where: { id } });
  }

  // ── Branches ──────────────────────────────────────────────────
  getBranches(ispId?: number) {
    return this.prisma.branch.findMany({
      where: ispId ? { ispId } : {},
      include: { isp: { select: { name: true } }, _count: { select: { subscribers: true, users: true } } },
      orderBy: { id: 'asc' },
    });
  }
  createBranch(data: any) {
    if (!data.name?.trim() || !data.ispId) throw new BadRequestException('Name and ispId are required');
    return this.prisma.branch.create({
      data: { name: data.name.trim(), ispId: Number(data.ispId), address: data.address || null },
    });
  }
  updateBranch(id: number, data: any) {
    return this.prisma.branch.update({
      where: { id },
      data: { name: data.name, address: data.address, isActive: data.isActive, ispId: data.ispId ? Number(data.ispId) : undefined },
    });
  }
  async deleteBranch(id: number) {
    const subs = await this.prisma.subscriber.count({ where: { branchId: id } });
    if (subs > 0) throw new BadRequestException('Move its subscribers to another branch first');
    return this.prisma.branch.delete({ where: { id } });
  }

  /** Bulk-assign subscribers (or users) to a branch. */
  async assign(branchId: number, body: { subscriberIds?: number[]; userIds?: number[] }) {
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new NotFoundException('Branch not found');
    const results = { subscribers: 0, users: 0 };
    if (body.subscriberIds?.length) {
      const r = await this.prisma.subscriber.updateMany({
        where: { id: { in: body.subscriberIds.map(Number) } },
        data: { branchId },
      });
      results.subscribers = r.count;
    }
    if (body.userIds?.length) {
      const r = await this.prisma.user.updateMany({
        where: { id: { in: body.userIds.map(Number) } },
        data: { branchId },
      });
      results.users = r.count;
    }
    return results;
  }

  // ── Reseller tree + wallets ───────────────────────────────────
  async resellerTree(actor?: Actor) {
    // Scope: a reseller only sees its own downline; ISP/platform sees all.
    const where: any = { role: { in: RESELLER_ROLES as any } };
    if (actor && !this.scope.isAdmin(actor.role)) {
      // A reseller manages its DOWNLINE only — never itself. Including self here
      // exposed the account's own wallet, commission % and top-up permission in
      // its own management screen, which are all the parent's to control.
      const selfId = this.scope.actorId(actor);
      const ids = (await this.scope.descendantIds(selfId)).filter((id) => id !== selfId);
      where.id = { in: ids.length ? ids : [-1] };
    }
    const users = await this.prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, role: true, parentId: true, balance: true,
        commissionPercent: true, isActive: true, branchId: true, canTopupDownline: true,
        // Needed by the pricing screen so a parent can see — and fix — why a
        // child cannot save prices. The toggle endpoint existed with no UI
        // behind it, which made the permission effectively unreachable.
        canSetPackagePrice: true,
        // Every delegated right travels with the account row so one screen can
        // show — and change — all of them together. Scattering them meant a
        // permission could exist, be enforced, and still be invisible.
        canAddNas: true,
        _count: { select: { salesSubscribers: true, children: true } },
      },
      orderBy: { id: 'asc' },
    });
    // build tree (roots = no parent or parent not a reseller)
    const byId = new Map(users.map((u) => [u.id, { ...u, children: [] as any[] }]));
    const roots: any[] = [];
    for (const u of byId.values()) {
      const parent = u.parentId ? byId.get(u.parentId) : null;
      if (parent) parent.children.push(u);
      else roots.push(u);
    }
    return roots;
  }

  /**
   * Overdrawn wallets — reseller accounts whose balance has gone below what
   * their credit limit allows. balance of -500 with a 500 credit limit is fine;
   * -600 is a genuine overdraft and means margin is being sold on money that
   * isn't there. Scoped to the actor's downline; ISP sees all.
   */
  async listOverdrawn(actor?: Actor) {
    const where: any = { role: { in: RESELLER_ROLES as any } };
    if (actor && !this.scope.isAdmin(actor.role)) {
      const selfId = this.scope.actorId(actor);
      const ids = (await this.scope.descendantIds(selfId)).filter((id) => id !== selfId);
      where.id = { in: ids.length ? ids : [-1] };
    }
    const users = await this.prisma.user.findMany({
      where,
      select: { id: true, name: true, email: true, role: true, parentId: true, balance: true, creditLimit: true },
      orderBy: { balance: 'asc' },
    });
    const overdrawn = users
      .map((u) => {
        const limit = (u as any).creditLimit ?? 0;
        // How far past the allowed floor (-limit) the balance sits.
        const overBy = round2(-limit - u.balance);
        return { ...u, creditLimit: limit, overBy };
      })
      .filter((u) => u.overBy > 0.005);
    return {
      count: overdrawn.length,
      totalOverdraft: round2(overdrawn.reduce((s, u) => s + u.overBy, 0)),
      accounts: overdrawn,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Commission statement per account — what each reseller earned in commission,
   * how much was clawed back when the underlying payment was refunded, and the
   * net. Makes the refund commission-clawback visible and reconcilable. Scoped
   * to the caller's subtree; ISP sees all. Optional date range.
   */
  async commissionStatement(actor?: Actor, opts: { from?: string; to?: string } = {}) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      const selfId = this.scope.actorId(actor);
      const ids = (await this.scope.descendantIds(selfId)).filter((id) => id !== selfId);
      where.userId = { in: ids.length ? ids : [-1] };
    }
    if (opts.from || opts.to) {
      where.createdAt = {};
      if (opts.from) where.createdAt.gte = new Date(opts.from);
      if (opts.to) where.createdAt.lte = new Date(opts.to);
    }
    // COMMISSION credits, plus the REV#-referenced ADJUSTMENT clawbacks.
    const rows = await this.prisma.userBalanceTransaction.findMany({
      where: {
        ...where,
        OR: [
          { type: 'COMMISSION' },
          { type: 'ADJUSTMENT', reference: { startsWith: 'REV#' } },
        ],
      },
      select: { userId: true, type: true, amount: true, reference: true },
    });

    const byUser = new Map<number, { userId: number; earned: number; clawedBack: number; net: number }>();
    for (const r of rows) {
      const isClawback = r.type === 'ADJUSTMENT';
      // A clawback amount is stored negative; count it as positive clawback.
      const row = byUser.get(r.userId) || { userId: r.userId, earned: 0, clawedBack: 0, net: 0 };
      if (isClawback) row.clawedBack = round2(row.clawedBack + Math.abs(r.amount || 0));
      else row.earned = round2(row.earned + (r.amount || 0));
      row.net = round2(row.earned - row.clawedBack);
      byUser.set(r.userId, row);
    }

    const ids = [...byUser.keys()];
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, role: true } })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u]));
    const accounts = [...byUser.values()]
      .map((r) => ({ ...r, name: nameById.get(r.userId)?.name ?? `#${r.userId}`, role: nameById.get(r.userId)?.role ?? '' }))
      .sort((a, b) => b.net - a.net);

    return {
      totalEarned: round2(accounts.reduce((s, a) => s + a.earned, 0)),
      totalClawedBack: round2(accounts.reduce((s, a) => s + a.clawedBack, 0)),
      totalNet: round2(accounts.reduce((s, a) => s + a.net, 0)),
      accounts,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Commission % is set BY THE PARENT, never by the account itself — it is the
   * cut this account earns on payments, so self-service would let a reseller
   * award itself any rate. The target must also sit inside the caller's own
   * subtree, so one branch can never touch another's numbers.
   */
  async setCommission(userId: number, percent: number, actor?: Actor) {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new BadRequestException('Commission must be 0–100');
    }
    if (actor) {
      if (userId === this.scope.actorId(actor) && !this.scope.isAdmin(actor.role)) {
        throw new ForbiddenException('You cannot set your own commission. Your parent account controls it.');
      }
      await this.scope.assertUser(actor, userId); // must be within your subtree
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: { commissionPercent: percent },
      select: { id: true, name: true, commissionPercent: true },
    });
  }

  /**
   * Wallet ledger for one account.
   *
   * Was completely unscoped — any logged-in account could read any other
   * account's full financial history by changing the id in the URL, including
   * sibling franchises and the ISP itself. Every top-up, every activation cost
   * and therefore the whole of that account's trading position was exposed.
   */
  async walletHistory(userId: number, actor?: Actor) {
    if (actor) await this.scope.assertUser(actor, Number(userId));
    const rows = await this.prisma.userBalanceTransaction.findMany({
      where: { userId }, orderBy: { id: 'desc' }, take: 200,
    });
    // Attach the name of whoever performed each transaction, so the ledger
    // reads "Franchise-1 added Rs 5,000" rather than a bare id. This is the
    // "who added the balance" record the operator needs.
    const byIds = [...new Set(rows.map((r) => r.createdBy).filter(Boolean))] as number[];
    const people = byIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: byIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    return rows.map((r) => ({ ...r, byName: r.createdBy ? nameOf.get(r.createdBy) ?? null : null }));
  }

  /**
   * Pull balance back out of a downline account, into the caller's own wallet.
   *
   * The route behind this was open: no scope check, no permission check, and
   * no ownership check. Any authenticated user could POST a WITHDRAWAL against
   * any account id in the system — a sibling dealer, another franchise, or the
   * ISP — and empty it. The money also simply vanished, since nothing credited
   * the account doing the withdrawing.
   *
   * Now it mirrors top-up exactly: direct children only, same permission, and
   * the money moves rather than disappearing.
   */
  async walletWithdrawScoped(actor: Actor, targetUserId: number, amount: number, notes?: string) {
    if (!amount || amount <= 0) throw new BadRequestException('Amount must be > 0');
    const actorId = this.scope.actorId(actor);
    if (targetUserId === actorId) throw new BadRequestException('Cannot withdraw from your own wallet');
    await this.scope.assertUser(actor, targetUserId);

    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException('Account not found');
    const actorUser = await this.prisma.user.findUnique({ where: { id: actorId } });

    // Same one-link-at-a-time rule as top-up: you can only reclaim from an
    // account you funded, otherwise a franchise could strip a retailer that
    // its own dealer had paid for.
    const isDirectChild = this.scope.isAdmin(actor?.role)
      ? target.parentId == null || target.parentId === actorId
      : target.parentId === actorId;
    if (!isDirectChild) {
      throw new ForbiddenException(
        `You can only withdraw from accounts directly below you. ${target.name} is funded by their own parent.`,
      );
    }
    if (!this.scope.isAdmin(actor?.role) && !actorUser?.canTopupDownline) {
      throw new ForbiddenException(
        'You do not have permission to move balance. Ask the ISP to enable it for your account.',
      );
    }

    const isSource = this.scope.isAdmin(actor?.role) || !actorUser?.parentId;

    return this.prisma.$transaction(async (tx) => {
      // Conditional update: the balance check and the debit are one statement,
      // so two concurrent withdrawals cannot both pass.
      const hit = await tx.user.updateMany({
        where: { id: targetUserId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (hit.count === 0) {
        throw new BadRequestException(
          `${target.name} has ${target.balance.toFixed(0)} — not enough to withdraw ${amount.toFixed(0)}.`,
        );
      }
      const after = await tx.user.findUnique({ where: { id: targetUserId }, select: { balance: true } });
      await tx.userBalanceTransaction.create({
        data: {
          userId: targetUserId, type: 'WITHDRAWAL', amount: -amount,
          balanceAfter: after?.balance ?? 0,
          notes: notes || `Reclaimed by ${actorUser?.name ?? 'parent account'}`,
          createdBy: actorId,
        } as any,
      });

      // The money returns to whoever took it — unless they are the top of the
      // tree, where balance is minted and burned rather than held.
      if (!isSource) {
        const credited = await tx.user.update({
          where: { id: actorId },
          data: { balance: { increment: amount } },
          select: { balance: true },
        });
        await tx.userBalanceTransaction.create({
          data: {
            userId: actorId, type: 'TOPUP', amount,
            balanceAfter: credited.balance,
            notes: `Reclaimed from ${target.name}`,
            createdBy: actorId,
          } as any,
        });
      }
      return { userId: targetUserId, balance: after?.balance ?? 0 };
    });
  }

  /**
   * @deprecated INTERNAL / SEEDING ONLY — do not expose on a route.
   *
   * This takes no actor and performs no scope, permission or ownership check.
   * It was wired to the public WITHDRAWAL route and let any authenticated user
   * empty any wallet in the system. Use walletTopupScoped() or
   * walletWithdrawScoped() for anything reachable from the API.
   */
  async walletAdjust(userId: number, amount: number, type: 'TOPUP' | 'WITHDRAWAL', notes?: string, byUserId?: number) {
    if (!amount || amount <= 0) throw new BadRequestException('Amount must be > 0');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const delta = type === 'TOPUP' ? amount : -amount;
    if (type === 'WITHDRAWAL' && user.balance < amount) throw new BadRequestException('Insufficient wallet balance');

    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { balance: { increment: delta } } }),
      this.prisma.userBalanceTransaction.create({
        data: { userId, type, amount: delta, balanceAfter: user.balance + delta, notes: notes || null, createdBy: byUserId },
      }),
    ]);
    await this.accounting.post([
      type === 'TOPUP'
        ? { account: 'CASH', debit: amount, description: `Reseller wallet top-up #${userId}`, createdBy: byUserId }
        : { account: 'RESELLER_BALANCE', debit: amount, description: `Reseller withdrawal #${userId}`, createdBy: byUserId },
      type === 'TOPUP'
        ? { account: 'RESELLER_BALANCE', credit: amount, description: `Reseller wallet top-up #${userId}`, createdBy: byUserId }
        : { account: 'CASH', credit: amount, description: `Reseller withdrawal #${userId}`, createdBy: byUserId },
    ]);
    return { userId, balance: updated.balance };
  }

  // ── Grant/revoke the "can add balance" permission ────────────
  async setTopupPermission(actor: Actor, targetUserId: number, allowed: boolean) {
    // Only the ISP/admin, or a reseller who already holds the permission, may delegate it.
    const actorId = this.scope.actorId(actor);
    // Nobody grants themselves rights — this is the parent's decision.
    if (targetUserId === actorId && !this.scope.isAdmin(actor?.role)) {
      throw new ForbiddenException('You cannot change your own permissions. Ask your parent account.');
    }
    const actorUser = await this.prisma.user.findUnique({ where: { id: actorId } });
    if (!this.scope.isAdmin(actor?.role) && !actorUser?.canTopupDownline) {
      throw new ForbiddenException('Only the ISP (or a delegate) can grant balance-adding permission.');
    }
    await this.scope.assertUser(actor, targetUserId); // must be in your subtree
    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { canTopupDownline: allowed },
      select: { id: true, name: true, canTopupDownline: true },
    });
    return updated;
  }

  /**
   * Set the display currency for this deployment. Operators run this product in
   * different countries, so the symbol shown next to every amount is theirs to
   * choose — it is presentation only and never converts stored values.
   */
  async setCurrency(actor: Actor, ispId: number, currency: string, currencySymbol: string) {
    if (!this.scope.isAdmin(actor?.role)) {
      throw new ForbiddenException('Only the ISP owner can change the display currency.');
    }
    const code = (currency || '').trim().toUpperCase().slice(0, 8);
    const symbol = (currencySymbol || code).trim().slice(0, 8);
    if (!code) throw new BadRequestException('Currency code is required (e.g. PKR, INR, USD).');

    /**
     * CHANGING THE CURRENCY IS NOT A DISPLAY SETTING.
     *
     * It used to be: amounts were stored bare and rendered with whatever this
     * field said, so flipping it silently reinterpreted the entire financial
     * history — a 5,000 PKR invoice from last year read as 5,000 USD, in every
     * report, with nothing anywhere recording what the money had actually been.
     *
     * Money rows now carry their own currency, so history is safe. But the
     * consequence has simply moved: from today onward this deployment holds
     * invoices in two currencies, and any report that wants one number has to
     * pick one. The operator should learn that here, from the screen where
     * they made the decision, rather than from a total that stops adding up.
     */
    const existing = await this.prisma.invoice.groupBy({
      by: ['currency'],
      _count: { _all: true },
      where: { currency: { notIn: ['', code] } },
    }).catch(() => [] as any[]);

    const updated = await this.prisma.isp.update({
      where: { id: Number(ispId) },
      data: { currency: code, currencySymbol: symbol },
      select: { id: true, name: true, currency: true, currencySymbol: true },
    });

    // The write path caches this; without the drop, invoices raised in the
    // next minute would still be stamped with the old code.
    this.currency.invalidate();

    const priorCount = existing.reduce((n: number, g: any) => n + (g?._count?._all ?? 0), 0);
    const priorCodes = existing.map((g: any) => g.currency).filter(Boolean);

    return {
      ...updated,
      /**
       * Present only when it matters. Existing history keeps its own currency
       * — that is the point of stamping — so this is information, not a
       * failure, and it must not read as though something broke.
       */
      ...(priorCount > 0
        ? {
            warning:
              `${priorCount} existing invoice(s) are priced in ${priorCodes.join(', ')} and keep that currency. ` +
              `New invoices will be in ${code}, so totals are now reported per currency rather than as one figure.`,
          }
        : {}),
    };
  }

  /**
   * Allow (or revoke) a downline account's ability to set the package price
   * its OWN children pay. Packages stay inherited; this only delegates the
   * onward pricing decision — and therefore who controls that tier's margin.
   *
   * Deliberately separate from wallet permissions: money in and out of a wallet
   * is always the parent's decision, no matter what pricing rights are granted.
   */
  async setPricePermission(actor: Actor, targetUserId: number, allowed: boolean) {
    const actorId = this.scope.actorId(actor);
    if (targetUserId === actorId && !this.scope.isAdmin(actor?.role)) {
      throw new ForbiddenException('You cannot change your own permissions.');
    }
    // Only the ISP, or a reseller that already holds the right, may delegate it.
    const actorUser = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { canSetPackagePrice: true },
    });
    if (!this.scope.isAdmin(actor?.role) && !actorUser?.canSetPackagePrice) {
      throw new ForbiddenException('You do not hold this permission, so you cannot grant it.');
    }
    await this.scope.assertUser(actor, targetUserId); // must be your downline

    return this.prisma.user.update({
      where: { id: targetUserId },
      data: { canSetPackagePrice: allowed },
      select: { id: true, name: true, canSetPackagePrice: true },
    });
  }

  /**
   * Allow (or revoke) a downline account's ability to register its OWN router.
   *
   * This existed as an enforced check in NasService with no way to grant it —
   * `canAddNas` defaults false, there was no endpoint and no UI, so every
   * reseller was permanently refused and the ISP had no switch to flip. The
   * enforcement was real; the permission was unreachable.
   *
   * Kept restrictive by default on purpose. A reseller that registers its own
   * NAS controls the RADIUS secret on it, and subscribers authenticating
   * against a router the ISP does not own are outside the ISP's visibility —
   * traffic, sessions and disconnects all become the reseller's to see and the
   * ISP's to guess at. Grant it to franchises running their own POPs; leave it
   * off for dealers who should be using routers handed down to them.
   */
  async setNasPermission(actor: Actor, targetUserId: number, allowed: boolean) {
    const actorId = this.scope.actorId(actor);
    if (targetUserId === actorId && !this.scope.isAdmin(actor?.role)) {
      throw new ForbiddenException('You cannot change your own permissions.');
    }
    // Only the ISP, or an account that already holds the right, may pass it on.
    const actorUser = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { canAddNas: true },
    });
    if (!this.scope.isAdmin(actor?.role) && !actorUser?.canAddNas) {
      throw new ForbiddenException(
        'You cannot add routers yourself, so you cannot grant that right to anyone else.',
      );
    }
    await this.scope.assertUser(actor, targetUserId); // must be your downline

    return this.prisma.user.update({
      where: { id: targetUserId },
      data: { canAddNas: allowed },
      select: { id: true, name: true, canAddNas: true },
    });
  }

  // ── Prepaid wallet transfer (scope + permission enforced) ────
  /**
   * The logged-in reseller adds balance to a DOWNLINE account. This is a real
   * prepaid transfer: the giver's wallet is debited and the receiver's credited,
   * so credit can only flow down and never be created out of thin air — EXCEPT
   * the top of a tree (SUPER_ADMIN, or a user with no parent) who is the source
   * and may "mint" credit into the system.
   */
  /**
   * Set a child account's credit limit — the overdraft it may run before
   * activations are blocked. Only the parent (or ISP) may set it, and only for
   * accounts inside their subtree.
   */
  async setCreditLimit(actor: Actor, targetUserId: number, limit: number) {
    const value = Math.max(0, Number(limit) || 0);
    if (!this.scope.isAdmin(actor?.role)) {
      await this.scope.assertUser(actor, targetUserId); // must be in my subtree
    }
    const before = await this.prisma.user.findUnique({ where: { id: targetUserId }, select: { name: true, creditLimit: true } });
    const updated = await this.prisma.user.update({
      where: { id: targetUserId }, data: { creditLimit: value }, select: { id: true, name: true, creditLimit: true },
    });
    await this.prisma.activityLog.create({
      data: {
        userId: this.scope.actorId(actor), action: 'SET_CREDIT_LIMIT', entity: 'User', entityId: targetUserId,
        details: `Credit limit for ${before?.name ?? targetUserId}: ${before?.creditLimit ?? 0} → ${value}`,
      },
    }).catch(() => null);
    return updated;
  }

  async walletTopupScoped(actor: Actor, targetUserId: number, amount: number, notes?: string) {
    if (!amount || amount <= 0) throw new BadRequestException('Amount must be > 0');
    // Permission: the target must be inside the actor's subtree (and not the actor itself).
    const actorId = this.scope.actorId(actor);
    if (targetUserId === actorId) throw new BadRequestException('Cannot top up your own wallet');
    await this.scope.assertUser(actor, targetUserId); // throws if outside subtree

    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundException('Account not found');

    const actorUser = await this.prisma.user.findUnique({ where: { id: actorId } });

    const isAdminActor = this.scope.isAdmin(actor?.role);

    /**
     * Who actually PAYS for the top-up = the target's DIRECT PARENT. Money
     * follows the commercial chain: a retailer is funded by its dealer, always,
     * so the dealer's wallet is the one that moves and the dealer's ledger
     * records it.
     *
     *   • A reseller may only top up its OWN direct child, from its own wallet
     *     (one link at a time — it cannot reach past its dealer).
     *   • The ISP/admin may top up ANY descendant, but the debit still hits that
     *     account's DIRECT PARENT. So "ISP adds balance to Booni's retailer"
     *     cuts BOONI's wallet, not the ISP's — the ISP is acting on the chain's
     *     behalf, and Booni's books stay correct.
     */
    if (!isAdminActor) {
      if (target.parentId !== actorId) {
        const parent = target.parentId
          ? await this.prisma.user.findUnique({ where: { id: target.parentId }, select: { name: true } })
          : null;
        throw new ForbiddenException(
          `You can only add balance to accounts directly below you. ` +
          `${target.name} is funded by ${parent?.name ?? 'their own parent'} — ` +
          `top up ${parent?.name ?? 'them'} instead and let them pass it down.`,
        );
      }
      if (!actorUser?.canTopupDownline) {
        throw new ForbiddenException('You do not have permission to add balance. Ask the ISP to enable it for your account.');
      }
    }

    // The funder is the target's direct parent. If that parent is the ISP/root,
    // the top-up mints (the source pays nobody); otherwise the parent's wallet
    // is debited and must have the balance.
    const funderId = isAdminActor ? target.parentId : actorId;
    const funder = funderId ? await this.prisma.user.findUnique({ where: { id: funderId } }) : null;
    const funderIsSource = !funder || this.scope.isAdmin(funder.role) || funder.parentId == null;

    // Shared reference links the receiver credit and funder debit so the whole
    // top-up can be reversed atomically later if it was a mistake.
    const topupRef = `TOP#${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const ops: any[] = [];
    // credit the receiver
    ops.push(this.prisma.user.update({ where: { id: targetUserId }, data: { balance: { increment: amount } } }));
    ops.push(this.prisma.userBalanceTransaction.create({
      data: { userId: targetUserId, type: 'TOPUP', amount, balanceAfter: target.balance + amount, reference: topupRef,
        notes: notes || `Top-up from ${funder?.name || actorUser?.name || 'upline'}${isAdminActor && funderId !== actorId ? ' (by ISP)' : ''}`,
        createdBy: actorId },
    }));

    if (!funderIsSource && funder) {
      // Real transfer — the direct parent pays for it (prepaid).
      if (funder.balance < amount) {
        throw new ForbiddenException(`${funder.name}'s wallet has ${funder.balance.toFixed(0)}, not enough to fund ${amount.toFixed(0)} for ${target.name}.`);
      }
      ops.push(this.prisma.user.update({ where: { id: funder.id }, data: { balance: { decrement: amount } } }));
      ops.push(this.prisma.userBalanceTransaction.create({
        data: { userId: funder.id, type: 'DEDUCT', amount: -amount, balanceAfter: funder.balance - amount, reference: topupRef,
          notes: `Funded ${target.name}${isAdminActor && funder.id !== actorId ? ' (initiated by ISP)' : ''}`, createdBy: actorId },
      }));
    }

    const [receiver] = await this.prisma.$transaction(ops);
    return { targetUserId, targetBalance: (receiver as any).balance, minted: funderIsSource, reference: topupRef };
  }

  /**
   * Reverse a wallet top-up done in error. Uses the shared reference to undo
   * BOTH sides — pull the amount back off the receiver and refund the funder —
   * with offsetting ADJUSTMENT rows (never editing the originals). Idempotent,
   * subtree-scoped, and refuses if the receiver has already spent the money.
   */
  async reverseWalletTopup(actor: Actor, reference: string, reason?: string) {
    if (!reference) throw new BadRequestException('Top-up reference is required');
    const legs = await this.prisma.userBalanceTransaction.findMany({ where: { reference } });
    if (!legs.length) throw new NotFoundException('Top-up not found — it may predate reversible top-ups.');
    if (await this.prisma.userBalanceTransaction.findFirst({ where: { reference: `REV#${reference}` }, select: { id: true } })) {
      throw new BadRequestException('This top-up has already been reversed.');
    }
    const credit = legs.find((l) => l.type === 'TOPUP');
    if (!credit) throw new BadRequestException('No top-up credit found for this reference.');
    await this.scope.assertUser(actor, credit.userId); // must be in the actor's subtree

    const receiver = await this.prisma.user.findUnique({ where: { id: credit.userId }, select: { balance: true, name: true } });
    if (!receiver) throw new NotFoundException('Receiver account not found');
    if ((receiver.balance ?? 0) < credit.amount - 0.005) {
      throw new BadRequestException(`${receiver.name} has already spent part of this top-up (balance ${round2(receiver.balance)} < ${round2(credit.amount)}). Reverse is unsafe.`);
    }

    const ops: any[] = [];
    const note = `Reversal of top-up ${reference}${reason ? ` — ${reason}` : ''}`;
    for (const leg of legs) {
      // Undo each leg: apply the opposite of what it did.
      const delta = -leg.amount; // TOPUP was +amount → pull back; DEDUCT was -amount → refund
      const u = await this.prisma.user.findUnique({ where: { id: leg.userId }, select: { balance: true } });
      const after = round2((u?.balance ?? 0) + delta);
      ops.push(this.prisma.user.update({ where: { id: leg.userId }, data: { balance: { increment: delta } } }));
      ops.push(this.prisma.userBalanceTransaction.create({
        data: { userId: leg.userId, type: 'ADJUSTMENT', amount: delta, balanceAfter: after, reference: `REV#${reference}`, notes: note, createdBy: this.scope.actorId(actor) },
      }));
    }
    await this.prisma.$transaction(ops);
    await this.prisma.activityLog.create({
      data: { userId: this.scope.actorId(actor), action: 'REVERSE_TOPUP', entity: 'User', entityId: credit.userId, details: note },
    }).catch(() => null);
    return { reversed: true, reference, amount: round2(credit.amount) };
  }

  // ── Commission distribution (called on every payment) ────────
  async distributeCommission(payment: { id: number; paymentNo?: string; amount: number; subscriberId: number | null }) {
    try {
      // No subscriber means the customer record was deleted after paying.
      // There is nobody to trace an upline from, so there is no commission
      // to distribute — the payment itself is untouched.
      if (payment.subscriberId == null) return;
      const sub = await this.prisma.subscriber.findUnique({
        where: { id: payment.subscriberId },
        select: { salespersonId: true },
      });
      if (!sub?.salespersonId) return;

      // walk the chain: salesperson → parent → grandparent (max 5 hops)
      let currentId: number | null = sub.salespersonId;
      let hops = 0;
      while (currentId && hops < 5) {
        const user: any = await this.prisma.user.findUnique({
          where: { id: currentId },
          select: { id: true, name: true, parentId: true, commissionPercent: true, balance: true, isActive: true },
        });
        if (!user) break;
        const cut = Math.round(payment.amount * (user.commissionPercent / 100) * 100) / 100;
        if (user.isActive && cut > 0) {
          await this.prisma.$transaction([
            this.prisma.user.update({ where: { id: user.id }, data: { balance: { increment: cut } } }),
            this.prisma.userBalanceTransaction.create({
              data: {
                userId: user.id,
                type: 'COMMISSION',
                amount: cut,
                balanceAfter: user.balance + cut,
                reference: payment.paymentNo || `PAY#${payment.id}`,
                notes: `${user.commissionPercent}% of ${payment.amount}`,
              },
            }),
          ]);
          await this.accounting.post([
            { account: 'COMMISSION', debit: cut, refType: 'PAYMENT', refId: payment.id, subscriberId: payment.subscriberId, description: `Commission → ${user.name}` },
            { account: 'RESELLER_BALANCE', credit: cut, refType: 'PAYMENT', refId: payment.id, subscriberId: payment.subscriberId, description: `Commission → ${user.name}` },
          ]);
        }
        currentId = user.parentId;
        hops++;
      }
    } catch (e: any) {
      this.logger.error(`Commission distribution failed for payment#${payment.id}: ${e.message}`);
    }
  }

  /**
   * Reverse the commission distributed for a payment — used on refund. Posts
   * offsetting entries against every account that earned a cut, referenced to
   * the payment, and idempotent (won't reverse the same payment's commission
   * twice). Never edits the original commission rows.
   */
  async reverseCommission(payment: { id: number; paymentNo?: string | null }, actorId?: number) {
    const ref = payment.paymentNo || `PAY#${payment.id}`;
    const revRef = `REV#${ref}`;
    const already = await this.prisma.userBalanceTransaction.findFirst({ where: { reference: revRef }, select: { id: true } });
    if (already) return { reversed: false, alreadyReversed: true };

    const rows = await this.prisma.userBalanceTransaction.findMany({
      where: { reference: ref, type: 'COMMISSION' },
    });
    if (!rows.length) return { reversed: false, rows: 0 };

    await this.prisma.$transaction(async (tx) => {
      for (const r of rows) {
        const signed = Number(r.amount || 0);
        if (!signed) continue;
        const u = await tx.user.update({ where: { id: r.userId }, data: { balance: { increment: -signed } }, select: { balance: true } });
        await tx.userBalanceTransaction.create({
          data: {
            userId: r.userId, type: 'ADJUSTMENT', amount: -signed, balanceAfter: u.balance,
            reference: revRef, notes: `Commission reversed on refund of ${ref}`, createdBy: actorId ?? null,
          } as any,
        });
      }
    });
    return { reversed: true, rows: rows.length, revRef };
  }

  // ── FRANCHISE GROUP PRICING (ISP sets wholesale price per franchise) ────

  /**
   * List all franchise users with their pricing for a given package.
   * ISP can see every franchise; a franchise only sees itself.
   */
  async listFranchisePricing(actor: any, packageId: number) {
    const where: any = { role: { in: RESELLER_ROLES as any } };
    if (!this.scope.isAdmin(actor?.role)) {
      const ids = await this.scope.descendantIds(this.scope.actorId(actor));
      where.id = { in: ids.length ? ids : [-1] };
    }
    const franchises = await this.prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, role: true, isActive: true,
        branchId: true, parentId: true, balance: true, commissionPercent: true,
        _count: { select: { salesSubscribers: true, children: true } },
      },
      orderBy: { name: 'asc' },
    });

    // Get existing pricing for this package
    const existingPrices = packageId ? await this.prisma.resellerPackagePrice.findMany({
      where: { packageId, userId: { in: franchises.map(f => f.id) } },
      select: { userId: true, price: true, retailPrice: true, subresellerProfit: true, subscriberProfit: true },
    }) : [];

    const priceMap = new Map(existingPrices.map(p => [p.userId, p]));

    return franchises.map(f => ({
      ...f,
      wholesalePrice: priceMap.get(f.id)?.price ?? null,
      retailPrice: priceMap.get(f.id)?.retailPrice ?? null,
      subresellerProfit: priceMap.get(f.id)?.subresellerProfit ?? null,
      subscriberProfit: priceMap.get(f.id)?.subscriberProfit ?? null,
      assigned: priceMap.has(f.id),
    }));
  }

  /**
   * Set wholesale price for a franchise on a package.
   * Bypasses the direct-child hierarchy check for ISP accounts.
   */
  async setFranchisePricing(actor: any, body: { userId: number; packageId: number; price: number }) {
    const userId = Number(body.userId);
    const packageId = Number(body.packageId);
    const price = Number(body.price);

    if (!packageId || !userId) throw new BadRequestException('userId and packageId are required');
    if (isNaN(price) || price < 0) throw new BadRequestException('price must be a non-negative number');

    const franchise = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true } });
    if (!franchise) throw new NotFoundException('User not found');

    // ISP can set pricing for any reseller; non-admin must use the regular hierarchy
    if (!this.scope.isAdmin(actor?.role)) {
      await this.scope.assertUser(actor, userId);
    }

    return this.prisma.resellerPackagePrice.upsert({
      where: { userId_packageId: { userId, packageId } },
      update: { price },
      create: { userId, packageId, price },
      include: {
        package: { select: { id: true, name: true, price: true } },
        user: { select: { id: true, name: true, role: true } },
      },
    });
  }

  /**
   * Remove a franchise's assignment to a package.
   */
  async removeFranchisePricing(actor: any, userId: number, packageId: number) {
    const existing = await this.prisma.resellerPackagePrice.findUnique({
      where: { userId_packageId: { userId, packageId } },
    });
    if (!existing) throw new NotFoundException('No pricing found for this franchise-package pair');

    if (!this.scope.isAdmin(actor?.role)) {
      await this.scope.assertUser(actor, userId);
    }

    await this.prisma.resellerPackagePrice.delete({
      where: { userId_packageId: { userId, packageId } },
    });
    return { ok: true };
  }
}
