import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ScopeService — row-level multi-tenancy by the reseller tree.
 *
 * Every reseller (User) has a parentId. A user may only see itself and its
 * DESCENDANTS (its dealers, their sub-dealers, their retailers …) and the
 * subscribers those users own. ISP-level roles (SUPER_ADMIN / ADMIN) see all.
 *
 * The "actor" is the logged-in user from the JWT: { sub, role }.
 *
 * IMPORTANT — multi-tenant isolation:
 * Only SUPER_ADMIN (the platform owner) sees everything. Each ISP is an ADMIN
 * that is scoped to ITS OWN subtree, so ISP1 can never see ISP2's dealers, and
 * a dealer only ever sees the sub-dealers directly beneath it. Isolation comes
 * from the parentId tree — siblings have different parents, so their subtrees
 * never overlap.
 */
const ADMIN_ROLES = ['SUPER_ADMIN'];

export type Actor = { sub?: number; id?: number; role?: string } | undefined;

@Injectable()
export class ScopeService {
  constructor(private prisma: PrismaService) {}

  isAdmin(role?: string): boolean {
    return !!role && ADMIN_ROLES.includes(role);
  }

  /**
   * Every account ABOVE this one, self included: [self, parent, …, ISP].
   *
   * Network resources (NAS, packages) flow DOWNWARD, so to decide what a
   * reseller may use we need its ancestors — a dealer can use the router its
   * franchise registered, and the packages the ISP assigned upstream of it.
   */
  async ancestorIds(userId: number): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      WITH RECURSIVE up AS (
        SELECT id, "parentId" FROM "User" WHERE id = ${userId}
        UNION ALL
        SELECT u.id, u."parentId" FROM "User" u INNER JOIN up ON u.id = up."parentId"
      )
      SELECT id FROM up;`;
    return rows.map((r) => Number(r.id));
  }

  /**
   * Which NAS records this actor may SEE/USE.
   *
   *   • ones they own
   *   • ones owned by any ancestor (the ISP's / franchise's routers flow down)
   *   • ones explicitly assigned to them (NasAssignment)
   *
   * Editing is a separate question — only the owner may change a NAS.
   */
  /**
   * Which routers an account may see.
   *
   * CHANGED: this used to include `ownerId: { in: ancestors }`, so every
   * reseller automatically saw the ISP's routers — and `ownerId: null`, which
   * leaked every legacy record too. A franchise running its own network was
   * shown the ISP's test equipment in its dropdowns, and had no way to tell
   * which routers were actually theirs to use.
   *
   * Infrastructure is now OPT-IN: you see what you own, plus what has been
   * explicitly handed to you. If the ISP wants a franchise on its router, it
   * assigns it — a deliberate act, which is also what makes it auditable.
   */
  async nasWhere(actor: Actor): Promise<any> {
    // Same reasoning as subscriberWhere(): the sandbox's 500 invented routers
    // are not part of anyone's real estate, so they do not belong in the ISP's
    // NAS count or its device lists. An actorless internal call keeps seeing
    // everything, because background jobs must still reach demo rows to expire
    // and purge them.
    if (!actor) return {};
    if (this.isAdmin(actor.role)) return this.demoExclusion('owner');
    const selfId = await this.rootId(actor);

    /**
     * A share is INHERITED BY THE WHOLE SUBTREE beneath the account it was
     * granted to.
     *
     * This previously matched `assignments.some({ userId: selfId })` — the
     * assigned account and nobody else. So the ISP could share a router with a
     * franchise, and that franchise's own dealers still could not put a single
     * subscriber on it. Every dealer needed a separate assignment, and adding a
     * new dealer silently produced an account that could sell nothing.
     *
     * That is also the wrong shape commercially: the franchise is responsible
     * for its dealers' customers, so a router the franchise may use is one its
     * dealers may use. Matching against my ANCESTOR chain gives exactly that —
     * shared to me, or to anyone above me.
     *
     * Ownership deliberately does NOT flow down the same way. If every account
     * could see routers owned by any ancestor, the ISP's entire estate would
     * appear in every reseller's list the moment they were created, which is
     * the multi-tenancy leak this scoping exists to prevent. Sharing stays an
     * explicit act; only its REACH is inherited.
     *
     * A sibling franchise shares no ancestor below the ISP, so it still sees
     * nothing of ours.
     */
    const chain = await this.ancestorIds(selfId);           // [me, parent, …, root]
    const strictAncestors = chain.filter((id) => id !== selfId); // [parent, …, root]

    /**
     * Propagation is now explicit per share (NasAssignment.propagate):
     *
     *   • a share made DIRECTLY to me — I see it no matter what, because it was
     *     handed to me on purpose;
     *   • a share made to an ANCESTOR — I only inherit it when that share was
     *     marked propagate=true. A franchise can therefore hold a router
     *     (propagate=false, so its dealers do NOT auto-inherit) and then re-share
     *     it to Booni alone. Mastuj, a sibling under the same franchise, shares
     *     no ancestor below the franchise and was never handed the router, so it
     *     never sees it.
     *
     * Default propagate=true means every pre-existing share keeps cascading
     * exactly as it did before this change.
     */
    return {
      OR: [
        { ownerId: selfId },                                                          // mine
        { assignments: { some: { userId: selfId } } },                               // handed to me directly
        { assignments: { some: { userId: { in: strictAncestors }, propagate: true } } }, // inherited from above
      ],
    };
  }

  /**
   * Which IP POOLS this actor may see and assign addresses from.
   *
   *   • pools they own, or that anyone in their downline owns
   *   • pools shared with them, or with any account above them
   *
   * Pools used to be covered by ownedWhere() alone, on the reasoning that they
   * are cheap to create so a franchise can just make its own. That is only true
   * when the franchise runs its OWN router. Put a franchise on the ISP's NAS —
   * the normal case — and they must draw from the ISP's address space, because
   * the addresses have to be routable on that router. They had no way to be
   * given it, so their pool list was empty and a static IP could not be
   * assigned by hand at all.
   *
   * Inheritance matches routers exactly: shared to me or to anyone above me, so
   * one share to a franchise reaches its dealers too. A sibling franchise still
   * sees nothing.
   */
  async poolWhere(actor: Actor): Promise<any> {
    if (!actor) return {};
    if (this.isAdmin(actor.role)) return this.demoExclusion('owner');
    const selfId = await this.rootId(actor);
    const [mine, chain] = await Promise.all([
      this.descendantIds(selfId),
      this.ancestorIds(selfId),
    ]);
    const strictAncestors = chain.filter((id) => id !== selfId);
    // Same propagation rule as routers: a pool handed straight to me is always
    // mine to use; a pool shared to an ancestor only reaches me when that share
    // is set to cascade. See nasWhere() for the full reasoning.
    return {
      OR: [
        { ownerId: { in: mine } },
        { assignments: { some: { userId: selfId } } },
        { assignments: { some: { userId: { in: strictAncestors }, propagate: true } } },
      ],
    };
  }

  /**
   * Which owned resources (areas, and anything else keyed purely by owner) an
   * account may see. Pools now use poolWhere() instead — they are shareable.
   */
  async ownedWhere(actor: Actor): Promise<any> {
    if (!actor) return {};
    if (this.isAdmin(actor.role)) return this.demoExclusion('owner');
    const selfId = await this.rootId(actor);
    // Descendants included so a franchise still sees what its own dealers
    // created — it is responsible for their network, and hiding it would
    // break the tree it is meant to manage.
    const ids = await this.descendantIds(selfId);
    return { ownerId: { in: ids } };
  }

  /**
   * Which packages this actor may SEE/SELL.
   *
   *   • ones they created
   *   • ones ASSIGNED to them — an assignment is a ResellerPackagePrice row,
   *     which carries the price they buy at. That is what creates the margin.
   */
  async packageWhere(actor: Actor): Promise<any> {
    if (!actor) return {};
    if (this.isAdmin(actor.role)) return this.demoExclusion('owner');
    const selfId = await this.rootId(actor);
    return {
      OR: [
        { ownerId: selfId },                                   // my own packages
        { resellerPrices: { some: { userId: selfId } } },      // assigned to me
      ],
    };
  }

  actorId(actor: Actor): number {
    return Number((actor as any)?.id ?? (actor as any)?.sub);
  }

  /**
   * The user id whose subtree defines this actor's visibility. Normally the actor
   * itself — but a STAFF (SALES) member works within its OWNER's scope, so it
   * resolves to the staff's parent. This lets any account hire staff who see and
   * manage that account's business.
   */
  async rootId(actor: Actor): Promise<number> {
    const id = this.actorId(actor);
    if (actor?.role === 'SALES') {
      const u = await this.prisma.user.findUnique({ where: { id }, select: { parentId: true } });
      return u?.parentId ?? id;
    }
    return id;
  }

  /** All descendant user IDs (including the root itself), via recursive CTE. */
  async descendantIds(rootUserId: number): Promise<number[]> {
    if (!rootUserId || Number.isNaN(rootUserId)) return [];
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      WITH RECURSIVE sub AS (
        SELECT id FROM "User" WHERE id = ${rootUserId}
        UNION ALL
        SELECT u.id FROM "User" u INNER JOIN sub ON u."parentId" = sub.id
      )
      SELECT id FROM sub;`;
    return rows.map((r) => Number(r.id));
  }

  /**
   * SANDBOX DATA IS NOT BUSINESS DATA.
   *
   * The demo sandbox seeds 10,000 synthetic subscribers and 500 fake routers
   * under a demo-flagged user. Reseller scoping already hides those from other
   * tenants — they sit in someone else's subtree. But SUPER_ADMIN is scoped by
   * nothing, so the platform owner's own dashboard counted them as customers:
   * "Total subscribers 10,016", "Signups today 10,000", and every renewal
   * forecast computed over a base that was 99.8% invented.
   *
   * An operator cannot run a business off numbers like that, and cannot tell by
   * looking which part is real. So demo-owned rows are excluded from ISP-level
   * views. The demo account itself is unaffected: it is an ordinary RESELLER and
   * reaches its data through the subtree branch below, seeing exactly the rich
   * environment the sandbox exists to show.
   *
   * THE NULL CASE, STATED EXPLICITLY.
   * `userId` and `ownerId` are both NULLABLE. An ownerless subscriber has no
   * user row to carry `isDemo: false`, so the obvious filter would silently
   * hide exactly the records findOwnerless() exists to surface — customers
   * receiving service that nobody is billed for. The naive fix, a NOT over the
   * relation, leans on how a particular ORM treats a NOT against an absent
   * relation; that is a subtlety, and a subtlety in a filter that decides what
   * an operator can see is a bug waiting to be discovered by its absence. So
   * the two cases are written out as plain boolean logic instead: keep rows
   * with no owner, and rows whose owner is not a demo. Nothing to get wrong.
   *
   * DEMO_VISIBLE_TO_ADMIN=1 restores the old behaviour, so an operator who
   * needs to inspect the sandbox is not left needing a code change.
   */
  get hidesDemo(): boolean {
    return process.env.DEMO_VISIBLE_TO_ADMIN !== '1';
  }

  private demoExclusion(relation: 'user' | 'owner'): any {
    if (!this.hidesDemo) return {};
    const fk = relation === 'user' ? 'userId' : 'ownerId';
    return {
      OR: [
        { [fk]: null },
        { [relation]: { is: { isDemo: false } } },
      ],
    };
  }

  /** The demo users themselves — hidden from ISP-level account lists. */
  private demoUserExclusion(): any {
    // `isDemo` is non-nullable with a default, so unlike the owner relations
    // above there is no null case to preserve here.
    return this.hidesDemo ? { isDemo: false } : {};
  }

  /**
   * The same rule as a raw-SQL fragment, for services that hand-write queries.
   *
   * analytics builds its scope as interpolated SQL rather than a Prisma filter,
   * so it cannot use the objects above. Defining the fragment HERE anyway is the
   * point: the reason demo rows kept reappearing on ISP screens is that four
   * different services each wrote their own "an admin sees everything" rule, and
   * fixing one never fixed the rest. One definition, four callers.
   *
   * No user input is interpolated — the alias is supplied by the calling code.
   */
  demoExclusionSql(subscriberAlias = 's'): string {
    if (!this.hidesDemo) return '';
    return ` AND (${subscriberAlias}."userId" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "User" _du WHERE _du.id = ${subscriberAlias}."userId" AND _du."isDemo" = true))`;
  }

  /** As above, for a query whose rows are Users rather than Subscribers. */
  demoUserExclusionSql(userAlias = 'u'): string {
    return this.hidesDemo ? ` AND ${userAlias}."isDemo" = false` : '';
  }

  /**
   * The demo account ids, for code that filters an already-fetched array.
   *
   * packages.service loads every package and then narrows the list in memory,
   * because a reseller's visibility depends on ResellerPackagePrice rows rather
   * than a column. That cannot use a Prisma where-fragment, so it needs the ids
   * instead — and without them an ISP saw the sandbox's twelve invented plans
   * sitting among its own, complete with 7,016 customers and Rs 59m of revenue
   * attributed to them.
   *
   * Empty when the override is on, so callers can filter unconditionally.
   */
  async demoUserIds(): Promise<Set<number>> {
    if (!this.hidesDemo) return new Set();
    const rows = await this.prisma.user.findMany({ where: { isDemo: true }, select: { id: true } });
    return new Set(rows.map((r) => Number(r.id)));
  }

  /**
   * Drop demo-owned entries from a list already loaded into memory.
   *
   * A row with no owner is KEPT, for the same reason as demoExclusion(): an
   * unowned record is a real one that nobody has claimed, and hiding it from
   * the ISP is how unowned things stay unnoticed.
   */
  async withoutDemoOwned<T extends { ownerId?: number | null }>(rows: T[]): Promise<T[]> {
    if (!this.hidesDemo || rows.length === 0) return rows;
    const demo = await this.demoUserIds();
    if (demo.size === 0) return rows;
    return rows.filter((r) => r.ownerId == null || !demo.has(Number(r.ownerId)));
  }

  /** Prisma where-fragment limiting SUBSCRIBERS to the actor's subtree. */
  async subscriberWhere(actor: Actor): Promise<any> {
    if (this.isAdmin(actor?.role)) return this.demoExclusion('user');
    const ids = await this.descendantIds(await this.rootId(actor));
    // subscribers owned by anyone in my subtree, or sold by anyone in my subtree
    /**
     * OWNERSHIP decides visibility — not who sold the customer.
     *
     * This used to also match `salespersonId IN subtree`, which leaked a
     * PARENT-owned customer into a CHILD's list: set the salesperson to a
     * dealer and that dealer could see (and edit / move / delete) a customer
     * belonging to the ISP. Ownership is the tenancy boundary, so it is the
     * only thing that may grant access.
     *
     * SALES staff are unaffected: rootId() already resolves a SALES user to
     * their parent, so they still see everything their own account owns — the
     * salesperson clause was redundant for them and harmful for everyone else.
     */
    return { userId: { in: ids } };
  }

  /** Prisma where-fragment limiting USERS (resellers) to the actor's descendants. */
  async userWhere(actor: Actor): Promise<any> {
    // The demo tree is 143 synthetic franchises, dealers and sub-dealers. They
    // filled the ISP's Users & Staff list, its wallet list and its user counts,
    // burying four real accounts among them.
    if (this.isAdmin(actor?.role)) return this.demoUserExclusion();
    const ids = await this.descendantIds(await this.rootId(actor));
    return { id: { in: ids } };
  }

  /**
   * True if the actor may see/act on this NAS (owned, shared directly, or
   * inherited from an ancestor — exactly the rules nasWhere() encodes).
   */
  async canAccessNas(actor: Actor, nasId: number): Promise<boolean> {
    if (this.isAdmin(actor?.role)) return true;
    const where = await this.nasWhere(actor);
    const hit = await this.prisma.nas.findFirst({
      where: Object.keys(where).length ? { AND: [{ id: nasId }, where] } : { id: nasId },
      select: { id: true },
    });
    return !!hit;
  }

  /**
   * Throwing guard for every per-device monitoring endpoint (health, graphs,
   * interfaces, SNMP test, syslog…). Without it a reseller could read another
   * tenant's router telemetry — or make our server probe it — just by changing
   * the id in the URL. "Not found" rather than "forbidden", so ids can't be
   * enumerated.
   */
  async assertNas(actor: Actor, nasId: number): Promise<void> {
    if (await this.canAccessNas(actor, nasId)) return;
    throw new NotFoundException(`NAS ${nasId} not found`);
  }

  /** True if the actor may see/act on this subscriber. */
  async canAccessSubscriber(actor: Actor, subscriberId: number): Promise<boolean> {
    if (this.isAdmin(actor?.role)) return true;
    const ids = await this.descendantIds(await this.rootId(actor));
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { userId: true },
    });
    if (!sub) return false;
    // Ownership only — see subscriberWhere(). Matching on salespersonId let a
    // child account act on a customer owned by its parent.
    return sub.userId != null && ids.includes(sub.userId);
  }

  /** Throwing guard used by mutations. */
  async assertSubscriber(actor: Actor, subscriberId: number): Promise<void> {
    if (!(await this.canAccessSubscriber(actor, subscriberId))) {
      throw new ForbiddenException('This subscriber is outside your account.');
    }
  }

  /** True if the actor may see/manage this user (must be self or a descendant). */
  async canAccessUser(actor: Actor, targetUserId: number): Promise<boolean> {
    if (this.isAdmin(actor?.role)) return true;
    const ids = await this.descendantIds(await this.rootId(actor));
    return ids.includes(Number(targetUserId));
  }

  async assertUser(actor: Actor, targetUserId: number): Promise<void> {
    if (!(await this.canAccessUser(actor, targetUserId))) {
      throw new ForbiddenException('This account is outside your hierarchy.');
    }
  }
}
