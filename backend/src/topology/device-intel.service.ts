import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * DeviceIntelService — two ways to learn the network without touching it.
 *
 * Both work on data already in the database, so they need no OLT credentials,
 * no SNMP community, and no config change on any device:
 *
 *  1. MAC IDENTIFICATION — radacct.callingstationid is the ONU or router MAC.
 *     Its first three octets identify the manufacturer, which tells you what
 *     hardware is on every connection you already have.
 *
 *  2. CO-OCCURRENCE CLUSTERING — subscribers who repeatedly drop within the
 *     same few seconds are almost certainly on shared infrastructure: one
 *     splitter, one feeder, one power phase. Clustering disconnect timestamps
 *     INFERS the shared segments even when the OLT never sends a circuit-id.
 *
 *     It cannot name a port. It can say "these fourteen always fail together,
 *     treat them as one segment" — which is the operationally useful half, and
 *     is available on any network today.
 */

/**
 * OUI prefixes for hardware actually seen on ISP access networks.
 *
 * Deliberately a curated list rather than the full IEEE registry: that file is
 * ~35,000 entries and would need shipping, updating and loading, to identify
 * vendors that never appear on a PON. These cover the ONUs, routers and CPEs
 * in real use; anything unmatched is reported honestly as unknown.
 */
const OUI: Record<string, { vendor: string; kind: string }> = {
  // ── ONU / OLT vendors ──
  '00E0FC': { vendor: 'Huawei', kind: 'ONU' },
  '00259E': { vendor: 'Huawei', kind: 'ONU' },
  '286ED4': { vendor: 'Huawei', kind: 'ONU' },
  '480031': { vendor: 'Huawei', kind: 'ONU' },
  '844765': { vendor: 'Huawei', kind: 'ONU' },
  'E0247F': { vendor: 'Huawei', kind: 'ONU' },
  '00196B': { vendor: 'ZTE', kind: 'ONU' },
  '0025F1': { vendor: 'ZTE', kind: 'ONU' },
  '344B50': { vendor: 'ZTE', kind: 'ONU' },
  '9CA6B5': { vendor: 'ZTE', kind: 'ONU' },
  'D0154A': { vendor: 'ZTE', kind: 'ONU' },
  '001E4C': { vendor: 'Fiberhome', kind: 'ONU' },
  '4C5499': { vendor: 'Fiberhome', kind: 'ONU' },
  '00A0DE': { vendor: 'Nokia / Alcatel', kind: 'ONU' },
  '0016BC': { vendor: 'Nokia / Alcatel', kind: 'ONU' },
  '001DAA': { vendor: 'BDCOM', kind: 'ONU' },
  'F8B7E2': { vendor: 'VSOL', kind: 'ONU' },
  '0C8112': { vendor: 'VSOL', kind: 'ONU' },
  '001B9E': { vendor: 'Askey', kind: 'ONU' },
  '00D0F6': { vendor: 'Alcatel', kind: 'OLT' },

  // ── Router / CPE vendors ──
  '000C42': { vendor: 'MikroTik', kind: 'Router' },
  '4C5E0C': { vendor: 'MikroTik', kind: 'Router' },
  '6C3B6B': { vendor: 'MikroTik', kind: 'Router' },
  '2CC81B': { vendor: 'MikroTik', kind: 'Router' },
  '48A98A': { vendor: 'MikroTik', kind: 'Router' },
  '00276F': { vendor: 'TP-Link', kind: 'Router' },
  '14CC20': { vendor: 'TP-Link', kind: 'Router' },
  '50C7BF': { vendor: 'TP-Link', kind: 'Router' },
  'A42BB0': { vendor: 'TP-Link', kind: 'Router' },
  'C46E1F': { vendor: 'TP-Link', kind: 'Router' },
  'EC086B': { vendor: 'TP-Link', kind: 'Router' },
  'C025E9': { vendor: 'TP-Link', kind: 'Router' },
  'C83A35': { vendor: 'Tenda', kind: 'Router' },
  '5CF9DD': { vendor: 'Tenda', kind: 'Router' },
  'D8320E': { vendor: 'Tenda', kind: 'Router' },
  '001346': { vendor: 'D-Link', kind: 'Router' },
  '1CBDB9': { vendor: 'D-Link', kind: 'Router' },
  '78321B': { vendor: 'D-Link', kind: 'Router' },
  '000FB5': { vendor: 'Netgear', kind: 'Router' },
  '20E52A': { vendor: 'Netgear', kind: 'Router' },
  '0018E7': { vendor: 'Cameo', kind: 'Router' },
  '802AA8': { vendor: 'Ubiquiti', kind: 'Radio' },
  '24A43C': { vendor: 'Ubiquiti', kind: 'Radio' },
  '744D28': { vendor: 'Ubiquiti', kind: 'Radio' },
  'DC9FDB': { vendor: 'Ubiquiti', kind: 'Radio' },
  'F09FC2': { vendor: 'Ubiquiti', kind: 'Radio' },
  '0418D6': { vendor: 'Ubiquiti', kind: 'Radio' },
  '00156D': { vendor: 'Ubiquiti', kind: 'Radio' },
  'E4956E': { vendor: 'Realtek/Generic', kind: 'CPE' },
  '001A79': { vendor: 'Realtek/Generic', kind: 'CPE' },
};

@Injectable()
export class DeviceIntelService {
  private readonly logger = new Logger(DeviceIntelService.name);

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /** MAC → manufacturer. Accepts any separator style the NAS might send. */
  identifyMac(mac?: string | null) {
    const clean = String(mac ?? '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (clean.length < 6) return { mac: mac ?? null, vendor: null, kind: null, known: false };
    const prefix = clean.slice(0, 6);
    const hit = OUI[prefix];
    return {
      mac: clean.match(/.{1,2}/g)?.slice(0, 6).join(':') ?? mac,
      oui: prefix,
      vendor: hit?.vendor ?? null,
      kind: hit?.kind ?? null,
      known: !!hit,
    };
  }

  /**
   * What hardware is on the network, by manufacturer.
   *
   * Useful beyond curiosity: a firmware fault or a bad batch shows up as one
   * vendor with a markedly worse online rate than the rest.
   */
  async deviceReport(actor?: Actor) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.userId = { in: await this.scope.descendantIds(await this.scope.rootId(actor)) };
    }

    const subs = await this.prisma.subscriber.findMany({
      where, select: { id: true, username: true, fullName: true },
    });
    if (!subs.length) return { vendors: [], unidentified: 0, total: 0 };

    // Latest MAC per user, plus whether they are up right now.
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT DISTINCT ON (username) username, callingstationid,
              (acctstoptime IS NULL
               AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '15 minutes') AS online
         FROM radacct
        WHERE username = ANY(${subs.map((s) => s.username).filter(Boolean)}::text[]) AND callingstationid IS NOT NULL
        ORDER BY username, acctstarttime DESC`
    .catch(() => [] as any[]);

    const map = new Map<string, any>();
    let unidentified = 0;

    for (const r of rows) {
      const id = this.identifyMac(r.callingstationid);
      const key = id.vendor ?? 'Unknown';
      if (!id.known) unidentified++;
      if (!map.has(key)) map.set(key, { vendor: key, kind: id.kind ?? '—', count: 0, online: 0 });
      const e = map.get(key);
      e.count++;
      if (r.online) e.online++;
    }

    const vendors = [...map.values()]
      .map((v) => ({
        ...v,
        onlinePercent: v.count ? Math.round((v.online / v.count) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    // A vendor sitting well below the fleet average is worth investigating —
    // usually a firmware issue or a bad hardware batch.
    const fleetAvg = rows.length
      ? Math.round((rows.filter((r) => r.online).length / rows.length) * 100)
      : 0;
    vendors.forEach((v: any) => {
      v.suspect = v.count >= 5 && v.onlinePercent < fleetAvg - 25;
    });

    return { vendors, unidentified, total: rows.length, fleetOnlinePercent: fleetAvg };
  }

  /**
   * Infer shared infrastructure from correlated outages.
   *
   * METHOD
   * Disconnects are bucketed into short time windows. Two subscribers dropping
   * in the same window once is coincidence; doing it repeatedly, across many
   * separate incidents, is not — they share something physical.
   *
   * Scoring uses the JACCARD index (shared incidents ÷ combined incidents)
   * rather than a raw count, because a raw count would rank the two busiest
   * subscribers on the network as "related" simply for being unstable
   * independently. Jaccard asks "when one fails, how often does the other?"
   *
   * @param windowSeconds how close two drops must be to count as together
   * @param minShared     incidents two subscribers must share before pairing
   */
  async inferSegments(
    actor?: Actor,
    opts: { days?: number; windowSeconds?: number; minShared?: number; minScore?: number } = {},
  ) {
    const days = opts.days ?? 14;
    const win = opts.windowSeconds ?? 90;
    const minShared = opts.minShared ?? 3;
    const minScore = opts.minScore ?? 0.4;

    const where: any = { status: 'ACTIVE' };
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.userId = { in: await this.scope.descendantIds(await this.scope.rootId(actor)) };
    }
    const subs = await this.prisma.subscriber.findMany({
      where,
      select: {
        id: true, username: true, fullName: true, phone: true,
        area: { select: { name: true } },
        nas: { select: { nasname: true } },
      },
    });
    const names = subs.map((s) => s.username).filter(Boolean) as string[];
    if (names.length < 3) {
      return { clusters: [], analysed: names.length,
        note: 'Not enough active subscribers to infer shared segments.' };
    }

    // Disconnects, bucketed. Truncating to the window size is what turns
    // "within 90 seconds of each other" into a cheap groupable key.
    const events = await this.prisma.$queryRaw<any[]>`
      SELECT username,
              FLOOR(EXTRACT(EPOCH FROM acctstoptime) / ${win})::bigint AS bucket
         FROM radacct
        WHERE username = ANY(${names}::text[])
          AND acctstoptime IS NOT NULL
          AND acctstoptime > NOW() - (${String(days)} || ' days')::interval
        GROUP BY username, bucket`
    .catch(() => [] as any[]);

    if (events.length < 10) {
      return { clusters: [], analysed: names.length,
        note: 'Too few recorded disconnects yet. Correlation needs a couple of weeks of history.' };
    }

    // username → set of incident buckets
    const byUser = new Map<string, Set<string>>();
    // bucket → users who dropped in it
    const byBucket = new Map<string, string[]>();
    for (const e of events) {
      const b = String(e.bucket);
      if (!byUser.has(e.username)) byUser.set(e.username, new Set());
      byUser.get(e.username)!.add(b);
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b)!.push(e.username);
    }

    // Count co-occurrences only WITHIN buckets. Comparing every pair of
    // subscribers would be O(n²) — 10k subscribers is 50M comparisons — while
    // walking the buckets touches only users who actually failed together.
    const pair = new Map<string, number>();
    for (const [, users] of byBucket) {
      // A window where nearly everyone dropped is a network-wide event and
      // says nothing about which two share a splitter.
      if (users.length < 2 || users.length > 60) continue;
      const u = [...new Set(users)].sort();
      for (let i = 0; i < u.length; i++) {
        for (let j = i + 1; j < u.length; j++) {
          const k = `${u[i]}|${u[j]}`;
          pair.set(k, (pair.get(k) ?? 0) + 1);
        }
      }
    }

    // Union-find: any two users scoring above the threshold join one segment.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
      return parent.get(x)!;
    };
    const union = (a: string, b: string) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    const links: any[] = [];
    for (const [k, shared] of pair) {
      if (shared < minShared) continue;
      const [a, b] = k.split('|');
      const setA = byUser.get(a)!, setB = byUser.get(b)!;
      const score = shared / (setA.size + setB.size - shared); // Jaccard
      if (score < minScore) continue;
      union(a, b);
      links.push({ a, b, shared, score: Math.round(score * 100) / 100 });
    }

    const groups = new Map<string, string[]>();
    for (const u of byUser.keys()) {
      if (!parent.has(u)) continue;
      const root = find(u);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(u);
    }

    const subByName = new Map(subs.map((s) => [s.username!, s]));
    const clusters = [...groups.values()]
      .filter((g) => g.length >= 2)
      .map((g, i) => {
        const members = g.map((u) => subByName.get(u)).filter(Boolean) as any[];
        const inner = links.filter((l) => g.includes(l.a) && g.includes(l.b));
        const avg = inner.length
          ? Math.round((inner.reduce((s, l) => s + l.score, 0) / inner.length) * 100) / 100
          : 0;
        const incidents = new Set<string>();
        g.forEach((u) => byUser.get(u)?.forEach((b) => incidents.add(b)));

        const areas = [...new Set(members.map((m) => m.area?.name).filter(Boolean))];
        const nasList = [...new Set(members.map((m) => m.nas?.nasname).filter(Boolean))];

        return {
          id: `seg-${i + 1}`,
          size: members.length,
          confidence: avg,
          // A cluster confined to one area is far more likely to be a real
          // splitter than one scattered across a city, which is more likely a
          // shared upstream or a coincidence of load-shedding schedules.
          likelyShared: areas.length === 1
            ? 'Splitter, feeder fibre or power phase'
            : nasList.length === 1
              ? 'Shared upstream on this router'
              : 'Unclear — members span several areas',
          areas, routers: nasList,
          incidents: incidents.size,
          members: members.map((m) => ({
            id: m.id, name: m.fullName, username: m.username,
            phone: m.phone, area: m.area?.name ?? null,
          })),
        };
      })
      .sort((a, b) => b.size - a.size || b.confidence - a.confidence);

    return {
      clusters,
      analysed: names.length,
      windowSeconds: win,
      days,
      note: clusters.length
        ? `${clusters.length} likely shared segment(s) inferred from ${events.length} disconnect events.`
        : 'No consistent co-occurrence found. Either the network is stable, or faults are genuinely independent.',
    };
  }
}
