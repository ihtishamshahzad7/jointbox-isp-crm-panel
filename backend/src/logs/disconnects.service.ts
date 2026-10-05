import { Injectable, Logger } from '@nestjs/common';
import { isIP } from 'net';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import {
  TERMINATE_TABLE, TERMINATE_CATEGORIES, TerminateInfo, endedInfo, fieldsOf,
} from '../common/radius-terminate';

export interface DisconnectQuery {
  sinceHours?: number;
  nasIp?: string;
  username?: string;
  cause?: string;      // canonical key, e.g. "Lost-Carrier"
  category?: string;   // e.g. "link"
  limit?: number;
  offset?: number;
  tz?: number;         // client getTimezoneOffset() in minutes, for day buckets
}

const ABNORMAL = new Set(['warn', 'critical']);
/** Rows read for the trend line. Beyond this the trend is marked partial. */
const TREND_CAP = 150_000;

/**
 * DISCONNECT REPORT — why sessions ended, across the caller's own customers.
 *
 * Every number here is drawn from radacct rows whose session ENDED inside the
 * window, limited to subscribers the caller owns (the same tenancy rule as the
 * subscriber list). The eighteen RFC 2866 causes are always listed, even at
 * zero, so the operator sees the whole picture rather than only what happened.
 *
 * Related records for the selected cause or category: the sessions themselves,
 * the customers who hit it most and the routers it happened on.
 */
@Injectable()
export class DisconnectsService {
  private readonly logger = new Logger('Disconnects');
  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /** radacct where-fragment for the caller, or null when they own no customers. */
  private async scopeWhere(actor: Actor): Promise<any | null> {
    if (this.scope.isAdmin(actor?.role)) {
      const rad = await this.scope.radiusWhere(actor);
      return rad;
    }
    const sub = await this.scope.subscriberWhere(actor);
    return { subscriber: { is: sub } };
  }

  async report(actor: Actor, q: DisconnectQuery = {}) {
    const hours = Math.min(Math.max(Math.round(Number(q.sinceHours) || 168), 1), 24 * 90);
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3600_000);
    const limit = Math.min(Math.max(Math.round(Number(q.limit) || 50), 1), 500);
    const offset = Math.max(Math.round(Number(q.offset) || 0), 0);
    const tz = Math.min(Math.max(Math.round(Number(q.tz) || 0), -840), 840);

    const scoped = await this.scopeWhere(actor);
    const and: any[] = [];
    if (scoped && Object.keys(scoped).length) and.push(scoped);
    if (q.nasIp && isIP(String(q.nasIp).trim())) and.push({ nasipaddress: String(q.nasIp).trim() });
    if (q.username) and.push({ username: String(q.username).trim().slice(0, 64) });
    const ended: any = { AND: [...and, { acctstoptime: { gte: from, lte: to } }] };

    // 1. Per raw cause value — the base every other figure maps through.
    const byRaw = await this.prisma.radAcct.groupBy({
      by: ['acctterminatecause'],
      where: ended,
      _count: { _all: true },
      _avg: { acctsessiontime: true },
      _max: { acctstoptime: true },
    });

    // Raw values ("Lost-Carrier", "2", null) folded onto canonical causes.
    type Agg = { info: TerminateInfo; count: number; secWeighted: number; lastAt: Date | null; raws: (string | null)[] };
    const byKey = new Map<string, Agg>();
    for (const g of byRaw) {
      const info = endedInfo(g.acctterminatecause);
      const n = g._count._all;
      const a = byKey.get(info.key) || { info, count: 0, secWeighted: 0, lastAt: null, raws: [] };
      a.count += n;
      a.secWeighted += (Number(g._avg.acctsessiontime) || 0) * n;
      const last = g._max.acctstoptime as Date | null;
      if (last && (!a.lastAt || last > a.lastAt)) a.lastAt = last;
      a.raws.push(g.acctterminatecause);
      byKey.set(info.key, a);
    }
    const totalEnded = Array.from(byKey.values()).reduce((s, a) => s + a.count, 0);

    // Selection: a cause key, or a category. Drives the related records.
    const cause = q.cause ? String(q.cause).trim() : '';
    const category = q.category ? String(q.category).trim() : '';
    const selectedAggs = Array.from(byKey.values()).filter((a) =>
      cause ? a.info.key.toLowerCase() === cause.toLowerCase()
        : category ? a.info.category === category : true,
    );
    const selectedRaws = selectedAggs.flatMap((a) => a.raws);
    const filtered = !!(cause || category);
    const causeFilter = (raws: (string | null)[]) => {
      const vals = raws.filter((r): r is string => r != null);
      const hasNull = raws.some((r) => r == null);
      const ors: any[] = [];
      if (vals.length) ors.push({ acctterminatecause: { in: vals } });
      if (hasNull) ors.push({ acctterminatecause: null });
      return ors.length ? { OR: ors } : { radacctid: { lt: BigInt(0) } }; // matches nothing
    };
    const selectedWhere: any = filtered ? { AND: [ended, causeFilter(selectedRaws)] } : ended;

    // 2. Customers per raw cause (distinct customers + the most affected).
    const byUser = await this.prisma.radAcct.groupBy({
      by: ['username', 'acctterminatecause'],
      where: ended,
      _count: { _all: true },
      _max: { acctstoptime: true },
    });
    const customersPerKey = new Map<string, Set<string>>();
    const allCustomers = new Set<string>();
    type UserAgg = { username: string; count: number; abnormal: number; lastAt: Date | null; lastKey: string; keys: Map<string, number> };
    const users = new Map<string, UserAgg>();
    const selectedRawSet = new Set(selectedRaws.map((r) => (r == null ? '\u0000' : r)));
    for (const g of byUser) {
      const uname = g.username || '';
      if (!uname) continue;
      const info = endedInfo(g.acctterminatecause);
      allCustomers.add(uname);
      const set = customersPerKey.get(info.key) || new Set<string>();
      set.add(uname);
      customersPerKey.set(info.key, set);
      if (filtered && !selectedRawSet.has(g.acctterminatecause == null ? '\u0000' : g.acctterminatecause)) continue;
      const n = g._count._all;
      const u = users.get(uname) || { username: uname, count: 0, abnormal: 0, lastAt: null, lastKey: '', keys: new Map() };
      u.count += n;
      if (ABNORMAL.has(info.severity)) u.abnormal += n;
      u.keys.set(info.key, (u.keys.get(info.key) || 0) + n);
      const last = g._max.acctstoptime as Date | null;
      if (last && (!u.lastAt || last > u.lastAt)) { u.lastAt = last; u.lastKey = info.key; }
      users.set(uname, u);
    }

    // 3. Routers.
    const byNas = await this.prisma.radAcct.groupBy({
      by: ['nasipaddress', 'acctterminatecause'],
      where: selectedWhere,
      _count: { _all: true },
    });
    type NasAgg = { nasIp: string; count: number; abnormal: number; keys: Map<string, number> };
    const routers = new Map<string, NasAgg>();
    for (const g of byNas) {
      const ip = String(g.nasipaddress || '');
      const info = endedInfo(g.acctterminatecause);
      const r = routers.get(ip) || { nasIp: ip, count: 0, abnormal: 0, keys: new Map() };
      r.count += g._count._all;
      if (ABNORMAL.has(info.severity)) r.abnormal += g._count._all;
      r.keys.set(info.key, (r.keys.get(info.key) || 0) + g._count._all);
      routers.set(ip, r);
    }

    // 4. Trend by category — hourly for two days or less, daily beyond.
    const unit: 'hour' | 'day' = hours <= 48 ? 'hour' : 'day';
    const step = unit === 'hour' ? 3600_000 : 86_400_000;
    const shift = -tz * 60_000; // local = UTC - offset
    const floorLocal = (ms: number) => Math.floor((ms + shift) / step) * step - shift;
    const bucketStarts: number[] = [];
    for (let b = floorLocal(from.getTime()); b <= to.getTime(); b += step) bucketStarts.push(b);
    const trendRows = await this.prisma.radAcct.findMany({
      where: ended,
      select: { acctstoptime: true, acctterminatecause: true },
      take: TREND_CAP,
      orderBy: { radacctid: 'desc' },
    });
    const catIds = TERMINATE_CATEGORIES.map((c) => c.id);
    const buckets = new Map<number, Record<string, number>>();
    for (const b of bucketStarts) buckets.set(b, Object.fromEntries(catIds.map((c) => [c, 0])));
    const memo = new Map<string, string>();
    for (const r of trendRows) {
      if (!r.acctstoptime) continue;
      const raw = r.acctterminatecause ?? '\u0000';
      let cat = memo.get(raw);
      if (!cat) { cat = endedInfo(r.acctterminatecause).category; memo.set(raw, cat); }
      const b = floorLocal(r.acctstoptime.getTime());
      const row = buckets.get(b);
      if (row) row[cat] = (row[cat] || 0) + 1;
    }

    // 5. Open right now (fresh — the NAS reported within 15 minutes).
    const openNow = await this.prisma.radAcct.count({
      where: {
        AND: [...and, { acctstoptime: null }, {
          OR: [
            { acctupdatetime: { gte: new Date(Date.now() - 15 * 60_000) } },
            { acctupdatetime: null, acctstarttime: { gte: new Date(Date.now() - 15 * 60_000) } },
          ],
        }],
      },
    });

    // 6. The records themselves.
    const [rows, recordsTotal] = await Promise.all([
      this.prisma.radAcct.findMany({
        where: selectedWhere,
        orderBy: [{ acctstoptime: 'desc' }, { radacctid: 'desc' }],
        take: limit,
        skip: offset,
        include: { subscriber: { select: { id: true, fullName: true } } },
      }),
      this.prisma.radAcct.count({ where: selectedWhere }),
    ]);

    // Names: routers the caller can see, customers the caller owns.
    const nasIps = Array.from(new Set([...routers.keys(), ...rows.map((r) => String(r.nasipaddress || ''))])).filter(Boolean);
    const nasNames = await this.nasNames(actor, nasIps);
    const topUsers = Array.from(users.values()).sort((a, b) => b.count - a.count || b.abnormal - a.abnormal).slice(0, 15);
    const subByName = await this.subscriberNames(actor, topUsers.map((u) => u.username));

    const topKeys = (m: Map<string, number>, n = 3) => Array.from(m.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([key, count]) => ({ key, label: byKey.get(key)?.info.label || key, count }));

    // Every standard cause, then whatever else occurred (panel / vendor / not reported).
    const toCause = (info: TerminateInfo) => {
      const a = byKey.get(info.key);
      const count = a?.count || 0;
      return {
        code: info.code, key: info.key, label: info.label, description: info.description,
        meaning: info.meaning, action: info.action, category: info.category,
        severity: info.severity, standard: info.standard,
        count,
        share: totalEnded ? count / totalEnded : 0,
        customers: customersPerKey.get(info.key)?.size || 0,
        avgSessionSec: a && a.count ? Math.round(a.secWeighted / a.count) : null,
        lastAt: a?.lastAt || null,
      };
    };
    const causes = [
      ...TERMINATE_TABLE.map(toCause),
      ...Array.from(byKey.values()).filter((a) => !a.info.standard).sort((a, b) => b.count - a.count).map((a) => toCause(a.info)),
    ];

    const categories = TERMINATE_CATEGORIES.map((c) => {
      const count = causes.filter((x) => x.category === c.id).reduce((s, x) => s + x.count, 0);
      return { ...c, count, share: totalEnded ? count / totalEnded : 0 };
    });

    const abnormal = causes.filter((c) => ABNORMAL.has(c.severity)).reduce((s, c) => s + c.count, 0);
    const secAll = Array.from(byKey.values()).reduce((s, a) => s + a.secWeighted, 0);
    const top = causes.filter((c) => c.count > 0).sort((a, b) => b.count - a.count)[0] || null;

    return {
      window: { sinceHours: hours, from, to, unit },
      selection: { cause: cause || null, category: category || null },
      totals: {
        ended: totalEnded,
        openNow,
        customers: allCustomers.size,
        avgSessionSec: totalEnded ? Math.round(secAll / totalEnded) : null,
        abnormal,
        abnormalShare: totalEnded ? abnormal / totalEnded : 0,
        topCause: top ? { key: top.key, label: top.label, count: top.count } : null,
      },
      causes,
      categories,
      trend: {
        unit,
        partial: trendRows.length >= TREND_CAP,
        buckets: bucketStarts.map((b) => ({ at: new Date(b), counts: buckets.get(b) || {} })),
      },
      routers: Array.from(routers.values())
        .sort((a, b) => b.count - a.count).slice(0, 12)
        .map((r) => ({ nasIp: r.nasIp, name: nasNames.get(r.nasIp) || null, count: r.count, abnormal: r.abnormal, top: topKeys(r.keys) })),
      customers: topUsers.map((u) => ({
        username: u.username,
        subscriberId: subByName.get(u.username)?.id ?? null,
        fullName: subByName.get(u.username)?.fullName ?? null,
        count: u.count,
        abnormal: u.abnormal,
        lastAt: u.lastAt,
        lastKey: u.lastKey,
        top: topKeys(u.keys),
      })),
      records: rows.map((r) => ({
        id: String(r.radacctid),
        sessionId: r.acctsessionid,
        username: r.username,
        subscriberId: r.subscriber?.id ?? null,
        fullName: r.subscriber?.fullName ?? null,
        nasIp: r.nasipaddress,
        nasName: nasNames.get(String(r.nasipaddress || '')) || null,
        nasPortId: r.nasportid,
        nasPortType: r.nasporttype,
        framedIp: r.framedipaddress,
        mac: r.callingstationid,
        service: r.calledstationid,
        start: r.acctstarttime,
        stop: r.acctstoptime,
        durationSec: r.acctsessiontime ?? (r.acctstarttime && r.acctstoptime
          ? Math.max(0, Math.round((r.acctstoptime.getTime() - r.acctstarttime.getTime()) / 1000)) : null),
        downloadBytes: r.acctoutputoctets != null ? Number(r.acctoutputoctets) : null,
        uploadBytes: r.acctinputoctets != null ? Number(r.acctinputoctets) : null,
        rawCause: r.acctterminatecause,
        ...fieldsOf(endedInfo(r.acctterminatecause)),
      })),
      recordsTotal,
      offset,
      limit,
    };
  }

  private async nasNames(actor: Actor, ips: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const valid = ips.filter((ip) => isIP(ip));
    if (!valid.length) return out;
    try {
      const where = await this.scope.nasWhere(actor);
      const list = await this.prisma.nas.findMany({
        where: Object.keys(where).length ? { AND: [where, { nasIp: { in: valid } }] } : { nasIp: { in: valid } },
        select: { nasIp: true, shortname: true, nasname: true, description: true },
      });
      for (const n of list) {
        if (!n.nasIp) continue;
        const name = n.shortname || (n.nasname && !isIP(n.nasname) ? n.nasname : '') || n.description || '';
        if (name) out.set(String(n.nasIp), name);
      }
    } catch (e: any) {
      this.logger.warn(`NAS name lookup skipped: ${e?.message || e}`);
    }
    return out;
  }

  private async subscriberNames(actor: Actor, usernames: string[]) {
    const out = new Map<string, { id: number; fullName: string }>();
    if (!usernames.length) return out;
    const sub = await this.scope.subscriberWhere(actor);
    const list = await this.prisma.subscriber.findMany({
      where: Object.keys(sub).length ? { AND: [sub, { username: { in: usernames } }] } : { username: { in: usernames } },
      select: { id: true, username: true, fullName: true },
    });
    for (const s of list) out.set(s.username, { id: s.id, fullName: s.fullName });
    return out;
  }
}
