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

    this.logger.log(
      `Static IP ${updated.ipAddress} → ${updated.subscriber?.username}` +
        (release.reconnected
          ? ` (pool address ${release.releasedAddress ?? 'n/a'} released, live now)`
          : ' (applies on next connection)'),
    );
    return { ...updated, ...release };
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

    // 1. Clear any secret-level address pin on the router.
    if (nas?.nasIp && nas.apiUsername && nas.apiPassword) {
      try {
        await this.mikrotik.clearSecretRemoteAddress(
          nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, username,
        );
      } catch (e: any) {
        this.logger.warn(`Could not clear secret address for ${username}: ${e?.message || e}`);
      }
    }

    // 2. Tear the session down.
    let reconnected = false;
    let method = 'none';
    try {
      const r = await this.network.disconnect(username);
      reconnected = true;
      method = r?.method ?? 'coa';
    } catch {
      // No live session — nothing to release, the address applies on next dial-in.
    }

    // radacct-only means the CoA never reached the NAS: the row was closed in
    // our database but the router still has the customer online holding the
    // pool address. Go at it directly over the API.
    if (method === 'radacct-only' && nas?.nasIp && nas.apiUsername && nas.apiPassword) {
      const killed = await this.mikrotik.disconnectPppoeUser(
        nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, username,
      );
      if (killed) {
        method = 'mikrotik-api';
        this.logger.log(`CoA did not land for ${username}; session removed via MikroTik API`);
      } else {
        reconnected = false;
        this.logger.warn(
          `${username} could not be disconnected — still on pool address ${releasedAddress ?? 'unknown'}. ` +
            `${newIp} will apply when they next reconnect.`,
        );
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

    return { reconnected, releasedAddress, method };
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
    try {
      const sub = await this.prisma.subscriber.findUnique({
        where: { id: subscriberId },
        select: { username: true },
      });
      if (sub?.username) await this.network.disconnect(sub.username);
    } catch {
      // Offline — they will pick up a pool address when they next dial in.
    }

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
            }).catch(() => {});
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
