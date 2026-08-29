import {
  Injectable, Logger, NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { SubscribersService } from '../subscribers/subscribers.service';
import { NetworkService } from '../network/network.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';
import { isPrimaryInstance } from '../common/cluster-util';
import { CurrencyService } from '../common/currency.service';

/**
 * StaticIpService — allocation, billing and lifecycle of routable addresses.
 *
 * Static IPs are usually tracked in a spreadsheet, which fails in three
 * expensive ways: nobody knows which addresses are free, allocations expire
 * and keep working for free, and when abuse is reported months later nobody
 * can say who held the address at the time.
 *
 * This fixes all three — a live status per address, an expiry sweep, and an
 * immutable assignment history.
 */
@Injectable()
export class StaticIpService {
  private readonly logger = new Logger(StaticIpService.name);

  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
    private subscribers: SubscribersService,
    private network: NetworkService,
    private notifications: NotificationsService,
    private mikrotik: MikrotikSyncService,
    private currency: CurrencyService,
  ) {}

  // ── Read ─────────────────────────────────────────────────────
  async findAll(actor?: Actor, query: any = {}) {
    const filters: any[] = [];
    if (query.status && query.status !== 'ALL') filters.push({ status: query.status });
    if (query.nasId) filters.push({ nasId: Number(query.nasId) });
    if (query.q) {
      filters.push({
        OR: [
          { ipAddress: { contains: String(query.q) } },
          { notes: { contains: String(query.q), mode: 'insensitive' } },
        ],
      });
    }

    // PRIVACY: a reseller sees addresses allocated to ITS OWN customers, plus
    // the free pool it may allocate from — never who else holds an address.
    //
    // The scope must be AND-ed with the search, not merged into the same OR.
    // Merging them meant a search matched addresses outside the caller's scope,
    // leaking other branches' customers.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      filters.push({
        OR: [
          { subscriber: { userId: { in: ids } } },
          { status: 'AVAILABLE' },
        ],
      });
    }

    const where: any = filters.length ? { AND: filters } : {};

    return this.prisma.staticIp.findMany({
      where,
      include: {
        subscriber: { select: { id: true, fullName: true, username: true, phone: true, userId: true } },
        nas: { select: { id: true, nasname: true, nasIp: true } },
      },
      orderBy: { ipAddress: 'asc' },
      take: Number(query.limit) || 1000,
    });
  }

  /** Pool health + what static IPs actually earn. */
  async stats(actor?: Actor) {
    // SECURITY: this accepted `actor` and ignored it, so a dealer saw the
    // ISP's entire static-IP pool and its total monthly revenue — including
    // addresses sold by other dealers. Everything below is now restricted to
    // addresses held by the caller's own subscribers.
    const scoped: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      scoped.subscriber = { userId: { in: ids } };
    }
    // Named `assignedWhere` because `assigned` further down is the COUNT of
    // assigned addresses. Two different things; one name was a redeclaration.
    const assignedWhere = { ...scoped, status: 'ASSIGNED' as const };

    const [byStatus, revenue, expiringSoon, expired] = await Promise.all([
      this.prisma.staticIp.groupBy({ by: ['status'], _count: { _all: true }, where: scoped }),
      this.prisma.staticIp.aggregate({
        where: assignedWhere,
        _sum: { monthlyPrice: true },
      }),
      this.prisma.staticIp.count({
        where: {
          ...assignedWhere,
          expiresAt: { gte: new Date(), lte: new Date(Date.now() + 30 * 86400_000) },
        },
      }),
      this.prisma.staticIp.count({
        where: { ...assignedWhere, expiresAt: { lt: new Date() } },
      }),
    ]);

    const m: Record<string, number> = {};
    byStatus.forEach((s) => (m[s.status] = s._count._all));
    const total = Object.values(m).reduce((a, b) => a + b, 0);
    const assigned = m.ASSIGNED ?? 0;

    return {
      total,
      available: m.AVAILABLE ?? 0,
      assigned,
      reserved: m.RESERVED ?? 0,
      blocked: m.BLOCKED ?? 0,
      expiredStatus: m.EXPIRED ?? 0,
      // Utilisation tells you when to buy more address space.
      utilisationPercent: total > 0 ? Math.round((assigned / total) * 1000) / 10 : 0,
      monthlyRevenue: Math.round((revenue._sum.monthlyPrice || 0) * 100) / 100,
      expiringIn30Days: expiringSoon,
      // Still allocated past their end date — free service being given away.
      overdue: expired,
    };
  }

  async findOne(id: number, actor?: Actor) {
    const ip = await this.prisma.staticIp.findUnique({
      where: { id },
      include: {
        subscriber: { select: { id: true, fullName: true, username: true, phone: true, userId: true } },
        nas: { select: { id: true, nasname: true } },
        history: { orderBy: { assignedAt: 'desc' }, take: 50 },
      },
    });
    if (!ip) throw new NotFoundException(`Static IP ${id} not found`);

    // PRIVACY: an allocated address may only be read by the ISP or by someone
    // in the holder's own branch. Free addresses are readable by anyone who can
    // allocate. Without this, any logged-in reseller could enumerate addresses
    // by id and see which customer in another branch holds each one.
    if (actor && !this.scope.isAdmin(actor.role) && ip.subscriberId) {
      await this.scope.assertSubscriber(actor, ip.subscriberId);
    }

    // Attach names to the history so it reads properly.
    const subIds = [...new Set(ip.history.map((h) => h.subscriberId))];
    const subs = subIds.length
      ? await this.prisma.subscriber.findMany({
          where: { id: { in: subIds } },
          select: { id: true, fullName: true, username: true },
        })
      : [];
    const byId = new Map(subs.map((s) => [s.id, s]));

    return {
      ...ip,
      history: ip.history.map((h) => ({ ...h, subscriber: byId.get(h.subscriberId) ?? null })),
    };
  }

  // ── Write ────────────────────────────────────────────────────
  async create(data: any) {
    const ip = String(data.ipAddress || '').trim();
    if (!this.isIpv4(ip)) throw new BadRequestException(`"${ip}" is not a valid IPv4 address.`);

    const exists = await this.prisma.staticIp.findUnique({ where: { ipAddress: ip } });
    if (exists) throw new ConflictException(`${ip} is already in the pool.`);

    return this.prisma.staticIp.create({
      data: {
        ipAddress: ip,
        gateway: data.gateway?.trim() || null,
        subnetMask: data.subnetMask || '255.255.255.255',
        nasId: data.nasId ? Number(data.nasId) : null,
        monthlyPrice: data.monthlyPrice ? Number(data.monthlyPrice) : null,
        status: data.status || 'AVAILABLE',
        notes: data.notes || null,
      },
    });
  }

  /**
   * Add a whole range at once — you buy address space in blocks, not one at a
   * time. Skips anything already present so it can be re-run safely.
   */
  async createRange(data: {
    startIp: string; endIp: string; gateway?: string;
    nasId?: number; monthlyPrice?: number; reserveFirst?: boolean;
  }) {
    const start = this.ipToInt(data.startIp);
    const end = this.ipToInt(data.endIp);
    if (start === null || end === null) throw new BadRequestException('Invalid start or end address.');
    if (end < start) throw new BadRequestException('End address must be after the start.');
    if (end - start > 1024) {
      throw new BadRequestException('Range too large — add at most 1024 addresses at a time.');
    }

    const created: string[] = [];
    const skipped: string[] = [];

    for (let n = start; n <= end; n++) {
      const ip = this.intToIp(n);
      try {
        await this.prisma.staticIp.create({
          data: {
            ipAddress: ip,
            gateway: data.gateway || null,
            nasId: data.nasId ? Number(data.nasId) : null,
            monthlyPrice: data.monthlyPrice ? Number(data.monthlyPrice) : null,
            // The first address of a block is nearly always the gateway.
            status: data.reserveFirst && n === start ? 'RESERVED' : 'AVAILABLE',
          },
        });
        created.push(ip);
      } catch {
        skipped.push(ip); // already exists
      }
    }

    this.logger.log(`Static IP range: ${created.length} added, ${skipped.length} already present`);
    return { added: created.length, skipped: skipped.length, from: data.startIp, to: data.endIp };
  }

  /**
   * Allocate an address to a customer.
   *
   * Also pushes it to RADIUS, because an allocation the network doesn't know
   * about is just a database row — the customer would still get a pool address.
   */
  async assign(
    id: number,
    body: { subscriberId: number; monthlyPrice?: number; expiresAt?: string; notes?: string },
    actor?: Actor,
  ) {
    const ip = await this.prisma.staticIp.findUnique({ where: { id } });
    if (!ip) throw new NotFoundException(`Static IP ${id} not found`);
    if (ip.status === 'BLOCKED') {
      throw new BadRequestException('This address is blocked and cannot be allocated.');
    }
    if (ip.subscriberId && ip.subscriberId !== Number(body.subscriberId)) {
      throw new ConflictException(
        `${ip.ipAddress} is already allocated. Release it first so the history stays accurate.`,
      );
    }
    if (actor) await this.scope.assertSubscriber(actor, Number(body.subscriberId));

    // ── NETWORK VALIDATION — before ANY row is written ─────────────
    // The address must be routable on the subscriber's NAS, the gateway must
    // be sane, and no OTHER subscriber may already be configured with this
    // exact address. Rejecting here (instead of after the row is saved) means
    // a bad allocation never half-happens: no register entry, no radreply,
    // no session cut that was never needed.
    const target = Number(body.subscriberId);
    const oldSettings = await this.prisma.serviceSettings.findUnique({
      where: { subscriberId: target },
      select: { ipAddress: true, ipType: true },
    });
    const oldStatic = oldSettings?.ipType === 'STATIC' ? (oldSettings.ipAddress ?? null) : null;
    const nasLabel = await this.validateIpForNas(ip.ipAddress, target, ip.gateway);
    const other = await this.prisma.serviceSettings.findFirst({
      where: { ipType: 'STATIC', ipAddress: ip.ipAddress, subscriberId: { not: target } },
      select: { subscriberId: true },
    });
    if (other) {
      throw new ConflictException(
        `${ip.ipAddress} is already configured as the static address of another subscriber (#${other.subscriberId}). ` +
          `Release it there first — two customers on one address will not work.`,
      );
    }

    const updated = await this.prisma.staticIp.update({
      where: { id },
      data: {
        subscriberId: Number(body.subscriberId),
        status: 'ASSIGNED',
        assignedAt: new Date(),
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        monthlyPrice: body.monthlyPrice !== undefined ? Number(body.monthlyPrice) : ip.monthlyPrice,
        notes: body.notes ?? ip.notes,
        // Start the recurring charge a month out. Re-assigning the same
        // address to the same customer keeps the existing date so nobody is
        // billed twice for editing a note.
        nextBillingDate:
          ip.subscriberId === Number(body.subscriberId) && ip.nextBillingDate
            ? ip.nextBillingDate
            : new Date(Date.now() + 30 * 86400_000),
      },
      include: { subscriber: { select: { id: true, fullName: true, username: true } } },
    });

    await this.prisma.staticIpAssignment.create({
      data: {
        staticIpId: id,
        subscriberId: Number(body.subscriberId),
        monthlyPrice: updated.monthlyPrice,
        assignedById: actor ? this.scope.actorId(actor) : null,
      },
    });

    // Mirror onto the subscriber's service settings, then push to RADIUS so the
    // address is actually handed out on the next connection.
    let syncOk = true;
    let syncError: string | null = null;
    try {
      await this.prisma.serviceSettings.upsert({
        where: { subscriberId: Number(body.subscriberId) },
        update: { ipAddress: updated.ipAddress, ipType: 'STATIC' },
        create: { subscriberId: Number(body.subscriberId), ipAddress: updated.ipAddress, ipType: 'STATIC' },
      });
      await this.subscribers.syncToRadius(Number(body.subscriberId));
    } catch (e: any) {
      syncOk = false;
      syncError = e?.message || String(e);
      this.logger.error(`Allocated ${updated.ipAddress} but RADIUS sync failed: ${syncError}`);
    }

    // NEVER disconnect a customer whose RADIUS profile did not write.
    //
    // syncSubscriberProfile clears radcheck and radreply before rewriting them.
    // If it fails partway the customer has no credentials left, so kicking them
    // here would put them offline with no way back in — they would sit dead
    // until somebody noticed. Leaving the session up is always the safer
    // failure: they keep working on the pool address and the new IP applies
    // once the sync is repaired.
    if (!syncOk) {
      return {
        ...updated,
        reconnected: false,
        releasedAddress: null,
        method: 'skipped',
        warning:
          `${updated.ipAddress} is recorded, but the RADIUS profile did not write (${syncError}). ` +
          `The customer has been left connected on their current address. ` +
          `Fix RADIUS, then use Sync to RADIUS on the subscriber to apply it.`,
      };
    }

    // Tear down the pool session so the old address goes back to the router's
    // pool and the new one is live. See releasePoolAddress for why this is
    // more than a single disconnect call.
    const release = await this.releasePoolAddress(
      Number(body.subscriberId),
      updated.subscriber!.username,
      updated.ipAddress,
    );

    // AUDIT (spec: actor / subscriber / old / new / NAS / timestamp / result / error).
    // The register row is duplicated here into the log even on failure — a
    // change that did not fully apply must be just as visible as one that did.
    await this.audit(
      oldStatic && oldStatic !== updated.ipAddress ? 'STATIC_IP_CHANGED' : 'STATIC_IP_ASSIGNED',
      {
        subscriberId: target,
        username: updated.subscriber!.username,
        oldValue: oldStatic,
        newValue: updated.ipAddress,
        nas: nasLabel ?? release.nasLabel ?? null,
        actor,
        result: syncOk
          ? release.reconnected
            ? release.applied === true
              ? 'verified-live'
              : release.applied === false
                ? 'mismatch'
                : 'disconnected-unverified'
            : 'applies-on-next-connect'
          : 'radius-sync-failed',
        error: !syncOk ? syncError ?? 'RADIUS sync failed' : (release.warning ?? null),
        extra: {
          radiusSync: syncOk ? 'ok' : 'failed',
          pinnedOnRouter: release.pinnedOnRouter ?? null,
          verifiedAddress: release.verifiedAddress ?? null,
        },
      },
    );

    this.logger.log(
      `Static IP ${updated.ipAddress} → ${updated.subscriber?.username}` +
        (release.reconnected
          ? ` (pool address ${release.releasedAddress ?? 'n/a'} released, live now)`
          : ' (applies on next connection)'),
    );
    return { ...updated, ...release, nasLabel };
  }

  /**
   * Hand the customer's pool address back to the router.
   *
   * Giving someone a static IP is only half the job — until the old session
   * dies the router is still holding a pool address for them, and the customer
   * is still USING it. Two things have to happen, in order:
   *
   *   1. The PPP secret's remote-address is cleared. MikroTik prefers a
   *      secret-level address over anything RADIUS sends, so a stale binding
   *      here silently overrides the new static IP and the change looks like
   *      it did nothing.
   *   2. The session is torn down. CoA is tried first; if radclient isn't
   *      available or the NAS ignores it, we fall back to the MikroTik API and
   *      remove the active connection directly. The pool address is freed by
   *      the router the moment the session ends.
   *
   * A CoA that silently fails is the dangerous case: the panel would report
   * success while the customer stayed on the pool address indefinitely.
   */
  private async releasePoolAddress(subscriberId: number, username: string, newIp: string) {
    // Capture what they are holding right now, before anything is torn down.
    const live = await this.prisma.$queryRaw<Array<any>>`
      SELECT acctsessionid, nasipaddress, framedipaddress
        FROM radacct
       WHERE username = ${username} AND acctstoptime IS NULL
       ORDER BY acctstarttime DESC LIMIT 1`;
    const releasedAddress: string | null = live[0]?.framedipaddress ?? null;

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { nas: true },
    });
    const nas = sub?.nas;
    const nasLabel = nas ? (nas.nasname ?? nas.nasIp ?? null) : null;

    const hasApi = !!(nas?.nasIp && nas.apiUsername && nas.apiPassword);

    // 1. Make the ROUTER agree with RADIUS about the address.
    //
    // Writing Framed-IP-Address into radreply is not enough on its own: if a
    // local /ppp/secret exists, MikroTik authenticates the customer itself and
    // never asks RADIUS, so the reply attribute is never read and they land on
    // the profile pool again on every reconnect. Pinning the secret to the same
    // address closes that gap — whichever way the session is authorised, the
    // customer gets this IP.
    let pinnedOnRouter = false;
    if (hasApi) {
      pinnedOnRouter = await this.mikrotik.setSecretRemoteAddress(
        // hasApi above guarantees nasIp/apiUsername/apiPassword are set.
        nas.nasIp!, nas.apiPort ?? 8728, nas.apiUsername!, nas.apiPassword!, username, newIp,
      ).catch(() => false);
    }

    // 2. Tear the session down. network.disconnect now falls back to the
    //    MikroTik API by itself and throws rather than reporting a disconnect
    //    that did not happen, so there is no second attempt to make here.
    let reconnected = false;
    let method = 'none';
    try {
      const r = await this.network.disconnect(username);
      reconnected = true;
      method = r?.method ?? 'coa';
    } catch (e: any) {
      // Either they were offline (fine — the address applies on next dial-in)
      // or the cut genuinely failed, which the caller needs to hear about.
      this.logger.warn(`Session for ${username} not cut: ${e?.message || e}`);
    }

    // 3. VERIFY rather than assume. Ask the router what address the customer
    //    actually holds now; if they are back online on the old pool address
    //    the operator must be told, not shown a success message.
    let verifiedAddress: string | null = null;
    if (hasApi && reconnected) {
      await new Promise((r) => setTimeout(r, 4000)); // let them redial
      verifiedAddress = await this.mikrotik.getActiveAddress(
        nas.nasIp!, nas.apiPort ?? 8728, nas.apiUsername!, nas.apiPassword!, username,
      );
      if (verifiedAddress && verifiedAddress !== newIp) {
        // IP MISMATCH DETECTED — durable, not just a log line. The panel must
        // never silently believe a static IP took effect when the router is
        // handing out something else.
        this.logger.warn(
          `${username} reconnected on ${verifiedAddress}, not ${newIp}. ` +
            `Check that the PPP profile does not force a remote-address pool.`,
        );
        await this.prisma.systemLog.create({
          data: {
            level: 'ERROR',
            source: 'static-ip',
            message:
              `IP MISMATCH: "${username}" reconnected on ${verifiedAddress}, expected static ${newIp} on ${nasLabel ?? nas?.nasIp ?? 'unknown NAS'}.`,
            metadata: JSON.stringify({
              username, subscriberId,
              expected: newIp, actual: verifiedAddress,
              nas: nasLabel ?? nas?.nasIp ?? null,
              pinnedOnRouter,
              timestamp: new Date().toISOString(),
            }),
          },
        }).catch(() => null);
      }
    }

    if (releasedAddress && reconnected) {
      await this.prisma.activityLog.create({
        data: {
          action: 'POOL_IP_RELEASED',
          entity: 'StaticIp',
          details: `${username}: pool address ${releasedAddress} released for static ${newIp} (via ${method})`,
        },
        }).catch(() => null);
    }

    return {
      reconnected,
      releasedAddress,
      method,
      pinnedOnRouter,
      verifiedAddress,
      nasLabel,
      // Only claim the address is live when the router says so.
      applied: verifiedAddress ? verifiedAddress === newIp : null,
      warning:
        verifiedAddress && verifiedAddress !== newIp
          ? `The customer reconnected on ${verifiedAddress} instead of ${newIp}. ` +
            `The PPP profile on ${nas?.nasname ?? 'the router'} is most likely forcing a ` +
            `remote-address pool, which overrides both RADIUS and the secret.`
          : !reconnected && releasedAddress
            ? `${username} is still online on ${releasedAddress} — the session could not be cut, ` +
              `so ${newIp} will only apply when they next reconnect.`
            : null,
    };
  }

  /**
   * Set a live static IP directly on a subscriber by typing the address.
   *
   * This is the path used from the subscriber page. Routing is handled on the
   * MikroTik, so no validation beyond the address format is attempted here —
   * if the operator says the address is theirs, it is theirs.
   *
   * The pool record is created on the fly when the address isn't already
   * known, so the Static IPs page still ends up with a complete register and
   * assignment history without anyone having to pre-load the block.
   */
  async setForSubscriber(
    subscriberId: number,
    body: { ipAddress: string; monthlyPrice?: number; gateway?: string; nasId?: number; notes?: string },
    actor?: Actor,
  ) {
    const ip = String(body.ipAddress || '').trim();
    if (!this.isIpv4(ip)) throw new BadRequestException(`"${ip}" is not a valid IPv4 address.`);
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const existing = await this.prisma.staticIp.findUnique({
      where: { ipAddress: ip },
      include: { subscriber: { select: { id: true, username: true } } },
    });

    if (existing?.subscriberId && existing.subscriberId !== subscriberId) {
      throw new ConflictException(
        `${ip} is already on ${existing.subscriber?.username}. Remove it there first — two customers on one address will not work.`,
      );
    }
    if (existing?.status === 'BLOCKED') {
      throw new BadRequestException(`${ip} is marked blocked and cannot be given out.`);
    }

    // Anything the subscriber currently holds is released first, so the
    // register never shows one customer on two addresses.
    const held = await this.prisma.staticIp.findMany({
      where: { subscriberId, ipAddress: { not: ip } },
    });
    for (const h of held) {
      await this.release(h.id, 'Replaced by a new address', actor).catch(() => null);
    }

    const record = existing
      ? existing
      : await this.prisma.staticIp.create({
          data: {
            ipAddress: ip,
            gateway: body.gateway?.trim() || null,
            nasId: body.nasId ? Number(body.nasId) : null,
            status: 'AVAILABLE',
            notes: body.notes || 'Added from the subscriber page',
          },
        });

    return this.assign(
      record.id,
      { subscriberId, monthlyPrice: body.monthlyPrice, notes: body.notes },
      actor,
    );
  }

  /** Whatever address this subscriber currently holds, if any. */
  async forSubscriber(subscriberId: number, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);
    return this.prisma.staticIp.findFirst({
      where: { subscriberId },
      include: {
        nas: { select: { id: true, nasname: true, nasIp: true } },
        history: { orderBy: { assignedAt: 'desc' }, take: 10 },
      },
    });
  }

  /** Return an address to the pool and close its history entry. */
  async release(id: number, reason?: string, actor?: Actor) {
    const ip = await this.prisma.staticIp.findUnique({ where: { id } });
    if (!ip) throw new NotFoundException(`Static IP ${id} not found`);
    if (!ip.subscriberId) return ip;

    const subscriberId = ip.subscriberId;

    await this.prisma.staticIpAssignment.updateMany({
      where: { staticIpId: id, subscriberId, releasedAt: null },
      data: { releasedAt: new Date(), releaseReason: reason || 'Released' },
    });

    const updated = await this.prisma.staticIp.update({
      where: { id },
      data: {
        subscriberId: null, status: 'AVAILABLE', assignedAt: null, expiresAt: null,
        // Stop the recurring charge — a released address must never keep billing.
        nextBillingDate: null, lastBilledAt: null,
      },
    });

    // Drop it from the customer's profile and RADIUS, or they would keep the
    // address the panel now believes is free.
    try {
      await this.prisma.serviceSettings.updateMany({
        where: { subscriberId },
        data: { ipAddress: null, ipType: 'DYNAMIC' },
      });
      await this.subscribers.syncToRadius(subscriberId);
    } catch { /* non-fatal */ }

    // The mirror image of assignment: RADIUS now says "use the pool", but the
    // live session is still on the static address. Without a kick the customer
    // keeps an address the panel has already marked AVAILABLE — and it could
    // be handed to somebody else, putting two customers on one IP.
    const holder = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { username: true, nas: true },
    }).catch(() => null) as any;
    const nas = holder?.nas;
    const nasLabel = nas ? (nas.nasname ?? nas.nasIp ?? null) : null;

    let disconnectResult: string | null = null;
    try {
      if (holder?.username && nas?.nasIp && nas.apiUsername && nas.apiPassword) {
        // Un-pin the router first. A secret still carrying remote-address =
        // the released IP would keep handing it out no matter what RADIUS says,
        // and the address is now marked AVAILABLE for someone else — two
        // customers on one IP.
        await this.mikrotik.clearSecretRemoteAddress(
          nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, holder.username,
        ).catch(() => null);
      }
      if (holder?.username) {
        await this.network.disconnect(holder.username);
        disconnectResult = 'session-cut'; // disconnect() only returns once verified
      }
    } catch (e: any) {
      // Either they were offline (fine — they pick up a pool address when they
      // next dial in) or the cut is still in flight. Either way the DB + RADIUS
      // state is already DYNAMIC; the audit entry records what actually happened.
      disconnectResult = `session-not-cut: ${e?.message || e}`;
    }

    // AUDIT: removal is the mirror image of assignment — old address, new
    // (none), who did it, and what the network actually did in response.
    await this.audit('STATIC_IP_REMOVED', {
      subscriberId,
      username: holder?.username ?? null,
      oldValue: ip.ipAddress,
      newValue: null,
      nas: nasLabel,
      actor,
      result: disconnectResult ?? 'unknown',
      error: null,
    });

    return updated;
  }

  async update(id: number, data: any, actor?: Actor) {
    await this.findOne(id, actor); // privacy + existence check
    return this.prisma.staticIp.update({
      where: { id },
      data: {
        gateway: data.gateway,
        subnetMask: data.subnetMask,
        monthlyPrice: data.monthlyPrice !== undefined ? Number(data.monthlyPrice) : undefined,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        status: data.status,
        notes: data.notes,
        nasId: data.nasId !== undefined ? (data.nasId ? Number(data.nasId) : null) : undefined,
      },
    });
  }

  async remove(id: number, actor?: Actor) {
    const ip = await this.findOne(id, actor);
    if (ip.subscriberId) {
      throw new BadRequestException('Release this address from its customer before deleting it.');
    }
    await this.prisma.staticIp.delete({ where: { id } });
    return { deleted: true, id };
  }

  /**
   * Daily expiry sweep.
   *
   * An allocation past its end date is free service — the customer keeps a paid
   * address nobody is billing for. Flag them rather than auto-releasing, since
   * yanking a business customer's IP without warning causes more damage than
   * the lost revenue.
   */
  @Cron('30 3 * * *')
  async expirySweep() {
    // CLUSTER GUARD — background work must run on ONE process only.
    // Without this the cron fired on every pm2 instance (11 web + 1 worker
    // = 12 concurrent runs of the same job), which duplicated side effects
    // and flooded the logs with identical rows.
    if (!isPrimaryInstance()) return;
    try {
      const overdue = await this.prisma.staticIp.findMany({
        where: { status: 'ASSIGNED', expiresAt: { lt: new Date() } },
        include: { subscriber: { select: { fullName: true, username: true } } },
      });
      if (!overdue.length) return;

      await this.prisma.staticIp.updateMany({
        where: { id: { in: overdue.map((i) => i.id) } },
        data: { status: 'EXPIRED' },
      });

      this.logger.warn(
        `${overdue.length} static IP allocation(s) expired and are still in use: ` +
          overdue.map((i) => `${i.ipAddress} (${i.subscriber?.username ?? '?'})`).join(', '),
      );
      return { expired: overdue.length };
    } catch (e: any) {
      this.logger.warn(`Static IP expiry sweep failed: ${e?.message || e}`);
    }
  }

  /**
   * Monthly charge for every assigned address.
   *
   * A static IP is an add-on sold on its own recurring cycle, deliberately
   * separate from the package renewal — a customer can be mid-package and
   * still owe this month's IP charge. Runs daily and picks up anything whose
   * date has come, so a missed day is caught the next morning rather than
   * skipped for a month.
   */
  @Cron('45 3 * * *')
  async billRenewals() {
    // CLUSTER GUARD — background work must run on ONE process only.
    // Without this the cron fired on every pm2 instance (11 web + 1 worker
    // = 12 concurrent runs of the same job), which duplicated side effects
    // and flooded the logs with identical rows.
    if (!isPrimaryInstance()) return;
    try {
      const due = await this.prisma.staticIp.findMany({
        where: {
          status: 'ASSIGNED',
          autoRenew: true,
          subscriberId: { not: null },
          monthlyPrice: { gt: 0 },
          nextBillingDate: { lte: new Date() },
        },
        include: { subscriber: { select: { id: true, fullName: true, username: true, phone: true } } },
      });
      if (!due.length) return { billed: 0 };

      let billed = 0;
      for (const ip of due) {
        try {
          const price = Number(ip.monthlyPrice);
          const invoice = await this.prisma.invoice.create({
            data: {
              ...(await this.currency.invoiceStamp()),
              invoiceNo: `SIP-${Date.now()}-${ip.id}`,
              subscriberId: ip.subscriberId!,
              amount: price,
              total: price,
              paidAmount: 0,
              dueAmount: price,
              dueDate: new Date(Date.now() + 7 * 86400_000),
              status: 'UNPAID',
              notes: `Static IP ${ip.ipAddress} — monthly charge`,
              items: {
                create: [{
                  description: `Static public IP ${ip.ipAddress}`,
                  quantity: 1, unitPrice: price, total: price,
                }],
              },
            },
          });

          // Advance from the date that was due, not from today — otherwise a
          // sweep that runs late would quietly shorten every future cycle.
          const next = new Date(ip.nextBillingDate!);
          next.setDate(next.getDate() + 30);

          await this.prisma.staticIp.update({
            where: { id: ip.id },
            data: { nextBillingDate: next, lastBilledAt: new Date() },
          });

          if (ip.subscriber?.phone) {
            void this.notifications.send({
              channel: 'SMS',
              recipient: ip.subscriber.phone,
              body: `Monthly charge for your static IP ${ip.ipAddress} is due. Invoice ${invoice.invoiceNo}.`,
              subscriberId: ip.subscriberId!,
              event: 'STATIC_IP_RENEWAL',
            }).catch((e) => { this.logger?.warn?.('sendBillingNotification: ' + (e?.message || e)); });
          }
          billed++;
        } catch (e: any) {
          this.logger.warn(`Static IP billing failed for ${ip.ipAddress}: ${e?.message || e}`);
        }
      }

      this.logger.log(`Static IP renewals: ${billed} charge(s) raised`);
      return { billed };
    } catch (e: any) {
      this.logger.warn(`Static IP renewal sweep failed: ${e?.message || e}`);
      return { billed: 0 };
    }
  }

  /**
   * Feeds the banner at the top of the app — what is overdue, due today, and
   * coming up in the next week.
   */
  async renewalAlerts(actor?: Actor) {
    const where: any = { status: { in: ['ASSIGNED', 'EXPIRED'] }, subscriberId: { not: null } };
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.subscriber = {
        userId: { in: await this.scope.descendantIds(await this.scope.rootId(actor)) },
      };
    }

    const soon = new Date(Date.now() + 7 * 86400_000);
    const rows = await this.prisma.staticIp.findMany({
      where: { ...where, OR: [{ nextBillingDate: { lte: soon } }, { expiresAt: { lte: soon } }] },
      include: { subscriber: { select: { id: true, fullName: true, username: true } } },
      orderBy: { nextBillingDate: 'asc' },
      take: 100,
    });

    const now = Date.now();
    const map = (r: any) => ({
      id: r.id,
      ipAddress: r.ipAddress,
      subscriberId: r.subscriberId,
      customer: r.subscriber?.fullName,
      username: r.subscriber?.username,
      monthlyPrice: r.monthlyPrice,
      nextBillingDate: r.nextBillingDate,
      expiresAt: r.expiresAt,
      daysUntilBilling: r.nextBillingDate
        ? Math.ceil((new Date(r.nextBillingDate).getTime() - now) / 86400_000)
        : null,
    });

    const all = rows.map(map);
    return {
      overdue: all.filter((r) => r.daysUntilBilling !== null && r.daysUntilBilling < 0),
      dueToday: all.filter((r) => r.daysUntilBilling === 0),
      dueSoon: all.filter((r) => r.daysUntilBilling !== null && r.daysUntilBilling > 0),
      expired: rows.filter((r) => r.expiresAt && new Date(r.expiresAt) < new Date()).map(map),
      monthlyRecurring: all.reduce((s, r) => s + Number(r.monthlyPrice || 0), 0),
    };
  }

  // ── helpers ──────────────────────────────────────────────────

  /**
   * NETWORK VALIDATION (spec: "A static IP must belong to a network/subnet
   * compatible with the subscriber's NAS/service").
   *
   * This is where the panel stops an allocation the network could never hand
   * out, instead of recording it in the database and pretending. Three layers:
   *
   *   1. Format — valid, routable public/private IPv4 (not loopback, multicast,
   *      network-zero, broadcast).
   *   2. Not the NAS itself — the router's own IP can never be a customer's.
   *   3. Compatibility — the address must be inside one of the NAS's registered
   *      IP pools (the routable customer space) OR share the NAS's own /24
   *      (PPPoE service subnets are frequently not registered as pools; if the
   *      router lives at 192.168.88.17, 192.168.88.151 is local to it even
   *      when no pool row exists). Anything else is rejected with the exact
   *      failure an operator can act on, rather than a silently-routed-mismatch.
   *
   * Returns the NAS label (for audit logs), or throws on an invalid address.
   */
  private async validateIpForNas(
    ip: string,
    subscriberId: number,
    gateway?: string | null,
  ): Promise<string | null> {
    if (!this.isIpv4(ip)) {
      throw new BadRequestException(`"${ip}" is not a valid IPv4 address.`);
    }
    const n = this.ipToInt(ip)!;
    const first = n >>> 24;
    if (first === 0 || first === 127 || (first >= 224 && first <= 255)) {
      throw new BadRequestException(
        `"${ip}" is not a routable customer address — network-zero, loopback, multicast and broadcast ranges are reserved.`,
      );
    }

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        nas: {
          select: {
            nasIp: true, nasname: true,
            ipPools: { select: { network: true, subnet: true } },
          },
        },
      },
    }).catch(() => null) as any;
    const nas = sub?.nas as any;
    if (!nas?.nasIp) return null; // no NAS — nothing to validate against

    const nasLabel = nas.nasname ?? nas.nasIp;
    if (ip === nas.nasIp) {
      throw new BadRequestException(
        `"${ip}" is the NAS's own address (${nas.nasIp}) — pick a customer address.`,
      );
    }

    const pools = (nas.ipPools || []).filter((p: any) => p?.network);
    const inPool = pools.some((p: any) => this.ipInCidr(ip, p.network, p.subnet));
    const inNas24 = this.sameSubnet24(ip, nas.nasIp);
    if (!inPool && !inNas24) {
      throw new BadRequestException(
        `Static IP is not valid for this NAS/network. ${ip} is not within ` +
          (pools.length
            ? `any of the NAS pools (${pools.map((p: any) => `${p.network}/${p.subnet}`).join(', ')})`
            : `the ${nasLabel} subnet`) +
          ` — addresses must be routable on NAS ${nasLabel} (${nas.nasIp}).`,
      );
    }

    // Gateway: local to the same network as the assigned address, never the
    // address itself. The gateway is NOT pushed to RADIUS (PPPoE derives the
    // default route from the PPP profile) — it only has to be a plausible hop.
    if (gateway) {
      if (!this.isIpv4(gateway)) {
        throw new BadRequestException(`"${gateway}" is not a valid gateway address.`);
      }
      if (gateway === ip) {
        throw new BadRequestException('The gateway cannot be the same address as the static IP.');
      }
      if (!this.sameSubnet24(ip, gateway)) {
        throw new BadRequestException(
          `Gateway ${gateway} is not on the same subnet as ${ip} — the customer could not reach it.`,
        );
      }
    }

    return nasLabel;
  }

  /** True when `ip` falls inside network/prefix (subnet = CIDR prefix, e.g. "24"). */
  private ipInCidr(ip: string, network: string, prefix: string | number): boolean {
    const ipN = this.ipToInt(ip);
    const netN = this.ipToInt(network);
    if (ipN === null || netN === null) return false;
    const bits = parseInt(String(prefix), 10);
    if (isNaN(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipN & mask) === (netN & mask);
  }

  /** True when both addresses share the first 24 bits (same /24). */
  private sameSubnet24(a: string, b: string): boolean {
    const x = this.ipToInt(a);
    const y = this.ipToInt(b);
    if (x === null || y === null) return false;
    return (x >>> 8) === (y >>> 8);
  }

  /**
   * AUDIT LOG (spec: actor / subscriber / old / new / NAS / timestamp /
   * result / error) for every static-IP state change. Written to systemLog
   * (structured, queryable metadata) and activityLog (the activity feed).
   */
  private async audit(
    action: string,
    data: {
      subscriberId?: number;
      username?: string | null;
      oldValue?: string | null;
      newValue?: string | null;
      nas?: string | null;
      actor?: Actor;
      result?: string;
      error?: string | null;
      extra?: Record<string, any>;
    },
  ) {
    const actorId = data.actor ? this.scope.actorId(data.actor) : null;
    const meta = {
      action,
      actorId,
      subscriberId: data.subscriberId ?? null,
      username: data.username ?? null,
      oldValue: data.oldValue ?? null,
      newValue: data.newValue ?? null,
      nas: data.nas ?? null,
      result: data.result ?? null,
      error: data.error ?? null,
      timestamp: new Date().toISOString(),
      ...(data.extra ?? {}),
    };
    await this.prisma.systemLog.create({
      data: {
        level: data.error ? 'ERROR' : 'INFO',
        source: 'static-ip',
        message: `${action}: ${data.username ?? data.subscriberId ?? '?'} ${data.oldValue ?? '—'} → ${data.newValue ?? '—'}`,
        metadata: JSON.stringify(meta),
      },
    }).catch(() => null);
    await this.prisma.activityLog.create({
      data: {
        userId: actorId ?? undefined,
        action,
        entity: 'StaticIp',
        entityId: data.subscriberId ?? null,
        details:
          `${data.username ?? '?'}: ${data.oldValue ?? '—'} → ${data.newValue ?? '—'}` +
          ` @ ${data.nas ?? 'unknown NAS'} — ${data.error ? `ERROR ${data.error}` : (data.result ?? 'ok')}`,
      },
    }).catch(() => null);
  }

  /**
   * STATIC-IP HEALTH CHECK (spec): database assignment vs RADIUS radreply vs
   * the router's actual live session. Reports what agrees and what does not —
   * the panel never hides a mismatch.
   */
  async staticIpHealth(subscriberId: number, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        id: true,
        username: true,
        authMethod: true,
        serviceSettings: true,
        nas: {
          select: { nasname: true, nasIp: true, apiPort: true, apiUsername: true, apiPassword: true },
        },
      },
    }) as any;
    if (!sub) throw new NotFoundException(`Subscriber ${subscriberId} not found`);

    const ss = sub?.serviceSettings;
    const wantsStatic = sub?.authMethod === 'STATIC' || ss?.ipType === 'STATIC';
    const configuredIp: string | null = wantsStatic ? (ss?.ipAddress ?? null) : null;

    // 1. DATABASE — the assignment the panel believes in.
    const register = await this.prisma.staticIp.findFirst({
      where: { subscriberId, status: { in: ['ASSIGNED', 'EXPIRED'] } },
      select: { id: true, ipAddress: true, status: true, nasId: true },
    });

    // 2. RADIUS — the Framed-IP-Address FreeRADIUS will actually return.
    let radiusIp: string | null = null;
    if (sub?.username) {
      const rr = await this.prisma.radReply.findFirst({
        where: { username: sub.username, attribute: 'Framed-IP-Address' },
        select: { value: true },
      });
      radiusIp = rr?.value ?? null;
    }

    // 3. SESSION — what the customer is holding RIGHT NOW. The router API is
    //    the authority when credentials exist; otherwise radacct's freshest
    //    open row. undefined = could not ask the router.
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT framedipaddress FROM radacct
       WHERE username = ${sub.username} AND acctstoptime IS NULL
         AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '15 minutes'
       ORDER BY acctstarttime DESC LIMIT 1`.catch(() => [] as any);
    const acctIp: string | null = rows[0]?.framedipaddress ?? null;

    const nas = sub?.nas as any;
    let routerIp: string | null | undefined;
    if (nas?.nasIp && nas.apiUsername && nas.apiPassword && sub?.username) {
      routerIp = await this.mikrotik.getActiveAddress(
        nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, sub.username,
      ).catch(() => undefined); // undefined = unreachable, null = offline
    }
    const sessionIp: string | null =
      routerIp !== undefined ? routerIp : acctIp;
    const online = !!sessionIp;

    const databaseOk = wantsStatic ? !!configuredIp : true;
    const radiusOk = !wantsStatic
      ? (radiusIp === null ? true : false) // dynamic expects NO Framed-IP-Address
      : radiusIp === configuredIp;
    const sessionOk = online ? sessionIp === configuredIp : null;

    let status: 'HEALTHY' | 'MISMATCH' | 'NOT_ONLINE' | 'DYNAMIC';
    if (!wantsStatic) status = 'DYNAMIC';
    else if (!online) status = 'NOT_ONLINE';
    else if (databaseOk && radiusOk && sessionOk) status = 'HEALTHY';
    else status = 'MISMATCH';

    return {
      subscriberId,
      username: sub.username,
      ipType: ss?.ipType ?? 'DYNAMIC',
      wantsStatic,
      configuredIp,
      register,
      nas: nas ? (nas.nasname ?? nas.nasIp ?? null) : null,
      database: { ok: databaseOk, ip: configuredIp },
      radius: { ok: radiusOk, ip: radiusIp, note: !wantsStatic && radiusIp ? 'Framed-IP-Address present on a DYNAMIC subscriber — stale' : null },
      session: { online, ip: sessionIp, ok: sessionOk, source: routerIp !== undefined ? 'router-api' : (acctIp ? 'radacct' : null) },
      status,
    };
  }

  private isIpv4(v: string) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
    return !!m && m.slice(1).every((o) => +o >= 0 && +o <= 255);
  }
  private ipToInt(ip: string): number | null {
    if (!this.isIpv4(ip)) return null;
    return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  }
  private intToIp(n: number) {
    return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  }
}
