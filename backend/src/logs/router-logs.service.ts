import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';
import { mapLimit } from '../common/concurrency';

/**
 * RouterLogsService — mirrors each MikroTik's own log into the panel, and
 * reads it so the operator doesn't have to.
 *
 * WHY THIS EXISTS
 * When a customer cannot stay connected, the router already knows why. It
 * writes lines like "logged in, 255.255.255.254" followed immediately by
 * "terminating...". That is a complete diagnosis sitting on the router — but
 * only reachable by SSHing in, which defeats the point of the panel.
 *
 * So two jobs here: keep a copy of what the router said, and turn the common
 * failure patterns into a plain sentence a support agent can act on without
 * knowing what a Framed-IP-Address is.
 */
@Injectable()
export class RouterLogsService {
  private readonly logger = new Logger(RouterLogsService.name);

  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
    private mikrotik: MikrotikSyncService,
  ) {}

  // ── Collection ───────────────────────────────────────────────

  /**
   * MikroTik log times are like "jul/20 12:24:44", "12:24:44" (today), or
   * "2026-07-20 12:24:44" depending on version and clock settings. Anything
   * unparseable falls back to now, so a line is never dropped over formatting.
   */
  private parseTime(raw: string): Date {
    const now = new Date();
    if (!raw) return now;

    const iso = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(raw);
    if (iso) {
      return new Date(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +iso[6]);
    }

    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const md = /^([a-z]{3})\/(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/i.exec(raw);
    if (md) {
      const m = months[md[1].toLowerCase()];
      if (m !== undefined) {
        const d = new Date(now.getFullYear(), m, +md[2], +md[3], +md[4], +md[5]);
        // A date in the future means it belongs to last year (Dec seen in Jan).
        if (d.getTime() > now.getTime() + 86400_000) d.setFullYear(now.getFullYear() - 1);
        return d;
      }
    }

    const t = /^(\d{2}):(\d{2}):(\d{2})/.exec(raw);
    if (t) {
      const d = new Date(now);
      d.setHours(+t[1], +t[2], +t[3], 0);
      return d;
    }
    return now;
  }

  /**
   * PPPoE lines name the user in one of two shapes:
   *   "<pppoe-ali_khan>: terminating..."
   *   "ali_khan logged in, 10.0.0.5 from 70:4F:..."
   */
  private extractUsername(message: string): string | null {
    const tagged = /<[a-z0-9]+-([^>]+)>/i.exec(message);
    if (tagged) return tagged[1];

    const account = /^(\S+)\s+(?:logged in|logged out)/i.exec(message);
    if (account) return account[1];

    return null;
  }

  private severityOf(topics: string): string {
    const t = topics.toLowerCase();
    if (t.includes('error') || t.includes('critical')) return 'error';
    if (t.includes('warning')) return 'warning';
    return 'info';
  }

  /** Pull one router's log and store anything new. */
  async collectFromNas(nas: any): Promise<number> {
    if (!nas?.nasIp || !nas.apiUsername || !nas.apiPassword) return 0;

    const rows = await this.mikrotik.getRouterLogs(
      nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, 300,
    );
    if (!rows.length) return 0;

    const records = rows.map((r) => {
      const loggedAt = this.parseTime(r.time);
      return {
        nasId: nas.id,
        loggedAt,
        topics: r.topics || '',
        message: r.message || '',
        username: this.extractUsername(r.message || ''),
        severity: this.severityOf(r.topics || ''),
        // Router + timestamp + message identifies a line. The router replays
        // its whole buffer on every poll, so without this the table would grow
        // by hundreds of duplicate rows a minute.
        fingerprint: createHash('sha1')
          .update(`${nas.id}|${loggedAt.toISOString()}|${r.topics}|${r.message}`)
          .digest('hex'),
      };
    });

    const res = await this.prisma.routerLog.createMany({
      data: records,
      skipDuplicates: true, // the fingerprint unique index does the work
    });
    return res.count;
  }

  /**
   * Every two minutes. Routers are polled in parallel but bounded — 200 NAS
   * opening API sockets at once would be worse than the problem it solves.
   */
  @Cron('0 */2 * * * *')
  async collectAll() {
    if (process.env.ROUTER_LOGS_ENABLED === 'false') return;
    try {
      const nasList = await this.prisma.nas.findMany({
        where: { isActive: true, nasIp: { not: null }, apiUsername: { not: null } },
      });
      if (!nasList.length) return;

      // mapLimit hands back {ok, value} per item so one unreachable router
      // never sinks the whole cycle.
      const results = await mapLimit(nasList, 8, (n) =>
        this.collectFromNas(n).catch(() => 0),
      );
      const total = results.reduce(
        (sum, r) => sum + (r.ok ? r.value : 0),
        0,
      );
      if (total) this.logger.debug(`Router logs: ${total} new line(s) from ${nasList.length} router(s)`);
    } catch (e: any) {
      this.logger.warn(`Router log collection failed: ${e?.message || e}`);
    }
  }

  /** Keep a fortnight. Routers are chatty and this table is for diagnosis. */
  @Cron('20 4 * * *')
  async prune() {
    try {
      const cutoff = new Date(Date.now() - 14 * 86400_000);
      const res = await this.prisma.routerLog.deleteMany({ where: { loggedAt: { lt: cutoff } } });
      if (res.count) this.logger.log(`Pruned ${res.count} router log line(s) older than 14 days`);
    } catch (e: any) {
      this.logger.warn(`Router log prune failed: ${e?.message || e}`);
    }
  }

  // ── Reading ──────────────────────────────────────────────────

  /** Log lines for one subscriber, newest first. Pulls fresh before returning. */
  async forSubscriber(subscriberId: number, actor?: Actor, limit = 200) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { username: true, nas: true },
    });
    if (!sub?.username) return { username: null, lines: [], diagnosis: null };

    // Fetch on demand as well as on the cron — when somebody is actively
    // looking at a broken connection, two-minute-old data is not good enough.
    if (sub.nas) await this.collectFromNas(sub.nas).catch(() => 0);

    const lines = await this.prisma.routerLog.findMany({
      where: { username: sub.username },
      orderBy: { loggedAt: 'desc' },
      take: limit,
      include: { nas: { select: { id: true, nasname: true, nasIp: true } } },
    });

    return {
      username: sub.username,
      lines,
      diagnosis: this.diagnose(sub.username, lines),
    };
  }

  /** Everything from one router, or everything in scope. */
  async list(actor?: Actor, query: any = {}) {
    const where: any = {};
    if (query.nasId) where.nasId = Number(query.nasId);
    if (query.username) where.username = query.username;
    if (query.severity && query.severity !== 'ALL') where.severity = query.severity;
    if (query.search) where.message = { contains: String(query.search), mode: 'insensitive' };

    // A reseller sees only routers they own or have been assigned.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.nas = { OR: [{ ownerId: { in: ids } }, { assignments: { some: { userId: { in: ids } } } }] };
    }

    const take = Math.min(Number(query.limit) || 200, 1000);
    const [lines, total] = await Promise.all([
      this.prisma.routerLog.findMany({
        where,
        orderBy: { loggedAt: 'desc' },
        take,
        skip: Number(query.offset) || 0,
        include: { nas: { select: { id: true, nasname: true, nasIp: true } } },
      }),
      this.prisma.routerLog.count({ where }),
    ]);
    return { lines, total };
  }

  // ── Diagnosis ────────────────────────────────────────────────

  /**
   * Turn a pile of log lines into one sentence that says what is wrong.
   *
   * Each rule below exists because it is a fault we have actually hit, and
   * each one names the fix rather than just the symptom. The alternative is
   * asking a support agent to interpret PPPoE log lines, which they should
   * never have to do.
   */
  diagnose(username: string, lines: Array<{ message: string; loggedAt: Date | string }>) {
    if (!lines.length) return null;

    const recent = lines.filter(
      (l) => new Date(l.loggedAt).getTime() > Date.now() - 30 * 60_000,
    );
    if (!recent.length) return null;

    const msgs = recent.map((l) => l.message);
    const logins = msgs.filter((m) => /logged in/i.test(m));
    const terminating = msgs.filter((m) => /terminating/i.test(m));

    // 1. The pool named in the RADIUS reply does not exist on the router.
    //
    //    Checked first because it is the most specific signal available and it
    //    is easy to misread: RADIUS looks perfect (Framed-Pool is set, no
    //    conflicting address), auth succeeds, and radpostauth is full of
    //    Accepts. The fault is entirely on the router, and only the router
    //    log reveals it — "could not determine remote address, using x.x.x.x"
    //    is RouterOS saying it had to invent an address because the named
    //    pool was missing or exhausted. It then drops the session.
    const noRemote = msgs.filter((m) => /could not determine remote address/i.test(m));
    if (noRemote.length) {
      const invented = /using\s+(\d+\.\d+\.\d+\.\d+)/i.exec(noRemote[0])?.[1];
      return {
        severity: 'critical',
        title: 'The IP pool named in the package does not exist on the router',
        detail:
          `${username} authenticates successfully, but the router cannot find the pool it was told to ` +
          `use. It falls back to an invented address${invented ? ` (${invented})` : ''} and drops the ` +
          `session immediately, so the customer reconnects in a loop.`,
        cause:
          'RADIUS is sending a Framed-Pool name that has no matching pool on the MikroTik. The name must ' +
          'match exactly — it is case-sensitive and must already exist on the router.',
        fix:
          'On the router run "/ip pool print" and compare the name with the pool on the package under ' +
          'Plans & Stock → Packages. Create the missing pool on the MikroTik, or point the package at a ' +
          'pool that already exists.',
        occurrences: noRemote.length,
      };
    }

    // 2. The bad-address loop. This is the fault that sent the operator to
    //    SSH: the router accepts the session, is handed an unusable address,
    //    and drops it immediately, forever.
    const sentinel = msgs.find((m) => /logged in,\s*255\.255\.255\.25[45]/i.test(m));
    if (sentinel && logins.length >= 3) {
      return {
        severity: 'critical',
        title: 'Reconnect loop — the address being issued is not usable',
        detail:
          `${username} authenticates successfully, is handed 255.255.255.254, and the router drops the ` +
          `session straight away. This repeats every few seconds, so the customer is effectively offline.`,
        cause:
          'The RADIUS reply is sending a placeholder address alongside the pool instead of letting the ' +
          'router allocate from the pool itself.',
        fix: 'Open the subscriber and press Sync to RADIUS. If it persists, check the package has an IP Pool set.',
        occurrences: logins.length,
      };
    }

    // 2. Flapping without an obvious address fault — usually a physical or
    //    CPE problem rather than anything in the panel.
    if (logins.length >= 5 && terminating.length >= 4) {
      return {
        severity: 'critical',
        title: 'Reconnect loop — session will not hold',
        detail:
          `${username} has connected ${logins.length} times in the last half hour and been dropped each time.`,
        cause:
          'The session comes up and dies immediately. Usually the router cannot allocate an address, ' +
          'or the line/CPE is unstable.',
        fix: 'Check the package has a valid IP Pool and that the pool is not exhausted, then check the customer’s cable and ONT.',
        occurrences: logins.length,
      };
    }

    // 3. Authentication failing outright — RADIUS or credentials.
    const authFail = msgs.filter((m) =>
      /authentication failed|no valid secret|user .* not found|rejected/i.test(m),
    );
    if (authFail.length >= 2) {
      return {
        severity: 'critical',
        title: 'Authentication is being rejected',
        detail: `${username} is being refused by RADIUS ${authFail.length} time(s) in the last half hour.`,
        cause: 'The username or password on the router does not match what is stored in RADIUS.',
        fix: 'Press Sync to RADIUS on the subscriber. If it continues, confirm the RADIUS database is reachable.',
        occurrences: authFail.length,
      };
    }

    // 4. Pool exhaustion — affects everyone on that pool, not just this user.
    const noAddress = msgs.filter((m) => /no more addresses|pool.*(empty|exhaust)/i.test(m));
    if (noAddress.length) {
      return {
        severity: 'critical',
        title: 'The IP pool has run out of addresses',
        detail: 'The router has no free address left to give out.',
        cause: 'Every address in the pool is allocated. New connections cannot be served.',
        fix: 'Widen the range under Network → IP Pools, or clear stale sessions holding addresses.',
        occurrences: noAddress.length,
      };
    }

    // 5. Repeated but not constant — worth flagging, not an emergency.
    if (logins.length >= 3) {
      return {
        severity: 'warning',
        title: 'Connection is unstable',
        detail: `${username} has reconnected ${logins.length} times in the last half hour.`,
        cause: 'Intermittent drops — commonly a power cut, a loose fibre, or a failing ONT.',
        fix: 'Check the area for an outage first; if the area is clear, raise a field job for the line.',
        occurrences: logins.length,
      };
    }

    return null;
  }

  /**
   * Everyone currently in trouble, for the dashboard — so a reconnect loop is
   * noticed by the panel rather than reported by the customer.
   */
  async problemSubscribers(actor?: Actor) {
    const since = new Date(Date.now() - 30 * 60_000);

    const grouped = await this.prisma.routerLog.groupBy({
      by: ['username'],
      where: { loggedAt: { gte: since }, username: { not: null }, message: { contains: 'logged in' } },
      _count: { _all: true },
      having: { username: { _count: { gte: 3 } } },
    });
    if (!grouped.length) return [];

    const names = grouped.map((g) => g.username!).filter(Boolean);
    const where: any = { username: { in: names } };
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.userId = { in: await this.scope.descendantIds(await this.scope.rootId(actor)) };
    }

    const subs = await this.prisma.subscriber.findMany({
      where,
      select: { id: true, fullName: true, username: true, phone: true },
    });

    const out: any[] = [];
    for (const s of subs) {
      const lines = await this.prisma.routerLog.findMany({
        where: { username: s.username, loggedAt: { gte: since } },
        orderBy: { loggedAt: 'desc' },
        take: 60,
      });
      const d = this.diagnose(s.username, lines);
      if (d) out.push({ ...s, diagnosis: d });
    }

    return out.sort((a, b) =>
      a.diagnosis.severity === b.diagnosis.severity ? 0 : a.diagnosis.severity === 'critical' ? -1 : 1,
    );
  }
}
