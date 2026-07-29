import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * SegmentationService — the same customer base sliced every way that matters
 * operationally: by router, VLAN, area, reseller, package and auth method.
 *
 * WHY
 * "How many subscribers do I have" is rarely the real question. The useful
 * questions are "how many are on VLAN 10 and how many of those are actually
 * up", "is this area quieter than it should be", "which router is carrying the
 * load". A single total cannot answer any of them.
 *
 * Each slice therefore reports not just a count but how many are ONLINE right
 * now, because the gap between the two is where faults live. A VLAN with 40
 * subscribers and 3 online is a broken VLAN, and that is invisible in a total.
 */
@Injectable()
export class SegmentationService {
  private readonly logger = new Logger(SegmentationService.name);

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /** Restrict everything to the caller's subtree. Only the ISP sees all. */
  private async scopeWhere(actor?: Actor) {
    if (!actor || this.scope.isAdmin(actor.role)) return {};
    const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
    return { userId: { in: ids } };
  }

  /**
   * Who is online right now, from RADIUS accounting.
   *
   * One query for the whole page rather than per segment — with 200 routers
   * and a large base, per-segment lookups would be thousands of queries for a
   * single screen.
   */
  private async liveSessions(): Promise<
    Map<string, { nasip: string; nasport: string; up: number; down: number }>
  > {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT username,
              nasipaddress::text AS nasip,
              COALESCE(nasportid, '') AS nasport,
              COALESCE(acctinputoctets, 0)::bigint  AS up,
              COALESCE(acctoutputoctets, 0)::bigint AS down
         FROM radacct
        WHERE acctstoptime IS NULL AND username IS NOT NULL`
    .catch(() => [] as any[]);

    const map = new Map<string, any>();
    for (const r of rows) {
      // BIGINT arrives as a string; adding without Number() concatenates and
      // produces absurd totals.
      map.set(r.username, {
        nasip: (r.nasip || '').split('/')[0],
        nasport: r.nasport || '',
        up: Number(r.up),
        down: Number(r.down),
      });
    }
    return map;
  }

  /**
   * MikroTik reports the port as things like "vlan10", "ether2-vlan10" or a
   * bare number. Pull the VLAN id out of whatever shape it takes so a live
   * session can be attributed even when nobody recorded it manually.
   */
  private vlanFromPort(port?: string | null): number | null {
    if (!port) return null;
    const named = /vlan[^0-9]*(\d{1,4})/i.exec(port);
    if (named) return Number(named[1]);
    const bare = /^(\d{1,4})$/.exec(port.trim());
    return bare ? Number(bare[1]) : null;
  }

  /**
   * Every dimension in one pass.
   *
   * The subscriber list is read once and bucketed in memory. Counting each
   * dimension with its own groupBy would mean six passes over the same rows
   * and no way to fold in live status consistently.
   */
  async overview(actor?: Actor) {
    const where = await this.scopeWhere(actor);

    const [subs, live] = await Promise.all([
      this.prisma.subscriber.findMany({
        where,
        select: {
          id: true, fullName: true, username: true, status: true, authMethod: true,
          kycStatus: true, cnicNumber: true,
          nas: { select: { id: true, nasname: true, nasIp: true } },
          area: { select: { id: true, name: true, city: true } },
          package: { select: { id: true, name: true, price: true } },
          user: { select: { id: true, name: true, role: true, parentId: true } },
          serviceSettings: { select: { vlanId: true, expiryDate: true } },
        },
      }),
      this.liveSessions(),
    ]);

    // --- Context for the advanced classifications, one query each so the whole
    // page still costs a handful of round trips regardless of base size. ---
    const since24h = new Date(Date.now() - 24 * 3600_000);
    const [activeOutages, flapRows, weakRows] = await Promise.all([
      this.prisma.powerOutage.findMany({ where: { endedAt: null }, select: { areaId: true } }).catch(() => [] as any[]),
      this.prisma.networkLog.findMany({
        where: { eventType: { in: ['LINK_FLAP', 'DISCONNECTION'] as any }, loggedAt: { gte: since24h }, username: { not: null } },
        select: { username: true },
      }).catch(() => [] as any[]),
      this.prisma.linkSignal.findMany({
        where: { status: { in: ['WEAK', 'CRITICAL'] }, readAt: { gte: since24h } },
        select: { username: true, subscriberId: true, status: true },
      }).catch(() => [] as any[]),
    ]);
    const outageAreas = new Set(activeOutages.map((o) => o.areaId).filter((v) => v != null));
    const flapCount = new Map<string, number>();
    for (const r of flapRows) if (r.username) flapCount.set(r.username, (flapCount.get(r.username) || 0) + 1);
    const worstSignal = new Map<string, string>(); // key: username|sub:<id> → WEAK|CRITICAL
    for (const r of weakRows) {
      const keys = [r.username, r.subscriberId != null ? `sub:${r.subscriberId}` : null].filter(Boolean) as string[];
      for (const k of keys) {
        if (worstSignal.get(k) === 'CRITICAL') continue;
        worstSignal.set(k, r.status === 'CRITICAL' ? 'CRITICAL' : (worstSignal.get(k) || r.status));
      }
    }
    const cnicCount = new Map<string, number>();
    for (const s of subs) if (s.cnicNumber) cnicCount.set(s.cnicNumber, (cnicCount.get(s.cnicNumber) || 0) + 1);
    const signalOf = (s: any) =>
      (s.username && worstSignal.get(s.username)) || worstSignal.get(`sub:${s.id}`) || null;

    type Bucket = {
      key: string; label: string; sub?: string;
      total: number; online: number; active: number; expired: number; suspended: number;
      bytes: number;
    };
    const make = (key: string, label: string, sub?: string): Bucket => ({
      key, label, sub, total: 0, online: 0, active: 0, expired: 0, suspended: 0, bytes: 0,
    });

    const dims: Record<string, Map<string, Bucket>> = {
      nas: new Map(), vlan: new Map(), area: new Map(),
      reseller: new Map(), package: new Map(), authMethod: new Map(),
      cnic: new Map(), tier: new Map(), uptime: new Map(), outage: new Map(),
    };

    // Advanced flagged-reason tallies — WHY a customer needs attention, not just
    // that a segment looks short. Each subscriber can raise several reasons.
    const reason: Record<string, number> = {
      expired: 0, suspended: 0, offlineActive: 0, neverConnected: 0, expiringSoon: 0,
      kycMissing: 0, dupCnic: 0, criticalSignal: 0, weakSignal: 0, flapping: 0, inOutage: 0,
    };
    const now = Date.now(), soon = now + 7 * 86400_000;

    const add = (dim: string, key: string, label: string, sub: string | undefined, s: any, sess: any) => {
      const m = dims[dim];
      if (!m.has(key)) m.set(key, make(key, label, sub));
      const b = m.get(key)!;
      b.total++;
      if (sess) { b.online++; b.bytes += sess.up + sess.down; }
      if (s.status === 'ACTIVE') b.active++;
      else if (s.status === 'EXPIRED') b.expired++;
      else if (s.status === 'SUSPENDED') b.suspended++;
    };

    for (const s of subs) {
      const sess = s.username ? live.get(s.username) : null;

      add('nas', s.nas ? `nas:${s.nas.id}` : 'nas:none',
          s.nas?.nasname ?? 'No router assigned', s.nas?.nasIp ?? undefined, s, sess);

      // Recorded VLAN first; otherwise infer it from the live session, so a
      // VLAN nobody typed in still shows up as soon as somebody connects on it.
      const vlan = s.serviceSettings?.vlanId ?? this.vlanFromPort(sess?.nasport);
      add('vlan', vlan != null ? `vlan:${vlan}` : 'vlan:none',
          vlan != null ? `VLAN ${vlan}` : 'No VLAN recorded', undefined, s, sess);

      add('area', s.area ? `area:${s.area.id}` : 'area:none',
          s.area?.name ?? 'No area', s.area?.city ?? undefined, s, sess);

      add('reseller', s.user ? `user:${s.user.id}` : 'user:none',
          s.user?.name ?? 'Direct (ISP)', s.user?.role ?? undefined, s, sess);

      add('package', s.package ? `pkg:${s.package.id}` : 'pkg:none',
          s.package?.name ?? 'No package', undefined, s, sess);

      add('authMethod', `auth:${s.authMethod}`, String(s.authMethod), undefined, s, sess);

      // CNIC / KYC classification
      const cnicKey = !s.cnicNumber ? 'cnic:none' : `cnic:${s.kycStatus}`;
      const cnicLabel = !s.cnicNumber
        ? 'No CNIC on file'
        : s.kycStatus === 'VERIFIED' ? 'CNIC verified'
        : s.kycStatus === 'PENDING'  ? 'CNIC pending review'
        : s.kycStatus === 'REJECTED' ? 'CNIC rejected'
        : 'CNIC expired';
      add('cnic', cnicKey, cnicLabel, undefined, s, sess);

      // Franchise / dealer / sub-dealer tier (by owning account's role)
      const tierKey = !s.user ? 'tier:direct' : `tier:${s.user.role}`;
      add('tier', tierKey, this.tierLabel(s.user?.role), s.user?.name ?? undefined, s, sess);

      // Uptime band
      const flaps = s.username ? (flapCount.get(s.username) || 0) : 0;
      const ub = this.uptimeBand(s.status, !!sess, flaps);
      add('uptime', ub.key, ub.label, undefined, s, sess);

      // Outage exposure
      const inOutage = !!(s.area && outageAreas.has(s.area.id));
      add('outage', inOutage ? 'outage:active' : 'outage:none',
          inOutage ? 'In active outage area' : 'No active outage', undefined, s, sess);

      // ---- advanced flagged reasons ----
      if (s.status === 'EXPIRED') reason.expired++;
      if (s.status === 'SUSPENDED') reason.suspended++;
      if (s.status === 'ACTIVE' && !sess) reason.offlineActive++;
      if (!sess && !s.serviceSettings?.expiryDate) reason.neverConnected++;
      const exp = s.serviceSettings?.expiryDate;
      if (exp && s.status === 'ACTIVE') {
        const t = new Date(exp).getTime();
        if (t > now && t <= soon) reason.expiringSoon++;
      }
      if (!s.cnicNumber || s.kycStatus === 'PENDING') reason.kycMissing++;
      if (s.cnicNumber && (cnicCount.get(s.cnicNumber) || 0) > 1) reason.dupCnic++;
      const sig = signalOf(s);
      if (sig === 'CRITICAL') reason.criticalSignal++;
      else if (sig === 'WEAK') reason.weakSignal++;
      if (flaps >= 3) reason.flapping++;
      if (inOutage) reason.inOutage++;
    }

    // Health is judged on ACTIVE customers only — an expired customer being
    // offline is correct behaviour, not a fault, and including them would
    // make every segment look broken at month end.
    const finish = (m: Map<string, Bucket>) =>
      [...m.values()]
        .map((b) => {
          const expectedUp = b.active;
          const onlinePercent = expectedUp > 0 ? Math.round((b.online / expectedUp) * 1000) / 10 : null;
          return {
            ...b,
            onlinePercent,
            gbTransferred: Math.round((b.bytes / 1024 ** 3) * 100) / 100,
            health: this.healthOf(onlinePercent, expectedUp),
          };
        })
        .sort((a, b) => b.total - a.total);

    return {
      generatedAt: new Date(),
      totals: {
        subscribers: subs.length,
        online: subs.filter((s) => s.username && live.has(s.username)).length,
        active: subs.filter((s) => s.status === 'ACTIVE').length,
      },
      dimensions: {
        nas: finish(dims.nas),
        vlan: finish(dims.vlan),
        area: finish(dims.area),
        reseller: finish(dims.reseller),
        package: finish(dims.package),
        authMethod: finish(dims.authMethod),
        cnic: finish(dims.cnic),
        tier: finish(dims.tier),
        uptime: finish(dims.uptime),
        outage: finish(dims.outage),
      },
      // Advanced flagged reasons — the "why", ordered worst first, for the
      // reasons panel and its bar/pie chart.
      reasons: [
        { key: 'criticalSignal', label: 'Critical fibre signal', count: reason.criticalSignal, tone: 'bad' },
        { key: 'flapping',       label: 'Flapping link (unstable)', count: reason.flapping, tone: 'bad' },
        { key: 'inOutage',       label: 'In active outage area', count: reason.inOutage, tone: 'bad' },
        { key: 'offlineActive',  label: 'Offline but active', count: reason.offlineActive, tone: 'bad' },
        { key: 'expired',        label: 'Expired', count: reason.expired, tone: 'warn' },
        { key: 'suspended',      label: 'Suspended', count: reason.suspended, tone: 'warn' },
        { key: 'weakSignal',     label: 'Weak fibre signal', count: reason.weakSignal, tone: 'warn' },
        { key: 'expiringSoon',   label: 'Expiring within 7 days', count: reason.expiringSoon, tone: 'warn' },
        { key: 'dupCnic',        label: 'Duplicate CNIC (possible resale)', count: reason.dupCnic, tone: 'warn' },
        { key: 'kycMissing',     label: 'No CNIC / KYC pending', count: reason.kycMissing, tone: 'muted' },
        { key: 'neverConnected', label: 'Never connected', count: reason.neverConnected, tone: 'muted' },
      ].filter((r) => r.count > 0),
    };
  }

  /** Human label for a franchise/dealer tier from the owning account's role. */
  private tierLabel(role?: string | null): string {
    switch (role) {
      case 'SUPER_ADMIN':
      case 'ADMIN':        return 'ISP (direct)';
      case 'RESELLER':     return 'Franchise';
      case 'SUB_RESELLER': return 'Dealer';
      case 'RETAILER':     return 'Sub-dealer';
      case 'SALES':        return 'Sales';
      case 'AUDITOR':      return 'Auditor';
      default:             return 'Direct (ISP)';
    }
  }

  /** Bucket a subscriber's connectivity into an uptime band. */
  private uptimeBand(status: string, online: boolean, flaps: number): { key: string; label: string } {
    if (status !== 'ACTIVE') return { key: 'uptime:na', label: 'Not active (expected offline)' };
    if (online && flaps >= 3) return { key: 'uptime:flapping', label: 'Unstable — flapping' };
    if (online) return { key: 'uptime:stable', label: 'Stable — online' };
    return { key: 'uptime:down', label: 'Down — active but offline' };
  }

  /**
   * Everything the analytics screen needs in one round trip.
   *
   * Deliberately a single call: the page shows status, dimensions and tickets
   * side by side, and issuing five requests would let them arrive at different
   * moments — a total that briefly disagrees with the sum of its parts reads
   * as a bug even when the data is fine.
   */
  async command(actor?: Actor) {
    const where = await this.scopeWhere(actor);

    const [subs, live, tickets, invoices] = await Promise.all([
      this.prisma.subscriber.findMany({
        where,
        select: {
          id: true, username: true, status: true, authMethod: true, createdAt: true,
          nas: { select: { id: true, nasname: true } },
          area: { select: { id: true, name: true, city: true } },
          package: { select: { id: true, name: true, price: true } },
          user: { select: { id: true, name: true, role: true, parentId: true } },
          serviceSettings: { select: { vlanId: true, expiryDate: true } },
        },
      }),
      this.liveSessions(),
      this.prisma.ticket.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => [] as any[]),
      this.prisma.invoice.groupBy({ by: ['status'], _count: { _all: true }, _sum: { dueAmount: true } })
        .catch(() => [] as any[]),
    ]);

    const now = Date.now();
    const soon = now + 7 * 86400_000;

    const status = { ACTIVE: 0, EXPIRED: 0, SUSPENDED: 0, INACTIVE: 0 } as Record<string, number>;
    let online = 0, expiringSoon = 0, neverConnected = 0;

    for (const s of subs) {
      status[s.status] = (status[s.status] ?? 0) + 1;
      if (s.username && live.has(s.username)) online++;
      const exp = s.serviceSettings?.expiryDate;
      if (exp && s.status === 'ACTIVE') {
        const t = new Date(exp).getTime();
        if (t > now && t <= soon) expiringSoon++;
      }
      if (!s.username || !live.has(s.username)) {
        // Approximation: no live session AND no expiry recorded usually means
        // the connection was created but never actually brought up.
        if (!s.serviceSettings?.expiryDate) neverConnected++;
      }
    }

    /** Bucket a dimension, carrying the full status split for each entry. */
    const bucket = (
      keyOf: (s: any) => string,
      labelOf: (s: any) => string,
      subOf?: (s: any) => string | undefined,
    ) => {
      const m = new Map<string, any>();
      for (const s of subs) {
        const k = keyOf(s);
        if (!m.has(k)) {
          m.set(k, {
            key: k, label: labelOf(s), sub: subOf?.(s),
            total: 0, online: 0, active: 0, expired: 0, suspended: 0, inactive: 0, revenue: 0,
          });
        }
        const e = m.get(k);
        e.total++;
        if (s.username && live.has(s.username)) e.online++;
        if (s.status === 'ACTIVE') { e.active++; e.revenue += Number(s.package?.price ?? 0); }
        else if (s.status === 'EXPIRED') e.expired++;
        else if (s.status === 'SUSPENDED') e.suspended++;
        else e.inactive++;
      }
      return [...m.values()]
        .map((e) => ({
          ...e,
          revenue: Math.round(e.revenue),
          onlinePercent: e.active > 0 ? Math.round((e.online / e.active) * 1000) / 10 : null,
          health: this.healthOf(e.active > 0 ? (e.online / e.active) * 100 : null, e.active),
        }))
        .sort((a, b) => b.total - a.total);
    };

    // Dealers vs sub-dealers: an account with a parent inside the same tree is
    // a sub-dealer. Splitting them matters because a franchise's numbers
    // otherwise swallow the retailers underneath it.
    const ownerIds = new Set(subs.map((s) => s.user?.id).filter(Boolean));
    const dealers = subs.filter((s) => s.user && !ownerIds.has(s.user.parentId as any));
    const subDealers = subs.filter((s) => s.user && ownerIds.has(s.user.parentId as any));

    // Role-based tier counts (subscribers owned by each account type) — feeds
    // the dashboard's franchise / dealer / sub-dealer tiles.
    const tiers = { franchise: 0, dealer: 0, subDealer: 0, direct: 0 };
    for (const s of subs) {
      switch (s.user?.role) {
        case 'RESELLER': tiers.franchise++; break;
        case 'SUB_RESELLER': tiers.dealer++; break;
        case 'RETAILER': tiers.subDealer++; break;
        default: if (!s.user) tiers.direct++; break;
      }
    }

    const ticketMap: Record<string, number> = {};
    tickets.forEach((t: any) => (ticketMap[t.status] = t._count._all));

    const unpaid = invoices.find((i: any) => i.status === 'UNPAID');
    const overdue = invoices.find((i: any) => i.status === 'OVERDUE');

    return {
      generatedAt: new Date(),
      totals: {
        subscribers: subs.length,
        online,
        offline: subs.length - online,
        active: status.ACTIVE,
        expired: status.EXPIRED,
        suspended: status.SUSPENDED,
        inactive: status.INACTIVE,
        expiringSoon,
        neverConnected,
        monthlyRevenue: Math.round(
          subs.filter((s) => s.status === 'ACTIVE')
            .reduce((t, s) => t + Number(s.package?.price ?? 0), 0),
        ),
      },
      status: [
        { label: 'Active', value: status.ACTIVE, tone: 'ok' },
        { label: 'Expired', value: status.EXPIRED, tone: 'bad' },
        { label: 'Suspended', value: status.SUSPENDED, tone: 'warn' },
        { label: 'Inactive', value: status.INACTIVE, tone: 'muted' },
      ],
      dimensions: {
        vlan: bucket(
          (s) => `vlan:${s.serviceSettings?.vlanId ?? this.vlanFromPort(live.get(s.username!)?.nasport) ?? 'none'}`,
          (s) => {
            const v = s.serviceSettings?.vlanId ?? this.vlanFromPort(live.get(s.username!)?.nasport);
            return v != null ? `VLAN ${v}` : 'No VLAN';
          },
        ),
        area: bucket(
          (s) => `area:${s.area?.id ?? 'none'}`,
          (s) => s.area?.name ?? 'No area',
          (s) => s.area?.city ?? undefined,
        ),
        dealer: bucket(
          (s) => `user:${s.user?.id ?? 'none'}`,
          (s) => s.user?.name ?? 'Direct (ISP)',
          (s) => s.user?.role ?? undefined,
        ),
        nas: bucket(
          (s) => `nas:${s.nas?.id ?? 'none'}`,
          (s) => s.nas?.nasname ?? 'No router',
        ),
        package: bucket(
          (s) => `pkg:${s.package?.id ?? 'none'}`,
          (s) => s.package?.name ?? 'No package',
        ),
      },
      hierarchy: {
        dealerCount: new Set(dealers.map((s) => s.user!.id)).size,
        subDealerCount: new Set(subDealers.map((s) => s.user!.id)).size,
        dealerSubscribers: dealers.length,
        subDealerSubscribers: subDealers.length,
        directSubscribers: subs.filter((s) => !s.user).length,
      },
      tiers,
      tickets: {
        open: ticketMap.OPEN ?? 0,
        inProgress: ticketMap.IN_PROGRESS ?? 0,
        resolved: ticketMap.RESOLVED ?? 0,
        closed: ticketMap.CLOSED ?? 0,
        total: Object.values(ticketMap).reduce((a, b) => a + b, 0),
      },
      billing: {
        unpaidCount: unpaid?._count?._all ?? 0,
        unpaidAmount: Math.round(Number(unpaid?._sum?.dueAmount ?? 0)),
        overdueCount: overdue?._count?._all ?? 0,
        overdueAmount: Math.round(Number(overdue?._sum?.dueAmount ?? 0)),
      },
    };
  }

  /**
   * Traffic-light on a segment.
   *
   * Thresholds are deliberately forgiving on small segments: two customers off
   * out of three is 33% and means nothing, whereas 33% across sixty customers
   * is an outage. Flagging the former trains people to ignore the indicator.
   */
  private healthOf(onlinePercent: number | null, activeCount: number) {
    if (onlinePercent === null || activeCount === 0) return 'unknown';
    if (activeCount < 5) return onlinePercent === 0 ? 'warning' : 'ok';
    if (onlinePercent < 25) return 'critical';
    if (onlinePercent < 60) return 'warning';
    return 'ok';
  }

  /**
   * The customers behind one segment — what you want the moment a slice looks
   * wrong. Includes live status and the last disconnect reason so the cause is
   * visible without opening each subscriber.
   */
  async drilldown(dimension: string, key: string, actor?: Actor) {
    const base = await this.scopeWhere(actor);
    const id = key.includes(':') ? key.split(':')[1] : key;
    const where: any = { ...base };

    switch (dimension) {
      case 'nas':      where.nasId = id === 'none' ? null : Number(id); break;
      case 'area':     where.areaId = id === 'none' ? null : Number(id); break;
      case 'reseller': where.userId = id === 'none' ? null : Number(id); break;
      case 'package':  where.packageId = id === 'none' ? null : Number(id); break;
      case 'authMethod': where.authMethod = id; break;
      case 'vlan':
        where.serviceSettings = id === 'none'
          ? { is: { vlanId: null } }
          : { is: { vlanId: Number(id) } };
        break;
      case 'cnic':
        if (id === 'none') where.cnicNumber = null;
        else { where.cnicNumber = { not: null }; where.kycStatus = id as any; }
        break;
      case 'tier':
        if (id === 'direct') where.userId = null;
        else where.user = { is: { role: id as any } };
        break;
      case 'outage': {
        const outs = await this.prisma.powerOutage.findMany({ where: { endedAt: null }, select: { areaId: true } }).catch(() => [] as any[]);
        const areas = outs.map((o) => o.areaId).filter((v) => v != null) as number[];
        if (id === 'active') where.areaId = { in: areas.length ? areas : [-1] };
        else if (areas.length) where.areaId = { notIn: areas };
        break;
      }
      case 'uptime':
        // Band is finished off in memory below (needs live status); here we just
        // narrow to the right status set.
        where.status = id === 'na' ? { not: 'ACTIVE' } : 'ACTIVE';
        break;
    }

    const [subs, live] = await Promise.all([
      this.prisma.subscriber.findMany({
        where,
        select: {
          id: true, fullName: true, username: true, phone: true, status: true,
          nas: { select: { nasname: true } },
          area: { select: { name: true } },
          package: { select: { name: true } },
          serviceSettings: { select: { vlanId: true, expiryDate: true } },
        },
        take: 500,
        orderBy: { fullName: 'asc' },
      }),
      this.liveSessions(),
    ]);

    // VLAN inferred from a live session won't match the SQL filter above, so
    // those rows are folded back in here — otherwise a customer visible in the
    // chart would be missing from the list behind it.
    let rows = subs;
    if (dimension === 'vlan' && id !== 'none') {
      const wanted = Number(id);
      const extra = await this.prisma.subscriber.findMany({
        where: { ...base, serviceSettings: { is: { vlanId: null } } },
        select: {
          id: true, fullName: true, username: true, phone: true, status: true,
          nas: { select: { nasname: true } },
          area: { select: { name: true } },
          package: { select: { name: true } },
          serviceSettings: { select: { vlanId: true, expiryDate: true } },
        },
        take: 500,
      });
      const inferred = extra.filter((s) => {
        const sess = s.username ? live.get(s.username) : null;
        return sess && this.vlanFromPort(sess.nasport) === wanted;
      });
      const seen = new Set(rows.map((r) => r.id));
      rows = [...rows, ...inferred.filter((r) => !seen.has(r.id))];
    }

    // Uptime bands need live status, so finish the split here.
    if (dimension === 'uptime' && id !== 'na') {
      rows = rows.filter((s) => {
        const on = !!(s.username && live.has(s.username));
        return id === 'down' ? !on : on; // 'stable' and 'flapping' are online
      });
    }

    const usernames = rows.map((r) => r.username).filter(Boolean) as string[];
    const lastStops = usernames.length
      ? await this.prisma.$queryRaw<any[]>`
          SELECT DISTINCT ON (username) username, acctterminatecause, acctstoptime
             FROM radacct
            WHERE username = ANY(${usernames}::text[]) AND acctstoptime IS NOT NULL
            ORDER BY username, acctstoptime DESC`
        .catch(() => [] as any[])
      : [];
    const stopByName = new Map(lastStops.map((r) => [r.username, r]));

    return rows.map((s) => {
      const sess = s.username ? live.get(s.username) : null;
      const stop = s.username ? stopByName.get(s.username) : null;
      return {
        id: s.id,
        name: s.fullName,
        username: s.username,
        phone: s.phone,
        status: s.status,
        nas: s.nas?.nasname ?? null,
        area: s.area?.name ?? null,
        package: s.package?.name ?? null,
        vlan: s.serviceSettings?.vlanId ?? this.vlanFromPort(sess?.nasport),
        expiryDate: s.serviceSettings?.expiryDate ?? null,
        online: !!sess,
        gbTransferred: sess ? Math.round(((sess.up + sess.down) / 1024 ** 3) * 100) / 100 : 0,
        lastDisconnect: sess ? null : stop?.acctterminatecause ?? null,
        lastSeen: sess ? null : stop?.acctstoptime ?? null,
      };
    }).sort((a, b) => Number(b.online) - Number(a.online));
  }
}
