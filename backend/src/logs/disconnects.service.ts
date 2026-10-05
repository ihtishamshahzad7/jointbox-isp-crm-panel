import { Injectable, Logger } from '@nestjs/common';
import { isIP } from 'net';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import {
  TERMINATE_TABLE, TERMINATE_CATEGORIES, TerminateInfo, endedInfo, fieldsOf,
} from '../common/radius-terminate';
import { macInfo, normaliseMac } from '../common/mac-vendor';

export interface DisconnectQuery {
  sinceHours?: number;
  nasIp?: string;
  username?: string;
  search?: string;     // username, MAC address or IP
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
    // Scope + router only — what mass-drop detection looks across, so a search
    // for one customer still shows that they went down with everyone else.
    const baseAnd = [...and];
    if (q.username) and.push({ username: String(q.username).trim().slice(0, 64) });
    // One box for what an operator actually has in hand: a username, the
    // customer's MAC address (any separator) or the IP they were given.
    const term = String(q.search ?? '').trim().slice(0, 64);
    if (term) {
      const ors: any[] = [
        { username: { contains: term, mode: 'insensitive' } },
        { callingstationid: { contains: term, mode: 'insensitive' } },
      ];
      const macish = term.replace(/[^0-9a-f]/gi, '');
      if (macish.length >= 4) {
        // "00-11-22" and "001122" find "00:11:22:…"
        const colon = macish.match(/.{1,2}/g)!.join(':');
        if (colon.toLowerCase() !== term.toLowerCase()) {
          ors.push({ callingstationid: { contains: colon, mode: 'insensitive' } });
        }
      }
      if (isIP(term)) ors.push({ framedipaddress: term });
      and.push({ OR: ors });
    }
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
      select: { acctstoptime: true, acctterminatecause: true, nasipaddress: true, username: true },
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
        include: {
          subscriber: {
            select: {
              id: true, fullName: true, status: true, fupApplied: true, fupAppliedAt: true,
              package: { select: { name: true } },
              area: { select: { name: true } },
              serviceSettings: { select: { expiryDate: true, macAddress: true } },
              onu: { select: { rxPower: true, lastPolledAt: true, telemetry: { select: { rxPowerDbm: true, status: true, lastSeenAt: true } } } },
              _count: { select: { tickets: { where: { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] as any } } } } },
            },
          },
        },
      }),
      this.prisma.radAcct.count({ where: selectedWhere }),
    ]);

    // Mass drops: many of the caller's customers on one router ending within
    // a minute of each other — an outage, not a run of single faults.
    const filtered2 = and.length !== baseAnd.length;
    let massSource: Array<{ nasipaddress: string | null; acctstoptime: Date | null; username: string | null; acctterminatecause: string | null }> = trendRows as any;
    if (filtered2 && rows.length) {
      const stops = rows.map((r) => r.acctstoptime?.getTime()).filter((x): x is number => !!x);
      massSource = await this.prisma.radAcct.findMany({
        where: { AND: [...baseAnd, {
          nasipaddress: { in: Array.from(new Set(rows.map((r) => String(r.nasipaddress)))) },
          acctstoptime: { gte: new Date(Math.min(...stops) - 60_000), lte: new Date(Math.max(...stops) + 60_000) },
        }] },
        select: { nasipaddress: true, acctstoptime: true, username: true, acctterminatecause: true },
        take: 50_000,
      }) as any;
    }
    const massDrops = detectMassDrops(massSource);
    const extras = await this.extras(actor, rows, massDrops);

    // Names: routers the caller can see, customers the caller owns.
    const nasIps = Array.from(new Set([...routers.keys(), ...rows.map((r) => String(r.nasipaddress || '')), ...massDrops.map((m) => m.nasIp)])).filter(Boolean);
    const nasNames = await this.nasNames(actor, nasIps);
    const topUsers = Array.from(users.values()).sort((a, b) => b.count - a.count || b.abnormal - a.abnormal).slice(0, 15);
    const subByName = await this.subscriberNames(actor, topUsers.map((u) => u.username));

    const howBySession = await this.attribute(actor, rows);

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
      massDrops: massDrops.slice(0, 8).map((m) => ({
        nasIp: m.nasIp, nasName: nasNames.get(m.nasIp) || null, from: new Date(m.from), to: new Date(m.to),
        customers: m.customers, topCause: m.topKey ? { key: m.topKey, label: endedInfo(m.topKey).label } : null,
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
        how: howBySession.get(String(r.radacctid)) || this.howFromCause(endedInfo(r.acctterminatecause)),
        ...(extras.get(String(r.radacctid)) || {}),
      })),
      recordsTotal,
      offset,
      limit,
    };
  }

  /** Accounts whose names the viewer may see: their own tree, nothing above it. */
  private async visibleTree(actor: Actor): Promise<Set<number>> {
    return new Set(await this.scope.descendantIds(await this.scope.rootId(actor)));
  }

  /** HOW a session ended, from the cause alone (no panel action recorded). */
  private howFromCause(info: TerminateInfo): DisconnectHow {
    const by: DisconnectHow['by'] =
      info.category === 'customer' ? 'customer'
        : info.category === 'timer' ? 'timer'
        : info.category === 'operator' ? 'operator'
        : info.category === 'link' ? 'line'
        : info.category === 'router' || info.category === 'port' || info.category === 'service' ? 'router'
        : info.category === 'panel' ? 'panel'
        : 'unknown';
    const extra = info.key === 'Admin-Reset'
      ? 'No disconnect was made from the panel at that time, so it was most likely reset on the router itself.'
      : null;
    return { by, title: info.how, detail: extra, actor: null, method: null, source: 'cause', steps: [] };
  }

  /**
   * Match each record to the panel action that ended it, if any: an operator's
   * Disconnect / Cut-all click, a plan or static-IP change, a fair-usage rule
   * or the automatic duplicate-login sweep. These write a structured log entry
   * (with the RADIUS session id when one was open), so a record can say "Cut
   * from the panel by Ali via RADIUS CoA" instead of a bare "Admin Reset".
   *
   * Operator names are shown only for accounts inside the viewer's own tree.
   */
  private async attribute(actor: Actor, rows: any[]): Promise<Map<string, DisconnectHow>> {
    const out = new Map<string, DisconnectHow>();
    const stops = rows.map((r) => r.acctstoptime?.getTime?.()).filter((t): t is number => !!t);
    if (!rows.length || !stops.length) return out;
    const lo = new Date(Math.min(...stops) - 10 * 60_000);
    const hi = new Date(Math.max(...stops) + 10 * 60_000);
    const names = new Set(rows.map((r) => r.username).filter(Boolean));
    const sessionIds = new Set(rows.map((r) => r.acctsessionid).filter(Boolean));

    type Ev = { at: number; username: string | null; sessionId: string | null; cutIds: string[]; actorId: number | null; why: string | null; method: string | null; steps: string[] };
    const events: Ev[] = [];
    try {
      const logs = await this.prisma.systemLog.findMany({
        where: { source: { in: ['disconnect', 'simultaneous-use'] }, level: 'INFO', createdAt: { gte: lo, lte: hi } },
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: { createdAt: true, metadata: true },
      });
      for (const l of logs) {
        let m: any = null;
        try { m = l.metadata ? JSON.parse(String(l.metadata)) : null; } catch { m = null; }
        if (!m || (m.action && String(m.action).includes('FAILED'))) continue;
        const uname = m.username ? String(m.username) : null;
        const ids: string[] = Array.isArray(m.cutSessionIds) ? m.cutSessionIds.map(String) : [];
        if (uname && !names.has(uname) && !ids.some((x) => sessionIds.has(x))) continue;
        events.push({
          at: l.createdAt.getTime(),
          username: uname,
          sessionId: m.acctSessionId ? String(m.acctSessionId) : null,
          cutIds: ids,
          actorId: m.actorId != null ? Number(m.actorId) || null : null,
          why: m.why ? String(m.why) : null,
          method: m.method ? String(m.method) : null,
          steps: Array.isArray(m.attempts) ? m.attempts.map(String).slice(0, 8) : [],
        });
      }
    } catch (e: any) {
      this.logger.warn(`Disconnect attribution skipped: ${e?.message || e}`);
      return out;
    }
    if (!events.length) return out;

    // Names for operators inside the viewer's own tree only.
    const actorIds = Array.from(new Set(events.map((e) => e.actorId).filter((x): x is number => !!x)));
    const visible = new Map<number, { name: string; email: string }>();
    if (actorIds.length) {
      const tree = await this.visibleTree(actor);
      const users = await this.prisma.user.findMany({
        where: { id: { in: actorIds } }, select: { id: true, name: true, email: true },
      });
      for (const u of users) if (tree.has(u.id)) visible.set(u.id, { name: u.name || u.email, email: u.email });
    }

    for (const r of rows) {
      const stop = r.acctstoptime?.getTime?.();
      if (!stop) continue;
      const sid = r.acctsessionid ? String(r.acctsessionid) : null;
      // Exact session id first; otherwise the same customer within 3 minutes.
      const ev = events.find((e) => sid && (e.sessionId === sid || e.cutIds.includes(sid)))
        || events.find((e) => !e.sessionId && !e.cutIds.length && e.username === r.username && Math.abs(e.at - stop) <= 3 * 60_000);
      if (!ev) continue;
      const who = ev.actorId ? visible.get(ev.actorId) : undefined;
      const why = WHY[ev.why || (ev.actorId ? 'operator-kick' : 'panel')] || WHY.panel;
      const method = ev.method === 'mikrotik-api' ? 'MikroTik API' : ev.method === 'coa' || ev.method === 'radius-coa' ? 'RADIUS CoA' : ev.method || null;
      out.set(String(r.radacctid), {
        by: why.by,
        title: why.title,
        detail: why.detail,
        actor: ev.actorId ? (who ? { name: who.name, email: who.email } : { name: 'Your provider', email: null }) : null,
        method,
        source: 'panel',
        steps: ev.steps,
      });
    }
    return out;
  }

  /**
   * Everything support asks next about a disconnect, for one page of records:
   * the device maker, a changed MAC, how often the customer has been dropping,
   * whether others on the router went down at the same time, the account's
   * state at that moment, what happened in the panel just before, failed
   * reconnect attempts just after, the router's own log line, the ONU signal
   * and open tickets. Every lookup is limited to these records' own customers.
   */
  private async extras(actor: Actor, rows: any[], mass: MassDrop[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    if (!rows.length) return out;
    const names = Array.from(new Set(rows.map((r) => r.username).filter(Boolean))) as string[];
    const stops = rows.map((r) => r.acctstoptime?.getTime?.()).filter((x): x is number => !!x);
    const starts = rows.map((r) => r.acctstarttime?.getTime?.()).filter((x): x is number => !!x);
    if (!stops.length) return out;
    const minStop = Math.min(...stops), maxStop = Math.max(...stops);
    const minStart = starts.length ? Math.min(...starts) : minStop;
    const subIds = Array.from(new Set(rows.map((r) => r.subscriber?.id).filter(Boolean))) as number[];
    const safe = <T,>(p: Promise<T>, fallback: T) => p.catch((e: any) => { this.logger.warn(`Disconnect detail skipped: ${e?.message || e}`); return fallback; });

    const [prior, recentStops, rejects, routerLines, activity] = await Promise.all([
      // The session before each one — to spot a different MAC.
      names.length ? safe(this.prisma.radAcct.findMany({
        where: { username: { in: names }, acctstarttime: { gte: new Date(minStart - 30 * 86_400_000), lt: new Date(Math.max(...starts, minStop)) } },
        select: { radacctid: true, username: true, acctstarttime: true, callingstationid: true },
        orderBy: { acctstarttime: 'desc' },
        take: 5000,
      }), [] as any[]) : Promise.resolve([] as any[]),
      // Every stop in the 24 hours before — how often they have been dropping.
      names.length ? safe(this.prisma.radAcct.findMany({
        where: { username: { in: names }, acctstoptime: { gte: new Date(minStop - 86_400_000), lte: new Date(maxStop) } },
        select: { username: true, acctstoptime: true },
        take: 20_000,
      }), [] as any[]) : Promise.resolve([] as any[]),
      // Logins refused in the 30 minutes after — they tried to come back.
      names.length ? safe(this.prisma.radPostAuth.findMany({
        where: { username: { in: names }, authdate: { gt: new Date(minStop), lte: new Date(maxStop + 30 * 60_000) }, reply: { contains: 'Reject', mode: 'insensitive' } },
        select: { username: true, authdate: true, callingstationid: true },
        orderBy: { authdate: 'asc' },
        take: 5000,
      }), [] as any[]) : Promise.resolve([] as any[]),
      // The router's own log lines for this customer around the drop.
      names.length ? safe(this.prisma.routerLog.findMany({
        where: { username: { in: names }, loggedAt: { gte: new Date(minStop - 2 * 60_000), lte: new Date(maxStop + 2 * 60_000) } },
        select: { username: true, loggedAt: true, message: true, severity: true },
        orderBy: { loggedAt: 'asc' },
        take: 2000,
      }), [] as any[]) : Promise.resolve([] as any[]),
      // What was done to the customer in the panel in the 15 minutes before.
      subIds.length ? safe(this.prisma.activityLog.findMany({
        where: {
          entityId: { in: subIds },
          entity: { in: ['subscribers', 'Session', 'service-settings', 'Subscriber', 'renewals'] },
          createdAt: { gte: new Date(minStop - 15 * 60_000), lte: new Date(maxStop + 60_000) },
          NOT: { action: { endsWith: '_FAILED' } },
        },
        select: { entityId: true, action: true, details: true, createdAt: true, userId: true },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }), [] as any[]) : Promise.resolve([] as any[]),
    ]);

    // Operator names only inside the viewer's own tree.
    const actorIds = Array.from(new Set(activity.map((a: any) => a.userId).filter(Boolean))) as number[];
    const visible = new Map<number, string>();
    if (actorIds.length) {
      const tree = await this.visibleTree(actor);
      const users = await safe(this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } }), [] as any[]);
      for (const u of users) if (tree.has(u.id)) visible.set(u.id, u.name || u.email);
    }

    for (const r of rows) {
      const stop: number | undefined = r.acctstoptime?.getTime?.();
      if (!stop) continue;
      const start: number | null = r.acctstarttime?.getTime?.() ?? null;
      const sub = r.subscriber || null;
      const mac = macInfo(r.callingstationid);

      // Previous session's MAC.
      const prev = prior.find((p: any) => p.username === r.username && p.radacctid !== r.radacctid && start != null && p.acctstarttime && p.acctstarttime.getTime() < start);
      const prevMac = normaliseMac(prev?.callingstationid);
      const macChanged = prevMac && mac && prevMac !== mac.mac ? { previous: prevMac, previousMaker: macInfo(prevMac)?.maker ?? null, at: prev.acctstarttime } : null;

      // Drops in the hour and day up to this one (this one included).
      const mine = recentStops.filter((x: any) => x.username === r.username && x.acctstoptime).map((x: any) => x.acctstoptime.getTime());
      const lastHour = mine.filter((t: number) => t <= stop && t > stop - 3600_000).length;
      const last24h = mine.filter((t: number) => t <= stop && t > stop - 86_400_000).length;

      // Part of a mass drop on the same router?
      const ip = String(r.nasipaddress || '');
      const m = mass.find((x) => x.nasIp === ip && stop >= x.from - 1000 && stop <= x.to + 1000);

      // Account state at the moment it dropped.
      const exp: Date | null = sub?.serviceSettings?.expiryDate ?? null;
      const account = sub ? {
        status: sub.status,
        package: sub.package?.name ?? null,
        area: sub.area?.name ?? null,
        expiryDate: exp,
        expiredAtDrop: !!exp && exp.getTime() <= stop,
        fupAtDrop: !!sub.fupApplied && (!sub.fupAppliedAt || sub.fupAppliedAt.getTime() <= stop),
        macLocked: normaliseMac(sub.serviceSettings?.macAddress),
      } : null;

      // Reconnect attempts refused afterwards.
      const tries = rejects.filter((x: any) => x.username === r.username && x.authdate.getTime() > stop && x.authdate.getTime() <= stop + 30 * 60_000);
      const retries = tries.length ? {
        failed: tries.length,
        firstAt: tries[0].authdate,
        lastAt: tries[tries.length - 1].authdate,
        likely: likelyReject(account, normaliseMac(tries[tries.length - 1].callingstationid), tries[tries.length - 1].authdate.getTime()),
      } : null;

      // Router log lines within two minutes.
      const lines = routerLines
        .filter((x: any) => x.username === r.username && Math.abs(x.loggedAt.getTime() - stop) <= 2 * 60_000)
        .slice(-3)
        .map((x: any) => ({ at: x.loggedAt, message: String(x.message).slice(0, 240), severity: x.severity }));

      // Panel actions just before.
      const before = activity
        .filter((a: any) => a.entityId === sub?.id && a.createdAt.getTime() <= stop + 60_000 && a.createdAt.getTime() >= stop - 15 * 60_000)
        .slice(0, 3)
        .map((a: any) => ({ at: a.createdAt, what: describeAction(a.action, a.details), by: a.userId ? (visible.get(a.userId) || 'Your provider') : null }));

      // Fibre signal, when the customer has an ONU.
      const tel = sub?.onu?.telemetry;
      const rx: number | null = tel?.rxPowerDbm ?? sub?.onu?.rxPower ?? null;
      const onu = sub?.onu ? {
        rxDbm: rx,
        status: tel?.status ?? null,
        at: tel?.lastSeenAt ?? sub.onu.lastPolledAt ?? null,
        weak: rx != null && rx <= -27,
      } : null;

      const dur = Number(r.acctsessiontime ?? (start != null ? Math.round((stop - start) / 1000) : 0)) || 0;
      const mbps = (b: any) => (dur > 0 && b != null ? Math.round((Number(b) * 8 / dur / 1e6) * 100) / 100 : null);

      out.set(String(r.radacctid), {
        device: mac ? { maker: mac.maker, privateMac: mac.privateMac } : null,
        macChanged,
        flapping: { lastHour, last24h, flagged: lastHour >= 3 || last24h >= 6 },
        massDrop: m ? { customers: m.customers, from: new Date(m.from), to: new Date(m.to) } : null,
        account,
        retries,
        routerLog: lines,
        before,
        onu,
        openTickets: Number(sub?._count?.tickets ?? 0),
        vlan: vlanOf(r.nasportid),
        speed: { downMbps: mbps(r.acctoutputoctets), upMbps: mbps(r.acctinputoctets) },
        ipv6: r.framedipv6address || r.delegatedipv6prefix || r.framedipv6prefix || null,
      });
    }
    return out;
  }

  /**
   * FAILED LOGINS — refused connection attempts by the caller's own customers,
   * grouped into bursts (same customer, MAC and router, no more than ten
   * minutes apart) with the most likely reason. The password column is never
   * read.
   */
  async failedLogins(actor: Actor, q: { sinceHours?: number; search?: string; nasIp?: string; limit?: number; offset?: number } = {}) {
    const hours = Math.min(Math.max(Math.round(Number(q.sinceHours) || 168), 1), 24 * 90);
    const from = new Date(Date.now() - hours * 3600_000);
    const limit = Math.min(Math.max(Math.round(Number(q.limit) || 50), 1), 200);
    const offset = Math.max(Math.round(Number(q.offset) || 0), 0);

    const and: any[] = [{ authdate: { gte: from } }, { reply: { contains: 'Reject', mode: 'insensitive' } }];
    if (this.scope.isAdmin(actor?.role)) {
      const rad = await this.scope.radiusWhere(actor);
      if (rad && Object.keys(rad).length) and.push(rad);
    } else {
      and.push({ subscriber: { is: await this.scope.subscriberWhere(actor) } });
    }
    if (q.nasIp && isIP(String(q.nasIp).trim())) and.push({ nasipaddress: String(q.nasIp).trim() });
    const term = String(q.search ?? '').trim().slice(0, 64);
    if (term) {
      const ors: any[] = [{ username: { contains: term, mode: 'insensitive' } }, { callingstationid: { contains: term, mode: 'insensitive' } }];
      const hex = term.replace(/[^0-9a-f]/gi, '');
      if (hex.length >= 4) {
        const colon = hex.match(/.{1,2}/g)!.join(':');
        if (colon.toLowerCase() !== term.toLowerCase()) ors.push({ callingstationid: { contains: colon, mode: 'insensitive' } });
      }
      and.push({ OR: ors });
    }

    const raw = await this.prisma.radPostAuth.findMany({
      where: { AND: and },
      select: { username: true, authdate: true, callingstationid: true, nasipaddress: true, nasportid: true, calledstationid: true },
      orderBy: { authdate: 'desc' },
      take: 5000,
    });

    // Bursts, newest first.
    type Burst = { username: string; mac: string | null; nasIp: string | null; nasPortId: string | null; service: string | null; firstAt: Date; lastAt: Date; attempts: number };
    const bursts: Burst[] = [];
    const open = new Map<string, Burst>();
    for (const r of raw) {
      const mac = normaliseMac(r.callingstationid) || r.callingstationid || null;
      const key = `${r.username}|${mac}|${r.nasipaddress}`;
      const b = open.get(key);
      if (b && b.firstAt.getTime() - r.authdate.getTime() <= 10 * 60_000) {
        b.firstAt = r.authdate; b.attempts++;
      } else {
        const nb: Burst = { username: r.username, mac, nasIp: r.nasipaddress, nasPortId: r.nasportid, service: r.calledstationid, firstAt: r.authdate, lastAt: r.authdate, attempts: 1 };
        bursts.push(nb); open.set(key, nb);
      }
    }

    const page = bursts.slice(offset, offset + limit);
    const names = Array.from(new Set(page.map((b) => b.username)));
    const subs = names.length ? await this.prisma.subscriber.findMany({
      where: { username: { in: names } },
      select: {
        id: true, username: true, fullName: true, status: true, fupApplied: true, fupAppliedAt: true,
        serviceSettings: { select: { expiryDate: true, macAddress: true } },
      },
    }) : [];
    const subBy = new Map(subs.map((x) => [x.username, x]));
    // Did they get in afterwards?
    const accepts = names.length ? await this.prisma.radPostAuth.findMany({
      where: { username: { in: names }, authdate: { gte: from }, reply: { contains: 'Accept', mode: 'insensitive' } },
      select: { username: true, authdate: true },
      orderBy: { authdate: 'asc' },
      take: 5000,
    }) : [];
    const nasNames = await this.nasNames(actor, Array.from(new Set(page.map((b) => b.nasIp).filter(Boolean))) as string[]);

    const reasonCount = new Map<string, number>();
    const items = page.map((b) => {
      const sub = subBy.get(b.username);
      const exp = sub?.serviceSettings?.expiryDate ?? null;
      const account = sub ? {
        status: sub.status, expiryDate: exp, expiredAtDrop: !!exp && exp.getTime() <= b.lastAt.getTime(),
        fupAtDrop: !!sub.fupApplied, macLocked: normaliseMac(sub.serviceSettings?.macAddress),
      } : null;
      const likely = likelyReject(account as any, normaliseMac(b.mac), b.lastAt.getTime());
      reasonCount.set(likely.key, (reasonCount.get(likely.key) || 0) + 1);
      const gotIn = accepts.find((a) => a.username === b.username && a.authdate.getTime() > b.lastAt.getTime());
      const mi = macInfo(b.mac);
      return {
        username: b.username,
        subscriberId: sub?.id ?? null,
        fullName: sub?.fullName ?? null,
        mac: b.mac,
        device: mi ? { maker: mi.maker, privateMac: mi.privateMac } : null,
        nasIp: b.nasIp,
        nasName: b.nasIp ? nasNames.get(b.nasIp) || null : null,
        nasPortId: b.nasPortId,
        service: b.service,
        firstAt: b.firstAt,
        lastAt: b.lastAt,
        attempts: b.attempts,
        likely,
        accountStatus: sub?.status ?? null,
        expiryDate: exp,
        gotInAt: gotIn?.authdate ?? null,
      };
    });

    return {
      window: { sinceHours: hours, from },
      totals: {
        attempts: raw.length,
        bursts: bursts.length,
        customers: new Set(raw.map((r) => r.username)).size,
        capped: raw.length >= 5000,
      },
      reasons: Array.from(reasonCount.entries()).map(([key, count]) => ({ key, label: REJECT_LABEL[key] || key, count })),
      items,
      total: bursts.length,
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

export interface DisconnectHow {
  by: 'customer' | 'timer' | 'operator' | 'line' | 'router' | 'panel' | 'unknown';
  title: string;
  detail: string | null;
  actor: { name: string; email: string | null } | null;
  method: string | null;     // "RADIUS CoA" | "MikroTik API"
  source: 'panel' | 'cause'; // a recorded panel action, or read from the cause
  steps: string[];           // the panel's attempt trail, when it cut the session
}

/** Panel features that cut sessions, in the words an operator would use. */
const WHY: Record<string, { by: DisconnectHow['by']; title: string; detail: string | null }> = {
  'operator-kick':      { by: 'operator', title: 'Disconnected from the panel', detail: 'An operator pressed Disconnect on this customer.' },
  'duplicate-takedown': { by: 'operator', title: 'All sessions cut from the panel', detail: 'An operator cut every open session for this login (duplicate login).' },
  'duplicate-sweep':    { by: 'panel', title: 'Automatic duplicate-login sweep', detail: 'The same login was online from more than one device, so the panel cut the extra sessions.' },
  'plan-change':        { by: 'panel', title: 'Reconnected after a plan change', detail: 'The package changed, so the session was restarted to apply the new speed.' },
  'static-ip-change':   { by: 'panel', title: 'Reconnected to apply a new static IP', detail: 'The customer was given a static IP, so the session was restarted to pick it up.' },
  'static-ip-released': { by: 'panel', title: 'Reconnected after the static IP was released', detail: 'The static IP was taken back, so the session was restarted on a pool address.' },
  'fup-block':          { by: 'panel', title: 'Fair-usage limit reached — blocked', detail: 'The data quota ran out and the plan blocks at the limit.' },
  'fup-throttle':       { by: 'panel', title: 'Fair-usage limit reached — speed reduced', detail: 'The data quota ran out, so the session was restarted on the reduced speed.' },
  'fup-restore':        { by: 'panel', title: 'Fair-usage reset — full speed restored', detail: 'The fair-usage limit was released and the session restarted at full speed.' },
  panel:                { by: 'panel', title: 'Disconnected by the panel', detail: null },
};

interface MassDrop { nasIp: string; from: number; to: number; customers: number; topKey: string | null }

/**
 * Clusters of stops on one router no more than 60 seconds apart, with enough
 * distinct customers to be an outage: at least 3, or 2% of the customers seen
 * on that router in the window (capped at 25), whichever is larger.
 */
export function detectMassDrops(rows: Array<{ nasipaddress: string | null; acctstoptime: Date | null; username: string | null; acctterminatecause: string | null }>): MassDrop[] {
  const byNas = new Map<string, Array<{ t: number; u: string; c: string | null }>>();
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.acctstoptime || !r.nasipaddress) continue;
    const ip = String(r.nasipaddress);
    const list = byNas.get(ip) || [];
    list.push({ t: r.acctstoptime.getTime(), u: r.username || '', c: r.acctterminatecause });
    byNas.set(ip, list);
    const set = seen.get(ip) || new Set<string>();
    if (r.username) set.add(r.username);
    seen.set(ip, set);
  }
  const out: MassDrop[] = [];
  for (const [ip, list] of byNas) {
    const threshold = Math.min(25, Math.max(3, Math.ceil((seen.get(ip)?.size || 0) * 0.02)));
    list.sort((a, b) => a.t - b.t);
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j + 1 < list.length && list[j + 1].t - list[j].t <= 60_000) j++;
      const cluster = list.slice(i, j + 1);
      const users = new Set(cluster.map((x) => x.u).filter(Boolean));
      if (users.size >= threshold) {
        const causes = new Map<string, number>();
        for (const x of cluster) {
          const k = endedInfo(x.c).key;
          causes.set(k, (causes.get(k) || 0) + 1);
        }
        const top = Array.from(causes.entries()).sort((a, b) => b[1] - a[1])[0];
        out.push({ nasIp: ip, from: cluster[0].t, to: cluster[cluster.length - 1].t, customers: users.size, topKey: top ? top[0] : null });
      }
      i = j + 1;
    }
  }
  return out.sort((a, b) => b.from - a.from);
}

const REJECT_LABEL: Record<string, string> = {
  expired: 'Account expired',
  suspended: 'Account suspended',
  disabled: 'Account disabled',
  'mac-locked': 'MAC address not allowed',
  'fup-block': 'Data limit reached',
  unknown: 'Wrong password or login refused',
};

/** The most likely reason a login was refused, from the account's own state. */
export function likelyReject(
  account: { status?: string; expiryDate?: Date | null; fupAtDrop?: boolean; macLocked?: string | null } | null,
  mac: string | null,
  at: number,
): { key: string; label: string; detail: string } {
  const pick = (key: string, detail: string) => ({ key, label: REJECT_LABEL[key], detail });
  if (account?.status === 'SUSPENDED') return pick('suspended', 'The account is suspended in the panel.');
  if (account?.status === 'INACTIVE') return pick('disabled', 'The account is disabled in the panel.');
  if (account?.status === 'EXPIRED' || (account?.expiryDate && account.expiryDate.getTime() <= at)) {
    return pick('expired', account?.expiryDate ? `The package expired on ${account.expiryDate.toISOString().slice(0, 10)}.` : 'The package has expired.');
  }
  if (account?.macLocked && mac && account.macLocked !== mac) return pick('mac-locked', `The account is locked to ${account.macLocked}, but the login came from ${mac}.`);
  if (account?.fupAtDrop) return pick('fup-block', 'The fair-usage limit blocks this account until it resets.');
  return pick('unknown', 'Most often a wrong password typed in the customer’s router.');
}

/** "ether1-vlan34", "vlan 120", "ether2.300" → the VLAN number. */
export function vlanOf(port: string | null | undefined): string | null {
  const p = String(port ?? '');
  const m = p.match(/vlan[\s._-]?(\d{1,4})/i) || p.match(/\.(\d{1,4})$/);
  return m ? m[1] : null;
}

/** A panel action in plain words, from the audit row. */
export function describeAction(action: string, details: string | null): string {
  const a = String(action || '').toUpperCase();
  const d = String(details || '');
  if (a.includes('DISCONNECT_ALL')) return 'All sessions cut';
  if (a.includes('DISCONNECT')) return 'Disconnected';
  if (a.includes('SUSPEND')) return 'Suspended';
  if (a.includes('ACTIVATE') || a.includes('RENEW') || a.includes('EXTEND') || a.includes('RECHARGE')) return 'Renewed / activated';
  if (a.includes('PACKAGE') || /packageId/.test(d)) return 'Package changed';
  if (a.includes('MAC') || /macAddress/.test(d)) return 'MAC binding changed';
  if (a.includes('PASSWORD') || /password/i.test(d)) return 'Password changed';
  if (a.includes('TRANSFER')) return 'Moved to another account';
  if (a.includes('DELETE')) return 'Deleted';
  if (a === 'UPDATE' || a.endsWith('.UPDATE') || a.endsWith('.WRITE')) return 'Details updated';
  return a.replace(/[._]/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
