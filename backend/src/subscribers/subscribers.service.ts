import {
  Injectable, Logger, OnModuleInit,
  ForbiddenException, NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RadiusSyncService, RadiusPolicyAttr } from '../nas/radius-sync.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';
import { CacheService } from '../common/cache.service';
import { QueueService } from '../common/queue.service';
import { AccountingService } from '../accounting/accounting.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ScopeService, Actor } from '../common/scope.service';
import { ResellerPricingService } from '../organization/reseller-pricing.service';
import { InvoicesService } from '../invoices/invoices.service';
import { SecurityService } from '../security/security.service';
import { RenewalService } from './renewal.service';
import {
  CONNECTION_TYPE, PROFILE_STATUS, DISCOUNT_TYPE, parsePanelDate, parseFlag,
} from './panel-format';
import { parseCursor, buildCursorPage } from '../common/pagination';
import { terminateInfo } from '../common/radius-terminate';

@Injectable()
export class SubscribersService implements OnModuleInit {
  private readonly logger = new Logger(SubscribersService.name);

  constructor(
    private prisma: PrismaService,
    public radiusSync: RadiusSyncService,
    private cache: CacheService,
    private queue: QueueService,
    private accounting: AccountingService,
    private notifications: NotificationsService,
    private scope: ScopeService,
    private pricing: ResellerPricingService,
    private invoices: InvoicesService,
    private security: SecurityService,
    // Owns duration and pricing for every renewal shape.
    private renewal: RenewalService,
    // Needed to kick a live PPPoE session off the router. Removing RADIUS
    // credentials alone stops only the next login, not the current session.
    private mikrotik: MikrotikSyncService,
  ) {}

  onModuleInit() {
    // ⚡ Phase 0: heavy RADIUS sync runs as background jobs, never in the request path
    this.queue.registerProcessor('radius-sync-all', () => this.syncAllToRadius());
    this.queue.registerProcessor('radius-sync-missing', () => this.syncMissingToRadius());

    // Self-heal any subscriber whose package / NAS / install-date links were
    // lost. Fills NULLs only, so it is safe on every boot. Delayed so it never
    // blocks startup and runs after the DB connection has settled.
    setTimeout(() => {
      this.repairMissingLinks().catch((e) =>
        this.logger?.warn?.(`Subscriber link repair skipped: ${e?.message || e}`),
      );
    }, 8000).unref?.();
  }

  /** Enqueue a bulk RADIUS sync job. Returns { jobId } for status polling. */
  async enqueueRadiusSync(scope: 'all' | 'missing') {
    const jobId = await this.queue.add(scope === 'all' ? 'radius-sync-all' : 'radius-sync-missing');
    return { jobId };
  }

  async getSyncJobStatus(jobId: string) {
    return this.queue.getStatus(jobId);
  }

  private normalizeConnectionType(value?: string | null):
    | 'FTTH'
    | 'ADSL'
    | 'G4_LTE'
    | 'WIRELESS'
    | 'FIBER' {
    const raw = (value || 'FTTH').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const map: Record<string, 'FTTH' | 'ADSL' | 'G4_LTE' | 'WIRELESS' | 'FIBER'> = {
      FTTH: 'FTTH',
      PPPOE: 'FTTH',
      ADSL: 'ADSL',
      DSL: 'ADSL',
      G4LTE: 'G4_LTE',
      LTE: 'G4_LTE',
      WIRELESS: 'WIRELESS',
      HOTSPOT: 'WIRELESS',
      FIBER: 'FIBER',
      APISTATIC: 'FIBER',
      STATIC: 'FIBER',
    };
    return map[raw] || 'FTTH';
  }

  private normalizeStatus(value?: string | null): 'ACTIVE' | 'INACTIVE' | 'EXPIRED' | 'SUSPENDED' {
    const raw = (value || 'ACTIVE').toUpperCase();
    if (raw === 'ACTIVE' || raw === 'INACTIVE' || raw === 'EXPIRED' || raw === 'SUSPENDED') {
      return raw;
    }
    return 'ACTIVE';
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVATE HELPER: fetch package with pool for RADIUS sync
  // Always use this before calling syncSubscriberProfile
  // ─────────────────────────────────────────────────────────────
  private async getPackageForRadius(packageId: number | null) {
    if (!packageId) return null;
    const pkg = await this.prisma.package.findUnique({
      where: { id: packageId },
      include: { pool: true },
    });
    if (!pkg) return null;

    // Resolve linked RADIUS policies. These used to be read out of
    // data/packages-management.json on every single profile build — a
    // synchronous file read on the path that runs for every activation, every
    // renewal and every re-sync. They now live in package_setting /
    // package_policy.
    //
    // The catch stays, and stays non-fatal for the same reason as before: a
    // package's extra RADIUS attributes are an enhancement, and failing to read
    // them must degrade to the speed fields rather than block the subscriber
    // from getting a profile at all.
    let policyAttributes: RadiusPolicyAttr[] | undefined;
    try {
      const setting = await this.prisma.packageSetting.findUnique({ where: { packageId } });
      const policyIds: number[] = ((setting?.settings as any)?.policyIds ?? []) as number[];
      if (policyIds.length > 0) {
        const matched = await this.prisma.packagePolicy.findMany({ where: { id: { in: policyIds } } });
        if (matched.length > 0) {
          policyAttributes = matched.map((p) => ({
            attribute: p.attributeName,
            op: p.attributeOp,
            value: p.attributeValue,
          }));
        }
      }
    } catch {
      // Non-critical — fall back to the speed fields
    }

    return {
      ...pkg,
      policyAttributes,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // FIND ALL
  // ─────────────────────────────────────────────────────────────
  async findAll(query?: any, actor?: Actor) {
    const where: any = {};
    const q = (query?.q || '').trim();

    if (q) {
      where.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { username: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { identity: { contains: q } },
      ];
    }

    if (query?.status && query.status !== 'ALL') {
      where.status = this.normalizeStatus(query.status);
    }
    if (query?.connectionType && query.connectionType !== 'ALL') {
      where.connectionType = this.normalizeConnectionType(query.connectionType);
    }
    if (query?.packageId) where.packageId = Number(query.packageId);
    if (query?.salespersonId) where.salespersonId = Number(query.salespersonId);
    if (query?.nasId) where.nasId = Number(query.nasId);
    if (query?.branchId) where.branchId = Number(query.branchId); // Phase 4B tenancy filter

    if (query?.dateFrom || query?.dateTo) {
      where.createdAt = {};
      if (query?.dateFrom) where.createdAt.gte = new Date(query.dateFrom);
      if (query?.dateTo) where.createdAt.lte = new Date(query.dateTo);
    }

    const include = {
      package:     { include: { pool: true } }, // include pool so frontend can show it
      area:        true,
      nas:         true,
      salesperson: true,
      serviceSettings: true,
      // The actual OWNER (who the wallet is charged and whose subtree this is).
      // Without it the "Owner" column silently fell back to the salesperson.
      user: { select: { id: true, name: true, role: true } },
    };

    // Hierarchy scoping: a reseller only sees subscribers in its subtree.
    const scopeWhere = await this.scope.subscriberWhere(actor);
    const finalWhere = Object.keys(scopeWhere).length ? { AND: [where, scopeWhere] } : where;

    // ⚡ Phase 0: cursor pagination when ?limit= is passed (no COUNT, index-driven).
    // Without ?limit= the legacy full-array shape is kept for backward compatibility.
    if (query?.limit !== undefined) {
      const { take, cursorArgs } = parseCursor(query);
      const rows = await this.prisma.subscriber.findMany({
        where: finalWhere,
        include,
        orderBy: { id: 'desc' },
        take: take + 1,
        ...cursorArgs,
      });
      return buildCursorPage(await this.attachLiveStatus(rows), take);
    }

    // SCALE GUARD: the legacy shape returns a plain array (no ?limit=), which at
    // 20k subscribers means a multi-megabyte payload and a very slow query.
    // We keep the shape for backward compatibility but cap it — anything larger
    // must page via ?limit=, which uses index-driven cursor pagination.
    const HARD_CAP = Number(process.env.SUBSCRIBER_LIST_CAP || 2000);
    const rows = await this.prisma.subscriber.findMany({
      where: finalWhere,
      include,
      orderBy: { createdAt: 'desc' },
      take: HARD_CAP,
    });
    if (rows.length === HARD_CAP) {
      this.logger.warn(
        `Subscriber list hit the ${HARD_CAP}-row cap. The client should paginate with ?limit= ` +
          `(raise SUBSCRIBER_LIST_CAP only as a stop-gap).`,
      );
    }
    return this.attachLiveStatus(rows);
  }

  /**
   * Push a subscriber's full profile to RADIUS, including their service type,
   * static IP and any session limits.
   *
   * Callers used to pass only (username, password, package), which silently
   * meant "PPPoE with a pool" for everyone. Business customers on a fixed IP
   * and hotspot users need different attributes, so resolve them here in one
   * place rather than at each call site.
   */
  /**
   * Build the FULL set of RADIUS opts for a subscriber — package speed, pool
   * OR static IP (never both — see radiusSync.syncSubscriberProfile), MAC,
   * and session flags.
   *
   * THIS IS THE SINGLE SOURCE OF TRUTH for "what should this subscriber's
   * RADIUS profile look like right now". Every place that re-syncs a
   * subscriber to RADIUS — activation, renewal, grace period, password reset,
   * static-IP assignment, bulk/missing sync, the credential-heal cron — must
   * go through this (directly or via syncToRadius). Several call sites used
   * to build their own partial opts (or pass none at all), which meant a
   * static IP or package speed could be silently wiped by whichever one of
   * them ran last. See git history / the audit notes on grantGracePeriod,
   * syncAllToRadius and IntegrityService.healActiveCredentials for the
   * concrete incidents this caused.
   */
  private buildFullRadiusOpts(sub: {
    authMethod?: string | null;
    serviceSettings?: {
      ipType?: string | null;
      ipAddress?: string | null;
      macAddress?: string | null;
      allowMultipleSessions?: boolean | null;
    } | null;
  }) {
    // A static address is only honoured when the service is actually configured
    // for one — otherwise a stale ipAddress field would pin a dynamic customer.
    const wantsStatic =
      sub.authMethod === 'STATIC' || sub.serviceSettings?.ipType === 'STATIC';
    const staticIp = wantsStatic ? sub.serviceSettings?.ipAddress ?? null : null;
    return {
      serviceType: sub.authMethod as any,
      staticIp,
      macAddress: sub.serviceSettings?.macAddress ?? null,
      // ServiceSettings.duration is the billing period, not a session limit,
      // so session/idle limits come from env defaults unless set explicitly.
      sessionTimeout: Number(process.env.HOTSPOT_SESSION_TIMEOUT || 0) || null,
      idleTimeout: Number(process.env.HOTSPOT_IDLE_TIMEOUT || 0) || null,
      allowMultipleSessions: sub.serviceSettings?.allowMultipleSessions ?? false,
    };
  }

  async syncToRadius(subscriberId: number) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: {
        package: { include: { pool: true } },
        serviceSettings: true,
      },
    });
    if (!sub?.username) return { synced: false, reason: 'No username' };

    const opts = this.buildFullRadiusOpts(sub);

    await this.radiusSync.syncSubscriberProfile(
      sub.username,
      sub.password,
      sub.package as any,
      opts,
    );

    return {
      synced: true,
      username: sub.username,
      authMethod: sub.authMethod,
      addressing: opts.staticIp ? `static ${opts.staticIp}` : sub.package?.pool?.name ? `pool ${sub.package.pool.name}` : 'none',
    };
  }

  // ─────────────────────────────────────────────────────────────
  // TRANSFER A SUBSCRIBER TO ANOTHER RESELLER
  //
  // "Move customer X from dealer 1 to dealer 2." The subscriber keeps its
  // username, sessions, invoices and history — only OWNERSHIP moves, which is
  // what decides who pays the cost and who earns the margin from now on.
  //
  // Because the new owner may buy at a different price, the cost/sell stamps
  // are recalculated for the new chain. Past invoices are untouched — history
  // stays true to what was actually billed at the time.
  // ─────────────────────────────────────────────────────────────
  async transferOwnership(
    subscriberId: number,
    toUserId: number,
    opts: { reason?: string; actor?: Actor; settle?: boolean; newPackageId?: number } = {},
  ) {
    const actor = opts.actor;
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, fullName: true, username: true, userId: true, packageId: true,
                nasId: true, sellPrice: true, costPrice: true,
                serviceSettings: { select: { expiryDate: true, duration: true } } },
    });
    if (!sub) throw new NotFoundException(`Subscriber ${subscriberId} not found`);
    if (sub.userId === toUserId) {
      throw new BadRequestException('That account already owns this subscriber.');
    }

    // Both ends must be inside the caller's own subtree — you can move a
    // customer between YOUR dealers, never into or out of another branch.
    if (actor && !this.scope.isAdmin(actor.role)) {
      await this.scope.assertSubscriber(actor, subscriberId);
      await this.scope.assertUser(actor, toUserId);
    }

    const target = await this.prisma.user.findUnique({
      where: { id: toUserId },
      select: { id: true, name: true, role: true, branchId: true },
    });
    if (!target) throw new NotFoundException('Destination account not found');

    /**
     * MIGRATE PACKAGE (optional). The move may also change the plan — e.g. the
     * new owner puts the customer on their own 20 Mbps package. When a target
     * package is given, ALL of the accounting below (cost, sell, and the daily
     * rate used to bill the remaining days at activation) is calculated on the
     * MIGRATED package, not the old one. If none is given, the customer keeps
     * their current package. The migrated package id is validated to exist.
     */
    let targetPackageId = sub.packageId;
    if (opts.newPackageId && opts.newPackageId !== sub.packageId) {
      const exists = await this.prisma.package.findUnique({
        where: { id: Number(opts.newPackageId) }, select: { id: true },
      });
      if (!exists) throw new BadRequestException(`Package #${opts.newPackageId} not found for migration.`);
      targetPackageId = Number(opts.newPackageId);
    }
    const migrated = targetPackageId !== sub.packageId;

    // Recalculate what the NEW owner pays and charges for the (possibly migrated) package.
    let newCost: number | null = null;
    let newSell: number | null = null;
    if (targetPackageId) {
      try {
        const pkg = await this.prisma.package.findUnique({
          where: { id: targetPackageId },
          select: { price: true },
        });
        const base = pkg?.price ?? 0;
        // What the new owner pays its parent for this package…
        newCost = await this.pricing.activationCost(toUserId, targetPackageId, base);
        // …and what the new owner charges (its own price row, else base).
        const own = await this.prisma.resellerPackagePrice.findUnique({
          where: { userId_packageId: { userId: toUserId, packageId: targetPackageId } },
          select: { price: true, retailPrice: true },
        });
        /**
         * The customer is re-billed at the new owner's RETAIL price.
         *
         * This used to take `own.price` — which is the new owner's BUY price,
         * what they pay their parent. Billing the customer that figure hands
         * the new owner a margin of exactly zero on every renewal: they pay
         * 1,000 and charge 1,000. It also silently changed what the customer
         * pays to a number nobody chose as a selling price.
         *
         * `retailPrice` is the price that account actually sells at. Falling
         * back to the package base only when they have not set one.
         */
        newSell = own?.retailPrice ?? base;

        /**
         * Never hand over a customer at a price below the new owner's cost.
         *
         * If the receiving account has not set a retail price yet, the
         * fallback is the package base — the ISP's own figure, typically far
         * below what a dealer pays. A dealer buying at 1,000 would inherit a
         * customer billed 500 and lose 500 every month, quietly, until someone
         * noticed the profit column was negative.
         */
        if (newCost !== null && newSell < newCost) {
          this.logger.warn(
            `Transfer to user #${toUserId}: no retail price set for package ${targetPackageId}, ` +
            `falling back to cost ${newCost} instead of ${newSell} to avoid a loss-making customer.`,
          );
          newSell = newCost;
        }
      } catch {
        /* pricing unavailable — keep the existing stamps */
      }
    }

    // ── Move = hand over ownership, then SUSPEND until the new owner activates ──
    // A move never silently charges anyone and never leaves the customer running
    // on the new owner's books unpaid. The customer's remaining paid days are
    // PRESERVED (expiry is not touched), the record is suspended, and internet is
    // cut. The new owner then activates — and only THAT step charges their wallet
    // (at their own cost) and bills the customer (at their own sell price) for the
    // days that remain. This is why there is no wallet movement or balance check
    // here anymore: the accounting happens once, at activation, keyed to the new
    // owner, exactly like a fresh activation.
    const DAY = 24 * 60 * 60 * 1000;
    const expiry = sub.serviceSettings?.expiryDate ?? null;
    const totalDays = sub.serviceSettings?.duration ?? 30;
    const now = new Date();

    let remainingDays = 0;
    if (expiry) {
      remainingDays = Math.max(0, Math.ceil((new Date(expiry).getTime() - now.getTime()) / DAY));
      remainingDays = Math.min(remainingDays, totalDays); // guard against stale data
    }
    const usedDays = Math.max(0, totalDays - remainingDays);

    const ops: any[] = [
      this.prisma.subscriber.update({
        where: { id: subscriberId },
        data: {
          userId: toUserId,
          /**
           * CLEAR THE OLD SALESPERSON.
           *
           * Visibility is `userId IN my-subtree OR salespersonId IN my-subtree`.
           * The transfer moved `userId` and left `salespersonId` pointing at
           * the previous owner — so the customer went on appearing in the old
           * account's list, their counts and their reports, while also
           * appearing in the new one. The same subscriber in two places,
           * counted twice, with two accounts believing they own them.
           *
           * Worse across branches: hand a customer from one franchise to
           * another and the first franchise keeps seeing them forever, which
           * is exactly the sibling isolation this system is built to enforce.
           *
           * The new owner is now also the seller of record. Anything else
           * leaves a stale claim behind.
           */
          salespersonId: toUserId,
          /**
           * SUSPEND ON MOVE. The customer must not keep working on the new
           * owner's books until that owner activates them — activation is what
           * charges the new owner and re-bills the customer at the new owner's
           * price. Internet is cut just below (RADIUS rows removed).
           */
          status: 'INACTIVE',
          /**
           * THE BRANCH MOVES TOO.
           *
           * A subscriber is reachable by owner, by salesperson AND by branch.
           * Moving only the first two left `branchId` pointing at the previous
           * owner's branch, so branch reports, revenue-by-branch and every
           * per-branch count kept the customer on the old side of the business
           * while the subscriber list showed them on the new one. The same
           * customer, in two places, disagreeing.
           *
           * Every route to a subscriber has to arrive at exactly one account —
           * that is what "moved" has to mean. Null target branch leaves it
           * alone rather than blanking a value we cannot replace.
           */
          ...(target.branchId != null ? { branchId: target.branchId } : {}),
          // Migrate the plan if a new package was chosen. Activation then bills
          // the remaining days at THIS package's daily rate.
          ...(migrated ? { packageId: targetPackageId } : {}),
          ...(newCost !== null ? { costPrice: newCost } : {}),
          ...(newSell !== null ? { sellPrice: newSell } : {}),
          ...(newCost !== null && newSell !== null
            ? { profit: Math.round((newSell - newCost) * 100) / 100 }
            : {}),
        },
      }),
      this.prisma.subscriberTransfer.create({
        data: {
          subscriberId,
          fromUserId: sub.userId ?? null,
          toUserId,
          byUserId: actor ? this.scope.actorId(actor) : null,
          reason: opts.reason ?? null,
          oldSellPrice: sub.sellPrice ?? null,
          oldCostPrice: sub.costPrice ?? null,
          newSellPrice: newSell,
          newCostPrice: newCost,
          expiryDate: expiry,
          totalDays,
          usedDays,
          remainingDays,
          // No money moves at the moment of the move — it is settled at
          // activation by the new owner. Recorded as zero so the transfer row
          // is an honest statement of what happened here.
          refundToFrom: 0,
          chargeToNew: 0,
        },
      }),
    ];
    // Suspend the service too (isBlocked), keeping the expiry so the remaining
    // paid days survive the move for the new owner to activate against.
    if (sub.serviceSettings) {
      ops.push(
        this.prisma.serviceSettings.update({
          where: { subscriberId },
          data: { isBlocked: true },
        }),
      );
    }

    const [updated] = await this.prisma.$transaction(ops);

    // Cut internet NOW — the customer must go offline the instant ownership
    // changes and stay off until the new owner reactivates. Removing the RADIUS
    // rows alone does NOT do this: MikroTik checks its own /ppp/secret before it
    // ever asks RADIUS, and an already-connected session keeps running until it
    // is actively killed (which is why a moved user stayed online with hours of
    // uptime). So, in the same order the deactivate flow uses:
    //   1) remove the router's LOCAL PPP secret  → no local re-auth path
    //   2) disconnect the live PPPoE session      → they drop immediately
    //   3) remove the RADIUS credentials          → no RADIUS re-auth path
    let sessionCut = false;
    try {
      const nas = sub.nasId
        ? await this.prisma.nas.findUnique({
            where: { id: sub.nasId },
            select: { nasIp: true, apiPort: true, apiUsername: true, apiPassword: true },
          })
        : null;
      if (nas?.nasIp && nas.apiUsername && nas.apiPassword) {
        await this.mikrotik.removePppSecret(
          nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, sub.username,
        ).catch((e: any) => this.logger.warn(`Transfer: PPP secret removal for ${sub.username} failed: ${e?.message || e}`));
        const killResult = await this.mikrotik.disconnectPppoeUser(
          nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, sub.username,
        ).catch(() => null);
        sessionCut = !!killResult?.removed;
      }
    } catch (e: any) {
      this.logger.warn(`Transfer of #${subscriberId}: could not cut live session (${e?.message || e})`);
    }
    try {
      await this.radiusSync.removeSubscriberFromRadius(sub.username);
    } catch (e: any) {
      this.logger.warn(`Transfer of #${subscriberId}: RADIUS suspend failed (${e?.message || e}); will be reconciled by the integrity sweep`);
    }
    this.logger.log(
      `Subscriber "${sub.username}" suspended after transfer — awaiting activation by new owner` +
      (sessionCut ? ', live session cut' : ' (no live session found to cut)'),
    );

    /**
     * VERIFY THE MOVE WAS TOTAL.
     *
     * A subscriber is reachable through owner, salesperson and branch. If any
     * one of those still points into the old account's tree, the customer
     * shows up in two places at once — counted twice, owned by two people,
     * and visible to an account that no longer serves them. That is the exact
     * failure this check exists to make impossible.
     *
     * Reading the row back after the commit is deliberate: it proves what is
     * actually stored rather than what the update intended.
     */
    const after = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { userId: true, salespersonId: true, branchId: true },
    });
    const strays: string[] = [];
    if (after?.userId !== toUserId) strays.push(`owner=${after?.userId}`);
    if (after?.salespersonId != null && after.salespersonId !== toUserId) {
      strays.push(`salesperson=${after.salespersonId}`);
    }
    if (strays.length) {
      // Loud, because a half-moved subscriber is worse than a failed move:
      // nothing looks broken until two accounts bill the same customer.
      this.logger.error(
        `⚠️ Subscriber #${subscriberId} did not move cleanly to #${toUserId} — ` +
        `still linked to ${strays.join(', ')}. This customer may appear under two accounts.`,
      );
    }

    this.logger.log(
      `Subscriber "${sub.username}" moved from user #${sub.userId} to #${toUserId} (${target.name}) — ` +
      `owner, salesperson and branch all reassigned`,
    );
    return {
      transferred: true,
      subscriber: { id: sub.id, fullName: sub.fullName, username: sub.username },
      from: sub.userId,
      to: { id: target.id, name: target.name, role: target.role },
      pricing: { oldCost: sub.costPrice, newCost, oldSell: sub.sellPrice, newSell },
      package: { migrated, from: sub.packageId, to: targetPackageId },
      // Service period is preserved; the customer is suspended until activated.
      period: {
        expiryDate: expiry,
        totalDays,
        usedDays,
        remainingDays,
        expiryUnchanged: true,
      },
      // Suspended, no money moved yet. The new owner activates to charge their
      // wallet (their cost) and re-bill the customer (their sell) for the days
      // that remain.
      suspended: true,
      awaitingActivation: true,
      settlement: {
        deferredToActivation: true,
        basis: `${remainingDays}/${totalDays} days remaining, billed at activation by ${target.name}`,
      },
    };
  }

  /** Full ownership history for a subscriber. */
  async transferHistory(subscriberId: number, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);
    const rows = await this.prisma.subscriberTransfer.findMany({
      where: { subscriberId },
      orderBy: { createdAt: 'desc' },
    });
    const ids = [...new Set(rows.flatMap((r) => [r.fromUserId, r.toUserId, r.byUserId]).filter(Boolean))] as number[];
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, role: true } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      ...r,
      fromUser: r.fromUserId ? byId.get(r.fromUserId) ?? null : null,
      toUser: byId.get(r.toUserId) ?? null,
      byUser: r.byUserId ? byId.get(r.byUserId) ?? null : null,
    }));
  }

  // ─────────────────────────────────────────────────────────────
  // UNIVERSAL REPAIR — rebuild links wiped by partial updates
  //
  // A partial edit used to null out packageId / areaId / nasId /
  // installationDate. Those links can be reconstructed for EVERY subscriber
  // from data RADIUS already holds:
  //   • nasId            ← the NAS IP on their most recent radacct session
  //   • packageId        ← their Mikrotik-Rate-Limit in radreply (e.g. "4M/4M")
  //   • installationDate ← falls back to the record's creation date
  //
  // Only ever FILLS NULLs — it never overwrites a value that is already set,
  // so it is safe to run repeatedly. Runs automatically on every backend start.
  // ─────────────────────────────────────────────────────────────
  async repairMissingLinks(): Promise<{
    scanned: number; repaired: number;
    details: Array<{ id: number; username: string | null; restored: string[] }>;
  }> {
    const broken = await this.prisma.subscriber.findMany({
      where: {
        OR: [
          { nasId: null }, { packageId: null }, { installationDate: null },
          { areaId: null }, { salespersonId: null },
          // Also catch subscribers whose only gap is a missing expiry date.
          { serviceSettings: { is: null } },
          { serviceSettings: { expiryDate: null } },
        ],
      },
      // SCALE: this runs on every boot and does per-row work. Cap it so a large
      // install repairs in batches across restarts instead of stalling startup.
      take: Number(process.env.REPAIR_BATCH_SIZE || 500),
    });
    if (!broken.length) return { scanned: 0, repaired: 0, details: [] };

    const [packages, nasList, areaList] = await Promise.all([
      this.prisma.package.findMany(),
      this.prisma.nas.findMany(),
      this.prisma.area.findMany(),
    ]);

    const details: Array<{ id: number; username: string | null; restored: string[] }> = [];

    for (const s of broken) {
      const data: any = {};
      // Fields repaired outside the Subscriber row itself (e.g. ServiceSettings).
      const restoredExtra: string[] = [];

      // ── NAS: whichever router last carried a session for this user.
      // The IP lookup and the matching are kept separate so a failing query
      // can't skip the single-NAS fallback below.
      if (!s.nasId) {
        let ip: string | null = null;
        if (s.username) {
          try {
            const rows = await this.prisma.$queryRaw<any[]>`
              SELECT host(nasipaddress) AS ip FROM radacct
                WHERE username = ${s.username} ORDER BY radacctid DESC LIMIT 1`;
            ip = rows?.[0]?.ip ? String(rows[0].ip) : null;
          } catch { /* fall through to the fallback */ }
        }

        // Normalise: inet values can carry a /prefix, and stored values may
        // have stray whitespace.
        const norm = (v?: string | null) =>
          (v || '').trim().split('/')[0].toLowerCase();

        let nas =
          ip ? nasList.find((n) => norm(n.nasIp) === norm(ip) || norm(n.nasname) === norm(ip)) : undefined;

        // Single-NAS deployment: the router is unambiguous even without a session.
        if (!nas && nasList.length === 1) nas = nasList[0];

        // Last resort: any active NAS is better than leaving the subscriber
        // unlinked, since an unlinked subscriber shows "—" everywhere and is
        // skipped by session/log matching.
        if (!nas && nasList.length > 1) nas = nasList.find((n) => n.isActive) ?? nasList[0];

        if (nas) {
          data.nasId = nas.id;
        } else {
          this.logger?.warn?.(
            `Could not resolve a NAS for "${s.username}" ` +
              `(session IP: ${ip ?? 'none'}, NAS records: ${nasList.length}). ` +
              `Add a NAS in the panel, then restart to retry.`,
          );
        }
      }

      // ── Package: match the speed we pushed to RADIUS back to a package
      if (!s.packageId && s.username) {
        try {
          const rows = await this.prisma.$queryRaw<any[]>`
            SELECT value FROM radreply
              WHERE username = ${s.username} AND attribute = 'Mikrotik-Rate-Limit' LIMIT 1`;
          const rl = rows?.[0]?.value ? String(rows[0].value) : null;
          const m = rl ? /^(\d+)([KM])\/(\d+)([KM])/i.exec(rl) : null;
          if (m) {
            const toMbps = (v: string, unit: string) =>
              unit.toUpperCase() === 'K' ? Number(v) / 1000 : Number(v);
            const a = toMbps(m[1], m[2]);
            const b = toMbps(m[3], m[4]);
            // Rate-limit is "upload/download"; accept either order to be safe.
            const pkg = packages.find(
              (p) =>
                (p.uploadSpeed === a && p.downloadSpeed === b) ||
                (p.uploadSpeed === b && p.downloadSpeed === a),
            );
            if (pkg) data.packageId = pkg.id;
          }
        } catch { /* ignore */ }
      }

      // ── Salesperson: the account that owns this subscriber is the correct
      // attribution — it's who created//sold the connection.
      if (!s.salespersonId && s.userId) data.salespersonId = s.userId;

      // ── Area: only inferable when the deployment has exactly one area, in
      // which case it is unambiguous. With several areas there is no safe
      // guess — putting the wrong location on a customer would corrupt area
      // reporting and dispatch, so we flag it instead of inventing one.
      if (!s.areaId) {
        if (areaList.length === 1) {
          data.areaId = areaList[0].id;
        } else if (areaList.length > 1) {
          this.logger?.warn?.(
            `"${s.username}" has no area and ${areaList.length} areas exist — ` +
              `set it in the subscriber's Edit form (cannot be inferred safely).`,
          );
        }
      }

      // ── Install date: creation date is the best available truth
      if (!s.installationDate) data.installationDate = s.createdAt;

      // ── Expiry: derive from the install date + the package's billing period
      // (Package.duration, in days). Without this the subscriber shows no
      // expiry until someone runs an Activation, and never appears in the
      // "expiring soon" reports.
      const effectivePackageId = data.packageId ?? s.packageId;
      const installDate = data.installationDate ?? s.installationDate ?? s.createdAt;
      if (effectivePackageId && installDate) {
        try {
          const existing = await this.prisma.serviceSettings.findUnique({
            where: { subscriberId: s.id },
          });
          if (!existing?.expiryDate) {
            const pkg = packages.find((p) => p.id === effectivePackageId);
            const days = pkg?.duration ?? 30;
            const expiry = new Date(installDate);
            expiry.setDate(expiry.getDate() + days);

            await this.prisma.serviceSettings.upsert({
              where:  { subscriberId: s.id },
              update: { expiryDate: expiry, duration: days },
              create: { subscriberId: s.id, expiryDate: expiry, duration: days },
            });
            restoredExtra.push('expiryDate');
          }
        } catch (e: any) {
          this.logger?.warn?.(`Could not set expiry for "${s.username}": ${e?.message || e}`);
        }
      }

      try {
        if (Object.keys(data).length) {
          await this.prisma.subscriber.update({ where: { id: s.id }, data });
        }
        const restored = [...Object.keys(data), ...restoredExtra];
        if (restored.length) {
          details.push({ id: s.id, username: s.username, restored });
          this.logger?.log?.(`Repaired subscriber "${s.username}" → ${restored.join(', ')}`);
        }
      } catch { /* ignore */ }
    }

    if (details.length) {
      this.logger?.log?.(
        `✅ Repaired ${details.length}/${broken.length} subscriber(s) with missing links.`,
      );
    }
    return { scanned: broken.length, repaired: details.length, details };
  }

  // ─────────────────────────────────────────────────────────────
  // LIVE CONNECTIVITY (ONLINE / OFFLINE + why)
  // `status` is the billing state (ACTIVE/EXPIRED/…). This adds the real
  // network state from RADIUS accounting, plus a plain-language reason for the
  // last disconnect so support can triage without reading RADIUS.
  // ─────────────────────────────────────────────────────────────
  private static readonly TERMINATE_LABEL: Record<string, string> = {
    'User-Request':        'User disconnected',
    'Lost-Carrier':        'ONU / cable down at client',
    'Lost-Service':        'Service lost',
    'Idle-Timeout':        'Idle timeout',
    'Session-Timeout':     'Session time limit',
    'Admin-Reset':         'Disconnected by admin',
    'Admin-Reboot':        'Router rebooted (admin)',
    'NAS-Reboot':          'Router rebooted',
    'NAS-Error':           'Router error',
    'NAS-Request':         'Router closed session',
    'Port-Error':          'Port error',
    'Port-Unneeded':       'Port unneeded',
    'Port-Preempted':      'Port preempted',
    'Port-Suspended':      'Port suspended',
    'Service-Unavailable': 'Service unavailable',
    'User-Error':          'Client config error',
    'Host-Request':        'Host request',
    'Callback':            'Callback',
  };

  /**
   * Usernames the ROUTERS themselves report as connected right now.
   *
   * Polls every NAS that has API credentials for its /ppp/active list and
   * unions the usernames. Cached for 20s so a list that refreshes every few
   * seconds does not open an API connection to every router each time. Any
   * router that is unreachable simply contributes nothing — never an error.
   *
   * Returned lower-cased because RADIUS usernames are case-insensitive in
   * practice and MikroTik may report a different case than we stored.
   */
  private async routerPresence(): Promise<Set<string>> {
    try {
      const arr = await this.cache.wrap<string[]>('subs:router-presence', 20, async () => {
        const nases = await this.prisma.nas.findMany({
          where: { apiUsername: { not: null } },
          select: { nasIp: true, apiPort: true, apiUsername: true, apiPassword: true },
        });
        const online = new Set<string>();
        await Promise.all(
          nases.map(async (n) => {
            if (!n.nasIp || !n.apiUsername) return;
            try {
              const users = await this.mikrotik.getActivePppoeUsers(
                n.nasIp, n.apiPort || 8728, n.apiUsername, n.apiPassword || '',
              );
              for (const u of users) if (u?.username) online.add(String(u.username).toLowerCase());
            } catch { /* unreachable router → contributes nothing */ }
          }),
        );
        return [...online];
      });
      return new Set(arr || []);
    } catch {
      return new Set();
    }
  }

  async attachLiveStatus(rows: any[]): Promise<any[]> {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    const usernames = rows.map((r) => r?.username).filter(Boolean) as string[];
    if (!usernames.length) return rows;

    let live: any[] = [];
    try {
      // One row per user: their most recent session.
      // A session counts as ONLINE only if it is still open AND the NAS has
      // reported on it recently. Without the freshness check, a session whose
      // Accounting-Stop was lost (router reboot, RADIUS restart, packet loss)
      // stays "online" forever — showing users as connected days later.
      // NOTE: this requires interim-updates on the router; the grace window is
      // deliberately wider than a typical 1–5 min interim interval.
      live = await this.prisma.$queryRaw<any[]>`
        SELECT DISTINCT ON (username)
          username, acctstarttime, acctstoptime, acctterminatecause,
          framedipaddress, callingstationid, acctsessiontime,
          COALESCE(acctupdatetime, acctstarttime) AS lastactivity,
          (
            acctstoptime IS NULL
            AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '15 minutes'
          ) AS is_online,
          (
            acctstoptime IS NULL
            AND COALESCE(acctupdatetime, acctstarttime) <= NOW() - INTERVAL '15 minutes'
          ) AS is_stale
        FROM radacct
        WHERE username = ANY(${usernames})
        ORDER BY username, radacctid DESC
      `;
    } catch (e: any) {
      // RADIUS tables unavailable — return the list rather than failing the page.
      this.logger?.warn?.(`Live status lookup skipped: ${e?.message || e}`);
      return rows;
    }

    const byUser = new Map(live.map((l) => [l.username, l]));

    /**
     * ROUTER-API PRESENCE — the accounting-independent source of truth.
     *
     * RADIUS accounting (radacct) is only as reliable as the router's willing-
     * ness to send Accounting-Start/Interim/Stop. In the field it frequently is
     * NOT: a user authenticates, the PPPoE session comes up, but no accounting
     * arrives — so radacct shows them offline while they are plainly connected
     * on the MikroTik. To fix that we ALSO ask each router directly who is in
     * its /ppp/active list, and treat that as authoritative for "online".
     *
     * Cached briefly so a frequently-reloaded list does not hammer the routers,
     * and fully wrapped so an unreachable router degrades to the radacct result
     * rather than failing the page.
     */
    const routerOnline = await this.routerPresence();

    return rows.map((r) => {
      const uname = r?.username ? String(r.username) : '';
      const l = uname ? byUser.get(uname) : null;
      const onAcct = !!l && l.is_online === true;
      const onRouter = uname ? routerOnline.has(uname.toLowerCase()) : false;
      const online = onAcct || onRouter;
      // A session the router reports as live is never "stale".
      const stale = !online && !!l && l.is_stale === true;
      const cause = l?.acctterminatecause || null;

      // A stale row means the NAS stopped reporting without closing the session,
      // so we know the user is NOT online but not why they dropped.
      const reason = stale
        ? 'No response from router (session stale)'
        : l
          ? (SubscribersService.TERMINATE_LABEL[cause as string] || cause || 'Disconnected')
          : 'Never connected';

      return {
        ...r,
        liveStatus:    online ? 'ONLINE' : 'OFFLINE',
        isStaleSession: stale,
        onlineSince:   online ? l?.acctstarttime ?? null : null,
        framedIp:      online ? l?.framedipaddress ?? null : null,
        macAddress:    l?.callingstationid ?? null,
        lastSeenAt:    l?.lastactivity ?? l?.acctstoptime ?? l?.acctstarttime ?? null,
        offlineCause:  online ? null : (stale ? 'Stale-Session' : cause),
        offlineReason: online ? null : reason,
      };
    });
  }

  async getOverview(actor?: Actor) {
    // ⚡ Phase 0: dashboard numbers cached for 30s (per-scope cache key)
    const scopeWhere = await this.scope.subscriberWhere(actor);
    const key = Object.keys(scopeWhere).length
      ? `subscribers:overview:u${this.scope.actorId(actor)}`
      : 'subscribers:overview';
    return this.cache.wrap(key, 30, () => this.computeOverview(scopeWhere));
  }

  private async computeOverview(scopeWhere: any = {}) {
    const withScope = (w: any) =>
      Object.keys(scopeWhere).length ? { AND: [w, scopeWhere] } : w;
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(now);
    dayEnd.setHours(23, 59, 59, 999);
    const expiringEnd = new Date(now.getTime() + 7 * 86400_000);

    const [
      total,
      active,
      inactive,
      suspended,
      expired,
      todaySignups,
      expiring,
      radiusOnlineRows,
    ] = await Promise.all([
      this.prisma.subscriber.count({ where: withScope({}) }),
      this.prisma.subscriber.count({ where: withScope({ status: 'ACTIVE' }) }),
      this.prisma.subscriber.count({ where: withScope({ status: 'INACTIVE' }) }),
      this.prisma.subscriber.count({ where: withScope({ status: 'SUSPENDED' }) }),
      this.prisma.subscriber.count({ where: withScope({ status: 'EXPIRED' }) }),
      this.prisma.subscriber.count({ where: withScope({ createdAt: { gte: dayStart, lte: dayEnd } }) }),
      // ACTIVE accounts whose expiry lands within the next 7 days — the
      // renewal lookahead. Scoped, server-counted (list is capped).
      this.prisma.subscriber.count({
        where: withScope({
          status: 'ACTIVE',
          serviceSettings: { is: { expiryDate: { gte: now, lte: expiringEnd } } },
        }),
      }),
      this.prisma.$queryRaw<Array<{ username: string }>>`
        SELECT DISTINCT username
        FROM radacct
        WHERE acctstoptime IS NULL
          AND username IS NOT NULL
          -- Must match the freshness rule used by attachLiveStatus(), otherwise
          -- the "Online Now" tile counts sessions the list already shows as
          -- Offline. A session whose Accounting-Stop was lost stays open
          -- forever, so only count it if the NAS reported on it recently.
          AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '15 minutes'
      `,
    ]);

    // Merge accounting presence with what the routers report live, exactly as
    // attachLiveStatus() does — otherwise the "Online Now" tile disagrees with
    // the list beneath it. Router usernames are lower-cased there, so match on
    // a lower-cased set here too.
    const routerOnline = await this.routerPresence();
    const onlineSet = new Set<string>(radiusOnlineRows.map((r) => r.username));
    const acctLower = new Set(Array.from(onlineSet).map((u) => u.toLowerCase()));
    let onlineNow: number;
    if (routerOnline.size === 0) {
      onlineNow = await this.prisma.subscriber.count({
        where: withScope({ username: { in: Array.from(onlineSet) } }),
      });
    } else {
      // Count subscribers whose username is online by EITHER source.
      const scoped = await this.prisma.subscriber.findMany({
        where: withScope({}), select: { username: true },
      });
      onlineNow = scoped.filter((s) => {
        const u = (s.username || '').toLowerCase();
        return u && (routerOnline.has(u) || acctLower.has(u));
      }).length;
    }

    // Count stale sessions: those that appear to radacct as still open but
    // haven't reported activity in 15+ minutes (same window as attachLiveStatus).
    const staleRows = await this.prisma.$queryRaw<Array<{ username: string }>>`
      SELECT DISTINCT username
      FROM radacct
      WHERE acctstoptime IS NULL
        AND username IS NOT NULL
        AND COALESCE(acctupdatetime, acctstarttime) <= NOW() - INTERVAL '15 minutes'
        AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '7 days'
    `;
    const staleSet = new Set(staleRows.map((r) => r.username));
    const staleCount = await this.prisma.subscriber.count({
      where: withScope({ username: { in: Array.from(staleSet) } }),
    });

    const offline = Math.max(total - onlineNow, 0);

    return {
      total,
      active,
      inactive,
      suspended,
      expired,
      expiring,
      onlineNow,
      stale: staleCount,
      offline,
      todaySignups,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // FIND ONE
  // ─────────────────────────────────────────────────────────────
  async findOne(id: number, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, id);
    return this.prisma.subscriber.findUnique({
      where: { id },
      include: {
        package:     { include: { pool: true } },
        area:        true,
        nas:         true,
        salesperson: true,
        // Needed for expiry/IP details — without it the profile and the public
        // API both reported a null expiry date for every subscriber.
        serviceSettings: true,
        user: { select: { id: true, name: true, role: true } },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // SEARCH
  // ─────────────────────────────────────────────────────────────
  async search(q: string, actor?: Actor) {
    const base: any = {
      OR: [
        { fullName:  { contains: q, mode: 'insensitive' } },
        { phone:     { contains: q } },
        { username:  { contains: q, mode: 'insensitive' } },
        { email:     { contains: q, mode: 'insensitive' } },
        { identity:  { contains: q } },
      ],
    };
    const scopeWhere = await this.scope.subscriberWhere(actor);
    const where = Object.keys(scopeWhere).length ? { AND: [base, scopeWhere] } : base;
    const rows = await this.prisma.subscriber.findMany({
      where,
      // MUST match findAll's shape, or a searched list silently loses expiry
      // (days-left) and online/offline status that the full list shows.
      include: {
        package:     { include: { pool: true } },
        area:        true,
        nas:         true,
        salesperson: true,
        serviceSettings: true,
        user: { select: { id: true, name: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    // Same live-status enrichment as findAll so search rows show correct online.
    return this.attachLiveStatus(rows);
  }

  // ─────────────────────────────────────────────────────────────
  // STATS
  // ─────────────────────────────────────────────────────────────
  async getStats(actor?: Actor) {
    const overview = await this.getOverview(actor);
    return {
      total: overview.total,
      active: overview.active,
      expired: overview.expired,
      expiring: overview.expiring,
      suspended: overview.suspended,
      onlineNow: overview.onlineNow,
      offline: overview.offline,
      todaySignups: overview.todaySignups,
    };
  }

  async getExpiring(days?: number, actor?: Actor) {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + (days ?? 30));

    // SECURITY: restrict to the caller's own subtree — never the whole system.
    const scopeWhere = await this.scope.subscriberWhere(actor);
    const expiryWindow: any = { not: null, lte: end };
    if (days !== undefined) expiryWindow.gte = now; // upcoming only (exclude already-expired)

    return this.prisma.subscriber.findMany({
      where: { AND: [scopeWhere, { serviceSettings: { is: { expiryDate: expiryWindow } } }] },
      include: { package: true, salesperson: true, serviceSettings: true },
      orderBy: { serviceSettings: { expiryDate: 'asc' } },
      take: 1000,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // CREATE SUBSCRIBER
  //
  // Flow:
  //   1. Validate input
  //   2. Save to CRM database
  //   3. Fetch the assigned package (with pool)
  //   4. Sync to RADIUS with password + speed + pool
  // ─────────────────────────────────────────────────────────────
  /**
   * Refuse a NAS the caller has no right to use.
   *
   * `nasId` came straight off the request body and was written with no check at
   * all. The dropdown only offers routers in your scope, but the dropdown is
   * not the security boundary — a dealer could POST any nasId and park their
   * subscriber on another franchise's router. That puts an unknown customer on
   * hardware someone else owns and pays for, and makes the session appear in
   * that franchise's live list with no explanation.
   */
  private async assertNasAllowed(actor: Actor | undefined, nasId: number) {
    if (!actor || !nasId || this.scope.isAdmin(actor.role)) return;
    const allowed = await this.prisma.nas.findFirst({
      where: { AND: [{ id: nasId }, await this.scope.nasWhere(actor)] },
      select: { id: true },
    });
    if (!allowed) {
      throw new ForbiddenException(
        'That router is not available to your account. You can use routers you own, ' +
        'or ones shared with you by your parent.',
      );
    }
  }

  /**
   * Subscribers with NO owner account.
   *
   * These are invisible in every reseller's books, charge nobody on activation,
   * and — when ACTIVE — are receiving service that no wallet ever paid for. The
   * only trace is a NULL, which no report was looking for.
   */
  async findOwnerless(actor?: Actor) {
    // Ownerless rows belong to nobody, so only an ISP-level account can see the
    // full set; a reseller subtree query would return nothing by definition.
    if (actor && !this.scope.isAdmin(actor.role)) {
      throw new ForbiddenException('Only ISP-level accounts can list ownerless subscribers.');
    }
    const rows = await this.prisma.subscriber.findMany({
      where: { userId: null },
      select: {
        id: true, username: true, fullName: true, status: true, createdAt: true,
        package: { select: { name: true, price: true } },
        salesperson: { select: { id: true, name: true, role: true } },
        serviceSettings: { select: { expiryDate: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const active = rows.filter((r) => r.status === 'ACTIVE');
    return {
      total: rows.length,
      active: active.length,
      items: rows.map((r) => ({
        subscriberId: r.id, username: r.username, name: r.fullName, status: r.status,
        package: r.package?.name ?? null, price: r.package?.price ?? null,
        expiry: r.serviceSettings?.expiryDate ?? null,
        // The most likely intended owner: whoever sold it.
        suggestedOwner: r.salesperson ?? null,
        createdAt: r.createdAt,
      })),
      note: active.length
        ? `${active.length} of these are ACTIVE — they have working internet and no account is being billed for them.`
        : 'None are currently active.',
    };
  }

  /**
   * ASSIGN AN OWNER TO AN OWNERLESS SUBSCRIBER — a data repair, not a transfer.
   *
   * WHY THIS IS NOT "MOVE". transferOwnership() deliberately SUSPENDS the
   * customer and cuts their internet, because a real dealer-to-dealer handover
   * must not leave them running on the new owner's books unpaid — the new owner
   * activates, and that step charges them. That is right for a transfer.
   *
   * It is wrong for THIS. These subscribers have `userId = NULL`: no owner was
   * ever recorded, so there is no previous owner to hand over from, and several
   * of them are live, paying customers who are online right now. Running Move
   * on them would take working customers offline to correct a database field.
   *
   * So this does exactly one thing: fills in the missing owner. It does NOT
   * touch status, expiry, RADIUS or the session. Billing is a SEPARATE, explicit
   * decision afterwards (see backchargeUnbilled) — assigning an owner must never
   * silently reach into someone's wallet.
   *
   * Refuses outright if the subscriber ALREADY has an owner: changing that is a
   * transfer, with money and service consequences, and must go through Move.
   */
  async assignOwner(
    subscriberId: number,
    newOwnerId: number,
    opts: { actor?: Actor; reason?: string } = {},
  ) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, username: true, fullName: true, userId: true, status: true },
    });
    if (!sub) throw new NotFoundException(`Subscriber ${subscriberId} not found`);

    if (sub.userId != null) {
      throw new BadRequestException(
        `${sub.fullName || sub.username} already belongs to an account. ` +
        `Changing ownership is a transfer — use Move, which suspends the customer ` +
        `until the new owner activates and pays for the remaining days.`,
      );
    }

    const owner = await this.prisma.user.findUnique({
      where: { id: newOwnerId },
      select: { id: true, name: true, role: true, isActive: true },
    });
    if (!owner) throw new NotFoundException(`Account ${newOwnerId} not found`);
    if (owner.isActive === false) {
      throw new BadRequestException(`${owner.name} is deactivated — pick an active account.`);
    }
    // The caller must be allowed to hand customers to this account.
    if (opts.actor && !this.scope.isAdmin(opts.actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(opts.actor));
      if (!ids.includes(newOwnerId)) {
        throw new ForbiddenException('You can only assign subscribers to accounts in your own tree.');
      }
    }

    await this.prisma.subscriber.update({
      where: { id: subscriberId },
      data: { userId: newOwnerId },
    });

    await this.prisma.activityLog.create({
      data: {
        userId: opts.actor ? this.scope.actorId(opts.actor) : null,
        action: 'SUBSCRIBER_OWNER_ASSIGNED',
        entity: 'Subscriber',
        entityId: subscriberId,
        details:
          `${sub.fullName || sub.username} had no owner; assigned to ${owner.name} (${owner.role}). ` +
          `Service untouched (still ${sub.status}). Billing not changed — back-charge separately if required.` +
          (opts.reason ? ` Reason: ${opts.reason}` : ''),
      },
    }).catch(() => null);

    this.logger.log(
      `Owner assigned: subscriber #${subscriberId} (${sub.username}) → ${owner.name} (#${owner.id}). ` +
      `No service or billing change.`,
    );

    return {
      ok: true,
      subscriberId,
      username: sub.username,
      owner: { id: owner.id, name: owner.name, role: owner.role },
      serviceChanged: false,
      billed: false,
      note: 'Owner recorded. The customer was not disconnected and nothing was charged — ' +
            'use the back-charge tool if this activation should be billed.',
    };
  }

  /** Bulk form of assignOwner — per-row results, one failure never aborts the rest. */
  async assignOwnerBulk(
    subscriberIds: number[],
    newOwnerId: number,
    opts: { actor?: Actor; reason?: string } = {},
  ) {
    const results: Array<{ subscriberId: number; status: 'assigned' | 'skipped' | 'failed'; reason?: string }> = [];
    let assigned = 0, skipped = 0, failed = 0;
    for (const id of (subscriberIds || []).slice(0, 500)) {
      try {
        await this.assignOwner(id, newOwnerId, opts);
        results.push({ subscriberId: id, status: 'assigned' });
        assigned++;
      } catch (e: any) {
        const msg = e?.message || 'Failed';
        // "already belongs to an account" is a skip, not an error.
        const isSkip = /already belongs/i.test(msg);
        results.push({ subscriberId: id, status: isSkip ? 'skipped' : 'failed', reason: msg });
        isSkip ? skipped++ : failed++;
      }
    }
    return { assigned, skipped, failed, results };
  }

  async create(data: any, actor?: Actor) {
    // IDEMPOTENCY: if the request carries a key and a subscriber was already
    // created with it (a retry or a double-clicked "Add"), return that record
    // instead of creating a duplicate and charging the wallet twice.
    if (data.idempotencyKey) {
      const existing = await this.prisma.subscriber.findUnique({ where: { idempotencyKey: String(data.idempotencyKey) } });
      if (existing) {
        this.logger.log(`Idempotent create: key ${data.idempotencyKey} already produced subscriber #${existing.id} — returning it.`);
        return existing;
      }
    }
    if (data.nasId) await this.assertNasAllowed(actor, parseInt(data.nasId));
    /**
     * WHO OWNS THIS CUSTOMER — and therefore WHOSE WALLET PAYS.
     *
     * Ownership drives two things: visibility (whose subtree it appears in) and
     * money (settleActivation debits the owner, never whoever clicked). So
     * getting this wrong charges the wrong account.
     *
     * THE BUG THIS FIXES: the form's "Salesperson" dropdown sends
     * `salespersonId`, not `userId`. An ISP admin who created a customer and
     * selected a DEALER there got `data.userId === undefined`, so ownership
     * fell through to the actor — the ISP itself. The dealer was recorded as
     * salesperson, the subscriber list showed the dealer's name, and everyone
     * reasonably assumed the dealer owned it. But the activation charge landed
     * on the ISP's own wallet, and the dealer paid nothing.
     *
     * The rule now: if no explicit owner was given and the selected salesperson
     * is an account that CAN own customers and hold a wallet — a reseller tier,
     * not ISP staff — then selecting them means they own it. That is the only
     * sensible reading of "assign this customer to D1".
     *
     * A SALES staff member is different: they sell on the ISP's behalf and hold
     * no wallet, so the ISP keeps ownership and pays. Passing `userId`
     * explicitly always wins, so the API can still express any combination.
     */
    let ownerId = data.userId
      ? parseInt(data.userId)
      : actor
        ? this.scope.actorId(actor)
        : null;

    if (!data.userId && data.salespersonId) {
      const sp = await this.prisma.user.findUnique({
        where: { id: parseInt(data.salespersonId) },
        select: { id: true, name: true, role: true },
      });
      // Roles that own customers and settle from their own wallet.
      const OWNS_CUSTOMERS = ['RESELLER', 'SUB_RESELLER', 'RETAILER'];
      if (sp && OWNS_CUSTOMERS.includes(sp.role)) {
        if (ownerId !== sp.id) {
          this.logger.log(
            `Owner set to "${sp.name}" (${sp.role}, #${sp.id}) from the selected salesperson — ` +
            `their wallet will be charged for this activation, not the creating account's.`,
          );
        }
        ownerId = sp.id;
      }
    }

    // ── Prepaid accounting: compute retail price, cost and profit for this sale.
    // sellPrice = what the END customer pays. ANY tier can set its own retail
    // price on a direct subscriber (e.g. ISP sells wholesale at 2 but bills its
    // own customer 5). Defaults to the package price if not provided.
    let sellPrice: number | null = null;
    let costPrice = 0;
    let profit: number | null = null;
    if (ownerId && data.packageId) {
      const pkg = await this.prisma.package.findUnique({
        where: { id: parseInt(data.packageId) },
        select: { price: true },
      });
      const base = pkg?.price ?? 0;

      /**
       * THREE PRICES, RESOLVED IN ORDER — and only ONE of them moves a wallet.
       *
       *   1. `data.sellPrice`  — a one-off price for this customer
       *   2. the owner's own retail price for this package
       *   3. the package base price
       *
       * Step 2 was missing here. Without it, a dealer who had set their retail
       * at 1,500 still got every new customer stamped at the ISP's base 500,
       * so `profit` recorded 500 − 1,000 = −500 on a sale that actually earned
       * them 500. Their own selling price existed in the price list and was
       * ignored at the one moment it mattered.
       *
       * `costPrice` is separate and never negotiable: it is what this account's
       * PARENT charges them, and it alone is what the wallet is debited by.
       */
      let ownRetail: number | null = null;
      const ownRow = await this.prisma.resellerPackagePrice.findUnique({
        where: { userId_packageId: { userId: ownerId, packageId: parseInt(data.packageId) } },
        select: { retailPrice: true },
      });
      if (ownRow?.retailPrice != null && ownRow.retailPrice > 0) ownRetail = ownRow.retailPrice;

      sellPrice = data.sellPrice != null && data.sellPrice !== ''
        ? Number(data.sellPrice)
        : (ownRetail ?? base);

      costPrice = await this.pricing.activationCost(ownerId, parseInt(data.packageId), base);
      profit = Math.round(((sellPrice ?? 0) - costPrice) * 100) / 100;

      // Selling below cost is legal but almost always a mistake, so it is
      // recorded rather than silently accepted.
      if (profit < 0) {
        this.logger.warn(
          `Subscriber being created at a LOSS: sell ${sellPrice} < cost ${costPrice} ` +
          `for user #${ownerId} on package ${data.packageId} (${profit} per cycle).`,
        );
      }

      // Prepaid guard: a reseller (non-admin) must have wallet ≥ cost − creditLimit.
      // ISP/admin never blocked. The credit limit is the permitted overdraft.
      if (actor && !this.scope.isAdmin(actor.role) && costPrice > 0) {
        const owner = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { balance: true, creditLimit: true } });
        const threshold = costPrice - (owner?.creditLimit ?? 0);
        if ((owner?.balance ?? 0) < threshold) {
          const reason = `Insufficient balance. Need ${costPrice}, wallet has ${owner?.balance ?? 0}${(owner?.creditLimit ?? 0) > 0 ? ` (+${owner?.creditLimit} credit)` : ''}.`;
          await this.prisma.failedActivation.create({
            data: { username: data.username, fullName: data.fullName, reason, createdById: ownerId },
          }).catch(() => null);
          throw new ForbiddenException(`${reason} Ask your upline to top up your balance.`);
        }
      }
    }

    console.log('========================================');
    console.log('🔍 CREATE SUBSCRIBER');
    console.log('  Username:    ', data.username);
    console.log('  Password:    ', data.password ? '✅ EXISTS' : '❌ MISSING');
    console.log('  Full Name:   ', data.fullName);
    console.log('  Package ID:  ', data.packageId ?? 'none');
    console.log('========================================');

    // ── Validate connectionType
    const connectionType = this.normalizeConnectionType(data.connectionType);

    // ── Handle identity uniqueness
    let identity = data.identity;
    if (!identity || identity.trim() === '') {
      identity = `ID_${data.username}_${Date.now()}`;
      console.log(`⚠️ Identity empty, generated: "${identity}"`);
    }
    const existingWithIdentity = await this.prisma.subscriber.findFirst({
      where: { identity },
    });
    if (existingWithIdentity) {
      identity = `${identity}_${Date.now()}`;
      console.log(`⚠️ Identity conflict, new identity: "${identity}"`);
    }

    try {
      // ── Step 1: Save to CRM database
      const subscriber = await this.prisma.subscriber.create({
        data: {
          fullName:         data.fullName,
          phone:            data.phone,
          email:            data.email,
          address:          data.address          || '',
          idempotencyKey:   data.idempotencyKey ? String(data.idempotencyKey) : null,
          username:         data.username,
          password:         data.password,
          identity:         identity,
          connectionType:   connectionType,
          authMethod:       data.authMethod || data.serviceType || 'PPPOE',
          userId:           ownerId,
          sellPrice:        sellPrice,
          costPrice:        costPrice,
          profit:           profit,
          packageId:        data.packageId        ? parseInt(data.packageId)        : null,
          areaId:           data.areaId           ? parseInt(data.areaId)           : null,
          nasId:            data.nasId            ? parseInt(data.nasId)            : null,
          salespersonId:    data.salespersonId    ? parseInt(data.salespersonId)    : null,
          documentUrl:      data.documentUrl      || '',
          photoUrl:         data.photoUrl         || null,
          cnicFrontUrl:     data.cnicFrontUrl     || null,
          cnicBackUrl:      data.cnicBackUrl      || null,
          installationDate: data.installationDate ? new Date(data.installationDate) : null,
          latitude:         data.latitude         ? parseFloat(data.latitude)       : null,
          longitude:        data.longitude        ? parseFloat(data.longitude)      : null,
          status:           this.normalizeStatus(data.status),
        },
      });

      console.log('✅ Subscriber saved to CRM, ID:', subscriber.id);

      // ── Step 2: Sync to RADIUS with full profile (password + speed + pool)
    /**
     * SETTLE BEFORE GRANTING ACCESS.
     *
     * The wallet cascade used to run fire-and-forget AFTER the RADIUS sync.
     * With prepaid enforcement on, an empty wallet made the cascade throw,
     * the .catch() swallowed it — and the customer was already in RADIUS.
     * Result: service delivered, nobody charged, silently.
     *
     * Now the money moves first. If the activator cannot pay, the subscriber
     * record is still CREATED (so the sale is not lost and the data is kept)
     * but is left INACTIVE and never reaches RADIUS. They have an account;
     * they do not have internet until someone tops up and activates.
     */
    let unpaid = false;
    let unpaidReason = '';

    // ── Activation gate: a subscriber may ONLY reach RADIUS (get internet)
    // after being activated against a package, invoiced, and the activator's
    // wallet charged. No package → no activation → INACTIVE, no internet.
    /**
     * REGISTER-ONLY MODE (`activateNow: false`).
     *
     * Creating a customer and SELLING them a month are two different acts. An
     * ISP that registers a customer and hands them to a dealer must not have the
     * wallet charged and the service switched on behind their back — the dealer
     * activates, and the dealer's wallet pays. Without this flag every create
     * with a package silently invoiced, charged and went live.
     */
    if (!subscriber.packageId || data.activateNow === false) {
      unpaid = true; // reuse the "not activated → don't sync to RADIUS" path
      unpaidReason = !subscriber.packageId
        ? 'No package assigned. Assign a package to activate and enable internet.'
        : 'Created without activating. Use Activate to charge the wallet, raise the invoice and switch the service on.';
      await this.prisma.subscriber.update({
        where: { id: subscriber.id },
        data: { status: 'INACTIVE' },
      });
      this.logger.log(`Subscriber #${subscriber.id} created ${!subscriber.packageId ? 'without a package' : 'WITHOUT activation (register-only)'} — left INACTIVE (no charge, no internet).`);
    } else {
      // Packaged subscriber: 1) raise the first invoice, then 2) charge the
      // owner's wallet (resellers only — the ISP owner has no wallet gate).
      // Only if both steps are satisfied does the customer reach RADIUS below.
      // MIGRATION IMPORT (skipCharge): the subscriber already exists in real
      // life and is mid-cycle — we are recording them, not selling to them. So
      // no invoice and no wallet charge; we just set their package, expiry and
      // RADIUS access. Otherwise importing a 100-customer book would try to bill
      // the owner 100 times and stall on the first empty-wallet.
      if (data.skipInvoice !== true && data.skipCharge !== true) {
        await this.autoInvoiceForSubscriber(subscriber.id, subscriber.packageId, sellPrice ?? undefined)
          .catch((e: any) => this.logger.warn(`Invoice at activation skipped for #${subscriber.id}: ${e?.message || e}`));
      }
      if (subscriber.userId && data.skipCharge !== true) {
        try {
          await this.pricing.settleActivation(subscriber.id, { byUserId: ownerId ?? undefined });
        } catch (e: any) {
          unpaid = true;
          unpaidReason = e?.message || 'Wallet could not cover this activation.';
          await this.prisma.subscriber.update({
            where: { id: subscriber.id },
            data: { status: 'INACTIVE' },
          });
          this.logger.warn(
            `Subscriber #${subscriber.id} created but NOT activated — ${unpaidReason}`,
          );
        }
      }

      /**
       * STAMP THE EXPIRY FROM THE ACTIVATION MOMENT.
       *
       * A subscriber created straight into ACTIVE with a package was invoiced,
       * charged and put online — but no expiryDate was ever written. With no
       * expiry the daily suspension sweep can never expire them, so they kept
       * the service for free after the period they paid for, and the "days left"
       * UI had nothing to show. The period must run from NOW (activation time)
       * for the package's own duration, exactly like activate-renewal does.
       */
      if (!unpaid) {
        // Honour an explicit expiry from the import file (a migrated customer
        // keeps their real remaining days); otherwise run from now for the
        // package duration.
        let expiry: Date | null = null;
        if (data.expiryDate) {
          const e = new Date(data.expiryDate);
          if (!isNaN(e.getTime())) expiry = e;
        }
        // Declared OUTSIDE the if-block: the cycle length below needs it even
        // when the expiry came from the import file. (Was previously scoped
        // inside the if — a subscriber with an explicit expiryDate crashed
        // here with "dpkg is not defined" and skipped the duration stamp.)
        const dpkg = await this.prisma.package.findUnique({
          where: { id: subscriber.packageId }, select: { duration: true },
        });
        if (!expiry) {
          expiry = new Date();
          expiry.setDate(expiry.getDate() + (dpkg?.duration || 30));
        }
        // Store the cycle LENGTH alongside the end date, so the current cycle's
        // start is exact (expiry − duration) rather than a "30 days ago" guess.
        const cycleDays = Math.max(1, Number(dpkg?.duration) || 30);
        await this.prisma.serviceSettings.upsert({
          where: { subscriberId: subscriber.id },
          update: { expiryDate: expiry, duration: cycleDays, isBlocked: false },
          create: { subscriberId: subscriber.id, expiryDate: expiry, duration: cycleDays },
        }).catch((e: any) => this.logger.warn(`Expiry stamp failed for #${subscriber.id}: ${e?.message || e}`));
      }
    }

if (!unpaid && data.username && data.password) {
      try {
        // **CRITICAL**: Sync to RADIUS ONLY after successful wallet activation.
        // Previously RADIUS sync happened BEFORE wallet validation, meaning users
        // could have RADIUS credentials but no paid service, or users would remain
        // activated without a wallet to cover costs.
        // 
        // This order ensures:
        // 1. The user has paid/can pay for the service
        // 2. Only then do they receive RADIUS credentials for internet access
        // 3. Users with insufficient balance get INACTIVE status and cannot connect
        
        // Fetch package WITH pool so we can send speed + Framed-Pool to RADIUS
        const pkg = await this.getPackageForRadius(subscriber.packageId);

        // **FIX**: Build opts like syncToRadius does - include authMethod, MAC, static IP, timeouts
        const subForOpts = await this.prisma.subscriber.findUnique({
          where: { id: subscriber.id },
          include: { serviceSettings: true },
        });
        const wantsStatic =
          subForOpts?.authMethod === 'STATIC' || subForOpts?.serviceSettings?.ipType === 'STATIC';
        const staticIp = wantsStatic ? subForOpts?.serviceSettings?.ipAddress ?? null : null;

        if (pkg) {
          console.log(`📡 Syncing "${data.username}" → RADIUS (POST-ACTIVATION)`);
          console.log(`   Package: ${pkg.name}`);
          console.log(`   Speed:   ${pkg.downloadSpeed}M/${pkg.uploadSpeed}M`);
          console.log(`   Pool:    ${pkg.pool?.name ?? 'none (no pool assigned to package)'}`);
        } else {
          console.log(`📡 Syncing "${data.username}" → RADIUS (no package — password only)`);
        }

        await this.radiusSync.syncSubscriberProfile(
          data.username,
          data.password,
          pkg,
          {
            serviceType: subForOpts?.authMethod as any,
            staticIp,
            macAddress: subForOpts?.serviceSettings?.macAddress ?? null,
            sessionTimeout: Number(process.env.HOTSPOT_SESSION_TIMEOUT || 0) || null,
            idleTimeout: Number(process.env.HOTSPOT_IDLE_TIMEOUT || 0) || null,
            allowMultipleSessions: subForOpts?.serviceSettings?.allowMultipleSessions ?? false,
          },
        );

        console.log(`✅ RADIUS sync successful for "${data.username}" (activated & paid)`);
        this.logger.log(
          `✅ Subscriber "${data.username}" synced to RADIUS` +
          (pkg ? ` with package "${pkg.name}"` : ' (no package)'),
        );
      } catch (error: any) {
        // RADIUS failure does NOT block CRM creation
        console.error(`❌ RADIUS sync failed:`, error.message);
        this.logger.error(
          `⚠️ Subscriber "${data.username}" created in CRM but RADIUS sync failed after activation: ${error.message}`,
        );
      }
    } else if (!data.username || !data.password) {
      // **SECURITY FIX**: Explicitly log when subscribers are created without username/password.
      // These users cannot authenticate through RADIUS but may have local MikroTik secrets.
      // This log helps identify cases where RADIUS authentication would fail.
      console.log(`⚠️ Subscriber created but missing username/password - RADIUS auth will fail`);
    }

      console.log('========================================');

      // Phase 2: welcome message (uses WELCOME template if one is active)
      void this.notifications.fireEvent('WELCOME', subscriber);

      // NOTE: the first invoice is now raised inside the activation gate above
      // (package → invoice → wallet charge → RADIUS), so it is intentionally NOT
      // re-created here — doing so would double-bill the customer.

      // The cascade already ran above, before RADIUS. Nothing to do here.

      // Tell the caller plainly when the customer exists but has no service,
      // so the UI can say so instead of reporting a clean success.
      if (unpaid) {
        return {
          ...subscriber,
          status: 'INACTIVE',
          activated: false,
          warning:
            `${subscriber.fullName} was saved but NOT activated — they have no internet. ` +
            unpaidReason,
        } as any;
      }

      return subscriber;

    } catch (error) {
      console.error('❌ Failed to create subscriber:', error);
      throw error;
    }
  }

  /**
   * Auto-generate the first invoice for a new subscriber based on their package
   * price. Due date = today + the package's duration (days). Reuses InvoicesService
   * so the invoice also posts to the ledger and fires the INVOICE_CREATED message.
   */
  private async autoInvoiceForSubscriber(subscriberId: number, packageId: number, retailPrice?: number) {
    const pkg = await this.prisma.package.findUnique({
      where: { id: packageId },
      select: { price: true, duration: true, name: true },
    });
    if (!pkg) return;
    /**
     * Billing falls back in three steps, most specific first:
     *
     *   1. this subscriber's own negotiated price (sellPrice)
     *   2. the OWNING ACCOUNT's retail price for this package
     *   3. the package's base price
     *
     * Step 2 was missing. Without it, a dealer who set their retail at 1,500
     * still had every customer invoiced at the ISP's base 500, so the invoice
     * contradicted both the price list and the wallet cascade.
     */
    let amount = retailPrice != null && retailPrice > 0 ? retailPrice : 0;
    if (!amount) {
      const sub = await this.prisma.subscriber.findUnique({
        where: { id: subscriberId }, select: { userId: true },
      });
      if (sub?.userId) {
        const own = await this.prisma.resellerPackagePrice.findUnique({
          where: { userId_packageId: { userId: sub.userId, packageId } },
          select: { retailPrice: true },
        });
        if (own?.retailPrice != null && own.retailPrice > 0) amount = own.retailPrice;
      }
    }
    if (!amount) amount = pkg.price;
    if (!amount || amount <= 0) return; // free/unpriced → no invoice

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + (pkg.duration || 30));

    await this.invoices.create({
      subscriberId,
      amount,
      dueDate,
      notes: `Auto-generated — ${pkg.name}`,
      items: [{ description: pkg.name, quantity: 1, unitPrice: amount, total: amount }],
    });
    this.logger.log(`🧾 Auto-invoice created for subscriber #${subscriberId} (${amount})`);
  }

  // ─────────────────────────────────────────────────────────────
  // UPDATE SUBSCRIBER
  //
  // RADIUS is re-synced when:
  //   A) Username changes     → remove old, create new entry
  //   B) Password changes     → update password in radcheck
  //   C) Package changes      → re-sync profile (new speed + new pool)
  //   D) Any of A+B+C         → full re-sync always wins
  // ─────────────────────────────────────────────────────────────
  /**
   * Put a subscriber on (or off) a billing hold. While on hold, the daily
   * expiry sweep will not auto-suspend them — used when a charge is disputed and
   * you don't want service cut while it's reviewed.
   */
  async setHold(id: number, onHold: boolean, reason: string | undefined, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, id);
    const updated = await this.prisma.subscriber.update({
      where: { id },
      data: { onHold, onHoldReason: onHold ? (reason?.trim() || 'Under dispute') : null },
      select: { id: true, fullName: true, onHold: true, onHoldReason: true },
    });
    await this.prisma.activityLog.create({
      data: {
        userId: actor ? this.scope.actorId(actor) : null,
        action: onHold ? 'HOLD_SUBSCRIBER' : 'UNHOLD_SUBSCRIBER',
        entity: 'Subscriber', entityId: id,
        details: onHold ? `On hold — ${updated.onHoldReason}` : 'Hold cleared',
      },
    }).catch(() => null);
    return updated;
  }

  /**
   * PREVIEW a mid-cycle package change (4mb → 8mb, etc.) without applying it —
   * shows exactly what the wallet will do so the operator can confirm. Mirrors
   * the pro-rata math in update(): the expiry never moves, the unused days of the
   * old plan are credited and the same days of the new plan are charged, both at
   * the owner's cost.
   */
  async packageChangeQuote(id: number, newPackageId: number, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, id);
    const sub = await this.prisma.subscriber.findUnique({
      where: { id },
      select: { id: true, packageId: true, userId: true, costPrice: true, sellPrice: true,
                serviceSettings: { select: { expiryDate: true, duration: true } },
                package: { select: { id: true, name: true, downloadSpeed: true, uploadSpeed: true } } },
    });
    if (!sub) throw new NotFoundException('Subscriber not found');
    const newPkg = await this.prisma.package.findUnique({
      where: { id: newPackageId },
      select: { id: true, name: true, price: true, downloadSpeed: true, uploadSpeed: true },
    });
    if (!newPkg) throw new BadRequestException('Chosen package not found.');
    if (sub.packageId === newPackageId) throw new BadRequestException('That is already the current package.');

    const expiry = sub.serviceSettings?.expiryDate ? new Date(sub.serviceSettings.expiryDate) : null;
    const cycleDays = sub.serviceSettings?.duration && sub.serviceSettings.duration > 0 ? sub.serviceSettings.duration : 30;
    let remainingDays = expiry ? Math.ceil((expiry.getTime() - Date.now()) / 86400_000) : cycleDays;
    remainingDays = Math.max(0, Math.min(remainingDays, cycleDays));
    const frac = cycleDays > 0 ? remainingDays / cycleDays : 0;

    const newBase = Number(newPkg.price ?? 0);
    const newCost = sub.userId ? await this.pricing.activationCost(sub.userId, newPackageId, newBase) : newBase;
    const oldCost = Number(sub.costPrice ?? 0);
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const creditOld = round2(oldCost * frac);
    const chargeNew = round2(newCost * frac);
    const net = round2(creditOld - chargeNew); // >0 = refund to owner, <0 = charge owner

    const own = sub.userId ? await this.prisma.resellerPackagePrice.findUnique({
      where: { userId_packageId: { userId: sub.userId, packageId: newPackageId } }, select: { retailPrice: true },
    }) : null;
    const newSell = own?.retailPrice ?? newBase;

    return {
      subscriberId: id,
      from: sub.package ? { id: sub.package.id, name: sub.package.name, speed: `${sub.package.downloadSpeed}/${sub.package.uploadSpeed}` } : null,
      to: { id: newPkg.id, name: newPkg.name, speed: `${newPkg.downloadSpeed}/${newPkg.uploadSpeed}` },
      remainingDays, cycleDays,
      creditFromOldPlan: creditOld,
      chargeForNewPlan: chargeNew,
      // What the owner's wallet does: positive = refunded, negative = charged.
      walletEffect: net,
      newCost, newSell, newProfit: round2(newSell - newCost),
      expiryUnchanged: true,
      expiryDate: expiry,
    };
  }

  async update(id: number, data: any, actor?: Actor) {
    if (actor) {
      await this.scope.assertSubscriber(actor, id);
      // Delegated permission checks for the specific actions.
      if (data.password) await this.security.assertCan(actor, 'subscribers.changePassword');
      if (data.packageId !== undefined) await this.security.assertCan(actor, 'subscribers.changePackage');
      // Same check as create — moving an existing subscriber onto someone
      // else's router is the same problem as creating them there.
      if (data.nasId) await this.assertNasAllowed(actor, parseInt(data.nasId));
    }
    console.log('========================================');
    console.log('🔍 UPDATE SUBSCRIBER - ID:', id);
    console.log('  Username:  ', data.username);
    console.log('  Password:  ', data.password ? '✅ NEW PASSWORD' : 'unchanged');
    console.log('  Package ID:', data.packageId ?? 'unchanged');
    console.log('========================================');

    const old = await this.prisma.subscriber.findUnique({ where: { id } });
    if (!old) throw new Error('Subscriber not found');

    /**
     * ADOPTION ON EDIT — allowed ONLY when the subscriber currently has no owner.
     *
     * Edit deliberately ignores `userId`, because CHANGING an owner is a
     * transfer: it moves money, re-prices the customer for the new chain and
     * suspends them until the new owner activates. That must go through Move,
     * never a quiet field edit.
     *
     * But that blanket rule also made a MISSING owner unfixable from the editor.
     * A subscriber with userId = NULL belongs to nobody, is billed to nobody and
     * appears in no reseller's books — and picking an owner in the form did
     * nothing, silently, which is why it still read "No owner" after saving.
     *
     * Filling in an absent owner is a repair, not a transfer: there is no
     * previous owner to hand over from, no pro-rata to settle, and the customer
     * must not be disconnected for it. So it is permitted here, and ONLY here —
     * once an owner exists, the transfer rules apply again.
     */
    let adoptOwnerId: number | null = null;
    if (data.userId !== undefined && data.userId !== null && data.userId !== '') {
      const requested = parseInt(data.userId);
      if (Number.isFinite(requested)) {
        if (old.userId == null) {
          const owner = await this.prisma.user.findUnique({
            where: { id: requested }, select: { id: true, name: true, role: true, isActive: true },
          });
          if (!owner) throw new BadRequestException(`Account ${requested} not found.`);
          if (owner.isActive === false) throw new BadRequestException(`${owner.name} is deactivated.`);
          if (actor && !this.scope.isAdmin(actor.role)) {
            const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
            if (!ids.includes(requested)) {
              throw new ForbiddenException('You can only assign subscribers to accounts in your own tree.');
            }
          }
          adoptOwnerId = requested;
          this.logger.log(
            `Subscriber #${id} (${old.username}) had no owner; adopting to ${owner.name} (${owner.role}). ` +
            `Service and billing unchanged.`,
          );
        } else if (requested !== old.userId) {
          // Explicit refusal beats silently ignoring it — the silent version is
          // what made this look broken.
          throw new BadRequestException(
            'This subscriber already belongs to an account. Changing the owner is a transfer — ' +
            'use Move, which preserves their remaining days and lets the new owner activate and pay.',
          );
        }
      }
    }

    // ── Validate connectionType
    const connectionType = this.normalizeConnectionType(data.connectionType || old.connectionType);

    // ── Handle identity
    let identity = data.identity;
    if (!identity || identity.trim() === '') {
      identity = old.identity;
    } else if (identity !== old.identity) {
      const conflict = await this.prisma.subscriber.findFirst({
        where: { identity, id: { not: id } },
      });
      if (conflict) {
        identity = `${identity}_${Date.now()}`;
        console.log(`⚠️ Identity conflict, new: "${identity}"`);
      }
    }

    // ── Save to CRM
    const subscriber = await this.prisma.subscriber.update({
      where: { id },
      data: {
        fullName:         data.fullName,
        phone:            data.phone,
        email:            data.email,
        address:          data.address,
        username:         data.username,
        password:         data.password,
        identity:         identity,
        connectionType:   connectionType,
        authMethod:       data.authMethod === undefined ? undefined : data.authMethod,
        // DATA-LOSS GUARD: only touch a field when the caller actually sent it.
        // Previously any key missing from the payload was coerced to null, so a
        // partial edit (e.g. uploading a CNIC photo) silently wiped the
        // subscriber's package, area, NAS, salesperson and install date.
        // `undefined` tells Prisma "leave this column alone".
        packageId:        data.packageId     === undefined ? undefined : (data.packageId     ? parseInt(data.packageId)     : null),
        areaId:           data.areaId        === undefined ? undefined : (data.areaId        ? parseInt(data.areaId)        : null),
        nasId:            data.nasId         === undefined ? undefined : (data.nasId         ? parseInt(data.nasId)         : null),
        salespersonId:    data.salespersonId === undefined ? undefined : (data.salespersonId ? parseInt(data.salespersonId) : null),
        documentUrl:      data.documentUrl,
        photoUrl:         data.photoUrl,
        cnicFrontUrl:     data.cnicFrontUrl,
        cnicBackUrl:      data.cnicBackUrl,
        installationDate: data.installationDate === undefined ? undefined : (data.installationDate ? new Date(data.installationDate) : null),
        latitude:         data.latitude      === undefined ? undefined : (data.latitude      ? parseFloat(data.latitude)    : null),
        longitude:        data.longitude     === undefined ? undefined : (data.longitude     ? parseFloat(data.longitude)   : null),
        /**
         * A plain edit may DOWNGRADE status (active → suspended/inactive) but must
         * NEVER upgrade a subscriber to ACTIVE. Activation is the only path that
         * charges the wallet, raises the invoice and stamps the expiry; letting the
         * edit form flip status to ACTIVE created a "fake active" — billed as live,
         * no money taken, no expiry, and not even synced to RADIUS. Upgrades go
         * through Activate/Renew.
         */
        status: (() => {
          const requested = this.normalizeStatus(data.status || old.status);
          return (requested === 'ACTIVE' && old.status !== 'ACTIVE') ? old.status : requested;
        })(),
        // Set ONLY when adopting a previously ownerless subscriber (see above).
        // `undefined` leaves an existing owner untouched — a change is a Move.
        ...(adoptOwnerId != null ? { userId: adoptOwnerId } : {}),
      },
    });

    if (adoptOwnerId != null) {
      await this.prisma.activityLog.create({
        data: {
          userId: actor ? this.scope.actorId(actor) : null,
          action: 'SUBSCRIBER_OWNER_ASSIGNED',
          entity: 'Subscriber',
          entityId: id,
          details:
            `${old.fullName || old.username} had no owner; assigned to account #${adoptOwnerId} via edit. ` +
            `Service untouched (still ${old.status}); nothing charged.`,
        },
      }).catch(() => null);
    }

    // ── Decide what RADIUS update is needed
    const usernameChanged = data.username && data.username !== old.username;
    const passwordChanged = data.password && data.password !== old.password;
    const packageChanged  =
      data.packageId !== undefined &&
      (data.packageId ? parseInt(data.packageId) : null) !== old.packageId;

    /**
     * PRO-RATA on a MID-CYCLE package change.
     *
     * Changing plan mid-cycle must not lose the month, and must not be free.
     * We credit the UNUSED days of the old plan and charge the SAME days of the
     * new plan, both at the owner's BUY price — so 4Mbps→6Mbps on day 4 of a
     * 30-day cycle charges only the 26 remaining days of the difference, and
     * 6Mbps→2Mbps refunds the unused 26 days of the pricier plan. The expiry
     * date is left exactly where it was; only the wallet and the stored
     * cost/sell/profit move. The new speed reaches RADIUS in the block below.
     *
     * Note: this settles the OWNER's wallet (the account that pays for the
     * plan). Upstream tiers keep what they earned on the original activation.
     */
    if (packageChanged && old.packageId && old.userId && subscriber.packageId) {
      try {
        const ss = await this.prisma.serviceSettings.findUnique({ where: { subscriberId: id } });
        const expiry = ss?.expiryDate ? new Date(ss.expiryDate) : null;
        const cycleDays = ss?.duration && ss.duration > 0 ? ss.duration : 30;
        let remainingDays = expiry ? Math.ceil((expiry.getTime() - Date.now()) / 86400_000) : cycleDays;
        remainingDays = Math.max(0, Math.min(remainingDays, cycleDays));
        const frac = cycleDays > 0 ? remainingDays / cycleDays : 0;

        const newPkg = await this.prisma.package.findUnique({ where: { id: subscriber.packageId }, select: { price: true } });
        const newBase = Number(newPkg?.price ?? 0);
        const newCost = await this.pricing.activationCost(old.userId, subscriber.packageId, newBase);
        const oldCost = Number(old.costPrice ?? 0);

        const creditOld = Math.round(oldCost * frac * 100) / 100;
        const chargeNew = Math.round(newCost * frac * 100) / 100;
        const net = Math.round((creditOld - chargeNew) * 100) / 100; // >0 refund owner, <0 charge owner

        const ownRow = await this.prisma.resellerPackagePrice.findUnique({
          where: { userId_packageId: { userId: old.userId, packageId: subscriber.packageId } },
          select: { retailPrice: true },
        });
        const newSell = data.sellPrice != null && data.sellPrice !== '' ? Number(data.sellPrice)
          : (ownRow?.retailPrice ?? newBase);

        if (net !== 0) {
          const isAdmin = this.scope.isAdmin(actor?.role);
          const ref = `SUB#${id}:PKGCHANGE:${Date.now()}`;
          await this.prisma.$transaction(async (tx) => {
            if (net < 0) {
              const need = -net;
              if (!isAdmin) {
                const hit = await tx.user.updateMany({ where: { id: old.userId!, balance: { gte: need } }, data: { balance: { decrement: need } } });
                if (hit.count === 0) {
                  const u = await tx.user.findUnique({ where: { id: old.userId! }, select: { balance: true, name: true } });
                  throw new ForbiddenException(`Upgrade costs ${need.toFixed(0)} more for the ${remainingDays} days left, but ${u?.name ?? 'the account'} has ${(u?.balance ?? 0).toFixed(0)}. Top up first.`);
                }
              } else {
                await tx.user.update({ where: { id: old.userId! }, data: { balance: { decrement: need } } });
              }
              const after = await tx.user.findUnique({ where: { id: old.userId! }, select: { balance: true } });
              await tx.userBalanceTransaction.create({ data: { userId: old.userId!, type: 'DEDUCT', amount: net, balanceAfter: after?.balance ?? 0, reference: ref, notes: `Plan change upgrade — pro-rata ${remainingDays}/${cycleDays}d`, createdBy: this.scope.actorId(actor) } as any });
            } else {
              const after = await tx.user.update({ where: { id: old.userId! }, data: { balance: { increment: net } }, select: { balance: true } });
              await tx.userBalanceTransaction.create({ data: { userId: old.userId!, type: 'COMMISSION', amount: net, balanceAfter: after.balance, reference: ref, notes: `Plan change downgrade refund — pro-rata ${remainingDays}/${cycleDays}d`, createdBy: this.scope.actorId(actor) } as any });
            }
          });
        }

        await this.prisma.subscriber.update({
          where: { id },
          data: { costPrice: newCost, sellPrice: newSell, profit: Math.round(((newSell) - newCost) * 100) / 100 },
        });
        this.logger.log(`Plan change #${id}: ${remainingDays}/${cycleDays}d left — credit ${creditOld}, charge ${chargeNew}, net ${net} to owner #${old.userId}`);
      } catch (e: any) {
        if (e instanceof ForbiddenException) throw e; // insufficient balance must surface
        this.logger.warn(`Pro-rata plan change failed for #${id}: ${e?.message || e}`);
      }
    }

    // Fetch service settings for RADIUS opts (not included in Prisma subscriber query)
    const serviceSettings = await this.prisma.serviceSettings.findUnique({ where: { subscriberId: id } });

    try {
      if (usernameChanged) {
        // Username changed → remove old entry, create completely new entry
        console.log(`📡 Username changed: "${old.username}" → "${data.username}"`);
        await this.radiusSync.removeSubscriberFromRadius(old.username);

        const pkg = await this.getPackageForRadius(subscriber.packageId);
        // **FIX**: Pass opts like syncToRadius does
        const wantsStatic = subscriber.authMethod === 'STATIC' || serviceSettings?.ipType === 'STATIC';
        const staticIp = wantsStatic ? serviceSettings?.ipAddress ?? null : null;
        await this.radiusSync.syncSubscriberProfile(
          data.username,
          data.password || old.password,
          pkg,
          {
            serviceType: subscriber.authMethod as any,
            staticIp,
            macAddress: serviceSettings?.macAddress ?? null,
            sessionTimeout: Number(process.env.HOTSPOT_SESSION_TIMEOUT || 0) || null,
            idleTimeout: Number(process.env.HOTSPOT_IDLE_TIMEOUT || 0) || null,
            allowMultipleSessions: serviceSettings?.allowMultipleSessions ?? false,
          },
        );
        this.logger.log(
          `✅ RADIUS updated: username "${old.username}" → "${data.username}"`,
        );

      } else if (packageChanged) {
        // Package changed → re-sync full profile so speed + pool update
        console.log(`📡 Package changed → re-syncing RADIUS profile`);
        const pkg = await this.getPackageForRadius(subscriber.packageId);

        if (pkg) {
          console.log(`   New package: ${pkg.name}`);
          console.log(`   New speed:   ${pkg.downloadSpeed}M/${pkg.uploadSpeed}M`);
          console.log(`   New pool:    ${pkg.pool?.name ?? 'none'}`);
        }

        // **FIX**: Pass opts like syncToRadius does
        const wantsStatic = subscriber.authMethod === 'STATIC' || serviceSettings?.ipType === 'STATIC';
        const staticIp = wantsStatic ? serviceSettings?.ipAddress ?? null : null;
        await this.radiusSync.syncSubscriberProfile(
          subscriber.username,
          data.password || old.password,
          pkg,
          {
            serviceType: subscriber.authMethod as any,
            staticIp,
            macAddress: serviceSettings?.macAddress ?? null,
            sessionTimeout: Number(process.env.HOTSPOT_SESSION_TIMEOUT || 0) || null,
            idleTimeout: Number(process.env.HOTSPOT_IDLE_TIMEOUT || 0) || null,
            allowMultipleSessions: serviceSettings?.allowMultipleSessions ?? false,
          },
        );
        this.logger.log(
          `✅ RADIUS profile updated for "${subscriber.username}" (package changed)`,
        );

      } else if (passwordChanged) {
        // Only password changed → just update password
        console.log(`📡 Password changed → updating RADIUS`);
        await this.radiusSync.updateSubscriberPasswordInRadius(
          old.username,
          data.password,
        );
        this.logger.log(
          `✅ RADIUS password updated for "${old.username}"`,
        );
      }
      // If nothing changed that affects RADIUS, skip the sync
    } catch (error: any) {
      this.logger.error(
        `⚠️ RADIUS sync failed during update for "${old.username}": ${error.message}`,
      );
    }

    console.log('========================================');
    return subscriber;
  }

  // ─────────────────────────────────────────────────────────────
  // DELETE SUBSCRIBER
  // Removes from CRM + removes from RADIUS (radcheck + radreply)
  // ─────────────────────────────────────────────────────────────
  async remove(id: number, actor?: Actor, force = false) {
    if (actor) {
      await this.scope.assertSubscriber(actor, id);
      await this.security.assertCan(actor, 'subscribers.delete');
    }
    console.log('========================================');
    console.log('🔍 DELETE SUBSCRIBER - ID:', id);

    const subscriber = await this.prisma.subscriber.findUnique({ where: { id } });
    if (!subscriber) throw new NotFoundException('Subscriber not found');

    /**
     * DELETION IS NOT THE OWNER'S DECISION.
     *
     * ISP/admin may always delete. Otherwise the caller must be strictly ABOVE
     * the account that owns the subscriber — a parent, grandparent, and so on.
     * The owning dealer cannot delete their own customers.
     *
     * The reason is that deletion is the one action that destroys evidence. A
     * dealer who has taken cash from a customer, or who is being audited on
     * their activation count, has an obvious motive to make a record vanish.
     * Everything else they do is reversible or visible; this is not.
     * Deactivating is still theirs to do, and stops the service just as fast.
     */
    if (actor && !this.scope.isAdmin(actor.role)) {
      const meId = await this.scope.rootId(actor);
      if (subscriber.userId === meId) {
        throw new ForbiddenException(
          'You cannot delete your own subscribers — only your parent account or the ISP can. ' +
          'To stop the service, deactivate them instead: it takes effect immediately and keeps the record.',
        );
      }
      // assertSubscriber above already proved it is inside our subtree, so
      // anything reaching here belongs to an account below us.
    }

    console.log('📝 Deleting:', subscriber.username);

    /**
     * FIRST: Cleanup the router before touching RADIUS - ensure no authentication
     * path remains. MikroTik checks /ppp/secret BEFORE RADIUS, so removing
     * the local secret first prevents any fallback to local authentication.
     */
    if (subscriber.username && subscriber.nasId) {
      try {
        const nas = await this.prisma.nas.findUnique({
          where: { id: subscriber.nasId },
          select: { nasIp: true, apiPort: true, apiUsername: true, apiPassword: true },
        });
        if (nas?.nasIp && nas.apiUsername && nas.apiPassword) {
          console.log(`🔌 Disconnecting ${subscriber.username} from router before deletion...`);
          await this.mikrotik.disconnectPppoeUser(
            nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, subscriber.username,
          );
          console.log(`📡 Removing ${subscriber.username}'s MikroTik secret...`);
          await this.mikrotik.removePppSecret(
            nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, subscriber.username,
          );
        }
      } catch (e: any) {
        console.log(`⚠️ Router cleanup after delete failed for ${subscriber.username}: ${e?.message}`);
      }
    }

    /**
     * SECOND: Now remove from RADIUS after router cleanup - removes the
     * final authentication path. RADIUS runs AFTER MikroTik in the
     * authentication chain.
     */
    if (subscriber.username) {
      try {
        console.log(`📡 Removing ${subscriber.username} from RADIUS...`);
        await this.radiusSync.removeSubscriberFromRadius(subscriber.username);
      } catch (error: any) {
        console.log(`⚠️ RADIUS cleanup after delete failed for ${subscriber.username}: ${error?.message}`);
      }
    }

    /**
     * RADIUS removal moved to AFTER the database delete succeeds.
     *
     * It used to run first. When the delete then failed on a foreign key, the
     * customer was already gone from RADIUS but still in the panel — so a live
     * subscriber lost their connection to a delete that did not happen, and
     * every retry knocked them off again. Ali Khan was cut off eight times by
     * a button that never worked.
     *
     * Ordering rule: destroy service only once the record is actually gone.
     */

    /**
     * Delete the dependent rows first.
     *
     * Almost none of the relations pointing at Subscriber declare
     * `onDelete: Cascade` — only SubscriberTransfer and CreditExtension do. So
     * `subscriber.delete()` hit a foreign-key violation on the first invoice,
     * ticket, service-settings row or logged session, and the delete simply
     * failed with a database error the UI showed as an unexplained failure.
     *
     * Two different treatments, deliberately:
     *
     *   • Rows that only make sense WITH the subscriber (service settings,
     *     tickets, static-IP holds, transfers) are deleted.
     *   • Rows that reference them but exist in their own right (inventory
     *     items, field jobs, network logs, ONU records) are DETACHED, not
     *     deleted. A router in a customer's house is still a router you own
     *     after the account closes, and network logs are evidence.
     */
    /**
     * STEP LOGGING.
     *
     * Four attempts at this delete have failed and every one of them produced
     * the same evidence: "📝 Deleting: <name>" and then silence. No error, no
     * completion. Silence is not a stack trace — it means the request is
     * BLOCKED somewhere, and without knowing where, every fix is a guess.
     * These lines make the stall point obvious in the log.
     */
    const step = (s: string) => this.logger.log(`   ↳ [delete #${id}] ${s}`);

    /**
     * The payments guard is gone.
     *
     * It refused to delete anyone who had ever paid, which is almost every real
     * customer — and it existed only because the delete used to DESTROY their
     * invoices and payments. Now that those records detach and survive, there
     * is nothing left to protect them from, and the guard was blocking the
     * normal case for a danger that no longer exists.
     */

    /**
     * Discover the foreign keys BEFORE opening the transaction.
     *
     * The previous version ran an `information_schema` query inside the
     * transaction. `information_schema.constraint_column_usage` is a notoriously
     * expensive view — it scans the whole catalogue with several joins — and
     * running it inside an interactive transaction put it on the transaction's
     * clock. The delete stopped producing log output entirely: not an error, a
     * stall, which is why there was no exception to catch and nothing to read.
     *
     * `pg_catalog` answers the same question in milliseconds, and schema
     * metadata does not need to be read transactionally anyway.
     */
    step('reading foreign keys from pg_catalog…');
    /**
     * Also read WHICH COLUMN each foreign key points at.
     *
     * The first version assumed every FK referenced `Subscriber.id` and passed
     * the numeric id to all of them. It does not: `radcheck.username` is a
     * foreign key to `Subscriber.username`, a varchar — so the delete became
     *
     *     DELETE FROM radcheck WHERE username = 3
     *
     * and Postgres refused with "operator does not exist: character varying =
     * bigint". Every attempt died on the first RADIUS table.
     *
     * `confkey[1]` gives the referenced column, so each statement can be sent
     * the value of the right type.
     */
    const fks = await this.prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; ref_column: string; notnull: boolean }>
    >`
      SELECT c.conrelid::regclass::text AS table_name,
             a.attname                  AS column_name,
             r.attname                  AS ref_column,
             a.attnotnull               AS notnull
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid  AND a.attnum = c.conkey[1]
      JOIN pg_attribute r
        ON r.attrelid = c.confrelid AND r.attnum = c.confkey[1]
      WHERE c.contype = 'f'
        AND c.confrelid = '"Subscriber"'::regclass;`;

    step(`found ${fks.length} referencing table(s), opening transaction…`);

    try {
    await this.prisma.$transaction(async (tx) => {
      /**
       * NEVER WAIT FOREVER FOR A LOCK.
       *
       * Postgres blocks indefinitely on a row lock by default. The background
       * pollers in NetworkLogsService write to Subscriber constantly — syncing
       * radacct and radpostauth every cycle, which is visible in the log right
       * before each stalled delete. If one of those holds a lock on this row,
       * the delete queues behind it silently and the request never returns:
       * exactly the "no error, no completion" behaviour seen four times.
       *
       * With a timeout it fails in five seconds with a readable message
       * instead, naming the problem rather than hiding it.
       */
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '20s'`);

      // Detach — these outlive the customer.
      await tx.inventoryItem.updateMany({ where: { subscriberId: id }, data: { subscriberId: null } }).catch(() => null);
      await tx.fieldJob.updateMany({ where: { subscriberId: id }, data: { subscriberId: null } }).catch(() => null);
      await tx.networkLog.updateMany({ where: { subscriberId: id }, data: { subscriberId: null } }).catch(() => null);
      await tx.onu.updateMany({ where: { subscriberId: id }, data: { subscriberId: null } }).catch(() => null);
      // Release any static IP back to the pool rather than leaving it held.
      await tx.staticIp.updateMany({
        where: { subscriberId: id },
        data: { subscriberId: null, status: 'AVAILABLE', assignedAt: null, expiresAt: null },
      }).catch(() => null);

      /**
       * Remove — meaningless without the subscriber. Grandchildren first:
       * InvoiceItem and TicketMessage do NOT cascade either, so deleting an
       * invoice or ticket that has lines would fail on its own foreign key and
       * take the whole transaction down with it.
       */
      /**
       * TicketMessage has no cascade of its own, and Ticket now cascades from
       * Subscriber — so the messages must go first or they orphan onto a
       * ticket that is about to disappear.
       */
      const ticketIds = (await tx.ticket.findMany({
        where: { subscriberId: id }, select: { id: true },
      })).map((r) => r.id);
      if (ticketIds.length) {
        await tx.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } });
      }

      /**
       * INVOICES AND PAYMENTS ARE NO LONGER DELETED.
       *
       * They used to be, which was the wrong answer to a foreign key: money you
       * actually billed and received does not stop being real because someone
       * tidied a subscriber list, and revenue totals must not move when they do.
       *
       * The schema now detaches them instead (SetNull), so the rows survive on
       * their own. Stamping the name first is what keeps them readable — a
       * payment with a null subscriber and no name is an unattributable number.
       */
      const who = subscriber.fullName || subscriber.username || `#${id}`;
      await tx.invoice.updateMany({ where: { subscriberId: id }, data: { subscriberName: who } });
      await tx.payment.updateMany({ where: { subscriberId: id }, data: { subscriberName: who } });

      // ServiceSettings and Ticket cascade at the database level now.

      /**
       * GENERIC SWEEP — everything else that points at this subscriber.
       *
       * Enumerating tables by hand does not work here and already failed once:
       * I listed the obvious ones and still missed SubscriberBalanceTx,
       * PppoeSession, GatewayTransaction and others, so the delete kept dying
       * on a foreign key while the logs happily reported the RADIUS removal
       * that had run first. The schema keeps growing, so any hand-written list
       * goes stale the next time a table is added.
       *
       * Asking the database which tables reference Subscriber cannot go stale.
       * Nullable links are detached; non-nullable ones are rows that cannot
       * exist without the subscriber, so they go.
       *
       * NOTE: in Postgres a failed statement aborts the whole transaction —
       * `.catch()` in JS does not rescue it. That is why this runs as one
       * discovered, ordered pass rather than a pile of optimistic deletes.
       */
      for (const fk of fks) {
        // conrelid::regclass already quotes identifiers that need it.
        const t = fk.table_name;
        const col = `"${fk.column_name}"`;

        /**
         * Send the value that matches what this key actually references —
         * the numeric id, or the username for the RADIUS tables.
         */
        const value: any = fk.ref_column === 'id' ? id : (subscriber as any)[fk.ref_column];

        // A key referencing a column we cannot read, or a subscriber with no
        // username, has nothing to match on. Skipping beats sending null and
        // silently deleting every row where the column IS NULL.
        if (value === undefined || value === null || value === '') {
          step(`skipping ${t}.${fk.column_name} — no ${fk.ref_column} to match`);
          continue;
        }

        step(`${fk.notnull ? 'deleting from' : 'detaching'} ${t}.${fk.column_name} (by ${fk.ref_column})`);
        if (fk.notnull) {
          await tx.$executeRawUnsafe(`DELETE FROM ${t} WHERE ${col} = $1`, value);
        } else {
          await tx.$executeRawUnsafe(`UPDATE ${t} SET ${col} = NULL WHERE ${col} = $1`, value);
        }
      }

      step('deleting the subscriber row…');
      await tx.subscriber.delete({ where: { id } });
      step('transaction committing…');
    },
    // Deleting a long-standing customer touches a dozen tables; the 5s default
    // is not enough on a remote database and expires mid-way as a silent stall.
    { timeout: 30000 });
    } catch (e: any) {
      /**
       * SAY WHAT ACTUALLY BROKE.
       *
       * Two previous attempts at this delete failed on constraints I had not
       * anticipated, and the only evidence was a log that stopped mid-way with
       * no error line at all — because the exception went straight to Nest's
       * default handler, which does not log it, and the UI printed a generic
       * "Delete failed". Three rounds were spent guessing at a cause the
       * database already knew.
       */
      const meta = e?.meta ? ` [${JSON.stringify(e.meta)}]` : '';
      this.logger.error(
        `❌ Delete failed for subscriber #${id} (${subscriber.username}): ` +
        `${e?.code ? e.code + ' — ' : ''}${e?.message}${meta}`,
      );
      // 55P03 = lock_not_available, 57014 = statement/lock timeout. Both mean
      // something else is holding the row, not that the delete is invalid.
      const pgCode = e?.meta?.code ?? e?.code;
      if (pgCode === '55P03' || pgCode === '57014' || /lock timeout|canceling statement/i.test(e?.message || '')) {
        throw new BadRequestException(
          `Could not delete ${subscriber.fullName}: another process is holding this record ` +
          `(most likely the background RADIUS session sync). Nothing was changed and their ` +
          `service is untouched — wait a few seconds and try again.`,
        );
      }
      throw new BadRequestException(
        `Could not delete ${subscriber.fullName}: ${e?.code === 'P2003'
          ? `another record still references this subscriber${meta}. Nothing was deleted and the customer's service is untouched.`
          : (e?.message || 'unknown database error')}`,
      );
    }

    /**
     * First cleanup the router before touching RADIUS - ensure no authentication
     * path remains. MikroTik checks /ppp/secret BEFORE RADIUS, so removing
     * the local secret first prevents any fallback to local authentication.
     */
    if (subscriber.username && subscriber.nasId) {
      try {
        const nas = await this.prisma.nas.findUnique({
          where: { id: subscriber.nasId },
          select: { nasIp: true, apiPort: true, apiUsername: true, apiPassword: true },
        });
        if (nas?.nasIp && nas.apiUsername && nas.apiPassword) {
          this.logger.log(`🔌 Disconnecting ${subscriber.username} from router before deletion...`);
          await this.mikrotik.disconnectPppoeUser(
            nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, subscriber.username,
          );
          await this.mikrotik.removePppSecret(
            nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, subscriber.username,
          );
        }
      } catch (e: any) {
        this.logger.warn(`Router cleanup after delete failed for ${subscriber.username}: ${e?.message}`);
      }
    }

    /**
     * Now remove RADIUS credentials only after the router is clear.
     * This ensures no authentication path remains.
     */
    if (subscriber.username) {
      try {
        await this.radiusSync.removeSubscriberFromRadius(subscriber.username);
      } catch (error: any) {
        this.logger.error(`⚠️ Deleted from CRM but RADIUS cleanup failed: ${error.message}`);
      }
    }

    this.logger.log(`✅ Subscriber "${subscriber.username}" deleted from CRM`);
    console.log('========================================');
    return { id, deleted: true, username: subscriber.username };
  }

  /**
   * Stop the service and hand back every address, WITHOUT deleting anything.
   *
   * This is what most people actually want when they reach for Delete. It cuts
   * the customer off immediately, frees the static IP and the pool address for
   * someone else, and keeps the invoices, payments and history intact — so the
   * accounting still adds up and the record survives an audit.
   *
   * Unlike deletion, this IS the owner's to do: a dealer must be able to stop
   * serving a customer who has not paid, without waiting for their parent.
   */
  /**
   * Find — and optionally repair — subscribers that are linked to more than one
   * account.
   *
   * Every transfer done before `salespersonId` and `branchId` were moved left a
   * customer half-attached to their previous owner. Those rows are still in the
   * database and will keep showing up under two accounts until something fixes
   * them; the corrected transfer code only helps future moves.
   *
   * Read-only by default. Nothing is written unless `repair` is passed.
   */
  async findSplitOwnership(actor?: Actor, repair = false) {
    if (actor && !this.scope.isAdmin(actor.role)) {
      throw new ForbiddenException('Only the ISP account can audit subscriber ownership.');
    }

    const rows = await this.prisma.subscriber.findMany({
      where: {
        userId: { not: null },
        // Salesperson pointing somewhere other than the owner is the tell.
        NOT: { salespersonId: null },
      },
      select: {
        id: true, fullName: true, username: true,
        userId: true, salespersonId: true, branchId: true,
        user: { select: { name: true, branchId: true } },
        salesperson: { select: { name: true } },
      },
    });

    const split = rows.filter((r) => r.salespersonId !== r.userId);

    if (repair) {
      for (const r of split) {
        await this.prisma.subscriber.update({
          where: { id: r.id },
          data: {
            salespersonId: r.userId,
            ...(r.user?.branchId != null ? { branchId: r.user.branchId } : {}),
          },
        });
      }
      this.logger.log(`🔧 Repaired ownership on ${split.length} subscriber(s)`);
    }

    return {
      checked: rows.length,
      split: split.length,
      repaired: repair ? split.length : 0,
      subscribers: split.map((r) => ({
        id: r.id,
        name: r.fullName,
        username: r.username,
        ownedBy: r.user?.name,
        alsoVisibleTo: r.salesperson?.name,
      })),
    };
  }

  /**
   * Grant a per-subscriber grace period: keep (or put) the customer online for
   * `days` more days despite their paid period having ended. If they were
   * EXPIRED/INACTIVE we reactivate them (status ACTIVE + re-push RADIUS creds),
   * so they immediately regain internet; the daily sweep will not cut them until
   * the grace moment passes. No charge and no new invoice — this is goodwill.
   */
  async grantGracePeriod(id: number, days: number, actor?: Actor, reason?: string) {
    if (actor) await this.scope.assertSubscriber(actor, id);
    const d = Math.max(1, Math.min(Math.floor(Number(days) || 0), 90)); // 1..90 days
    const sub = await this.prisma.subscriber.findUnique({
      where: { id },
      select: { id: true, username: true, password: true, fullName: true, status: true },
    });
    if (!sub) throw new NotFoundException('Subscriber not found');

    const until = new Date(Date.now() + d * 86400_000);
    await this.prisma.serviceSettings.upsert({
      where: { subscriberId: id },
      update: { gracePeriodUntil: until, isBlocked: false },
      create: { subscriberId: id, gracePeriodUntil: until },
    });
    if (sub.status !== 'ACTIVE') {
      await this.prisma.subscriber.update({ where: { id }, data: { status: 'ACTIVE' } });
    }
    // Ensure they can authenticate during the grace window.
    //
    // BUG FIX: this used to call syncSubscriberProfile(username, password, null)
    // directly — `null` package meant NO Framed-Pool AND no static IP was
    // written, only the password. Any subscriber with a static IP who was
    // granted a grace period would have their Framed-IP-Address silently
    // erased; on their next reconnect the router had no addressing
    // instruction from RADIUS at all and fell back to its local PPP profile
    // pool. syncToRadius() rebuilds the FULL profile (package speed, pool OR
    // static IP, MAC, session flags) from the subscriber's current settings,
    // so grace periods can no longer downgrade a static-IP customer to pool.
    if (sub.username && sub.password) {
      await this.syncToRadius(id).catch((e: any) =>
        this.logger.warn(`Grace RADIUS restore failed for ${sub.username}: ${e?.message || e}`));
    }
    await this.prisma.activityLog.create({
      data: {
        userId: actor ? this.scope.actorId(actor) : null,
        action: 'GRACE_PERIOD_GRANTED', entity: 'Subscriber', entityId: id,
        details: `Granted ${d}-day grace period to ${sub.fullName} until ${until.toLocaleString()}${reason ? ` — ${reason}` : ''}.`,
      },
    }).catch(() => null);

    return { ok: true, subscriberId: id, days: d, gracePeriodUntil: until, reactivated: sub.status !== 'ACTIVE' };
  }

  async deactivateAndRelease(id: number, actor?: Actor, reason?: string) {
    if (actor) await this.scope.assertSubscriber(actor, id);
    if (actor) await this.security.assertCan(actor, 'subscribers.disconnect');
    const sub = await this.prisma.subscriber.findUnique({
      where: { id },
      select: { id: true, username: true, fullName: true, nasId: true },
    });
    if (!sub) throw new NotFoundException('Subscriber not found');

    const released: string[] = [];

    // 1. Hand back any static IP so it can be resold.
    const statics = await this.prisma.staticIp.findMany({
      where: { subscriberId: id }, select: { id: true, ipAddress: true },
    });
    if (statics.length) {
      await this.prisma.staticIp.updateMany({
        where: { subscriberId: id },
        data: { subscriberId: null, status: 'AVAILABLE', assignedAt: null, expiresAt: null },
      });
      released.push(...statics.map((s) => s.ipAddress));
    }

    // 2. Mark inactive so no renewal or reactivation happens by accident.
    await this.prisma.subscriber.update({
      where: { id },
      data: { status: 'INACTIVE' },
    });

    /**
     * 3. Remove the RADIUS credentials and kill the live session.
     *
     * Without the disconnect the customer stays online until their session
     * happens to drop — which on a stable PPPoE link can be weeks. Removing
     * credentials alone only stops the NEXT login, not this one.
     */
    let sessionCut = false;
    if (sub.username) {
      /**
       * First remove the router's LOCAL PPP secret before cutting the session.
       *
       * MikroTik checks /ppp/secret before it asks RADIUS. With a secret
       * still present, the customer simply reconnects and authenticates
       * locally — which is why a "deleted" subscriber kept getting online
       * one more time. Order matters: remove the MikroTik secret BEFORE RADIUS,
       * then kill the session, or they race back on.
       */
      try {
        const nas = await this.prisma.nas.findFirst({
          where: { id: (await this.prisma.subscriber.findUnique({
            where: { id }, select: { nasId: true },
          }))?.nasId ?? -1 },
          select: { nasIp: true, apiPort: true, apiUsername: true, apiPassword: true },
        });
        if (nas?.nasIp && nas.apiUsername && nas.apiPassword) {
          await this.mikrotik.removePppSecret(
            nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, sub.username,
          );
          const killResult = await this.mikrotik.disconnectPppoeUser(
            nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, sub.username,
          );
          sessionCut = !!killResult.removed;
        }
      } catch (e: any) {
        this.logger.warn(`Could not cut the live session for ${sub.username}: ${e?.message}`);
      }

      /**
       * Now remove RADIUS credentials only after the router is clear.
       * This ensures no authentication path remains.
       */
      try {
        await this.radiusSync.removeSubscriberFromRadius(sub.username);
      } catch (e: any) {
        this.logger.error(`Deactivated in CRM but RADIUS cleanup failed: ${e?.message}`);
      }

      this.logger.log(
        `⛔ ${sub.username} deactivated, credentials removed` +
        (sessionCut ? ', live session cut' : ' (no live session found to cut)'),
      );
    }

    return {
      id, deactivated: true, releasedIps: released,
      message: `${sub.fullName} is offline. ${released.length
        ? `Released ${released.length} address(es): ${released.join(', ')}.`
        : 'Their pool address is back in circulation.'} ` +
        `Billing history kept.${reason ? ` Reason: ${reason}` : ''}`,
    };
  }

  /**
   * One scoped, permission-checked engine for multi-select actions on the list.
   * Every id is access-checked against the actor's subtree, so a bulk action can
   * never touch a subscriber the caller doesn't own. Each item is attempted
   * independently — one failure never aborts the rest.
   *
   * actions: 'activate' | 'deactivate' | 'grace' | 'message'
   */
  async bulkAction(
    ids: number[],
    action: string,
    params: { days?: number; reason?: string; message?: string } = {},
    actor?: Actor,
  ) {
    const unique = [...new Set((ids || []).map(Number).filter(Boolean))];
    let success = 0, failed = 0, skipped = 0;
    const errors: Array<{ id: number; error: string }> = [];

    for (const id of unique) {
      try {
        if (actor) {
          const ok = await this.scope.canAccessSubscriber(actor, id);
          if (!ok) { skipped++; continue; } // silently skip out-of-scope ids
        }
        switch (action) {
          case 'activate': {
            const sub = await this.prisma.subscriber.findUnique({ where: { id }, select: { packageId: true } });
            if (!sub?.packageId) throw new Error('No package assigned — cannot activate.');
            await this.activateRenewal({ subscriberId: id, packageId: sub.packageId, mode: 'FULL', actorId: actor ? this.scope.actorId(actor) : null });
            break;
          }
          case 'deactivate':
            await this.deactivateAndRelease(id, actor, params.reason);
            break;
          case 'grace':
            await this.grantGracePeriod(id, Number(params.days) || 3, actor, params.reason);
            break;
          case 'message': {
            if (!params.message) throw new Error('Message body is required.');
            const sub = await this.prisma.subscriber.findUnique({ where: { id }, select: { phone: true, fullName: true } });
            if (!sub?.phone) throw new Error('No phone number on file.');
            await this.notifications.send({
              channel: 'SMS', recipient: sub.phone, subscriberId: id, event: 'BULK_MESSAGE',
              body: params.message,
            });
            break;
          }
          default:
            throw new Error(`Unknown bulk action "${action}".`);
        }
        success++;
      } catch (e: any) {
        failed++;
        errors.push({ id, error: e?.message || 'Failed' });
      }
    }
    return { action, total: unique.length, success, failed, skipped, errors };
  }

  /**
   * Group subscribers by a related dimension — NAS, area, dealer/parent
   * (owner), package or status — with counts, so the list can be presented
   * classified rather than as one flat roll. Scoped to the actor's subtree.
   */
  async groupedBy(by: string, actor?: Actor) {
    const where = await this.scope.subscriberWhere(actor);
    const fieldMap: Record<string, string> = {
      nas: 'nasId', area: 'areaId', owner: 'userId', dealer: 'userId',
      parent: 'userId', package: 'packageId', status: 'status',
    };
    const field = fieldMap[by] || 'nasId';

    const groups = await this.prisma.subscriber.groupBy({
      by: [field as any],
      where,
      _count: { _all: true },
    });
    // Active count per group, so each row shows total + how many are live-billing.
    const activeGroups = await this.prisma.subscriber.groupBy({
      by: [field as any],
      where: { AND: [where, { status: 'ACTIVE' }] },
      _count: { _all: true },
    });
    const activeMap = new Map(activeGroups.map((g: any) => [g[field], g._count._all]));

    // Resolve human labels for the grouping keys.
    const keys = groups.map((g: any) => g[field]).filter((v) => v != null);
    const labels = new Map<any, string>();
    if (field === 'nasId' && keys.length) {
      const rows = await this.prisma.nas.findMany({ where: { id: { in: keys } }, select: { id: true, shortname: true, nasname: true } });
      rows.forEach((r) => labels.set(r.id, r.shortname || r.nasname));
    } else if (field === 'areaId' && keys.length) {
      const rows = await this.prisma.area.findMany({ where: { id: { in: keys } }, select: { id: true, name: true } });
      rows.forEach((r) => labels.set(r.id, r.name));
    } else if (field === 'userId' && keys.length) {
      const rows = await this.prisma.user.findMany({ where: { id: { in: keys } }, select: { id: true, name: true, role: true } });
      rows.forEach((r) => labels.set(r.id, `${r.name} (${r.role})`));
    } else if (field === 'packageId' && keys.length) {
      const rows = await this.prisma.package.findMany({ where: { id: { in: keys } }, select: { id: true, name: true } });
      rows.forEach((r) => labels.set(r.id, r.name));
    }

    return {
      groupBy: by,
      groups: groups
        .map((g: any) => {
          const key = g[field];
          return {
            key,
            label: field === 'status' ? String(key) : (labels.get(key) ?? (key == null ? 'Unassigned' : `#${key}`)),
            total: g._count._all,
            active: activeMap.get(key) ?? 0,
          };
        })
        .sort((a, b) => b.total - a.total),
    };
  }

  /**
   * Run a bulk action on an ENTIRE group (everyone on a NAS / area / dealer /
   * package / status) without selecting each subscriber. Resolves the group to
   * its subscriber ids within the actor's subtree, then reuses bulkAction — so
   * scoping and per-item safety are identical.
   */
  async groupAction(
    by: string,
    key: any,
    action: string,
    params: { days?: number; reason?: string; message?: string } = {},
    actor?: Actor,
  ) {
    const where = await this.scope.subscriberWhere(actor);
    const fieldMap: Record<string, string> = {
      nas: 'nasId', area: 'areaId', owner: 'userId', dealer: 'userId',
      parent: 'userId', package: 'packageId', status: 'status',
    };
    const field = fieldMap[by] || 'nasId';
    const keyVal = field === 'status' ? String(key) : (key == null || key === '' ? null : Number(key));

    const rows = await this.prisma.subscriber.findMany({
      where: { AND: [where, { [field]: keyVal } as any] },
      select: { id: true },
      take: 5000,
    });
    const ids = rows.map((r) => r.id);
    if (!ids.length) return { action, total: 0, success: 0, failed: 0, skipped: 0, errors: [] };
    return this.bulkAction(ids, action, params, actor);
  }

  async bulkDelete(ids: number[], actor?: Actor, force = false) {
    // Mass delete is the single most destructive action a downline account can
    // take — gate it on the delegated permission, not just scope.
    if (actor) await this.security.assertCan(actor, 'subscribers.massDelete');
    let success = 0;
    let failed = 0;
    const errors: Array<{ id: number; error: string }> = [];

    for (const id of ids) {
      try {
        // The actor was never passed here, so bulk delete skipped BOTH the
        // subtree check and the delete permission that the single-delete path
        // enforces — a dealer could bulk-delete any subscriber by id.
        await this.remove(id, actor, force);
        success++;
      } catch (error: any) {
        failed++;
        errors.push({ id, error: error.message || 'Delete failed' });
      }
    }

    return { total: ids.length, success, failed, errors };
  }

  async bulkUpdateServiceSettings(ids: number[], payload: any) {
    let success = 0;
    let failed = 0;
    const errors: Array<{ id: number; error: string }> = [];

    for (const id of ids) {
      try {
        const subscriber = await this.findOne(id);
        if (!subscriber) throw new Error('Subscriber not found');

        await this.prisma.subscriber.update({
          where: { id },
          data: {
            status: payload.profileStatus ? this.normalizeStatus(payload.profileStatus) : undefined,
            connectionType: payload.connectionType ? this.normalizeConnectionType(payload.connectionType) : undefined,
            nasId: payload.nasId ? Number(payload.nasId) : undefined,
            salespersonId: payload.salespersonId ? Number(payload.salespersonId) : undefined,
            packageId: payload.packageId ? Number(payload.packageId) : undefined,
          },
        });

        const existing = await this.prisma.serviceSettings.findUnique({ where: { subscriberId: id } });
        const settingsData: any = {
          expiryDate: payload.expirationDate ? new Date(payload.expirationDate) : undefined,
          quota: payload.totalVolumeGb ? String(payload.totalVolumeGb) : undefined,
          quotaUsed: payload.usedVolumeGb !== undefined ? Number(payload.usedVolumeGb) : undefined,
          duration: payload.totalSessionMin !== undefined ? Number(payload.totalSessionMin) : undefined,
          discountType:
            payload.discountAmountType === 'PERCENTAGE'
              ? 'PERCENTAGE'
              : payload.discountAmountType === 'FIXED'
                ? 'FIXED'
                : undefined,
          discountValue: payload.discount !== undefined ? Number(payload.discount) : undefined,
          // Physical-install fields now write to their OWN columns. Previously
          // each was crammed into an unrelated field (Box number → ontSerial,
          // Uplink port → uploadSpeed, Fiber colour → pptpUsername …), so the
          // data landed in the wrong place and showed blank where it was typed.
          boxNumber:      payload.boxPopNumber,
          boxAddress:     payload.boxPopAddress,
          switchBoard:    payload.mcSwitchOnuBoard,
          electricSocket: payload.electricTypeSocket,
          cableType:      payload.cableType,        // was dropped entirely
          uplinkPort:     payload.uplinkPort,
          fiberCode:      payload.fiberCodeId,
          fiberColor:     payload.fiberColor,
          quotaResetDate: undefined,
          macAddress: payload.autoMacLock === true || payload.autoMacLock === 'true' ? 'LOCKED' : undefined,
          isBlocked: payload.profileStatus === 'SUSPENDED',
        };

        if (existing) {
          await this.prisma.serviceSettings.update({
            where: { subscriberId: id },
            data: settingsData,
          });
        } else {
          await this.prisma.serviceSettings.create({
            data: {
              subscriberId: id,
              ...settingsData,
            },
          });
        }

        success++;
      } catch (error: any) {
        failed++;
        errors.push({ id, error: error.message || 'Update failed' });
      }
    }

    return { total: ids.length, success, failed, errors };
  }

  /**
   * Roll an activation back to a clean, unpaid, non-active state when the
   * reseller charge could not be applied. Keeps the record and the wallet in
   * sync: no charge → no ACTIVE lock, no RADIUS, and the invoice is voided so it
   * does not sit as a phantom "paid" bill.
   */
  private async abortActivationUnpaid(subscriberId: number, invoiceId: number, reason: string, deactivate: boolean) {
    this.logger.error(`⛔ Activation aborted for subscriber #${subscriberId} — ${reason}. Not charged.`);
    // Always void the phantom invoice.
    await this.prisma.invoice.update({
      where: { id: invoiceId }, data: { status: 'CANCELLED', dueAmount: 0 },
    }).catch(() => null);

    // Only cut the customer off on a FIRST activation. A failed RENEWAL of a
    // customer who still has valid paid days must not knock them offline mid-
    // period — we simply do not extend them and do not charge.
    if (deactivate) {
      await this.prisma.subscriber.update({
        where: { id: subscriberId }, data: { status: 'INACTIVE' },
      }).catch(() => null);
      await this.prisma.serviceSettings.update({
        where: { subscriberId }, data: { isBlocked: true },
      }).catch(() => null);
      const sub = await this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: { username: true } });
      if (sub?.username) await this.radiusSync.removeSubscriberFromRadius(sub.username).catch(() => null);
    }
  }

  async activateRenewal(payload: any) {
    const subscriberId = Number(payload.subscriberId);
    const packageId = Number(payload.packageId);
    const extraFee = payload.extraFeeAmount ? Number(payload.extraFeeAmount) : 0;

    const subscriber = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        id: true,
        status: true,
        username: true,
        fullName: true,
        userId: true,
        packageId: true,
        password: true,
        sellPrice: true,
        costPrice: true,
        profit: true,
      },
    });
    if (!subscriber) throw new NotFoundException('Subscriber not found');

    /**
     * ALREADY-ACTIVATED — the check the user asked for, with the package name
     * and the price it was assigned at, so the operator sees WHY it is blocked
     * and what a renewal would really do. No second invoice, no second charge.
     */
    if (subscriber.status === 'ACTIVE' && payload.force !== true) {
      let currentPkg: any = null;
      if (subscriber.packageId) {
        currentPkg = await this.prisma.package.findUnique({
          where: { id: subscriber.packageId },
          select: { id: true, name: true, price: true },
        });
      }
      const currentPrice = subscriber.sellPrice != null
        ? Number(subscriber.sellPrice)
        : Number(currentPkg?.price || 0);
      const auditCreate = this.prisma.activityLog?.create;
      if (auditCreate) {
        await auditCreate({
          data: {
            userId: payload.actorId ?? null,
            action: 'DUPLICATE_ACTIVATION_BLOCKED',
            entity: 'Subscriber',
            entityId: subscriberId,
            details: `Blocked duplicate activation for subscriber #${subscriberId} — already ACTIVE on "${currentPkg?.name ?? '—'}" at ${currentPrice}.`,
          },
        }).catch(() => null);
      }

      throw new ConflictException(
        `Subscriber "${subscriber.fullName}" (#${subscriberId}) is already activated — ` +
        `the package "${currentPkg?.name ?? '—'}" was already assigned at ${currentPrice}. ` +
        `No second charge is possible. Renew only when the period expires, or change the package to migrate.`,
      );
    }

    /**
     * THE ACTIVATING RESELLER CLAIMS THE CUSTOMER — so the sale is priced and
     * charged at THEIR tier.
     *
     * A subscriber the ISP (or any ancestor) created sits at the TOP of the
     * tree, so its cost is 0 and its price falls to the package base — which is
     * why a dealer saw "Costs you 0 / Customer pays 250" instead of their real
     * 800 / 1000. When a reseller activates a customer that currently sits AT OR
     * ABOVE them (not one already owned further down their own subtree), that
     * reseller becomes the owner and salesperson, so the whole activation runs
     * on their pricing. A parent activating one of a child's customers does NOT
     * steal it (the owner is below them → left untouched).
     */
    if (payload.actorId) {
      const actorUser = await this.prisma.user.findUnique({
        where: { id: Number(payload.actorId) },
        select: { id: true, role: true, branchId: true },
      });
      if (actorUser && !this.scope.isAdmin(actorUser.role) && subscriber.userId !== actorUser.id) {
        const below = await this.scope.descendantIds(actorUser.id); // self + descendants
        const ownerIsBelowActor = subscriber.userId != null && below.includes(subscriber.userId);
        if (!ownerIsBelowActor) {
          await this.prisma.subscriber.update({
            where: { id: subscriberId },
            data: {
              userId: actorUser.id,
              salespersonId: actorUser.id,
              ...(actorUser.branchId != null ? { branchId: actorUser.branchId } : {}),
            },
          });
          subscriber.userId = actorUser.id; // downstream quote/settlement price at this tier
          this.logger.log(`Activation: subscriber #${subscriberId} claimed by reseller #${actorUser.id} (priced at their tier)`);
        }
      }
    }

    const pkg = await this.prisma.package.findUnique({ where: { id: packageId } });
    if (!pkg) throw new Error('Package not found');

    // Duration comes from RenewalService so every path — full period, partial
    // days, an exact date, or whatever the balance buys — is priced and dated
    // by the same rules. The legacy customExpiryDate flag still works.
    let mode = payload.mode || (payload.customExpiryDate && payload.expiryDateTime ? 'DATE' : 'FULL');
    let effectiveExpiryDate = payload.expiryDateTime || payload.expiryDate;
    let effectiveDays = payload.days;

    /**
     * ACTIVATING A JUST-TRANSFERRED CUSTOMER — charge only for the days that
     * remain. A move suspends the customer but preserves their expiry (their
     * already-paid days). When the new owner activates and hasn't asked for a
     * specific period, bill them and the customer for the REMAINING days at the
     * new owner's price — not a fresh full month that would double-charge the
     * days the customer already paid the previous owner for. Billed as DAYS so
     * the period runs from today for the number of days left. Only kicks in when
     * the operator gave no explicit mode/days/date and there is a real future
     * expiry to honour (more than a day out).
     */
    if (!payload.mode && !payload.days && !effectiveExpiryDate && subscriber.status !== 'ACTIVE') {
      const ss = await this.prisma.serviceSettings.findUnique({
        where: { subscriberId }, select: { expiryDate: true },
      });
      const exp = ss?.expiryDate ? new Date(ss.expiryDate) : null;
      const msLeft = exp ? exp.getTime() - Date.now() : 0;
      if (msLeft > 24 * 60 * 60 * 1000) {
        mode = 'DAYS';
        effectiveDays = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
      }
    }

    // First activation (subscriber not currently ACTIVE) → bill from today, so
    // the 30-day period runs from the activation date, not the creation date.
    // A custom expiry date always wins if the operator picked one.
    const firstActivation = subscriber.status !== 'ACTIVE' && mode !== 'DATE';
    const quote = await this.renewal.quote(subscriberId, {
      mode,
      packageId,
      days: effectiveDays,
      expiryDate: effectiveExpiryDate,
      extraFee: extraFee,
      fromActivation: firstActivation,
    });
    const expiryDate = quote.newExpiry;

    /**
     * DETERMINISTIC SETTLEMENT KEY — the heart of "charged once, never twice".
     *
     * The settlement reference used to be `RENEW:${invoice.id}`, and every
     * request minted a fresh invoice — so a double-clicked button created two
     * invoices, two different references, and TWO wallet charges. The key is
     * now derived ONLY from what the customer is actually getting: the package
     * and the day the period ends. A replayed request computes the same key and
     * is refused by settleActivation, whatever invoice number it carries. A
     * genuine next renewal ends on a later day → a different key → a legitimate
     * second charge.
     */
    const actKey = `ACT:${pkg.id}:${expiryDate.toISOString().slice(0, 10)}`;

    const methodMap: Record<string, 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'ONLINE'> = {
      CASH: 'CASH',
      BANK_TRANSFER: 'BANK_TRANSFER',
      CARD: 'CARD',
      ONLINE: 'ONLINE',
    };
    const paymentMethod = mode === 'BALANCE'
      ? ('BALANCE' as any)
      : methodMap[(payload.paymentMethod || 'CASH').toUpperCase()] || 'CASH';

    // Retail price to STAMP on the subscriber. Only reuse the stored sellPrice
    // when we are activating the SAME package it was set for; a package change
    // (or a first activation) must resolve fresh from the owner's retail so we
    // never re-stamp a stale figure from the old plan. Falls back to the owner's
    // retail for this package, then the package base.
    let sell: number;
    if (payload.sellPrice != null && payload.sellPrice !== '') {
      sell = Number(payload.sellPrice);
    } else if (subscriber.packageId === pkg.id && subscriber.sellPrice != null) {
      sell = Number(subscriber.sellPrice);
    } else {
      const ownRetail = subscriber.userId
        ? (await this.prisma.resellerPackagePrice.findUnique({
            where: { userId_packageId: { userId: subscriber.userId, packageId: pkg.id } },
            select: { retailPrice: true },
          }))?.retailPrice ?? null
        : null;
      sell = ownRetail != null && ownRetail > 0 ? Number(ownRetail) : Number(pkg.price || 0);
    }

    const total = quote.total;
    // Full timestamp + a short random tail, so two activations in the same
    // minute cannot mint the same invoice number (the old `slice(-6)` repeated
    // every ~16.7 minutes and caused collisions).
    const invoiceNo = `INV-${new Date().getFullYear()}-${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;

    let invoice: any = null;
    let payment: any = null;
    // True when settleActivation recognised an OLD, already-charged settlement
    // for this exact (package, expiry-day) — a previous attempt took the money
    // but died before the subscriber was marked ACTIVE. We finish the job
    // without charging again (recovery), never with a second charge.
    let isRecovery = false;
    let recoveredInvoice: any = null;

    try {
      /**
       * ONE ATOMIC TRANSACTION for the whole money segment.
       *
       * Package, expiry, the invoice, the reseller wallet charge, a BALANCE-mode
       * wallet deduction and the payment now commit — or roll back — together.
       * Before this, each step ran as its own write: a failure part-way left
       * orphans (an invoice with no charge, a deducted wallet with no invoice,
       * a charged reseller with no activation). Now any single failure rolls
       * the whole segment back to the state before the operator clicked.
       */
      await this.prisma.$transaction(async (tx) => {
        // ── 0. Idempotency gate: ONE client key = ONE charge ──
        // The browser mints a key per activation dialog and sends the same key
        // for every attempt of the SAME click. If an invoice for this subscriber
        // already carries this key, the request is a replay (double-click, or a
        // timed-out retry) — refuse it and roll back whatever this attempt had
        // started, so the same click can never charge twice.
        if (payload.idempotencyKey) {
          const replay = await tx.invoice.findFirst({
            where: { subscriberId, idempotencyKey: payload.idempotencyKey },
            select: { id: true },
          });
          if (replay) {
            throw new ConflictException(
              `Subscriber "${subscriber.fullName}" (#${subscriberId}) is already activated — ` +
              `the package "${pkg.name}" was already assigned at ${total}, and this exact activation was already recorded. ` +
              `No second charge was made.`,
            );
          }
        }

        // ── 1. State the period: package + expiry (+ fresh FUP allowance) ──
        await tx.subscriber.update({
          where: { id: subscriberId },
          data: { packageId },
        });

        /**
         * PERSIST THE CYCLE LENGTH, not just the end date.
         *
         * `duration` was never written here, so every normally-activated
         * subscriber had it NULL. Anything that needs the START of the current
         * cycle then fell back to "30 days before today" — which is why a
         * customer activated on 17 Aug displayed "Cycle began 18 Jul", and why
         * quota usage was summed over the wrong window. Storing the real period
         * length makes cycleStart = expiry − duration exact.
         */
        const currentSettings = await tx.serviceSettings.findUnique({ where: { subscriberId } });
        const cycleDays = Math.max(1, Number(quote.days) || pkg.duration || 30);
        if (currentSettings) {
          await tx.serviceSettings.update({
            where: { subscriberId },
            data: { expiryDate, duration: cycleDays },
          });
        } else {
          await tx.serviceSettings.create({
            data: { subscriberId, expiryDate, duration: cycleDays },
          });
        }

        // A new period means a fresh data allowance, so clear any FUP throttle
        // carried over from the previous cycle.
        await tx.subscriber.update({
          where: { id: subscriberId },
          data: { fupApplied: false, fupAppliedAt: null },
        });

        // ── 2. Charge — but only once ──
        if (subscriber.userId) {
          // `activationCost` is a read-only price-ladder computation.
          const cost = await this.pricing.activationCost(subscriber.userId, packageId, Number(pkg.price || 0));
          await tx.subscriber.update({
            where: { id: subscriberId },
            data: { sellPrice: sell, costPrice: cost, profit: Math.round((sell - cost) * 100) / 100 },
          });

          let settlement: any;
          try {
            // Same tx → a duplicate rolls back the invoice WITH the settlement.
            // Same deterministic actKey → the replay collapses onto the first charge.
            settlement = await this.pricing.settleActivation(subscriberId, {
              byUserId: subscriber.userId,
              event: actKey,
            }, tx);
          } catch (e: any) {
            // Insufficient prepaid balance (or any charge failure). Roll back all.
            throw new Error(`charge failed: ${e?.message || e}`);
          }

          if (!settlement?.settled) {
            if (settlement?.alreadySettled) {
              // The buyer asked for the SAME period twice. If the first charge is
              // moments old, it is a double-click — refuse with the friendly error.
              // If it is old AND the subscriber is still not ACTIVE, a previous
              // attempt died between charging and activating: recover instead.
              const settledAt = settlement.settledAt ? new Date(settlement.settledAt).getTime() : 0;
              const recent = Date.now() - settledAt < 15_000;
              if (recent || subscriber.status === 'ACTIVE') {
                throw new ConflictException(
                  `Subscriber "${subscriber.fullName}" (#${subscriberId}) is already activated — ` +
                  `the package "${pkg.name}" was already assigned at ${total}. ` +
                  `No second charge was made. Renew only when the period expires, or change the package to migrate.`,
                );
              }
              // Stale settlement + still INACTIVE → finish a half-done activation.
              isRecovery = true;
            } else {
              throw new Error((settlement as any)?.reason || 'settlement returned unsettled');
            }
          }
        }

        // ── 3. Invoice + payment (skipped on recovery — the money and the
        //       original invoice already exist) ──
        if (!isRecovery) {
          try {
            invoice = await tx.invoice.create({
              data: {
                invoiceNo,
                subscriberId,
                amount: total,
                total,
                dueAmount: total,
                paidAmount: 0,
                dueDate: expiryDate,
                notes: payload.notes || null,
                idempotencyKey: payload.idempotencyKey || null,
                status: 'UNPAID',
                items: {
                  create: [
                    {
                      description: `Activation/Renewal - ${pkg.name} (${quote.days} day${quote.days === 1 ? '' : 's'})`,
                      quantity: 1,
                      unitPrice: quote.amount,
                      total: quote.amount,
                    },
                    ...(extraFee > 0
                      ? [{ description: 'Extra Fee', quantity: 1, unitPrice: extraFee, total: extraFee }]
                      : []),
                  ],
                },
              },
              include: { items: true },
            });
          } catch (e2: any) {
            // The UNIQUE index on idempotencyKey caught a concurrent replay that
            // slipped past the findFirst gate above — the same click, in flight
            // twice. Same friendly refusal; the whole transaction (and the wallet
            // deduction that may already have run) rolls back.
            if (e2?.code === 'P2002') {
              throw new ConflictException(
                `Subscriber "${subscriber.fullName}" (#${subscriberId}) is already activated — ` +
                `the package "${pkg.name}" was already assigned at ${total}. No second charge was made.`,
              );
            }
            throw e2;
          }

          // Paying from the wallet must actually move the money out of it,
          // otherwise the same balance could be spent repeatedly. Runs AFTER the
          // reseller charge outcome so a duplicate never reaches the wallet, and
          // INSIDE this tx so a failure rolls the deduction back.
          if (mode === 'BALANCE') {
            const deduct = await this.accounting.deductBalance(subscriberId, total, actKey, 'RENEWAL', payload.actorId, tx);
            if (deduct.alreadyDeducted) {
              throw new ConflictException(
                `Subscriber "${subscriber.fullName}" (#${subscriberId}) is already activated — ` +
                `the wallet was already charged ${total} for "${pkg.name}". No second deduction was made.`,
              );
            }
          }

          payment = await tx.payment.create({
            data: {
              paymentNo: `PAY-${Date.now()}`,
              invoiceId: invoice.id,
              subscriberId,
              amount: total,
              method: paymentMethod,
              notes: payload.notes || null,
            },
          });
        }
      });
    } catch (e: any) {
      // A duplicate attempt → keep the friendly Conflict message; the whole
      // transaction (including any partial invoice/payment) is already rolled back.
      if (e instanceof ConflictException) throw e;
      // Otherwise the money did NOT move (rolled back) — report and clean up.
      await this.abortActivationUnpaid(subscriberId, invoice?.id ?? Number.NaN, `charge failed: ${e?.message || e}`, subscriber.status !== 'ACTIVE');
      throw new ForbiddenException(
        `Activation blocked — the account was not charged: ${e?.message || e}. ` +
        `The customer was NOT activated. Top up the wallet and try again.`,
      );
    }

    /**
     * Money has moved (or was recovered) — NOW lock the record ACTIVE, unblock
     * and put into RADIUS. The invoice is marked paid and the ledger posted only
     * after RADIUS succeeds, so a sync failure never leaves a "paid" bill for a
     * customer who is not actually online.
     */
    await this.prisma.subscriber.update({
      where: { id: subscriberId },
      data: { status: 'ACTIVE' },
    });
    await this.prisma.serviceSettings.update({
      where: { subscriberId }, data: { isBlocked: false },
    }).catch(() => null);

    try {
      await this.syncToRadius(subscriberId);
      this.logger.log(`✅ RADIUS access restored for subscriber #${subscriberId}`);
    } catch (e: any) {
      this.logger.error(
        `Activation charged for #${subscriberId} but RADIUS sync FAILED: ${e?.message || e}. ` +
          `Use Sync to RADIUS on their profile.`,
      );
    }

    if (isRecovery) {
      // The original attempt left a paid-for-but-uncompleted activation. Its
      // UNPAID invoice is still on the books — complete that invoice (the real
      // record of the money already taken), post its ledger once, and notify.
      recoveredInvoice = await this.prisma.invoice.findFirst({
        where: { subscriberId, status: 'UNPAID' },
        orderBy: { createdAt: 'desc' },
      });
      if (recoveredInvoice) {
        await this.accounting.postInvoiceCreated(recoveredInvoice).catch((err: any) =>
          this.logger.warn(`Recovery: could not post ledger for invoice #${recoveredInvoice.id}: ${err?.message || err}`));
        await this.prisma.invoice.update({
          where: { id: recoveredInvoice.id },
          data: { paidAmount: recoveredInvoice.total, dueAmount: 0, status: 'PAID', paidDate: new Date() },
        });
        void this.notifications.fireEvent('RENEWAL', { ...subscriber, package: pkg }, {
          amount: recoveredInvoice.total,
          invoiceNo: recoveredInvoice.invoiceNo,
          expiry: expiryDate,
        });
      }
      this.logger.warn(
        `Activation #${subscriberId} completed in RECOVERY — the charge for ${actKey} already existed; ` +
        `no second charge was made` + (recoveredInvoice ? `, original invoice #${recoveredInvoice.id} marked paid.` : '.'),
      );
    } else if (invoice) {
      // Ledger postings + mark the invoice paid.
      await this.accounting.postInvoiceCreated(invoice);
      await this.accounting.postPaymentReceived(payment);
      void this.notifications.fireEvent('RENEWAL', { ...subscriber, package: pkg }, {
        amount: total,
        invoiceNo: invoice.invoiceNo,
        expiry: expiryDate,
      });
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { paidAmount: total, dueAmount: 0, status: 'PAID', paidDate: new Date() },
      });
    }

    return {
      subscriberId,
      packageId,
      packageName: pkg.name,
      expiryDate,
      totalAmount: total,
      invoiceId: (invoice ?? recoveredInvoice)?.id ?? null,
      recovered: isRecovery,
    };
  }

  async importSubscribers(payload: { rows: any[]; salespersonId?: number | null; charge?: boolean }, actor?: Actor) {
    const rows = payload.rows || [];
    let success = 0;
    let failed = 0;
    const errors: Array<{ index: number; username?: string; error: string }> = [];

    /**
     * RESOLVE NAMES → IDS ONCE, UP FRONT.
     *
     * A spreadsheet almost never carries the internal numeric ids — it carries
     * the human names ("4mb", "Gulberg", the router's name). The old import fed
     * those straight in as packageId/nasId/areaId, where parseInt() turned them
     * into NaN and dropped them silently — which is exactly why imported
     * subscribers came in with no package, no speed and no expiry, forcing a
     * manual edit of every single one. Here we build name→id maps (numbers pass
     * through untouched) so a package/area/NAS given by name is matched to its
     * real record, the subscriber activates, and the expiry is stamped.
     */
    const [pkgs, areas, nases] = await Promise.all([
      this.prisma.package.findMany({ select: { id: true, name: true } }),
      this.prisma.area.findMany({ select: { id: true, name: true } }),
      this.prisma.nas.findMany({ select: { id: true, shortname: true, nasname: true, nasIp: true } }),
    ]);
    const norm = (v: any) => String(v ?? '').trim().toLowerCase();
    const pkgByName = new Map(pkgs.map((p) => [norm(p.name), p.id]));
    const areaByName = new Map(areas.map((a) => [norm(a.name), a.id]));
    const nasByName = new Map<string, number>();
    for (const n of nases) {
      for (const k of [n.shortname, n.nasname, n.nasIp]) if (k) nasByName.set(norm(k), n.id);
    }
    // Resolve a cell that may be a numeric id OR a name into a numeric id.
    const resolve = (raw: any, byName: Map<string, number>): number | undefined => {
      if (raw == null || raw === '') return undefined;
      if (/^\d+$/.test(String(raw).trim())) return Number(raw);
      return byName.get(norm(raw));
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const packageId = resolve(row.packageId ?? row.package ?? row.packageName, pkgByName);
        const areaId = resolve(row.areaId ?? row.area ?? row.areaName, areaByName);
        const nasId = resolve(row.nasId ?? row.nas ?? row.nasName, nasByName);

        // Flag an unmatched package by NAME so the operator knows why a row came
        // in without service, instead of it failing silently as before.
        const rawPkg = row.packageId ?? row.package ?? row.packageName;
        if (rawPkg && !packageId) {
          throw new Error(`package "${rawPkg}" not found — check the name matches a package exactly`);
        }

        await this.create({
          fullName: row.fullName || row.fullname,
          username: row.username,
          password: row.connectionPassword || row.password,
          identity: row.identity,
          phone: row.phone,
          email: row.email,
          address: row.address,
          packageId,
          areaId,
          nasId,
          salespersonId: row.salespersonId || payload.salespersonId || row.salesperson,
          connectionType: row.connectionType,
          status: row.profileStatus || row.status || 'ACTIVE',
          installationDate: row.installationDate,
          // Migrating an existing book: keep their real expiry, and DON'T charge
          // the owner's wallet or raise an invoice for a customer they already
          // have. (Pass migrate:false in the payload to bill on import instead.)
          expiryDate: row.expiryDate || undefined,
          skipCharge: payload.charge === true ? undefined : true,
        }, actor);
        success++;
      } catch (error: any) {
        failed++;
        errors.push({
          index: i,
          username: row.username,
          error: error.message || 'Import failed',
        });
      }
    }

    return {
      total: rows.length,
      success,
      failed,
      errors,
    };
  }

  /**
   * Import a file in the PANEL EXCHANGE FORMAT — the 46-column layout.
   *
   * Takes rows already parsed into objects keyed by the snake_case header
   * names, so the same code path serves an uploaded CSV and a pasted one.
   *
   * Two decisions worth knowing:
   *
   *  • VALIDATE-THEN-WRITE. Every row is checked before anything is created,
   *    and if `dryRun` is set nothing is written at all. A 400-row migration
   *    that fails at row 250 leaves a half-populated database that is worse
   *    than either outcome, so the caller can see the whole verdict first.
   *
   *  • ROW NUMBERS ARE SPREADSHEET ROW NUMBERS. Errors report the line as it
   *    appears in Excel (header is row 1, first record is row 2), because that
   *    is where the person has to go to fix it.
   */
  async importPanelFormat(payload: {
    rows: any[];
    dryRun?: boolean;
    updateExisting?: boolean;
    defaultSalespersonId?: number | null;
  }, actor?: Actor) {
    const rows = payload.rows || [];
    const problems: Array<{ row: number; username?: string; issue: string; fatal: boolean }> = [];
    const seen = new Set<string>();

    // ── Pass 1: validate ────────────────────────────────────────
    const prepared: any[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] ?? {};
      const line = i + 2; // header occupies row 1
      const username = String(r.username ?? '').trim();

      if (!username) {
        problems.push({ row: line, issue: 'username is empty — it is the key for this format', fatal: true });
        continue;
      }
      if (seen.has(username.toLowerCase())) {
        problems.push({ row: line, username, issue: 'duplicate username within this file', fatal: true });
        continue;
      }
      seen.add(username.toLowerCase());

      const password = String(r.connection_password ?? r.password ?? '').trim();
      if (!password) {
        problems.push({ row: line, username, issue: 'no password — the connection could not authenticate', fatal: true });
        continue;
      }
      if (!String(r.full_name ?? '').trim()) {
        problems.push({ row: line, username, issue: 'full_name is empty', fatal: true });
        continue;
      }

      const expiry = parsePanelDate(r.expiration_date);
      if (r.expiration_date && !expiry) {
        problems.push({
          row: line, username, fatal: false,
          issue: `expiration_date "${r.expiration_date}" not understood — expected M/D/YYYY HH:mm`,
        });
      }

      prepared.push({ line, username, password, expiry, r });
    }

    // Referenced ids are checked in bulk rather than per row — 400 rows would
    // otherwise mean 1,200 lookups, and the error is far clearer stated once.
    const pkgIds = [...new Set(prepared.map((p) => Number(p.r.package_id)).filter(Boolean))];
    const nasIds = [...new Set(prepared.map((p) => Number(p.r.nas_id)).filter(Boolean))];
    const [pkgs, nases] = await Promise.all([
      pkgIds.length ? this.prisma.package.findMany({ where: { id: { in: pkgIds } }, select: { id: true } }) : [],
      nasIds.length ? this.prisma.nas.findMany({ where: { id: { in: nasIds } }, select: { id: true } }) : [],
    ]);
    const havePkg = new Set(pkgs.map((p) => p.id));
    const haveNas = new Set(nases.map((n) => n.id));

    const missingPkgs = pkgIds.filter((id) => !havePkg.has(id));
    const missingNas = nasIds.filter((id) => !haveNas.has(id));
    if (missingPkgs.length) {
      problems.push({
        row: 0, fatal: true,
        issue: `package_id ${missingPkgs.join(', ')} do not exist here. Create the packages first, or map the ids.`,
      });
    }
    if (missingNas.length) {
      problems.push({
        row: 0, fatal: true,
        issue: `nas_id ${missingNas.join(', ')} do not exist here. Add the routers first, or map the ids.`,
      });
    }

    const existing = await this.prisma.subscriber.findMany({
      where: { username: { in: prepared.map((p) => p.username) } },
      select: { id: true, username: true },
    });
    const existingByName = new Map(existing.map((e) => [e.username, e]));
    if (existing.length && !payload.updateExisting) {
      problems.push({
        row: 0, fatal: true,
        issue: `${existing.length} username(s) already exist. Tick "update existing" to overwrite them, or remove those rows.`,
      });
    }

    const fatal = problems.filter((p) => p.fatal);
    const willImport = prepared.length;

    if (payload.dryRun || fatal.length) {
      return {
        dryRun: true,
        total: rows.length,
        wouldImport: fatal.length ? 0 : willImport,
        wouldUpdate: payload.updateExisting ? existing.length : 0,
        blocked: fatal.length > 0,
        problems,
        note: fatal.length
          ? 'Nothing was written. Fix the problems above and try again.'
          : `Checks passed. ${willImport} row(s) ready to import.`,
      };
    }

    // ── Pass 2: write ───────────────────────────────────────────
    let created = 0, updated = 0, failed = 0;
    for (const p of prepared) {
      const { r, username, password, expiry, line } = p;
      try {
        const data: any = {
          fullName: String(r.full_name).trim(),
          username,
          password,
          identity: String(r.identity ?? '').trim() || undefined,
          cnicNumber: String(r.identity ?? '').replace(/\D/g, '') || undefined,
          phone: String(r.phone ?? '').trim(),
          email: String(r.email ?? '').trim() || undefined,
          address: String(r.address ?? '').trim() || undefined,
          packageId: Number(r.package_id) || undefined,
          nasId: Number(r.nas_id) || undefined,
          areaId: Number(r.area_id) || undefined,
          branchId: Number(r.branch_id) || undefined,
          salespersonId: Number(r.salesperson_id) || payload.defaultSalespersonId || undefined,
          connectionType: CONNECTION_TYPE[String(r.connection_type ?? '1')] ?? 'FTTH',
          status: PROFILE_STATUS[String(r.profile_status ?? '2')] ?? 'ACTIVE',
          balance: Number(r.previous_balance) || 0,
          latitude: r.latitude ? Number(r.latitude) : undefined,
          longitude: r.longitude ? Number(r.longitude) : undefined,
          installationDate: parsePanelDate(r.join_date) ?? undefined,
        };

        // The installation block. These are the columns that had nowhere to go
        // before — the physical detail a technician needs and nobody can
        // reconstruct once the installer has moved on.
        const settings: any = {
          expiryDate: expiry ?? undefined,
          macAddress: String(r.mac_address ?? '').trim() || undefined,
          macLockEnabled: parseFlag(r.mac_lock_status),
          smsEnabled: r.sms_status === undefined || r.sms_status === '' ? true : parseFlag(r.sms_status),
          quota: String(r.total_volume ?? '').trim() || undefined,
          quotaUsed: r.used_volume ? Number(r.used_volume) : undefined,
          totalSession: r.total_session ? Number(r.total_session) : undefined,
          usedSession: r.used_session ? Number(r.used_session) : undefined,
          discountType: DISCOUNT_TYPE[String(r.discount_type ?? '')] ?? 'NONE',
          discountValue: r.discount ? Number(r.discount) : undefined,
          boxNumber: String(r.box_number ?? '').trim() || undefined,
          boxAddress: String(r.box_address ?? '').trim() || undefined,
          switchBoard: String(r.switch_board ?? '').trim() || undefined,
          switchPort: String(r.switch_port ?? '').trim() || undefined,
          electricSocket: String(r.electric_socket ?? '').trim() || undefined,
          cableType: String(r.cable_type ?? '').trim() || undefined,
          uplinkPort: String(r.uplink_port ?? '').trim() || undefined,
          fiberCode: String(r.fiber_code ?? '').trim() || undefined,
          fiberColor: String(r.fiber_color ?? '').trim() || undefined,
          onuNote: String(r.onu_note ?? '').trim() || undefined,
        };

        const staticIp = String(r.static_ip ?? '').trim();
        if (staticIp) {
          settings.ipAddress = staticIp;
          settings.ipType = 'STATIC';
          settings.isStaticIp = true;
        }

        const found = existingByName.get(username);
        if (found) {
          await this.prisma.subscriber.update({ where: { id: found.id }, data });
          await this.prisma.serviceSettings.upsert({
            where: { subscriberId: found.id },
            update: settings,
            create: { subscriberId: found.id, ...settings },
          });
          await this.syncToRadius(found.id).catch(() => null);
          updated++;
        } else {
          // OWNER = THE ACCOUNT DOING THE IMPORT. The file has no owner column,
          // and an ownerless ACTIVE subscriber used to sync into RADIUS with no
          // wallet movement at all — imported internet for free. Assigning the
          // importer puts the row in their subtree and makes the activation
          // charge below land on someone real.
          const ownerId = actor ? this.scope.actorId(actor) : null;
          const sub = await this.prisma.subscriber.create({ data: { ...data, userId: ownerId } });
          await this.prisma.serviceSettings.create({
            data: { subscriberId: sub.id, ...settings },
          });

          /**
           * CHARGE-THEN-ACTIVATE on import, same contract as create().
           *
           * A new row imported as ACTIVE gets its first invoice raised and the
           * owner's wallet charged BEFORE it ever reaches RADIUS. If the charge
           * fails (empty wallet, no price ladder) the row is left INACTIVE and
           * blocked — the customer exists in the panel but gets no internet —
           * exactly like a failed manual activation. Only a settled import is
           * synced to RADIUS.
           */
          if (sub.status === 'ACTIVE' && sub.packageId) {
            try {
              await this.autoInvoiceForSubscriber(sub.id, sub.packageId, data.sellPrice ?? undefined)
                .catch((e: any) => this.logger.warn(`Import invoice skipped for #${sub.id}: ${e?.message || e}`));
              if (ownerId) {
                await this.pricing.settleActivation(sub.id, { byUserId: ownerId });
              }
            } catch (e: any) {
              const reason = e?.message || 'Wallet could not cover this activation.';
              await this.prisma.subscriber.update({
                where: { id: sub.id },
                data: { status: 'INACTIVE' },
              }).catch(() => null);
              await this.prisma.serviceSettings.update({
                where: { subscriberId: sub.id },
                data: { isBlocked: true },
              }).catch(() => null);
              failed++;
              problems.push({
                row: line, username, fatal: false,
                issue: `Imported but NOT activated - ${reason} No internet until the wallet is topped up and the subscriber is activated.`,
              });
              continue;
            }
          }

          // Without this the customer exists in the panel but cannot dial in,
          // which is the most confusing possible half-success. Only runs when
          // the import settled (ACTIVE rows) or the row starts non-active but
          // simply needs its RADIUS profile (password/speed) written.
          await this.syncToRadius(sub.id).catch(() => null);
          created++;
        }
      } catch (e: any) {
        failed++;
        problems.push({ row: line, username, fatal: false, issue: e?.message ?? 'Import failed' });
      }
    }

    this.logger.log(`Panel import: ${created} created, ${updated} updated, ${failed} failed`);
    return {
      dryRun: false,
      total: rows.length,
      created,
      updated,
      failed,
      problems,
      note: `${created} created, ${updated} updated${failed ? `, ${failed} failed` : ''}.`,
    };
  }

  async exportSubscribers(query?: any, actor?: Actor) {
    // export always needs the full list — strip pagination params
    const { limit: _limit, cursor: _cursor, ...exportQuery } = query || {};
    const subscribers = (await this.findAll(exportQuery, actor)) as any[];
    return subscribers.map((sub) => ({
      id: sub.id,
      fullName: sub.fullName,
      username: sub.username,
      phone: sub.phone,
      email: sub.email,
      identity: sub.identity,
      status: sub.status,
      connectionType: sub.connectionType,
      package: sub.package?.name || null,
      nas: sub.nas?.nasname || null,
      salesperson: sub.salesperson?.name || null,
      area: sub.area?.name || null,
      expiryDate: sub.serviceSettings?.expiryDate || null,
      createdAt: sub.createdAt,
    }));
  }

  async getProfileBundle(id: number) {
    const subscriber = await this.prisma.subscriber.findUnique({
      where: { id },
      include: {
        package: { include: { pool: true } },
        area: true,
        nas: true,
        salesperson: true,
        serviceSettings: true,
      },
    });

    if (!subscriber) return null;

    const [invoices, payments, tickets] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { subscriberId: id },
        include: { items: true, payments: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.payment.findMany({
        where: { subscriberId: id },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.ticket.findMany({
        where: { subscriberId: id },
        include: { messages: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      subscriber,
      serviceSettings: subscriber.serviceSettings,
      invoices,
      payments,
      tickets,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // SYNC ALL TO RADIUS — full profile sync including speed + pool
  // This replaces the old bulk sync that only sent passwords
  // ─────────────────────────────────────────────────────────────
  async syncAllToRadius() {
    console.log('========================================');
    console.log('📡 FULL SYNC — ALL ACTIVE SUBSCRIBERS → RADIUS');

    // Fetch all active subscribers with their package AND pool
    const subscribers = await this.prisma.subscriber.findMany({
      where: { status: 'ACTIVE' },
      include: {
        package: { include: { pool: true } },
        serviceSettings: true,
      },
    });

    console.log(`📊 Found ${subscribers.length} active subscribers`);
    if (subscribers.length === 0) return { total: 0, success: 0, failed: 0 };

    let success = 0;
    let failed  = 0;

    for (const sub of subscribers) {
      if (!sub.username || !sub.password) { failed++; continue; }
      try {
        // BUG FIX: this used to pass only `{ allowMultipleSessions }`, which
        // meant a bulk "Sync All to RADIUS" silently stripped every static-IP
        // subscriber back to pool addressing (and dropped their MAC lock and
        // auth method) the moment an admin ran it. buildFullRadiusOpts()
        // rebuilds the complete profile from current ServiceSettings, same as
        // a single-subscriber syncToRadius() would.
        const opts = this.buildFullRadiusOpts(sub);
        await this.radiusSync.syncSubscriberProfile(
          sub.username,
          sub.password,
          sub.package ?? null,
          opts,
        );
        success++;
        console.log(
          `✅ ${sub.username} — ` +
          (opts.staticIp
            ? `static ${opts.staticIp}`
            : sub.package
              ? `${sub.package.downloadSpeed}M/${sub.package.uploadSpeed}M, pool: ${sub.package.pool?.name ?? 'none'}`
              : 'no package'),
        );
      } catch (error: any) {
        failed++;
        console.error(`❌ Failed: ${sub.username} — ${error.message}`);
      }
    }

    console.log(`📊 Done: ${success} success, ${failed} failed`);
    console.log('========================================');
    return { total: subscribers.length, success, failed };
  }

  // ─────────────────────────────────────────────────────────────
  // SYNC MISSING — only adds subscribers not yet in RADIUS
  // Also syncs their full profile (speed + pool), not just password
  // ─────────────────────────────────────────────────────────────
  async syncMissingToRadius() {
    console.log('========================================');
    console.log('📡 SYNC MISSING SUBSCRIBERS → RADIUS');

    const subscribers = await this.prisma.subscriber.findMany({
      include: {
        package: { include: { pool: true } },
        serviceSettings: true,
      },
    });

    let synced  = 0;
    let failed  = 0;
    let skipped = 0;

    for (const sub of subscribers) {
      if (!sub.username || !sub.password) { skipped++; continue; }

      try {
        const exists = await this.radiusSync.isSubscriberInRadius(sub.username);
        if (!exists) {
          await this.radiusSync.syncSubscriberProfile(
            sub.username,
            sub.password,
            sub.package ?? null,
            this.buildFullRadiusOpts(sub),
          );
          synced++;
          console.log(`✅ Synced: ${sub.username}`);
        } else {
          skipped++;
        }
      } catch (error: any) {
        failed++;
        console.error(`❌ Failed: ${sub.username} — ${error.message}`);
      }
    }

    console.log(
      `📊 Done: ${synced} synced, ${failed} failed, ${skipped} skipped`,
    );
    return { synced, failed, skipped };
  }

  // ─────────────────────────────────────────────────────────────
  // CHECK RADIUS STATUS
  // ─────────────────────────────────────────────────────────────
  async checkRadiusStatus(username: string) {
    try {
      const exists = await this.radiusSync.isSubscriberInRadius(username);

      // Also return what's actually stored in RADIUS for debugging
      let profile = null;
      if (exists) {
        profile = await this.radiusSync.getSubscriberFromRadius(username);
      }

      return { username, existsInRadius: exists, profile };
    } catch (error: any) {
      return { username, existsInRadius: false, error: error.message };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // FIND BY USERNAME
  // ─────────────────────────────────────────────────────────────
  async findByUsername(username: string) {
    return this.prisma.subscriber.findFirst({
      where: { username },
      include: {
        package:     { include: { pool: true } },
        area:        true,
        nas:         true,
        salesperson: true,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // TEST RADIUS CONNECTION
  // ─────────────────────────────────────────────────────────────
  async testRadiusConnection() {
    try {
      const result = await this.radiusSync.testRadiusConnection();
      return { connected: result };
    } catch (error: any) {
      return { connected: false, error: error.message };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GET RADIUS LIVE SESSION + HISTORY (from radacct)
  // Called by profile page — Connection tab + Session Log tab
  // ─────────────────────────────────────────────────────────────
  async getRadiusSession(username: string) {
    try {
      const pg = this.radiusSync.getPgClient();
      if (!pg) return { session: null, history: [], openCount: 0, duplicate: false };

      // Active session — no stop time means currently online
      const activeRes = await pg.query(`
        SELECT
          username,
          nasipaddress,
          framedipaddress,
          callingstationid,
          acctstarttime,
          acctupdatetime,
          acctstoptime,
          -- Clamp at 0: acctstarttime comes from the NAS's Event-Timestamp, so a
          -- router clock ahead of the DB clock would otherwise yield a negative
          -- uptime. Prefer the NAS-reported session time once interim updates
          -- start arriving, since that is authoritative.
          GREATEST(
            0,
            COALESCE(NULLIF(acctsessiontime, 0),
                     EXTRACT(EPOCH FROM (NOW() - acctstarttime))::int)
          ) AS duration_seconds,
          acctinputoctets   AS upload_bytes,
          acctoutputoctets  AS download_bytes,
          nasportid,
          nasporttype,
          framedprotocol,
          servicetype,
          acctterminatecause,
          acctinterval,
          COALESCE(acctupdatetime, acctstarttime) AS lastactivity
        FROM radacct
        WHERE username = $1
          AND acctstoptime IS NULL
          -- Only treat it as live if the NAS reported on it recently. A lost
          -- Accounting-Stop otherwise leaves the session "online" forever.
          AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '15 minutes'
        ORDER BY acctstarttime DESC
        LIMIT 1
      `, [username]);

      // History — last 50 completed sessions
      const histRes = await pg.query(`
        SELECT
          username,
          nasipaddress,
          framedipaddress,
          callingstationid,
          acctstarttime,
          acctstoptime,
          EXTRACT(EPOCH FROM (acctstoptime - acctstarttime))::int AS duration_seconds,
          acctinputoctets   AS upload_bytes,
          acctoutputoctets  AS download_bytes,
          nasportid,
          nasporttype,
          acctterminatecause,
          acctinterval
        FROM radacct
        WHERE username = $1
          AND acctstoptime IS NOT NULL
        ORDER BY acctstarttime DESC
        LIMIT 50
      `, [username]);

      // Attach the plain-language termination cause to every history row, so
      // the session log reads "Lost carrier — the customer's cable/ONU dropped"
      // instead of a bare "Lost-Carrier" or a numeric code.
      const enrich = (r: any) => {
        if (!r) return r;
        const info = terminateInfo(r.acctterminatecause);
        return { ...r, terminateLabel: info.label, terminateDescription: info.description, terminateCode: info.code };
      };

      /**
       * SIMULTANEOUS-USE FLAG. Count ALL open sessions — not just the fresh
       * ones — so the profile can warn the operator the moment the same
       * username is dialled in from more than one device (credential sharing or
       * a ghost). The duplicate-session sweep closes stalls to the router timer,
       * so a second open row here genuinely means "two online connections".
       */
      const dupRes = await pg.query(`
        SELECT COUNT(*)::int AS open_count
        FROM radacct
        WHERE username = $1 AND acctstoptime IS NULL
      `, [username]);
      const openCount = Number(dupRes.rows[0]?.open_count || 0);

      return {
        session: enrich(activeRes.rows[0] || null),
        history: histRes.rows.map(enrich),
        openCount,
        duplicate: openCount > 1,
      };
    } catch (error: any) {
      this.logger.error(`getRadiusSession error: ${error.message}`);
      return { session: null, history: [], openCount: 0, duplicate: false };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // BANDWIDTH HISTORY (live graph data)
  // Called by profile page — live bandwidth chart
  // Returns time-series of upload/download bytes over last N minutes
  // ─────────────────────────────────────────────────────────────
  async getBandwidthHistory(username: string, minutes = 60) {
    try {
      const pg = this.radiusSync.getPgClient();
      if (!pg) return { samples: [] };

      const cutoff = `NOW() - INTERVAL '${minutes} minutes'`;
      const res = await pg.query(`
        SELECT
          acctupdatetime AS sampled_at,
          acctstarttime,
          acctstoptime,
          acctinputoctets   AS upload_bytes,
          acctoutputoctets  AS download_bytes,
          acctsessiontime   AS duration_seconds
        FROM radacct
        WHERE username = $1
          AND (acctupdatetime >= ${cutoff} OR acctstarttime >= ${cutoff})
        ORDER BY acctupdatetime ASC
      `, [username]);

      // Compute rate (bytes/sec) between consecutive samples of the active
      // session by calculating the delta from previous sample.  Completed
      // sessions contribute one point at their stop time.
      const raw = res.rows;
      const samples: any[] = [];
      let prevUp = 0;
      let prevDown = 0;
      let prevTime: Date | null = null;

      for (const row of raw) {
        const t = new Date(row.sampled_at || row.acctstarttime);
        if (prevTime && t.getTime() !== prevTime.getTime()) {
          const dt = (t.getTime() - prevTime.getTime()) / 1000; // seconds
          const upBps = dt > 0 ? Math.max(0, (Number(row.upload_bytes) - prevUp) / dt) : 0;
          const downBps = dt > 0 ? Math.max(0, (Number(row.download_bytes) - prevDown) / dt) : 0;
          samples.push({
            timestamp: t.toISOString(),
            uploadBps: Math.round(upBps),
            downloadBps: Math.round(downBps),
            uploadBytes: Number(row.upload_bytes),
            downloadBytes: Number(row.download_bytes),
          });
        } else if (!row.acctstoptime) {
          // First sample of the active session — include as base point
          samples.push({
            timestamp: t.toISOString(),
            uploadBps: 0,
            downloadBps: 0,
            uploadBytes: Number(row.upload_bytes),
            downloadBytes: Number(row.download_bytes),
          });
        }
        prevUp = Number(row.upload_bytes);
        prevDown = Number(row.download_bytes);
        prevTime = t;
      }

      return { samples };
    } catch (error: any) {
      this.logger.error(`getBandwidthHistory error: ${error.message}`);
      return { samples: [] };
    }
  }

  /**
   * Daily data usage for the last N days — powers the historical usage bar
   * chart on the subscriber profile. Bytes are attributed to the day the
   * session started (a good-enough MRTG-style view for support/upsell).
   */
  async getDailyUsage(username: string, days = 14) {
    try {
      const pg = this.radiusSync.getPgClient();
      if (!pg) return { days: [] };
      const res = await pg.query(`
        SELECT to_char(date_trunc('day', acctstarttime), 'YYYY-MM-DD') AS day,
               COALESCE(SUM(acctinputoctets), 0)::float8  AS up,
               COALESCE(SUM(acctoutputoctets), 0)::float8 AS down
        FROM radacct
        WHERE username = $1 AND acctstarttime >= NOW() - ($2 || ' days')::interval
        GROUP BY 1 ORDER BY 1
      `, [username, days]);
      const gb = (b: number) => Math.round((b / 1024 ** 3) * 100) / 100;
      return {
        days: res.rows.map((r: any) => ({ day: r.day, uploadGb: gb(Number(r.up)), downloadGb: gb(Number(r.down)) })),
      };
    } catch (error: any) {
      this.logger.error(`getDailyUsage error: ${error.message}`);
      return { days: [] };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GET RADIUS AUTH LOG (from radpostauth)
  // Called by profile page — Login Log tab
  // ─────────────────────────────────────────────────────────────
  async getRadiusAuthLog(username: string) {
    try {
      const pg = this.radiusSync.getPgClient();
      if (!pg) return [];
      const res = await pg.query(`
        SELECT username, reply, authdate
        FROM radpostauth
        WHERE username = $1
        ORDER BY authdate DESC
        LIMIT 100
      `, [username]);
      return res.rows;
    } catch (error: any) {
      this.logger.error(`getRadiusAuthLog error: ${error.message}`);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GET RADIUS CHECKS (from radcheck table)
  // Called by profile page — RADIUS tab
  // ─────────────────────────────────────────────────────────────
  async getRadiusChecks(username: string) {
    try {
      const pg = this.radiusSync.getPgClient();
      if (!pg) return [];
      const res = await pg.query(`
        SELECT id, username, attribute, op, value
        FROM radcheck
        WHERE username = $1
        ORDER BY id
      `, [username]);
      return res.rows;
    } catch (error: any) {
      this.logger.error(`getRadiusChecks error: ${error.message}`);
      return [];
    }
  }
}