import { Injectable, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * ResellerPricingService — the wholesale price ladder + wallet cascade.
 *
 * Each user sets the price it charges the tier directly BELOW it for a package
 * (ResellerPackagePrice). When a subscriber is activated under a reseller, the
 * cost cascades up the parent chain: the activator's wallet is debited by its
 * buy price, every middle tier keeps its markup (sell − buy), and the top (ISP)
 * account is debited by the base cost. Every movement is a UserBalanceTransaction.
 */
@Injectable()
export class ResellerPricingService {
  private readonly logger = new Logger(ResellerPricingService.name);

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  // ── Price list management ────────────────────────────────────
  /** Prices visible to the actor: its own + its descendants'. */
  async listPrices(actor: Actor, packageId?: number) {
    const where: any = {};
    if (packageId) where.packageId = Number(packageId);
    if (!this.scope.isAdmin(actor?.role)) {
      const ids = await this.scope.descendantIds(this.scope.actorId(actor));
      where.userId = { in: ids };
    }
    return this.prisma.resellerPackagePrice.findMany({
      where,
      include: {
        package: { select: { id: true, name: true, price: true } },
        user: { select: { id: true, name: true, role: true } },
      },
      orderBy: [{ packageId: 'asc' }, { userId: 'asc' }],
    });
  }

  /** Set (upsert) a price. A reseller may only price for itself or a descendant. */
  async setPrice(actor: Actor, body: {
    userId?: number;
    packageId: number;
    price?: number;
    retailPrice?: number;
    subresellerProfit?: number;
    subscriberProfit?: number;
  }) {
    const packageId = Number(body.packageId);

    // price is the only genuinely required field — the others are optional extras.
    // But for updates where only profit fields change, price might already exist.
    if (!packageId) {
      throw new ForbiddenException('packageId is required.');
    }
    let userId = body.userId ? Number(body.userId) : this.scope.actorId(actor);

    /**
     * DIRECT CHILDREN ONLY.
     *
     * Each tier prices the tier immediately below it and nobody else. That is
     * what makes the cascade work: your margin is what your child pays minus
     * what you pay, so if you could price your grandchild directly you would
     * be setting your child's income without their involvement, and the middle
     * tier's margin would become whatever was left over — possibly negative.
     *
     * It also keeps responsibility where the commercial relationship is. You
     * negotiate with your dealer; your dealer negotiates with their retailer.
     */
    const meId = this.scope.actorId(actor);
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, parentId: true, role: true },
    });
    if (!target) throw new ForbiddenException('That account does not exist.');

    const isDirectChild = this.scope.isAdmin(actor?.role)
      // For the ISP, a "direct child" is a top-level reseller — one whose
      // parent is the ISP's own account, or who sits at the root of the tree.
      ? target.parentId == null || target.parentId === meId
      : target.parentId === meId;

    if (!isDirectChild && userId !== meId) {
      const parent = target.parentId
        ? await this.prisma.user.findUnique({
            where: { id: target.parentId }, select: { name: true },
          })
        : null;
      throw new ForbiddenException(
        `You can only set prices for accounts directly below you. ` +
        `${target.name} belongs to ${parent?.name ?? 'another account'} — ` +
        `${parent?.name ?? 'they'} must set that price so their own margin stays theirs to decide.`,
      );
    }

    if (!this.scope.isAdmin(actor?.role)) {

      // Permission gate: setting the price your downline pays is what creates
      // their margin, so it is delegated explicitly. Packages themselves are
      // always inherited — this only controls the onward selling price.
      const me = await this.prisma.user.findUnique({
        where: { id: meId },
        select: { canSetPackagePrice: true },
      });
      if (!me?.canSetPackagePrice) {
        throw new ForbiddenException(
          'Price-setting is switched off for this account. The ISP can enable it under ' +
          'Administration → Organization → Resellers → "can set price".',
        );
      }

      // You price for your DOWNLINE, never for yourself — your own buy price is
      // set by your parent. Otherwise a reseller could lower its own cost.
      if (userId === meId) {
        throw new ForbiddenException(
          'You cannot set your own price — your parent sets what you pay. You can only price for your downline.',
        );
      }
      await this.scope.assertUser(actor, userId); // must be inside your subtree

      // You must own or have been assigned this package before passing it on.
      const mine = await this.prisma.resellerPackagePrice.findUnique({
        where: { userId_packageId: { userId: meId, packageId } },
      });
      const pkg = await this.prisma.package.findUnique({
        where: { id: packageId },
        select: { price: true, ownerId: true },
      });
      const myCost = mine?.price ?? (pkg?.ownerId === meId ? 0 : pkg?.price ?? 0);

      if (!mine && pkg?.ownerId !== meId) {
        throw new ForbiddenException(
          'This package has not been assigned to you, so you cannot assign it onward.',
        );
      }

      // Selling below your own cost would make the cascade pay out more than it
      // takes in — the margin (sell − cost) would be negative.
      const p = body.price !== undefined ? Number(body.price) : undefined;
      if (p !== undefined && p < myCost) {
        throw new ForbiddenException(
          `Price cannot be below your own cost of ${myCost}. You would lose ${(myCost - p).toFixed(2)} per activation.`,
        );
      }
    }

    // Build the data object with only the provided fields, preserving existing ones
    const priceVal = body.price !== undefined ? Number(body.price) : undefined;
    const retailPrice = body.retailPrice !== undefined ? Number(body.retailPrice) : undefined;
    const subresellerProfit = body.subresellerProfit !== undefined ? Number(body.subresellerProfit) : undefined;
    const subscriberProfit = body.subscriberProfit !== undefined ? Number(body.subscriberProfit) : undefined;

    // If no price is provided, read the existing one (or package default) for upsert
    const existingPrice = priceVal !== undefined ? priceVal : (
      await this.prisma.resellerPackagePrice.findUnique({
        where: { userId_packageId: { userId, packageId } },
      }).then((r) => r?.price)
    );

    return this.prisma.resellerPackagePrice.upsert({
      where: { userId_packageId: { userId, packageId } },
      update: {
        ...(priceVal !== undefined && { price: priceVal }),
        ...(retailPrice !== undefined && { retailPrice }),
        ...(subresellerProfit !== undefined && { subresellerProfit }),
        ...(subscriberProfit !== undefined && { subscriberProfit }),
      },
      create: {
        userId,
        packageId,
        price: existingPrice ?? 0,
        ...(retailPrice !== undefined && { retailPrice }),
        ...(subresellerProfit !== undefined && { subresellerProfit }),
        ...(subscriberProfit !== undefined && { subscriberProfit }),
      },
    });
  }

  /**
   * Set what MY OWN end subscribers pay for a package (my retail price).
   *
   * This is the piece a leaf account was missing entirely. `setPrice()` prices
   * your DOWNLINE — so a dealer with no accounts below them could not enter a
   * price anywhere, even though they are the tier that actually sells to
   * customers. Their screen showed nothing and their profit read as zero.
   *
   * Unlike setPrice() this needs no delegated permission: what you charge your
   * own customers is always yours to decide. What it does need is a floor —
   * selling below your buy price means every customer you win loses you money.
   */
  async setRetailPrice(actor: Actor, packageId: number, retailPrice: number) {
    const pkgId = Number(packageId);
    const retail = Number(retailPrice);
    if (!pkgId || Number.isNaN(retail) || retail < 0) {
      throw new ForbiddenException('packageId and a non-negative retail price are required.');
    }
    const meId = await this.scope.rootId(actor);

    const pkg = await this.prisma.package.findUnique({
      where: { id: pkgId },
      select: { price: true, ownerId: true, name: true },
    });
    if (!pkg) throw new ForbiddenException('That package does not exist.');

    const existing = await this.prisma.resellerPackagePrice.findUnique({
      where: { userId_packageId: { userId: meId, packageId: pkgId } },
    });

    // My real cost per activation:
    //   • explicit row if I have one,
    //   • zero if I'm the ISP / owner (I pay nobody),
    //   • otherwise the INHERITED cost from the nearest priced ancestor — NOT
    //     the ISP base. This is the fix that lets a retailer set their own
    //     subscriber price on a package their dealer sells: their cost is what
    //     the dealer pays (e.g. Rs 1000), so the loss-guard and the stored buy
    //     price are both correct instead of collapsing to the base (Rs 500).
    const myCost = existing?.price
      ?? (pkg.ownerId === meId || this.scope.isAdmin(actor?.role)
        ? 0
        : await this.priceFor(meId, pkgId, pkg.price));

    if (retail < myCost) {
      throw new ForbiddenException(
        `You pay ${myCost} for ${pkg.name}, so you cannot sell it at ${retail} — ` +
        `you would lose ${(myCost - retail).toFixed(0)} on every subscriber you activate.`,
      );
    }

    return this.prisma.resellerPackagePrice.upsert({
      where: { userId_packageId: { userId: meId, packageId: pkgId } },
      update: { retailPrice: retail },
      // Store the real inherited cost as our buy price so the record is coherent
      // and the cascade stays monotonic. If our parent later sets our price
      // explicitly, setPrice() updates this same row.
      create: { userId: meId, packageId: pkgId, price: myCost, retailPrice: retail },
    });
  }

  /**
   * Assign MANY packages to MANY resellers in one action.
   *
   * `prices` maps packageId → price. Anything missing falls back to `price`.
   * Each pair goes through setPrice(), so every guard still applies (subtree
   * scope, no self-pricing, never below your own cost) — one rejected pair
   * doesn't abort the batch.
   */
  async assignBulk(
    actor: Actor,
    body: { packageIds: number[]; userIds: number[]; price?: number; prices?: Record<string, number> },
  ) {
    const results: any[] = [];
    for (const packageId of body.packageIds || []) {
      const p = body.prices?.[String(packageId)] ?? body.price;
      if (p === undefined || p === null) {
        results.push({ packageId, error: 'No price given for this package' });
        continue;
      }
      for (const userId of body.userIds || []) {
        try {
          const row = await this.setPrice(actor, { userId: Number(userId), packageId: Number(packageId), price: Number(p) });
          results.push({ assigned: true, packageId, userId, price: row.price });
        } catch (e: any) {
          results.push({ assigned: false, packageId, userId, error: e?.message || String(e) });
        }
      }
    }
    return {
      requested: (body.packageIds?.length || 0) * (body.userIds?.length || 0),
      assigned: results.filter((r) => r.assigned).length,
      results,
    };
  }

  /**
   * Quote, filtered to what the caller is allowed to see.
   *
   * PRIVACY RULE: an account may see its OWN cost and the prices/margins of its
   * DOWNLINE. It must never see what its parent pays upstream — that is the
   * parent's trade secret, and exposing it would reveal the whole chain's
   * markup. So movements belonging to ancestors are stripped, along with the
   * package base price (which is the ISP's cost).
   */
  async quoteFor(actor: Actor, subscriberId: number) {
    const q = await this.quote(subscriberId);
    if (!q) return null;
    if (this.scope.isAdmin(actor?.role)) return q;

    const rootId = await this.scope.rootId(actor);
    const visible = new Set(await this.scope.descendantIds(rootId)); // me + below

    const movements = q.movements.filter((m) => visible.has(m.userId));
    const mine = movements.find((m) => m.userId === rootId);

    return {
      subscriberId: q.subscriberId,
      packageId: q.packageId,
      packageName: q.packageName,
      // `base` deliberately omitted — it is the ISP's cost.
      myCost: mine ? Math.abs(mine.delta) : null,
      movements,
      hiddenTiers: q.movements.length - movements.length,
    };
  }

  /**
   * The price ladder for one package: every tier's BUY price, what each of its
   * children pays, and the margin earned per activation.
   *
   * Packages are inherited, so every account below the owner sells the same
   * product — only the price changes as it passes down. This shows exactly
   * where each rupee of margin is created.
   */
  async priceLadder(actor: Actor, packageId: number) {
    const pkg = await this.prisma.package.findUnique({
      where: { id: Number(packageId) },
      select: { id: true, name: true, price: true },
    });
    if (!pkg) return null;

    // Visibility: yourself + your downline. Ancestors are excluded, so a
    // reseller can never read what its parent pays upstream.
    const rootId = this.scope.isAdmin(actor?.role)
      ? null
      : await this.scope.rootId(actor);

    const users = await this.prisma.user.findMany({
      where: rootId ? { id: { in: await this.scope.descendantIds(rootId) } } : {},
      select: { id: true, name: true, role: true, parentId: true },
      orderBy: { id: 'asc' },
    });

    const priceRows = await this.prisma.resellerPackagePrice.findMany({
      where: { packageId: Number(packageId), userId: { in: users.map((u) => u.id) } },
      select: { userId: true, price: true, retailPrice: true },
    });
    const buyOf = new Map(priceRows.map((r) => [r.userId, r.price]));
    // What each tier charges its own END CUSTOMERS. A tier with no accounts
    // below it earns nothing from the wholesale ladder — all of its profit is
    // retail − buy, so a ladder that ignored retail showed the last (and often
    // largest) tier of the business earning zero.
    const retailOf = new Map(
      priceRows.filter((r) => r.retailPrice != null).map((r) => [r.userId, r.retailPrice as number]),
    );

    // A user's buy price inherits the nearest priced ancestor's cost (walking up
    // the parentId chain within this list), falling back to base only at the
    // top — mirrors priceFor(). Without this, an unpriced tier showed the ISP
    // base (e.g. Rs 500) as its cost, below what its own parent pays.
    const byId = new Map(users.map((u) => [u.id, u]));
    const resolveBuy = (uid: number): number => {
      let cur: any = byId.get(uid);
      const seen = new Set<number>();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (buyOf.has(cur.id)) return buyOf.get(cur.id)!;
        cur = cur.parentId != null ? byId.get(cur.parentId) : null;
      }
      return pkg.price;
    };

    const rows = users.map((u) => {
      const myBuy = resolveBuy(u.id);
      const children = users.filter((c) => c.parentId === u.id);
      const sales = children
        .filter((c) => buyOf.has(c.id))
        .map((c) => {
          const theyPay = buyOf.get(c.id)!;
          return {
            childId: c.id,
            childName: c.name,
            childRole: c.role,
            theyPay,
            myMargin: Math.round((theyPay - myBuy) * 100) / 100,
          };
        });

      return {
        userId: u.id,
        name: u.name,
        role: u.role,
        parentId: u.parentId,
        assigned: buyOf.has(u.id),
        buyPrice: myBuy,          // what THIS account pays per activation
        sells: sales,             // what each child pays, and the margin earned
        bestMargin: sales.length ? Math.max(...sales.map((s) => s.myMargin)) : 0,
        // Direct-to-customer selling, which exists at EVERY tier — not just
        // the bottom one. A franchise can hold its own subscribers as well as
        // dealers, and both streams count toward what it earns.
        retailPrice: retailOf.get(u.id) ?? null,
        retailMargin: retailOf.has(u.id)
          ? Math.round((retailOf.get(u.id)! - myBuy) * 100) / 100
          : null,
      };
    });

    return { package: pkg, ladder: rows };
  }

  async removePrice(actor: Actor, userId: number, packageId: number) {
    if (!this.scope.isAdmin(actor?.role)) await this.scope.assertUser(actor, userId);
    await this.prisma.resellerPackagePrice
      .delete({ where: { userId_packageId: { userId: Number(userId), packageId: Number(packageId) } } })
      .catch(() => null);
    return { removed: true };
  }

  // ── Price resolution ─────────────────────────────────────────
  /**
   * A user's BUY price for a package.
   *
   * If the user has their own assigned price, that's it. If not, they inherit
   * the NEAREST priced ancestor's cost — NOT the ISP base. This is the fix for
   * the broken ladder: a retailer whose dealer hasn't set their price used to
   * fall through to the ISP's base price (e.g. Rs 500), which is LESS than the
   * dealer paid (Rs 1000). That made the retailer cheaper than its own dealer,
   * and on activation the cascade debited the dealer's wallet a negative margin.
   *
   * Inheriting the parent's cost keeps every tier ≥ the tier above it: an
   * unpriced retailer simply buys at its dealer's cost (the dealer earns zero
   * until it sets a markup), and the package is still sellable immediately.
   */
  private async priceFor(userId: number, packageId: number, basePrice: number): Promise<number> {
    const chain = await this.chainUp(userId); // [self, parent, …, root]
    const rows = await this.prisma.resellerPackagePrice.findMany({
      where: { packageId, userId: { in: chain.map((c) => c.id) } },
      select: { userId: true, price: true },
    });
    const byUser = new Map(rows.map((r) => [r.userId, r.price]));
    for (const node of chain) if (byUser.has(node.id)) return byUser.get(node.id) as number;
    return basePrice; // only the ISP, or a fully-unpriced chain, reaches base
  }

  /** Parent chain from a user up to the root: [self, parent, …, root]. */
  private async chainUp(userId: number): Promise<{ id: number; role: string }[]> {
    const rows = await this.prisma.$queryRaw<{ id: number; role: string }[]>`
      WITH RECURSIVE up AS (
        SELECT id, "parentId", role, 0 AS depth FROM "User" WHERE id = ${userId}
        UNION ALL
        SELECT u.id, u."parentId", u.role, up.depth + 1
        FROM "User" u INNER JOIN up ON u.id = up."parentId"
      )
      SELECT id, role FROM up ORDER BY depth ASC;`;
    return rows.map((r) => ({ id: Number(r.id), role: r.role }));
  }

  /**
   * What `userId` must pay to activate `packageId` = the price its PARENT charges
   * it (or the base package price if unset). Used for the prepaid balance check.
   * Returns 0 for a top-of-tree user (they are the source, not a buyer).
   */
  async activationCost(userId: number, packageId: number, basePrice: number): Promise<number> {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { parentId: true } });
    if (!me?.parentId) return 0; // top of the tree buys from no one
    // A user's price row IS their buy price — the price their parent assigned
    // the package to them at.
    return this.priceFor(userId, packageId, basePrice);
  }

  // ── Cascade ──────────────────────────────────────────────────
  /**
   * Compute the per-tier money movement for activating `subscriberId`.
   * Returns null if the subscriber has no owner or no package.
   */
  async quote(subscriberId: number, db: Prisma.TransactionClient = this.prisma as any) {
    // Read through the passed transaction client when there is one, so a package
    // that was just set inside an uncommitted activation transaction is visible.
    // Reading via this.prisma there saw the OLD (null) package and made the
    // settlement a no-op — the subscriber activated but no wallet was charged.
    const sub = await db.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, userId: true, packageId: true, package: { select: { price: true, name: true } } },
    });
    if (!sub?.userId || !sub.packageId) return null;

    const base = sub.package?.price ?? 0;
    const chain = await this.chainUp(sub.userId); // [owner, a1, a2, ..., root]
    if (chain.length === 0) return null;

    // resolve every tier's sell price
    const sell: Record<number, number> = {};
    for (const node of chain) sell[node.id] = await this.priceFor(node.id, sub.packageId, base);

    const movements: { userId: number; role: string; delta: number; note: string }[] = [];

    /**
     * `sell[userId]` is that user's BUY price — what their parent charges them.
     *
     *   • the activator PAYS their own buy price
     *   • each middle tier EARNS (what my child pays me) − (what I pay upward)
     *   • the ISP at the top RECEIVES what its direct child pays it
     *
     * The last line is the fix. The ISP used to be debited `-sell[root]`,
     * described as "consuming its own cost" — but the ISP owns the package and
     * pays nobody. That drove the ISP wallet steadily NEGATIVE on every
     * activation, and broke the arithmetic: the money the activator spent did
     * not equal the money the chain received.
     *
     * With 1200 → 800 the movements must be −1200, +400, +800, summing to zero.
     * Previously the top was −500 (the base price), so the cascade destroyed
     * 900 per activation and the ISP absorbed the loss.
     */
    if (chain.length === 1) {
      // The ISP activated its own customer — no internal transfer happens.
      // They collect the money from the subscriber directly; there is no
      // upline to pay and no downline to earn from.
      movements.push({
        userId: chain[0].id, role: chain[0].role, delta: 0,
        note: 'Direct ISP customer — no reseller settlement',
      });
    } else {
      const owner = chain[0];
      const ownerBuy = sell[owner.id]; // the price assigned TO the activator
      movements.push({ userId: owner.id, role: owner.role, delta: -ownerBuy, note: `Buy price ${ownerBuy}` });

      // middle tiers keep the difference between what their child pays them
      // and what they themselves pay upward
      for (let i = 1; i < chain.length - 1; i++) {
        const childPays = sell[chain[i - 1].id];
        const iPay = sell[chain[i].id];
        const margin = Math.round((childPays - iPay) * 100) / 100;
        movements.push({ userId: chain[i].id, role: chain[i].role, delta: margin, note: `Margin ${childPays}−${iPay}` });
      }

      // The ISP RECEIVES what its direct child pays it. It owns the package,
      // so it pays nobody — this is revenue, not cost.
      const root = chain[chain.length - 1];
      const directChild = chain[chain.length - 2];
      const theyPayMe = sell[directChild.id];
      movements.push({
        userId: root.id, role: root.role, delta: theyPayMe,
        note: `Received from ${directChild.role.toLowerCase()} (${theyPayMe})`,
      });
    }

    return { subscriberId, packageId: sub.packageId, packageName: sub.package?.name, base, movements };
  }

  // ── Simple layman accounting: profit per layer + per subscriber ──
  /**
   * Earnings summary per account, scoped to the actor's subtree.
   * earned = money added to the wallet from activations (their margin),
   * spent  = money burned from the wallet buying activations (their cost),
   * balance = current wallet. Everything is already recorded per sale.
   */
  async profitSummary(actor: Actor) {
    const admin = this.scope.isAdmin(actor?.role);
    const ids = admin ? null : await this.scope.descendantIds(this.scope.actorId(actor));
    const whereClause: Prisma.Sql = admin
      ? Prisma.sql`WHERE u.role IN ('RESELLER','SUB_RESELLER','RETAILER','SALES','ADMIN')`
      : Prisma.sql`WHERE u.id IN (${Prisma.join(ids && ids.length ? ids : [0])})`;
    const rows: any[] = await this.prisma.$queryRaw(
      Prisma.sql`
        SELECT u.id, u.name, u.role, u.balance,
          COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) AS earned,
          COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) AS spent,
          COUNT(t.id) AS movements
        FROM "User" u
        LEFT JOIN "UserBalanceTransaction" t
          ON t."userId" = u.id AND t.reference LIKE 'SUB#%'
        ${whereClause}
        GROUP BY u.id
        ORDER BY earned DESC`);
    /**
     * RETAIL REVENUE — the missing half of every reseller's profit.
     *
     * This report summed UserBalanceTransaction only, which is money moving
     * BETWEEN accounts. For a dealer at the bottom of the tree that is all
     * outgoing: their wallet is debited 1,000 per activation and nothing is
     * ever credited back, because their income arrives as cash from the
     * customer and never touches a wallet.
     *
     * So the screen showed earned=0, spent=1,000, net=−1,000 — a dealer
     * running a healthy business was told they were losing money on every
     * customer they signed. The number was not wrong so much as half a story.
     *
     * Real profit = wholesale margin (from the downline)
     *             + retail collected (from their own customers)
     *             − wholesale cost (paid to their parent)
     */
    // `ids` is already taken above by the scope filter — this is the set of
    // accounts the query actually returned, which is not the same thing.
    const rowIds = rows.map((r) => Number(r.id));
    const retail = rowIds.length
      ? await this.prisma.$queryRaw<Array<{ userId: number; collected: number; billed: number; subs: number }>>(Prisma.sql`
          SELECT s."userId"                                   AS "userId",
                 COALESCE(SUM(i."paidAmount"), 0)             AS collected,
                 COALESCE(SUM(i.total), 0)                    AS billed,
                 COUNT(DISTINCT s.id)                         AS subs
          FROM "Subscriber" s
          LEFT JOIN "Invoice" i ON i."subscriberId" = s.id
          WHERE s."userId" IN (${Prisma.join(rowIds)})
          GROUP BY s."userId"`)
      : [];
    const retailMap = new Map(
      retail.map((r) => [Number(r.userId), {
        collected: Number(r.collected), billed: Number(r.billed), subs: Number(r.subs),
      }]),
    );

    return rows.map((r) => {
      const id = Number(r.id);
      const earned = Number(r.earned);      // margin from the downline
      const spent = Number(r.spent);        // cost paid upward
      const rt = retailMap.get(id) ?? { collected: 0, billed: 0, subs: 0 };
      return {
        id, name: r.name, role: r.role,
        balance: Number(r.balance),
        earned, spent,
        // Kept for compatibility: wallet-only net, as before.
        net: earned - spent,
        // What the customers were billed, and what has actually been collected.
        retailBilled: rt.billed,
        retailCollected: rt.collected,
        ownSubscribers: rt.subs,
        /**
         * The number a reseller actually cares about. Uses COLLECTED rather
         * than billed — an unpaid invoice is not profit, and counting it as
         * such is how a business talks itself into being solvent.
         */
        totalProfit: Math.round((earned + rt.collected - spent) * 100) / 100,
        movements: Number(r.movements),
      };
    });
  }

  /**
   * One account's own books: what they sold, what it cost them, what is left.
   *
   * Deliberately separate from profitSummary(), which answers "how is my
   * downline doing". This answers "how am *I* doing" — the question a dealer
   * with no downline actually has, and the one the panel could not answer at
   * all because every screen was built around wallet movements between
   * accounts rather than trade with customers.
   */
  async myBooks(actor: Actor) {
    const meId = await this.scope.rootId(actor);

    const [wallet, subs, invoices] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: meId }, select: { balance: true, name: true } }),
      this.prisma.subscriber.findMany({
        where: { userId: meId },
        select: { id: true, fullName: true, status: true, sellPrice: true, costPrice: true, profit: true,
                  package: { select: { name: true } } },
      }),
      this.prisma.$queryRaw<Array<{ billed: number; collected: number; outstanding: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(i.total), 0)                              AS billed,
               COALESCE(SUM(i."paidAmount"), 0)                       AS collected,
               COALESCE(SUM(i.total - i."paidAmount"), 0)             AS outstanding
        FROM "Invoice" i
        JOIN "Subscriber" s ON s.id = i."subscriberId"
        WHERE s."userId" = ${meId}`),
    ]);

    // Wallet movements: what this account paid upward, and earned from below.
    const moves = await this.prisma.$queryRaw<Array<{ paidUp: number; earnedDown: number }>>(Prisma.sql`
      SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS "paidUp",
             COALESCE(SUM(CASE WHEN amount > 0 THEN  amount ELSE 0 END), 0) AS "earnedDown"
      FROM "UserBalanceTransaction"
      WHERE "userId" = ${meId} AND reference LIKE 'SUB#%'`);

    const inv = invoices[0] ?? { billed: 0, collected: 0, outstanding: 0 };
    const mv = moves[0] ?? { paidUp: 0, earnedDown: 0 };

    const collected = Number(inv.collected);
    const paidUp = Number(mv.paidUp);
    const earnedDown = Number(mv.earnedDown);

    return {
      account: wallet?.name,
      walletBalance: wallet?.balance ?? 0,

      // What I sell to my own customers.
      ownSubscribers: subs.length,
      billedToCustomers: Number(inv.billed),
      collectedFromCustomers: collected,
      stillOwedByCustomers: Number(inv.outstanding),

      // What the business costs me, and what my downline pays me.
      paidToParent: paidUp,
      earnedFromDownline: earnedDown,

      /**
       * Collected, not billed. An invoice you have not been paid is not
       * profit, and treating it as one is how an ISP runs out of cash while
       * the dashboard says it is doing well.
       */
      profit: Math.round((collected + earnedDown - paidUp) * 100) / 100,

      perSubscriber: subs.map((s) => ({
        id: s.id, name: s.fullName, status: s.status, package: s.package?.name,
        theyPay: s.sellPrice, costsMe: s.costPrice, marginPerCycle: s.profit,
      })),
    };
  }

  /**
   * FULL ACCOUNTABILITY for the logged-in account: profit / cost / expenses over
   * time (today, this week, this month, all-time), the balance flow (what the
   * parent loaded to you, what you loaded to your children, your wallet now), and
   * a per-child breakdown ("from this child you earned X; you loaded them Y").
   * Everything ties back to recorded transactions so it is auditable in production.
   */
  async accountability(actor: Actor) {
    const r2 = (n: any) => Math.round(Number(n || 0) * 100) / 100;
    const meId = await this.scope.rootId(actor);
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(dayStart);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // Monday
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // ── Period P&L ────────────────────────────────────────────────
    const pnl = async (from: Date | null) => {
      const paidFrom = from ? Prisma.sql`AND p."paymentDate" >= ${from}` : Prisma.empty;
      const txFrom   = from ? Prisma.sql`AND t."createdAt"   >= ${from}` : Prisma.empty;
      const expFrom  = from ? Prisma.sql`AND e."expenseDate" >= ${from}` : Prisma.empty;

      const [collectedRow] = await this.prisma.$queryRaw<Array<{ v: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(p.amount - p."refundedAmount"), 0) AS v
        FROM "Payment" p JOIN "Subscriber" s ON s.id = p."subscriberId"
        WHERE s."userId" = ${meId} ${paidFrom}`);
      const [movesRow] = await this.prisma.$queryRaw<Array<{ paidup: number; earneddown: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) AS paidup,
               COALESCE(SUM(CASE WHEN t.amount > 0 THEN  t.amount ELSE 0 END), 0) AS earneddown
        FROM "UserBalanceTransaction" t
        WHERE t."userId" = ${meId} AND t.reference LIKE 'SUB#%' ${txFrom}`);
      const [expRow] = await this.prisma.$queryRaw<Array<{ v: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(e.amount), 0) AS v FROM "Expense" e
        WHERE e."createdBy" = ${meId} AND e.status = 'APPROVED' ${expFrom}`);

      const collected = Number(collectedRow?.v || 0);
      const paidUp = Number(movesRow?.paidup || 0);
      const earnedDown = Number(movesRow?.earneddown || 0);
      const expenses = Number(expRow?.v || 0);
      const revenue = collected + earnedDown;
      return {
        revenue: r2(revenue), collectedFromCustomers: r2(collected), marginFromDownline: r2(earnedDown),
        activationCost: r2(paidUp), expenses: r2(expenses),
        profit: r2(revenue - paidUp - expenses),
      };
    };
    const [today, week, month, all] = await Promise.all([pnl(dayStart), pnl(weekStart), pnl(monthStart), pnl(null)]);

    // ── Balance flow ──────────────────────────────────────────────
    const [me, flowRow] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: meId }, select: { balance: true, name: true } }),
      this.prisma.$queryRaw<Array<{ loadedin: number; loadedout: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(CASE WHEN type='TOPUP' THEN amount ELSE 0 END), 0)            AS loadedin,
               COALESCE(SUM(CASE WHEN type='DEDUCT' AND reference LIKE 'TOP#%' THEN -amount ELSE 0 END), 0) AS loadedout
        FROM "UserBalanceTransaction" WHERE "userId" = ${meId}`),
    ]);

    // ── Per-child breakdown ───────────────────────────────────────
    const children = await this.prisma.user.findMany({
      where: { parentId: meId },
      select: { id: true, name: true, role: true, balance: true },
    });

    // My margin credits, each tied to a subscriber; bucket by which child's
    // subtree that subscriber sits in, so "earned from this child" is exact.
    const credits = await this.prisma.userBalanceTransaction.findMany({
      where: { userId: meId, amount: { gt: 0 }, reference: { startsWith: 'SUB#' } },
      select: { amount: true, reference: true, createdAt: true },
    });
    const subIdOf = (ref: string | null) => {
      const m = ref && ref.match(/^SUB#(\d+)/); return m ? Number(m[1]) : null;
    };
    const subIds = [...new Set(credits.map((c) => subIdOf(c.reference)).filter((x): x is number => x != null))];
    const subOwners = subIds.length
      ? await this.prisma.subscriber.findMany({ where: { id: { in: subIds } }, select: { id: true, userId: true } })
      : [];
    const ownerBySub = new Map(subOwners.map((s) => [s.id, s.userId]));

    const perChild = await Promise.all(children.map(async (c) => {
      const set = new Set(await this.scope.descendantIds(c.id)); // c + its subtree
      let earnedAll = 0, earnedMonth = 0;
      for (const cr of credits) {
        const sid = subIdOf(cr.reference); if (sid == null) continue;
        const owner = ownerBySub.get(sid);
        if (owner != null && set.has(owner)) {
          earnedAll += cr.amount;
          if (cr.createdAt >= monthStart) earnedMonth += cr.amount;
        }
      }
      // Balance I loaded into this child (top-ups on the child, done by me).
      const [loaded] = await this.prisma.$queryRaw<Array<{ v: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(amount), 0) AS v FROM "UserBalanceTransaction"
        WHERE "userId" = ${c.id} AND type='TOPUP' AND ("createdBy" = ${meId} OR "createdBy" IS NULL)`);
      const [subCount] = await this.prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        SELECT COUNT(*) AS n FROM "Subscriber" WHERE "userId" IN (${Prisma.join([...set])})`);
      return {
        id: c.id, name: c.name, role: c.role, balance: r2(c.balance),
        earnedFromThisChild: r2(earnedAll),
        earnedThisMonth: r2(earnedMonth),
        balanceYouLoaded: r2(Number(loaded?.v || 0)),
        subscribersInTree: Number(subCount?.n || 0),
      };
    }));

    return {
      account: me?.name,
      periods: { today, week, month, all },
      balance: {
        wallet: r2(me?.balance ?? 0),
        loadedFromParent: r2(Number(flowRow?.[0]?.loadedin || 0)),
        loadedToChildren: r2(Number(flowRow?.[0]?.loadedout || 0)),
      },
      children: perChild.sort((a, b) => b.earnedFromThisChild - a.earnedFromThisChild),
    };
  }

  /** Per-subscriber step-by-step breakdown: what each layer earned/paid on this sale. */
  async profitBySubscriber(actor: Actor, subscriberId: number) {
    await this.scope.assertSubscriber(actor, subscriberId);
    const rows: any[] = await this.prisma.$queryRaw`
      SELECT t."userId" AS "userId", u.name, u.role, t.amount, t.notes, t."createdAt"
      FROM "UserBalanceTransaction" t
      JOIN "User" u ON u.id = t."userId"
      WHERE t.reference = ${'SUB#' + subscriberId}
      ORDER BY t.amount DESC`;

    // PRIVACY: strip movements belonging to accounts ABOVE the caller. Owning a
    // subscriber lets you see your own cost and your downline's margins — not
    // what your parent paid, and not the ISP's cost.
    let visible: Set<number> | null = null;
    if (!this.scope.isAdmin(actor?.role)) {
      const rootId = await this.scope.rootId(actor);
      visible = new Set(await this.scope.descendantIds(rootId));
    }

    return rows
      .filter((r) => !visible || visible.has(Number(r.userId)))
      .map((r) => ({
        userId: Number(r.userId), name: r.name, role: r.role,
        amount: Number(r.amount), notes: r.notes, createdAt: r.createdAt,
      }));
  }

  /**
   * Apply the cascade atomically: update wallets + write a UserBalanceTransaction
   * for each tier. `enforce` blocks the activator if their wallet can't cover it.
   */
  /**
   * Reverse an activation/renewal settlement — a proper credit-note, not an edit.
   *
   * For every ledger row of the original settlement it posts an OFFSETTING
   * ADJUSTMENT to the SAME account, so the exact tier that was charged is
   * credited back and the commission that cascaded up is clawed back too. The
   * originals are never touched.
   *
   * Hardened for money-integrity:
   *   • a REASON is required (audit + dispute classification);
   *   • IDEMPOTENT — a settlement can be reversed once; a second attempt is
   *     refused, so a double-clicked "Reverse" can't credit twice;
   *   • balances may go negative (if the money was already spent) — that is the
   *     correct state: the account now owes it back;
   *   • optionally reverts the subscriber's service to INACTIVE so the ledger
   *     and the service state agree (RADIUS cut-off is handled by the caller).
   */
  async reverseActivation(
    subscriberId: number,
    opts: { reference?: string; reason?: string; actorId?: number; reasonCode?: string; revertService?: boolean } = {},
  ) {
    const reason = (opts.reason || '').trim();
    if (!reason) throw new ForbiddenException('A reason is required to reverse a settlement.');

    const reference = opts.reference || `SUB#${subscriberId}`;
    const reversalReference = `REV#${reference}`;

    // IDEMPOTENCY: if this settlement was already reversed, refuse.
    const already = await this.prisma.userBalanceTransaction.findFirst({
      where: { reference: reversalReference },
      select: { id: true, createdAt: true },
    });
    if (already) {
      throw new ForbiddenException(
        `This settlement was already reversed on ${already.createdAt.toISOString()}. It cannot be reversed twice.`,
      );
    }

    const rows = await this.prisma.userBalanceTransaction.findMany({
      where: { reference: { in: [reference, `${reference}:RENEWAL`] } },
      orderBy: { id: 'asc' },
    });
    if (!rows.length) {
      throw new NotFoundException(`No activation settlement found for subscriber #${subscriberId}.`);
    }

    const note = opts.reasonCode ? `[${opts.reasonCode}] ${reason}` : reason;

    await this.prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const signed = Number(row.amount || 0);
        if (!signed) continue;
        const updated = await tx.user.update({
          where: { id: row.userId },
          data: { balance: { increment: -signed } }, // force — may go negative, correctly
          select: { balance: true },
        });
        await tx.userBalanceTransaction.create({
          data: {
            userId: row.userId, type: 'ADJUSTMENT', amount: -signed,
            balanceAfter: updated.balance, reference: reversalReference,
            notes: `Reversal of ${reference} — ${note}`, createdBy: opts.actorId ?? null,
          } as any,
        });
      }
      // Keep service state consistent with the ledger when asked.
      if (opts.revertService) {
        await tx.subscriber.update({ where: { id: subscriberId }, data: { status: 'INACTIVE' } }).catch(() => null);
      }
    });

    await this.prisma.activityLog.create({
      data: {
        userId: opts.actorId ?? null, action: 'REVERSE_ACTIVATION',
        entity: 'Subscriber', entityId: subscriberId,
        details: `Reversed ${reference} — ${note}${opts.revertService ? ' (service set INACTIVE)' : ''}`,
      },
    }).catch(() => null);

    return { reversed: true, subscriberId, reference, reversalReference, reversedRows: rows.length, revertedService: !!opts.revertService };
  }

  /**
   * All reversals across the actor's tree, grouped into one row per credit-note
   * (a reversal touches every tier, so we roll the per-tier rows up by their
   * shared REV# reference). Scoped: a franchise sees its whole dealer tree's
   * reversals, a dealer only its own.
   */
  async listReversals(actor: Actor, limit = 300) {
    const where: any = { reference: { startsWith: 'REV#' } };
    if (!this.scope.isAdmin(actor?.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.userId = { in: ids.length ? ids : [-1] };
    }
    const rows = await this.prisma.userBalanceTransaction.findMany({
      where, orderBy: { id: 'desc' }, take: Math.min(limit, 1000),
      include: { user: { select: { id: true, name: true, role: true } } },
    });

    const byRef = new Map<string, any>();
    for (const r of rows) {
      const ref = r.reference as string;
      const subMatch = /SUB#(\d+)/.exec(ref);
      const subscriberId = subMatch ? Number(subMatch[1]) : null;
      // notes look like: "Reversal of SUB#12 — [DUPLICATE] dealer double-clicked"
      let reasonCode: string | null = null; let reason = r.notes || '';
      const codeM = /—\s*\[([A-Z_]+)\]\s*(.*)$/.exec(r.notes || '');
      if (codeM) { reasonCode = codeM[1]; reason = codeM[2]; }
      const g = byRef.get(ref) || {
        reference: ref, subscriberId, when: r.createdAt, reasonCode, reason,
        by: r.createdBy, restored: 0, clawedBack: 0, tiers: [] as any[],
      };
      const amt = Number(r.amount || 0);
      if (amt > 0) g.restored += amt; else g.clawedBack += -amt;
      g.tiers.push({ userId: r.user?.id, name: r.user?.name, role: r.user?.role, amount: Math.round(amt * 100) / 100 });
      byRef.set(ref, g);
    }

    // Attach subscriber names in one query.
    const subIds = [...new Set([...byRef.values()].map((g) => g.subscriberId).filter(Boolean))] as number[];
    const subs = subIds.length
      ? await this.prisma.subscriber.findMany({ where: { id: { in: subIds } }, select: { id: true, fullName: true, username: true } })
      : [];
    const subMap = new Map(subs.map((s) => [s.id, s]));

    return [...byRef.values()].map((g) => ({
      ...g,
      restored: Math.round(g.restored * 100) / 100,
      clawedBack: Math.round(g.clawedBack * 100) / 100,
      subscriber: g.subscriberId ? subMap.get(g.subscriberId) ?? null : null,
    }));
  }

  async settleActivation(
    subscriberId: number,
    opts: { enforce?: boolean; byUserId?: number; event?: string } = {},
    tx?: Prisma.TransactionClient,
  ) {
    // Use the caller's transaction (if any) so the package/owner set moments ago
    // in the same uncommitted activation transaction are visible here.
    const q = await this.quote(subscriberId, tx ?? (this.prisma as any));
    if (!q) return { settled: false, reason: 'No reseller owner or package on this subscriber.' };

    /**
     * IDEMPOTENCY.
     *
     * Every settlement for a subscriber wrote the same reference, `SUB#id`, and
     * nothing checked whether it had already been written. Three separate paths
     * call this — create(), the package-change path, and a public endpoint — so
     * the same activation could be charged two or three times over. A retry, a
     * double-clicked Save, or one manual call to the endpoint took the money
     * again, and the only trace was two identical ledger lines nobody compares.
     *
     * `event` distinguishes legitimate repeat charges (a monthly renewal IS a
     * second, real charge) from an accidental replay of the same one. Callers
     * must pass a DETERMINISTIC event (e.g. package + resulting expiry day), so
     * a replayed request produces the same reference and is refused.
     */
    const reference = opts.event ? `SUB#${subscriberId}:${opts.event}` : `SUB#${subscriberId}`;

    /**
     * CONCURRENCY.
     *
     * The old code checked for a duplicate ONCE, before the transaction opened.
     * Two simultaneous activations of the same subscriber both read "nothing
     * here", both opened their transaction, both debited — the double-click that
     * the reference check was meant to stop, stopped by nothing. The check is
     * therefore re-run INSIDE the transaction, after taking a `FOR UPDATE` row
     * lock on the subscriber. The second concurrent request blocks on that lock
     * until the first commits, then re-checks and sees the winner's settlement
     * row → alreadySettled, with not a single balance moved.
     *
     * The pre-transaction check stays only as a cheap fast-path for sequential
     * replays (no lock, no writes); it is NOT the guard.
     */
    const already = await this.prisma.userBalanceTransaction.findFirst({
      where: { reference },
      select: { id: true, createdAt: true },
    });
    if (already) {
      this.logger.warn(
        `Settlement for subscriber ${subscriberId} (${reference}) was already applied ` +
        `on ${already.createdAt.toISOString()} — refusing to charge twice.`,
      );
      return { settled: false, alreadySettled: true, reference, settledAt: already.createdAt, ...q };
    }

    const settle = async (db: Prisma.TransactionClient) => {
      if ((db as any).$queryRaw) {
        await (db as any).$queryRaw`SELECT id FROM "Subscriber" WHERE id = ${subscriberId} FOR UPDATE`;
      }
      const dup = await db.userBalanceTransaction.findFirst({
        where: { reference },
        select: { id: true, createdAt: true },
      });
      if (dup) {
        this.logger.warn(
          `Concurrent settlement for subscriber ${subscriberId} (${reference}) lost the race — refusing to charge twice.`,
        );
        return { settled: false, alreadySettled: true, reference, settledAt: dup.createdAt, ...q };
      }

      /**
       * Prepaid enforcement, ON BY DEFAULT.
       *
       * This used to require `enforce: true`, and the activation path never
       * passed it — so a dealer with an empty wallet could activate customers
       * indefinitely and simply go negative. That is not prepaid, it is
       * unsecured credit issued silently by the system.
       *
       * Opting OUT is now the explicit act (`enforce: false`), for the rare case
       * where an operator deliberately allows an overdraft.
       */
      const enforce = opts.enforce !== false;

      /**
       * The balance check runs INSIDE the transaction, as a conditional update.
       *
       * It used to be a separate read before the transaction opened: read
       * balance, compare, then deduct. Two activations racing each other both
       * read 1,000, both decided 1,000 ≥ 1,000, and both deducted — leaving the
       * account at −1,000 with prepaid enforcement supposedly on. Two clerks at
       * one dealer, or a double-clicked button, was enough.
       *
       * `updateMany` with the balance condition in the WHERE makes the check and
       * the deduction one atomic statement: the database refuses the second one.
       */
      if (enforce) {
        const activator = q.movements[0];
        if (activator && activator.delta < 0) {
          const need = -activator.delta;
          // Credit limit = permitted overdraft. The account may spend down to
          // −creditLimit, so the minimum balance it needs is (need − creditLimit).
          const actUser = await db.user.findUnique({
            where: { id: activator.userId }, select: { creditLimit: true },
          });
          const threshold = need - (actUser?.creditLimit ?? 0);
          const hit = await db.user.updateMany({
            where: { id: activator.userId, balance: { gte: threshold } },
            data: { balance: { decrement: need } },
          });
          if (hit.count === 0) {
            const u = await db.user.findUnique({
              where: { id: activator.userId },
              select: { balance: true, name: true, creditLimit: true },
            });
            const have = u?.balance ?? 0;
            const limit = u?.creditLimit ?? 0;
            throw new ForbiddenException(
              `Not enough balance. ${u?.name ?? 'This account'} has ${have.toFixed(0)}` +
              (limit > 0 ? ` (+${limit.toFixed(0)} credit limit)` : '') +
              ` but this activation costs ${need.toFixed(0)} — short by ${(threshold - have).toFixed(0)}. ` +
              `Ask your parent account to top up or raise the credit limit.`,
            );
          }
          const after = await db.user.findUnique({
            where: { id: activator.userId }, select: { balance: true },
          });
          await db.userBalanceTransaction.create({
            data: {
              userId: activator.userId, type: 'DEDUCT', amount: activator.delta,
              balanceAfter: after?.balance ?? 0, reference,
              notes: `Package activation: ${activator.note}`,
              createdBy: opts.byUserId ?? null,
            } as any,
          });
        }
      }

      for (const m of q.movements) {
        if (!m.delta) continue;
        // The activator was already debited atomically above; skip it here so
        // the deduction is not applied a second time.
        if (enforce && m === q.movements[0] && m.delta < 0) continue;
        const after = await db.user.update({
          where: { id: m.userId },
          data: { balance: { increment: m.delta } },
          select: { balance: true },
        });
        await db.userBalanceTransaction.create({
          data: {
            userId: m.userId,
            type: m.delta >= 0 ? 'COMMISSION' : 'DEDUCT',
            amount: m.delta,
            balanceAfter: after.balance,
            reference,
            notes: `Package activation: ${m.note}`,
            createdBy: opts.byUserId ?? null,
          } as any,
        });
      }
      return null; // no duplicate → proceed
    };

    if (tx) {
      const dup = await settle(tx);
      if (dup) return dup;
    } else {
      const dup = await this.prisma.$transaction((t) => settle(t));
      if (dup) return dup;
    }

    this.logger.log(`💰 Settled activation for subscriber ${subscriberId}: ${q.movements.length} tiers`);
    return { settled: true, ...q };
  }
}
