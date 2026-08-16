import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';
import { terminateInfo } from '../common/radius-terminate';

@Injectable()
export class LogsService {
  private readonly logger = new Logger('Logs');
  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
    private mikrotik: MikrotikSyncService,
  ) {}

  async createLoginLog(data: {
    userId?: any;
    email?: string;
    username?: string;
    ipAddress?: string;
    ip?: string;
    userAgent?: string;
    status?: 'SUCCESS' | 'FAILED';
    success?: boolean;
    failReason?: string;
    reason?: string;
    [key: string]: any;
  }) {
    try {
      return await this.prisma.loginLog.create({
        data: {
          userId: data.userId ? Number(data.userId) : null,
          email: data.email || data.username || '',
          ipAddress: data.ipAddress || data.ip || null,
          userAgent: data.userAgent || null,
          status: data.status || (data.success ? 'SUCCESS' : 'FAILED'),
          failReason: data.failReason || data.reason || null,
        },
      });
    } catch (e) {
      console.error('Login log error:', e);
    }
  }

  async log(action: string, userId?: any, details?: any) {
    try {
      await this.prisma.activityLog.create({
        data: {
          userId: userId ? Number(userId) : null,
          action,
          entity: details?.entity || 'SYSTEM',
          entityId: details?.entityId || null,
          details: details ? JSON.stringify(details) : null,
          ipAddress: details?.ip || details?.ipAddress || null,
          userAgent: details?.userAgent || null,
        },
      });
    } catch (e) {
      console.error('Activity log error:', e);
    }
  }

  private async subtreeIds(actor: Actor): Promise<number[] | null> {
    if (this.scope.isAdmin(actor?.role)) return null;
    const rootId = await this.scope.rootId(actor);
    return this.scope.descendantIds(rootId);
  }

  // ── Login Logs ────────────────────────────────────────────────

  async getLoginLogs(
    actor: Actor,
    opts: { limit?: number; offset?: number; forUser?: number } = {},
  ) {
    const ids = opts.forUser ? [opts.forUser] : await this.subtreeIds(actor);
    const where: any = {};
    if (ids) where.userId = { in: ids };

    const [logs, total] = await Promise.all([
      this.prisma.loginLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: opts.limit ?? 100,
        skip: opts.offset ?? 0,
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
      }),
      this.prisma.loginLog.count({ where }),
    ]);
    return { logs, total };
  }

  // ── Activity Logs ─────────────────────────────────────────────

  /** Actions that touch money — used by the financial audit trail. */
  static readonly FINANCIAL_ACTIONS = [
    'REFUND', 'REVERSE', 'REFUND_REQUEST', 'EXPENSE_REQUEST',
    'SET_PERIOD_LOCK', 'SET_CREDIT_LIMIT', 'TOPUP', 'REVERSE_TOPUP', 'COMMISSION', 'PAYMENT',
  ];

  async getActivityLogs(
    actor: Actor,
    opts: { limit?: number; offset?: number; forUser?: number; action?: string; financial?: boolean } = {},
  ) {
    const ids = opts.forUser ? [opts.forUser] : await this.subtreeIds(actor);
    const where: any = {};
    if (ids) where.userId = { in: ids };
    // Optional action filter: an explicit comma list, or the financial preset.
    const actions = opts.action
      ? opts.action.split(',').map((a) => a.trim()).filter(Boolean)
      : opts.financial ? LogsService.FINANCIAL_ACTIONS : null;
    if (actions && actions.length) where.action = { in: actions };

    const [logs, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: opts.limit ?? 100,
        skip: opts.offset ?? 0,
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
      }),
      this.prisma.activityLog.count({ where }),
    ]);
    return { logs, total };
  }

  // ── RADIUS auth logs (radpostauth) ────────────────────────────
  /**
   * Paginated FreeRADIUS post-auth log — every Access-Accept / Access-Reject.
   * radpostauth only stores id/username/pass/reply/authdate natively, so MAC,
   * VLAN/port and NAS are enriched per page from the user's most recent radacct
   * session (cheap: only the rows on the current page are joined).
   */
  async getRadiusAuthLogs(actor: Actor, opts: { limit?: number; offset?: number; q?: string; days?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const days = opts.days && opts.days > 0 ? opts.days : null;
    const q = (opts.q ?? '').trim();

    // SECURITY: non-admin actors (reseller/retailer/staff) may ONLY see auth logs
    // for subscribers inside their own subtree — never the whole system. Admins
    // (SUPER_ADMIN/ADMIN) see everything. subtreeIds() returns null for admins.
    const ids = await this.subtreeIds(actor);

    const since = days ? `NOW() - INTERVAL '${days} days'` : null;
    const whereParts: string[] = [];
    const params: any[] = [];
    if (since) whereParts.push(`p.authdate > ${since}`);
    if (q) { params.push(`%${q}%`); whereParts.push(`(p.username ILIKE $${params.length} OR p.reply ILIKE $${params.length})`); }
    if (ids !== null) {
      // Restrict to usernames owned within the actor's subtree. An empty subtree
      // yields no rows (the `= ANY(...)` on an empty array matches nothing).
      params.push(ids);
      whereParts.push(`p.username IN (SELECT username FROM "Subscriber" WHERE "userId" = ANY($${params.length}::int[]))`);
    }
    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    // Prefer the values the post-auth query now stores natively on radpostauth
    // (present on every attempt, including rejects). For rows written before
    // that capture existed, fall back to the user's most recent session.
    const rowsSql = `
      SELECT p.id::text AS id, p.authdate, p.username, p.pass, p.reply,
             COALESCE(p.callingstationid, a.callingstationid) AS mac,
             COALESCE(p.nasportid, a.nasportid) AS port,
             COALESCE(p.nasipaddress, host(a.nasipaddress)) AS nasip,
             COALESCE(n.shortname, n.nasname, p.nasipaddress, host(a.nasipaddress)) AS nas
      FROM radpostauth p
      LEFT JOIN LATERAL (
        SELECT callingstationid, nasportid, nasipaddress
        FROM radacct r WHERE r.username = p.username
        ORDER BY r.acctstarttime DESC LIMIT 1
      ) a ON true
      LEFT JOIN nas n ON n.nasname = COALESCE(p.nasipaddress, host(a.nasipaddress))
      ${whereSql}
      ORDER BY p.id DESC
      LIMIT ${limit} OFFSET ${offset}`;

    const countSql = `SELECT COUNT(*)::bigint AS n FROM radpostauth p ${whereSql}`;

    try {
      const [logs, cnt] = await Promise.all([
        this.prisma.$queryRawUnsafe<any[]>(rowsSql, ...params),
        this.prisma.$queryRawUnsafe<any[]>(countSql, ...params),
      ]);
      const total = Number(cnt?.[0]?.n ?? 0);
      return { logs, total };
    } catch (e: any) {
      this.logger?.warn?.(`RADIUS auth log query failed: ${e?.message || e}`);
      return { logs: [], total: 0 };
    }
  }

  // ── Network Logs ──────────────────────────────────────────────

  async getNetworkLogs(
    actor: Actor,
    opts: { limit?: number; offset?: number } = {},
  ) {
    const userIds = await this.subtreeIds(actor);
    const where: any = {};
    if (userIds) {
      where.nas = { ownerId: { in: userIds } };
    }

    const [logs, total] = await Promise.all([
      this.prisma.networkLog.findMany({
        where,
        orderBy: { loggedAt: 'desc' },
        take: opts.limit ?? 100,
        skip: opts.offset ?? 0,
        include: {
          nas: { select: { id: true, nasname: true, nasIp: true } },
          subscriber: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.networkLog.count({ where }),
    ]);
    return { logs, total };
  }

  // ── Router logs from the subscriber's NAS ─────────────────────────

  async getRouterLogsForSubscriber(
    actor: Actor,
    subscriberId: number,
    limit = 200,
  ) {
    const ids = await this.subtreeIds(actor);
    const where: any = { id: subscriberId };
    if (ids) where.userId = { in: ids };

    const subscriber = await this.prisma.subscriber.findFirst({
      where,
      include: {
        nas: {
          select: {
            id: true,
            nasname: true,
            nasIp: true,
            apiPort: true,
            apiUsername: true,
            apiPassword: true,
          },
        },
      },
    });

    if (!subscriber || !subscriber.nas || !subscriber.nas.nasIp || !subscriber.nas.apiUsername || !subscriber.nas.apiPassword) {
      return { lines: [] };
    }

    const rawLines = await this.mikrotik.getRouterLogs(
      subscriber.nas.nasIp,
      subscriber.nas.apiPort ?? 8728,
      subscriber.nas.apiUsername,
      subscriber.nas.apiPassword,
      limit,
    );

    const lines = rawLines.map((line: any, index: number) => ({
      id: `${subscriber.nas?.id || 'nas'}-${index}-${line.time}`,
      loggedAt: line.time,
      nas: { nasname: subscriber.nas?.nasname || '', nasIp: subscriber.nas?.nasIp || '' },
      message: line.message,
      topics: line.topics,
    }));

    const errorPatterns = [
      /authentication failed/i,
      /access denied/i,
      /reject/i,
      /no more addresses/i,
      /terminated/i,
      /disconnect/i,
      /error/i,
      /timeout/i,
    ];
    const criticalPatterns = [
      /authentication failed/i,
      /access denied/i,
      /reject/i,
      /no more addresses/i,
    ];
    const warningPatterns = [
      /terminated/i,
      /disconnect/i,
      /timeout/i,
    ];

    const matches = lines.filter((line) =>
      errorPatterns.some((pattern) => pattern.test(line.message || '')),
    );
    const critical = lines.filter((line) =>
      criticalPatterns.some((pattern) => pattern.test(line.message || '')),
    );
    const warning = lines.filter((line) =>
      warningPatterns.some((pattern) => pattern.test(line.message || '')),
    );

    const diagnosis = lines.length === 0
      ? {
        severity: 'warn',
        title: 'Router log empty',
        detail: 'No recent router events were found for this subscriber.',
        cause: 'The router may not have recorded any PPPoE events yet, or the log query did not return matching records.',
        fix: 'Verify the NAS is reachable, has API credentials configured, and that this subscriber has attempted to connect.',
        occurrences: 0,
      }
      : critical.length > 0
      ? {
        severity: 'critical',
        title: 'Router reported a PPPoE failure',
        detail: `The router log shows ${critical.length} failure event(s) for this subscriber.`,
        cause: 'The router is rejecting or dropping the session, often due to authentication, address assignment or PPPoE timeout issues.',
        fix: 'Check the subscriber password, RADIUS credentials, NAS settings and whether the subscriber has a valid IP assignment.',
        occurrences: critical.length,
      }
      : warning.length > 0
      ? {
        severity: 'warn',
        title: 'Router reported a connection warning',
        detail: `The router log shows ${warning.length} warning event(s) for this subscriber.`,
        cause: 'The router has observed session disconnects or timeouts that may indicate an unstable connection.',
        fix: 'Inspect the NAS link, subscriber profile and any intermittent errors in the router log.',
        occurrences: warning.length,
      }
      : {
        severity: 'ok',
        title: 'No router fault detected',
        detail: 'The router log does not show any obvious PPPoE failure messages for this subscriber.',
        cause: 'The router appears to be handling authentication and session setup normally.',
        fix: 'If the subscriber is still experiencing issues, check the upstream network and RADIUS server logs.',
        occurrences: 0,
      };

    return { lines, diagnosis };
  }

  // ── System Logs ───────────────────────────────────────────────

  async getSystemLogs(
    actor: Actor,
    opts: { limit?: number; offset?: number } = {},
  ) {
    if (!this.scope.isAdmin(actor?.role)) {
      return { logs: [], total: 0 };
    }

    const [logs, total] = await Promise.all([
      this.prisma.systemLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: opts.limit ?? 100,
        skip: opts.offset ?? 0,
      }),
      this.prisma.systemLog.count(),
    ]);
    return { logs, total };
  }

  // ── Web Sessions ──────────────────────────────────────────────

  async getSessions(actor: Actor, opts: { forUser?: number } = {}) {
    const ids = opts.forUser ? [opts.forUser] : await this.subtreeIds(actor);
    const where: any = { isActive: true };
    if (ids) where.userId = { in: ids };

    const sessions = await this.prisma.sessionLog.findMany({
      where,
      orderBy: { loginAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
      },
    });
    return sessions;
  }

  /**
   * RADIUS SESSION HISTORY — the real accounting record (radacct), including
   * WHY each session ended, mapped from the RFC 2866 Acct-Terminate-Cause codes
   * (User-Request, Idle/Session-Timeout, NAS-Reboot, Lost-Carrier, …) to a plain
   * label + description. This is the view an operator needs to see why a
   * customer keeps dropping. Scoped to the caller's own subscribers.
   */
  async getRadiusSessions(
    actor: Actor,
    opts: { limit?: number; username?: string; cause?: string; sinceHours?: number } = {},
  ) {
    const take = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
    const where: any = {};

    // Scope: non-admins only see their own subtree's subscriber usernames.
    if (!this.scope.isAdmin(actor?.role)) {
      const subWhere = await this.scope.subscriberWhere(actor);
      const subs = await this.prisma.subscriber.findMany({ where: subWhere, select: { username: true } });
      const names = subs.map((s) => s.username).filter(Boolean) as string[];
      if (!names.length) return { items: [], summary: [], total: 0 };
      where.username = { in: names };
    }
    if (opts.username) where.username = opts.username;
    // Time window: sessions that STARTED within the last N hours.
    if (opts.sinceHours && opts.sinceHours > 0) {
      where.acctstarttime = { gte: new Date(Date.now() - opts.sinceHours * 3600_000) };
    }

    const rows = await this.prisma.radAcct.findMany({
      where,
      orderBy: { radacctid: 'desc' },
      take,
    });

    const MB = 1024 * 1024;
    let items = rows.map((r) => {
      const online = r.acctstoptime == null;
      const info = terminateInfo(online ? null : r.acctterminatecause);
      return {
        id: r.radacctid,
        username: r.username,
        nasIp: r.nasipaddress,
        framedIp: r.framedipaddress,
        callingStation: r.callingstationid,
        start: r.acctstarttime,
        stop: r.acctstoptime,
        lastSeen: r.acctupdatetime,
        durationSec: r.acctsessiontime ?? null,
        downloadMB: r.acctoutputoctets != null ? Math.round(Number(r.acctoutputoctets) / MB) : null,
        uploadMB: r.acctinputoctets != null ? Math.round(Number(r.acctinputoctets) / MB) : null,
        online,
        // The star of this view — the mapped RFC 2866 termination cause.
        terminateCode: info.code,
        terminateLabel: info.label,
        terminateDescription: info.description,
      };
    });

    // Per-cause count summary (built BEFORE the cause filter, so the chips always
    // show the full breakdown to pick from). Repeated NAS reboots or carrier
    // losses jump out here.
    const counts = new Map<string, { code: number; label: string; count: number; online: boolean }>();
    for (const it of items) {
      const key = it.online ? 'online' : `${it.terminateCode}:${it.terminateLabel}`;
      const cur = counts.get(key) || { code: it.terminateCode, label: it.online ? 'Online' : it.terminateLabel, count: 0, online: it.online };
      cur.count++;
      counts.set(key, cur);
    }
    const summary = Array.from(counts.values()).sort((a, b) => b.count - a.count);

    // Optional filter by a specific cause label (or "online").
    if (opts.cause) {
      const c = opts.cause.toLowerCase();
      items = items.filter((it) =>
        c === 'online' ? it.online : (!it.online && it.terminateLabel.toLowerCase() === c),
      );
    }

    return { items, summary, total: items.length };
  }

  // ── Failed Activations ────────────────────────────────────────

  async getFailedActivations(actor: Actor, opts: { limit?: number } = {}) {
    try {
      const ids = await this.subtreeIds(actor);
      const where: any = {};
      if (ids) where.createdById = { in: ids };

      const logs = await this.prisma.failedActivation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: opts.limit ?? 200,
      });
      return logs;
    } catch (e) {
      // Table may not exist yet
      console.warn('failedActivation table not available:', e);
      return [];
    }
  }

  // ── RADIUS Diagnostics ────────────────────────────────────────

  async getRadiusDiagnostics(actor: Actor) {
    if (!this.scope.isAdmin(actor?.role)) {
      throw new ForbiddenException(
        'Only ISP-level accounts can view RADIUS diagnostics.',
      );
    }

    const checks: any[] = [];
    const summary = { failures: 0, warnings: 0, ok: 0 };

    const addCheck = (
      key: string,
      label: string,
      status: string,
      detail: string,
      hint?: string,
    ) => {
      checks.push({ key, label, status, detail, hint });
      if (status === 'FAIL') summary.failures++;
      else if (status === 'WARN') summary.warnings++;
      else summary.ok++;
    };

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);

    // 1. Recent login failures
    const recentFails = await this.prisma.loginLog.count({
      where: { status: 'FAILED', createdAt: { gte: fiveMinAgo } },
    });
    if (recentFails > 10) {
      addCheck('login-failures', 'Login failures', 'FAIL',
        `${recentFails} failed logins in the last 5 minutes`,
        'Check for brute-force attacks or misconfigured credentials.');
    } else if (recentFails > 0) {
      addCheck('login-failures', 'Login failures', 'WARN',
        `${recentFails} failed login(s) in the last 5 minutes`);
    } else {
      addCheck('login-failures', 'Login failures', 'OK',
        'No failed logins recently');
    }

    // 2. Recent network errors
    const recentErrors = await this.prisma.networkLog.count({
      where: { severity: 'ERROR', loggedAt: { gte: fiveMinAgo } },
    });
    if (recentErrors > 5) {
      addCheck('network-errors', 'Network errors', 'FAIL',
        `${recentErrors} network errors in last 5 minutes`,
        'Check NAS connectivity and RADIUS server logs.');
    } else if (recentErrors > 0) {
      addCheck('network-errors', 'Network errors', 'WARN',
        `${recentErrors} network error(s) recently`);
    } else {
      addCheck('network-errors', 'Network errors', 'OK', 'No network errors');
    }

    // 3. Stale PPPoE sessions — wrapped in try/catch in case table missing
    let staleSessions: any[] = [];
    try {
      staleSessions = await this.prisma.pppoeSession.findMany({
        where: { isActive: true, lastSeenAt: { lt: thirtyMinAgo } },
        take: 50,
        orderBy: { lastSeenAt: 'asc' },
        select: {
          id: true,
          sessionId: true,
          username: true,
          callerId: true,
          framedIp: true,
          lastSeenAt: true,
          nas: { select: { nasIp: true, nasname: true } },
        },
      });

      if (staleSessions.length > 10) {
        addCheck('stale-sessions', 'Stale RADIUS sessions', 'FAIL',
          `${staleSessions.length} stale session(s)`,
          'Click "Close stale sessions" to clean them up.');
      } else if (staleSessions.length > 0) {
        addCheck('stale-sessions', 'Stale RADIUS sessions', 'WARN',
          `${staleSessions.length} stale session(s)`);
      } else {
        addCheck('stale-sessions', 'Stale RADIUS sessions', 'OK',
          'No stale sessions');
      }
    } catch (e) {
      addCheck('stale-sessions', 'Stale RADIUS sessions', 'WARN',
        'PPPoE session table not available yet');
    }

    // 4. NAS count
    const nasCount = await this.prisma.nas.count({ where: { isActive: true } });
    addCheck('nas-count', 'Active NAS devices', 'OK',
      `${nasCount} NAS device(s) registered`);

    // 5. Active PPPoE sessions
    let activePppoe = 0;
    try {
      activePppoe = await this.prisma.pppoeSession.count({
        where: { isActive: true },
      });
    } catch (e) {}
    addCheck('active-sessions', 'Active PPPoE sessions', 'OK',
      `${activePppoe} currently active`);

    // 6. Last network log
    const lastNetworkLog = await this.prisma.networkLog.findFirst({
      orderBy: { loggedAt: 'desc' },
      select: {
        loggedAt: true,
        nas: { select: { nasname: true } },
      },
    });
    if (lastNetworkLog) {
      const minsSince = Math.round(
        (Date.now() - lastNetworkLog.loggedAt.getTime()) / 60000,
      );
      if (minsSince > 30) {
        addCheck('last-log', 'Last network event', 'FAIL',
          `${minsSince} minutes ago — no RADIUS traffic received`,
          'Check NAS devices are sending accounting packets.');
      } else if (minsSince > 10) {
        addCheck('last-log', 'Last network event', 'WARN',
          `${minsSince} minutes since last event`);
      } else {
        addCheck('last-log', 'Last network event', 'OK',
          `${minsSince} minute(s) ago from ${lastNetworkLog.nas?.nasname}`);
      }
    } else {
      addCheck('last-log', 'Last network event', 'WARN',
        'No network logs found — RADIUS may not be receiving data');
    }

    return {
      summary,
      checks,
      staleSessions: staleSessions.map((s: any) => ({
        username: s.username,
        nasipaddress: s.nas?.nasIp ?? '',
        nasname: s.nas?.nasname ?? '',
        framedipaddress: s.framedIp,
        callingstationid: s.callerId,
        silent_seconds: Math.round(
          (Date.now() - new Date(s.lastSeenAt).getTime()) / 1000,
        ),
      })),
    };
  }

  async closeStaleSessions(actor: Actor) {
    if (!this.scope.isAdmin(actor?.role)) {
      throw new ForbiddenException(
        'Only ISP-level accounts can close stale sessions.',
      );
    }
    try {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
      const stale = await this.prisma.pppoeSession.findMany({
        where: { isActive: true, lastSeenAt: { lt: thirtyMinAgo } },
      });

      let closed = 0;
      for (const session of stale) {
        await this.prisma.pppoeSession.update({
          where: { id: session.id },
          data: {
            isActive: false,
            endTime: new Date(),
            disconnectReason: 'Closed as stale (no recent activity)',
          },
        });
        closed++;
      }
      return { closed };
    } catch (e) {
      return { closed: 0, error: 'PPPoE session table not available' };
    }
  }

  // ── Unified Timeline ──────────────────────────────────────────

  async getTimeline(
    actor: Actor,
    opts: {
      limit?: number;
      offset?: number;
      severity?: string;
      forUser?: number;
    } = {},
  ) {
    const limit = opts.limit ?? 100;
    const ids = opts.forUser
      ? [opts.forUser]
      : await this.subtreeIds(actor);

    const loginWhere: any = {};
    if (ids) loginWhere.userId = { in: ids };

    const activityWhere: any = {};
    if (ids) activityWhere.userId = { in: ids };

    const networkWhere: any = {};
    if (ids) networkWhere.nas = { ownerId: { in: ids } };

    const severity = opts.severity?.toUpperCase();

    const [loginLogs, activityLogs, networkLogs, systemLogs] =
      await Promise.all([
        this.prisma.loginLog.findMany({
          where: loginWhere,
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: { user: { select: { id: true, name: true } } },
        }),
        this.prisma.activityLog.findMany({
          where: activityWhere,
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: { user: { select: { id: true, name: true } } },
        }),
        this.prisma.networkLog.findMany({
          where: { ...networkWhere, ...(severity ? { severity } : {}) },
          orderBy: { loggedAt: 'desc' },
          take: limit,
          include: {
            nas: { select: { nasname: true, nasIp: true } },
            subscriber: { select: { id: true, fullName: true } },
          },
        }),
        this.scope.isAdmin(actor?.role)
          ? this.prisma.systemLog.findMany({
              orderBy: { createdAt: 'desc' },
              take: limit,
            })
          : Promise.resolve([]),
      ]);

    const tagged: any[] = [];

    for (const l of loginLogs) {
      tagged.push({
        _type: 'login',
        id: `login-${l.id}`,
        ts: l.createdAt,
        status: l.status,
        user: l.user?.name,
        email: l.email,
        ipAddress: l.ipAddress,
        userAgent: l.userAgent,
        severity: l.status === 'SUCCESS' ? 'INFO' : 'ERROR',
        failReason: l.failReason,
      });
    }

    for (const a of activityLogs) {
      tagged.push({
        _type: 'activity',
        id: `activity-${a.id}`,
        ts: a.createdAt,
        user: a.user?.name,
        action: a.action,
        entity: a.entity,
        entityId: a.entityId,
        details: a.details,
        ipAddress: a.ipAddress,
        severity: 'INFO',
      });
    }

    for (const n of networkLogs) {
      tagged.push({
        _type: 'network',
        id: `network-${n.id}`,
        ts: n.loggedAt,
        nasName: n.nas?.nasname,
        nasIp: n.nas?.nasIp,
        username: n.username,
        eventType: n.eventType,
        message: n.message,
        callerId: n.callerId,
        framedIp: n.framedIp,
        subscriberName: n.subscriber?.fullName,
        severity: n.severity || 'INFO',
      });
    }

    for (const s of systemLogs) {
      tagged.push({
        _type: 'system',
        id: `system-${s.id}`,
        ts: s.createdAt,
        level: s.level,
        source: s.source,
        message: s.message,
        severity: s.level || 'INFO',
      });
    }

    tagged.sort(
      (a: any, b: any) =>
        new Date(b.ts).getTime() - new Date(a.ts).getTime(),
    );

    return tagged.slice(0, limit);
  }

  // ── Stats ─────────────────────────────────────────────────────

  async getStats(actor: Actor, hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const ids = await this.subtreeIds(actor);

    const where: any = {};
    if (ids) where.userId = { in: ids };

    const netWhere: any = {};
    if (ids) netWhere.nas = { ownerId: { in: ids } };

    const [
      loginCount,
      activityCount,
      networkCount,
      systemCount,
      failedLogins,
      networkErrors,
      activeSessions,
      hourlyRaw,
    ] = await Promise.all([
      this.prisma.loginLog.count({
        where: { ...where, createdAt: { gte: since } },
      }),
      this.prisma.activityLog.count({
        where: { ...where, createdAt: { gte: since } },
      }),
      this.prisma.networkLog.count({
        where: { ...netWhere, loggedAt: { gte: since } },
      }),
      this.prisma.systemLog.count({ where: { createdAt: { gte: since } } }),
      this.prisma.loginLog.count({
        where: { ...where, status: 'FAILED', createdAt: { gte: since } },
      }),
      this.prisma.networkLog.count({
        where: { ...netWhere, severity: 'ERROR', loggedAt: { gte: since } },
      }),
      this.prisma.sessionLog.count({ where: { isActive: true } }),
      this.prisma.$queryRaw<Array<{ hour: string; count: bigint }>>`
        SELECT to_char("createdAt", 'YYYY-MM-DD HH24') AS hour,
               COUNT(*)::int AS count
        FROM "ActivityLog"
        WHERE "createdAt" >= ${since}
        GROUP BY hour
        ORDER BY hour ASC`,
    ]);

    const hourly = (hourlyRaw || []).map((r: any) => ({
      hour: String(r.hour),
      count: Number(r.count),
    }));

    return {
      period: { hours, since: since.toISOString() },
      totals: {
        login: Number(loginCount),
        activity: Number(activityCount),
        network: Number(networkCount),
        system: Number(systemCount),
      },
      errors: {
        failedLogins: Number(failedLogins),
        networkErrors: Number(networkErrors),
      },
      activeSessions: Number(activeSessions),
      hourly,
    };
  }
}