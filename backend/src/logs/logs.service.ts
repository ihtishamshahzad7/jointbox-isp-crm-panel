import { BadRequestException, Injectable, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';
import { terminateInfo, endedInfo, fieldsOf } from '../common/radius-terminate';
import { radiusTenancyAllows, TENANCY_REFUSED } from '../nas/radius-tenancy';
import { redactForAudit } from '../common/audit.interceptor';

const ACTIVITY_ENTITY_ALIASES: Record<string, string[]> = {
  subscriber: ['Subscriber', 'subscriber', 'subscribers'],
  nas: ['Nas', 'nas'],
  'ip-pool': ['IpPool', 'ip-pool', 'ip-pools', 'ip_pool'],
  user: ['User', 'user', 'users'],
  payment: ['Payment', 'payment', 'payments'],
};

function activityEntityKey(value: string): string {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['subscriber', 'subscribers'].includes(normalized)) return 'subscriber';
  if (['nas', 'network-device', 'network-devices'].includes(normalized)) return 'nas';
  if (['ip-pool', 'ip-pools'].includes(normalized)) return 'ip-pool';
  if (['user', 'users', 'account', 'accounts'].includes(normalized)) return 'user';
  if (['payment', 'payments', 'transaction', 'transactions'].includes(normalized)) return 'payment';
  return '';
}

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
          details: details ? JSON.stringify(redactForAudit(details)) : null,
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

  private redactAuditDetails(details: string | null): string | null {
    if (!details) return details;
    const splitAt = details.lastIndexOf(' · ');
    const prefix = splitAt < 0 ? '' : details.slice(0, splitAt + 3);
    const body = splitAt < 0 ? details : details.slice(splitAt + 3);
    try {
      const parsed: unknown = JSON.parse(body) as unknown;
      if (typeof parsed === 'string') {
        return prefix + this.redactAuditDetails(parsed);
      }
      return prefix + JSON.stringify(redactForAudit(parsed));
    } catch {
      return (
        prefix +
        body.replace(
          /\b(password|passwd|pass|secret|token|authorization|credential|api[_-]?key|shared[_-]?secret|community|otp|pin)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
          '$1$2"[redacted]"',
        )
      );
    }
  }

  /**
   * One account's logs (?forUser=) — only an account inside the caller's own
   * tree. The id was used as given, so any account could read the login
   * history (emails, IPs) and audit trail of another company or the platform.
   */
  private async idsFor(actor: Actor, forUser?: number): Promise<number[] | null> {
    if (!forUser) return this.subtreeIds(actor);
    if (!this.scope.isAdmin(actor?.role)) await this.scope.assertUser(actor, Number(forUser));
    return [Number(forUser)];
  }

  private async assertActivityEntityReadPermission(actor: Actor, resource: string): Promise<void> {
    if (this.scope.isAdmin(actor?.role)) return;
    const actorId = this.scope.actorId(actor);
    if (!Number.isSafeInteger(actorId) || actorId < 1) {
      throw new ForbiddenException('You are not allowed to view this record activity.');
    }
    const accountIds = await this.scope.ancestorIds(actorId);
    const [grants, denied] = await Promise.all([
      this.prisma.rolePermission.findMany({
        where: { role: actor?.role },
        select: { permission: true },
      }),
      this.prisma.userPermission.findMany({
        where: {
          userId: { in: accountIds },
          allowed: false,
          permission: { in: ['*', `${resource}.*`, `${resource}.read`] },
        },
        select: { permission: true },
      }),
    ]);
    const granted = new Set(grants.map((row) => row.permission));
    if (
      denied.length ||
      !['*', `${resource}.*`, `${resource}.read`, `${resource}.write`].some((permission) => granted.has(permission))
    ) {
      throw new ForbiddenException(`You are not allowed to view ${resource} activity.`);
    }
  }

  // ── Login Logs ────────────────────────────────────────────────

  async getLoginLogs(
    actor: Actor,
    opts: { limit?: number; offset?: number; forUser?: number; q?: string; sinceHours?: number } = {},
  ) {
    const ids = await this.idsFor(actor, opts.forUser);
    const where: any = {};
    if (ids) where.userId = { in: ids };
    if (opts.sinceHours && opts.sinceHours > 0) {
      where.createdAt = { gte: new Date(Date.now() - opts.sinceHours * 3600_000) };
    }
    const q = opts.q?.trim();
    if (q) {
      where.OR = ['email', 'ipAddress', 'failReason'].map((field) => ({
        [field]: { contains: q, mode: 'insensitive' },
      }));
    }

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
    opts: { limit?: number; offset?: number; forUser?: number; action?: string; financial?: boolean; q?: string; sinceHours?: number; auditType?: string; entity?: string; entityId?: number } = {},
  ) {
    const limit = opts.limit ?? 25;
    const offset = opts.offset ?? 0;
    if (![25, 50, 100].includes(limit)) {
      throw new BadRequestException('Limit must be 25, 50, or 100');
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) {
      throw new BadRequestException('Offset must be between 0 and 10000');
    }
    if (opts.q && opts.q.length > 120) {
      throw new BadRequestException('Search text must be 120 characters or fewer');
    }
    let entityFilter: { aliases: string[]; id: number } | null = null;
    if (opts.entity || opts.entityId !== undefined) {
      const entityKey = activityEntityKey(opts.entity || '');
      if (!entityKey || !Number.isSafeInteger(opts.entityId) || Number(opts.entityId) < 1) {
        throw new BadRequestException('A supported entity and positive entity ID are required');
      }
      entityFilter = { aliases: ACTIVITY_ENTITY_ALIASES[entityKey], id: Number(opts.entityId) };
      await this.getEntityActivity(actor, entityKey, entityFilter.id, {
        limit: 25,
        offset: 0,
        authorizeOnly: true,
      });
    }
    const ids = entityFilter && !opts.forUser ? null : await this.idsFor(actor, opts.forUser);
    const where: any = {};
    if (ids) where.userId = { in: ids };
    if (opts.sinceHours && opts.sinceHours > 0) {
      where.createdAt = { gte: new Date(Date.now() - opts.sinceHours * 3600_000) };
    }
    if (opts.auditType === 'changes') where.entity = { not: 'SYSTEM' };
    if (opts.auditType === 'activity') {
      where.AND = [...(where.AND ?? []), { userId: { not: null } }];
    }
    if (entityFilter) {
      where.entity = { in: entityFilter.aliases };
      where.entityId = entityFilter.id;
    }
    const q = opts.q?.trim();
    if (q) {
      where.OR = ['action', 'entity', 'details', 'ipAddress', 'traceId'].map((field) => ({
        [field]: { contains: q, mode: 'insensitive' },
      }));
    }
    // Optional action filter: an explicit comma list, or the financial preset.
    const actions = opts.action
      ? opts.action.split(',').map((a) => a.trim()).filter(Boolean)
      : opts.financial ? LogsService.FINANCIAL_ACTIONS : null;
    if (actions && actions.length) where.action = { in: actions };

    const [logs, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
      }),
      this.prisma.activityLog.count({ where }),
    ]);
    return {
      logs: logs.map((log) => ({ ...log, details: this.redactAuditDetails(log.details) })),
      total,
    };
  }

  /**
   * Return audit rows for exactly one record, after verifying the caller can
   * still access that record. For deleted records, only the caller's own
   * authorized tenant-scope audit rows can establish a retained reference.
   */
  async getEntityActivity(
    actor: Actor,
    entity: string,
    entityId: number,
    opts: { limit: number; offset: number; q?: string; authorizeOnly?: boolean },
  ) {
    const key = activityEntityKey(entity);
    const aliases = ACTIVITY_ENTITY_ALIASES[key];
    if (!key || !aliases) throw new BadRequestException('Unsupported activity entity');
    const permissionResource = key === 'subscriber' ? 'subscribers'
      : key === 'ip-pool' ? 'ip-pools'
        : key === 'user' ? 'users'
          : key === 'payment' ? 'payments' : key;
    await this.assertActivityEntityReadPermission(actor, permissionResource);

    const whereForEntity = { entity: { in: aliases }, entityId };
    let visible = false;
    let exists = false;

    if (key === 'subscriber') {
      const scopeWhere = await this.scope.subscriberWhere(actor);
      visible = !!await this.prisma.subscriber.findFirst({
        where: { AND: [{ id: entityId }, scopeWhere] },
        select: { id: true },
      });
      exists = visible || !!await this.prisma.subscriber.findUnique({
        where: { id: entityId }, select: { id: true },
      });
    } else if (key === 'nas') {
      const scopeWhere = await this.scope.nasWhere(actor);
      visible = !!await this.prisma.nas.findFirst({
        where: { AND: [{ id: entityId }, scopeWhere] },
        select: { id: true },
      });
      exists = visible || !!await this.prisma.nas.findUnique({
        where: { id: entityId }, select: { id: true },
      });
    } else if (key === 'ip-pool') {
      const scopeWhere = await this.scope.poolWhere(actor);
      visible = !!await this.prisma.ipPool.findFirst({
        where: { AND: [{ id: entityId }, scopeWhere] },
        select: { id: true },
      });
      exists = visible || !!await this.prisma.ipPool.findUnique({
        where: { id: entityId }, select: { id: true },
      });
    } else if (key === 'user') {
      const scopeWhere = await this.scope.userWhere(actor);
      visible = !!await this.prisma.user.findFirst({
        where: { AND: [{ id: entityId }, scopeWhere] },
        select: { id: true },
      });
      exists = visible || !!await this.prisma.user.findUnique({
        where: { id: entityId }, select: { id: true },
      });
    } else if (key === 'payment') {
      if (this.scope.isAdmin(actor?.role)) {
        visible = !!await this.prisma.payment.findUnique({
          where: { id: entityId }, select: { id: true },
        });
      } else {
        const [subscriberWhere, tree] = await Promise.all([
          this.scope.subscriberWhere(actor),
          this.scope.descendantIds(await this.scope.rootId(actor)),
        ]);
        visible = !!await this.prisma.payment.findFirst({
          where: {
            id: entityId,
            OR: [
              { subscriber: { is: subscriberWhere } },
              { receivedBy: { in: tree } },
            ],
          },
          select: { id: true },
        });
      }
      exists = visible || !!await this.prisma.payment.findUnique({
        where: { id: entityId }, select: { id: true },
      });
    }

    if (!visible) {
      if (exists) throw new NotFoundException('Record not found');
      const actorIds = await this.subtreeIds(actor);
      const retained = await this.prisma.activityLog.findFirst({
        where: {
          ...whereForEntity,
          ...(actorIds ? { userId: { in: actorIds } } : {}),
        },
        select: { id: true },
      });
      if (!retained) throw new NotFoundException('Record not found');
    }

    if (opts.authorizeOnly) {
      return { latestActivity: null, logs: [], hasMore: false, limit: opts.limit, offset: opts.offset };
    }

    const q = opts.q?.trim();
    const where: any = {
      ...whereForEntity,
      ...(q ? {
        AND: [{
          OR: ['action', 'details', 'ipAddress', 'traceId'].map((field) => ({
            [field]: { contains: q, mode: 'insensitive' },
          })),
        }],
      } : {}),
    };
    const latestWhere = whereForEntity;
    const [latest, pageRows] = await Promise.all([
      this.prisma.activityLog.findFirst({
        where: latestWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
      }),
      this.prisma.activityLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: opts.limit + 1,
        skip: opts.offset,
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
      }),
    ]);
    const hasMore = pageRows.length > opts.limit;
    const logs = (hasMore ? pageRows.slice(0, opts.limit) : pageRows).map((row) => ({
      ...row,
      details: this.redactAuditDetails(row.details),
    }));
    return {
      latestActivity: latest ? {
        ...latest,
        details: this.redactAuditDetails(latest.details),
      } : null,
      logs,
      hasMore,
      limit: opts.limit,
      offset: opts.offset,
    };
  }

  // ── RADIUS auth logs (radpostauth) ────────────────────────────
  /**
   * Paginated FreeRADIUS post-auth log. Credential material is never returned;
   * MAC, port and NAS are enriched per page from the latest radacct session
   * when they were not captured on the authentication attempt itself.
   */
  async getRadiusAuthLogs(actor: Actor, opts: { limit?: number; offset?: number; q?: string; days?: number; sinceHours?: number; forUser?: number; outcome?: string } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const days = opts.days && opts.days > 0 ? opts.days : null;
    const q = (opts.q ?? '').trim();

    // SECURITY: non-admin actors (reseller/retailer/staff) may ONLY see auth logs
    // for subscribers inside their own subtree — never the whole system. Admins
    // (SUPER_ADMIN/ADMIN) see everything. subtreeIds() returns null for admins.
    const ids = opts.forUser
      ? await this.idsFor(actor, opts.forUser)
      : await this.subtreeIds(actor);

    const whereParts: string[] = [];
    const params: any[] = [];
    if (opts.sinceHours && opts.sinceHours > 0) {
      params.push(Math.min(opts.sinceHours, 24 * 90));
      whereParts.push(`p.authdate > NOW() - ($${params.length} * INTERVAL '1 hour')`);
    } else if (days) {
      params.push(Math.min(days, 90));
      whereParts.push(`p.authdate > NOW() - ($${params.length} * INTERVAL '1 day')`);
    }
    const outcome = opts.outcome?.toUpperCase();
    const replyPatterns: Record<string, string> = {
      ACCEPT: '%Access-Accept%',
      REJECT: '%Access-Reject%',
      CHALLENGE: '%Access-Challenge%',
    };
    if (outcome && replyPatterns[outcome]) {
      params.push(replyPatterns[outcome]);
      whereParts.push(`p.reply ILIKE $${params.length}`);
    } else if (outcome === 'UNKNOWN') {
      whereParts.push(`(p.reply IS NULL OR (p.reply NOT ILIKE '%Access-Accept%' AND p.reply NOT ILIKE '%Access-Reject%' AND p.reply NOT ILIKE '%Access-Challenge%'))`);
    }
    if (q) { params.push(`%${q}%`); whereParts.push(`(p.username ILIKE $${params.length} OR p.reply ILIKE $${params.length})`); }
    if (ids !== null) {
      // Restrict to usernames owned within the actor's subtree. An empty subtree
      // yields no rows (the `= ANY(...)` on an empty array matches nothing).
      params.push(ids);
      whereParts.push(`p.username IN (SELECT username FROM "Subscriber" WHERE "userId" = ANY($${params.length}::int[]))`);
    }
    // Demo subscribers authenticate in the sandbox too; their Access-Accepts
    // do not belong in the ISP's auth log. `ids === null` is the ISP branch,
    // which is the only one that can reach them.
    if (ids === null) {
      const frag = this.scope.demoSessionSql('p').trim();
      if (frag) whereParts.push(frag.replace(/^AND\s+/, ''));
    }
    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    // Prefer the values the post-auth query now stores natively on radpostauth
    // (present on every attempt, including rejects). For rows written before
    // that capture existed, fall back to the user's most recent session.
    const rowsSql = `
      SELECT p.id::text AS id, p.authdate, p.username, p.reply, s.id AS subscriberid,
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
      LEFT JOIN "Subscriber" s ON s.username = p.username
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
      // Report only what the RADIUS reply confirms. A reject alone does not
      // establish whether the password, policy, or another factor caused it.
      const mapped = (logs as any[]).map((r) => {
        const accepted = typeof r.reply === 'string' && /accept/i.test(r.reply);
        const reply = typeof r.reply === 'string' ? r.reply : null;
        const result = /accept/i.test(reply || '') ? 'Accept'
          : /reject/i.test(reply || '') ? 'Reject'
          : /challenge/i.test(reply || '') ? 'Challenge'
          : 'Unknown';
        return {
          id: r.id, authdate: r.authdate, username: r.username,
          subscriberId: r.subscriberid == null ? null : Number(r.subscriberid),
          reply, accepted, result, reason: reply || 'No RADIUS reply recorded',
          mac: r.mac, port: r.port, nasip: r.nasip, nas: r.nas,
        };
      });
      return { logs: mapped, total };
    } catch (e: any) {
      this.logger?.warn?.(`RADIUS auth log query failed: ${e?.message || e}`);
      throw e;
    }
  }

  // ── Network Logs ──────────────────────────────────────────────

  async getNetworkLogs(
    actor: Actor,
    opts: { limit?: number; offset?: number; q?: string; severity?: string; sinceHours?: number; forUser?: number } = {},
  ) {
    const userIds = await this.subtreeIds(actor);
    const where: any = {};
    const and: any[] = [];
    if (userIds) {
      where.nas = { ownerId: { in: userIds } };
      // A row about ANOTHER company's subscriber on one of our routers — a
      // cross-company session recorded before the RADIUS tenancy policy was
      // enforced, or while it only monitors — is that company's data: its
      // subscriber's name, address and usage. Router events with no
      // subscriber stay visible.
      and.push({ OR: [
        { subscriberId: null },
        { subscriber: { userId: { in: userIds } } },
      ] });
    }
    if (opts.forUser) {
      await this.scope.assertUser(actor, opts.forUser);
      and.push({ OR: [
        { nas: { ownerId: opts.forUser } },
        { subscriber: { userId: opts.forUser } },
      ] });
    }
    if (opts.sinceHours && opts.sinceHours > 0) {
      where.loggedAt = { gte: new Date(Date.now() - opts.sinceHours * 3600_000) };
    }
    if (opts.severity && opts.severity.toUpperCase() !== 'ALL') {
      where.severity = opts.severity.toUpperCase();
    }
    const term = opts.q?.trim().slice(0, 100);
    if (term) {
      and.push({ OR: ['eventType', 'eventReason', 'username', 'callerId', 'framedIp', 'sessionId', 'message'].map((field) => ({
        [field]: { contains: term, mode: 'insensitive' },
      })) });
    }
    if (and.length) where.AND = and;

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

  /**
   * The live log of one router (Router Console). The company that owns the
   * router sees every line; an account the router was only SHARED with sees
   * the lines about its own customers — never another account's usernames.
   */
  async getRouterLogsForNas(actor: Actor, nasId: number, limit = 120) {
    await this.scope.assertNas(actor, nasId);
    const nas = await this.prisma.nas.findUnique({
      where: { id: nasId },
      select: { id: true, nasname: true, nasIp: true, apiPort: true, apiUsername: true, apiPassword: true, ownerId: true },
    });
    if (!nas?.nasIp || !nas.apiUsername || !nas.apiPassword) {
      return { lines: [], note: 'Add the router\'s API username and password to read its log.' };
    }
    let raw: any[] = [];
    try {
      raw = await this.mikrotik.getRouterLogs(nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword, Math.min(limit, 500));
    } catch (e: any) {
      return { lines: [], error: `Could not read the router log: ${String(e?.message || e).slice(0, 160)}` };
    }

    let allowed: ((msg: string) => boolean) | null = null;
    if (!this.scope.isAdmin(actor?.role)) {
      const mine = await this.scope.descendantIds(await this.scope.rootId(actor));
      const ownsRouter = this.scope.isOwner(actor?.role) && nas.ownerId != null && mine.includes(nas.ownerId);
      if (!ownsRouter) {
        const subs = await this.prisma.subscriber.findMany({
          where: { AND: [{ nasId }, await this.scope.subscriberWhere(actor)] },
          select: { username: true },
        });
        const names = new Set(subs.map((x) => String(x.username || '').toLowerCase()).filter(Boolean));
        allowed = (msg: string) => RouterLogScope.tokens(msg).some((t) => names.has(t));
      }
    }
    const lines = raw
      .filter((l: any) => !allowed || allowed(String(l?.message || '')))
      .map((l: any, i: number) => ({
        id: `${nas.id}-${i}-${l.time}`,
        loggedAt: l.time,
        nas: { nasname: nas.nasname, nasIp: nas.nasIp },
        message: l.message,
        topics: l.topics,
      }));
    return { lines };
  }

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
    // RADIUS tenancy: never another company's router or its API login
    if (
      !(await radiusTenancyAllows(
        this.prisma,
        subscriber.username,
        subscriber.nas.nasIp,
        this.logger,
      ))
    ) {
      return { lines: [], note: TENANCY_REFUSED };
    }

    const rawLines = await this.mikrotik.getRouterLogs(
      subscriber.nas.nasIp,
      subscriber.nas.apiPort ?? 8728,
      subscriber.nas.apiUsername,
      subscriber.nas.apiPassword,
      limit,
    );

    // A router log holds EVERY customer on that router — the ISP's and other
    // franchises' too. This view is about one subscriber, so only lines that
    // name them are returned.
    const uname = String(subscriber.username || '').toLowerCase();
    const lines = rawLines
      .filter((line: any) => !!uname && RouterLogScope.mentions(line?.message, uname))
      .map((line: any, index: number) => ({
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
    opts: { limit?: number; offset?: number; q?: string; sinceHours?: number } = {},
  ) {
    if (!this.scope.isAdmin(actor?.role)) {
      return { logs: [], total: 0 };
    }

    const where: any = {};
    if (opts.sinceHours && opts.sinceHours > 0) {
      where.createdAt = { gte: new Date(Date.now() - opts.sinceHours * 3600_000) };
    }
    const q = opts.q?.trim();
    if (q) {
      where.OR = ['level', 'message', 'source', 'metadata'].map((field) => ({
        [field]: { contains: q, mode: 'insensitive' },
      }));
    }
    const [logs, total] = await Promise.all([
      this.prisma.systemLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: opts.limit ?? 100,
        skip: opts.offset ?? 0,
      }),
      this.prisma.systemLog.count({ where }),
    ]);
    return { logs, total };
  }

  // ── Web Sessions ──────────────────────────────────────────────

  async getSessions(actor: Actor, opts: { forUser?: number } = {}) {
    const ids = await this.idsFor(actor, opts.forUser);
    const where: any = { isActive: true };
    if (ids) where.userId = { in: ids };

    const sessions = await this.prisma.sessionLog.findMany({
      where,
      orderBy: { loginAt: 'desc' },
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        loginAt: true,
        expiresAt: true,
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
    opts: { limit?: number; offset?: number; username?: string; cause?: string; sinceHours?: number; q?: string; forUser?: number } = {},
  ) {
    const take = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
    const skip = Math.max(opts.offset ?? 0, 0);
    const where: any = {};

    // Narrow to the actor's own subtree, and optionally to one authorized account.
    if (!this.scope.isAdmin(actor?.role) || opts.forUser) {
      let subWhere = await this.scope.subscriberWhere(actor);
      if (opts.forUser) {
        await this.scope.assertUser(actor, opts.forUser);
        subWhere = { AND: [subWhere, { userId: opts.forUser }] };
      }
      const subs = await this.prisma.subscriber.findMany({ where: subWhere, select: { username: true } });
      const names = subs.map((s) => s.username).filter(Boolean) as string[];
      if (!names.length) return { items: [], summary: [], total: 0 };
      where.username = { in: names };
    }
    // An ISP-level actor skipped the block above, so it needs the demo rule
    // applied here instead: 2,500 synthetic sessions otherwise fill a page that
    // holds 2,000, and the real ones never appear at all.
    {
      const _rad = await this.scope.radiusWhere(actor);
      if (Object.keys(_rad).length) where.AND = [...(where.AND ?? []), _rad];
    }
    // A username filter narrows the caller's own list — it must never replace
    // it, or any operator could read another company's customer by name.
    if (opts.username) {
      const own: string[] | undefined = where.username?.in;
      if (own && !own.includes(opts.username)) return { items: [], summary: [], total: 0 };
      where.username = opts.username;
    }
    // Time window: sessions that STARTED within the last N hours.
    if (opts.sinceHours && opts.sinceHours > 0) {
      where.acctstarttime = { gte: new Date(Date.now() - opts.sinceHours * 3600_000) };
    }
    if (opts.cause?.toLowerCase() === 'current') where.acctstoptime = null;
    const term = opts.q?.trim().slice(0, 100);
    if (term) {
      where.AND = [...(where.AND ?? []), {
        OR: ['username', 'acctsessionid', 'nasipaddress', 'framedipaddress', 'callingstationid'].map((field) => ({
          [field]: { contains: term, mode: 'insensitive' },
        })),
      }];
    }

    const [rows, total] = await Promise.all([
      this.prisma.radAcct.findMany({
        where,
        orderBy: { radacctid: 'desc' },
        take,
        skip,
      }),
      this.prisma.radAcct.count({ where }),
    ]);

    const [pppoeSessions, nasDevices] = rows.length
      ? await Promise.all([
          this.prisma.pppoeSession.findMany({
            where: { sessionId: { in: rows.map((r) => r.acctsessionid) } },
            select: { sessionId: true, subscriberId: true, isActive: true, lastSeenAt: true, endTime: true, disconnectReason: true },
          }),
          this.prisma.nas.findMany({
            where: { nasIp: { in: [...new Set(rows.map((r) => r.nasipaddress).filter(Boolean))] } },
            select: { id: true, nasname: true, shortname: true, nasIp: true },
          }),
        ])
      : [[], []];
    const pppoeBySession = new Map(pppoeSessions.map((session) => [session.sessionId, session]));
    const nasByIp = new Map(nasDevices.map((nas) => [String(nas.nasIp).replace(/^::ffff:/i, ''), nas]));
    const staleBefore = Date.now() - 30 * 60 * 1000;
    const MB = 1024 * 1024;
    let items = rows.map((r) => {
      const tracked = pppoeBySession.get(r.acctsessionid);
      const nas = nasByIp.get(String(r.nasipaddress).replace(/^::ffff:/i, ''));
      const stoppedAt = r.acctstoptime ?? tracked?.endTime ?? null;
      const sessionState = stoppedAt || tracked?.isActive === false
        ? 'stopped'
        : !tracked
          ? 'unknown'
          : new Date(tracked.lastSeenAt).getTime() < staleBefore
            ? 'stale'
            : 'active';
      const online = sessionState === 'active';
      const info = sessionState === 'stopped'
        ? endedInfo(r.acctterminatecause || tracked?.disconnectReason)
        : terminateInfo(null);
      const durationEnd = sessionState === 'active'
        ? new Date()
        : stoppedAt ?? (sessionState !== 'unknown' ? tracked?.lastSeenAt ?? null : null);
      return {
        id: r.radacctid,
        sessionId: r.acctsessionid,
        subscriberId: tracked?.subscriberId ?? null,
        nasId: nas?.id ?? null,
        nasName: nas?.shortname || nas?.nasname || null,
        sessionState,
        username: r.username,
        nasIp: r.nasipaddress,
        framedIp: r.framedipaddress,
        callingStation: r.callingstationid,
        start: r.acctstarttime,
        stop: stoppedAt,
        lastSeen: r.acctupdatetime,
        durationSec: r.acctsessiontime ?? (r.acctstarttime && durationEnd
          ? Math.max(0, Math.floor((durationEnd.getTime() - r.acctstarttime.getTime()) / 1000))
          : null),
        downloadMB: r.acctoutputoctets != null ? Math.round(Number(r.acctoutputoctets) / MB) : null,
        uploadMB: r.acctinputoctets != null ? Math.round(Number(r.acctinputoctets) / MB) : null,
        online,
        nasPortId: r.nasportid,
        nasPortType: r.nasporttype,
        // The star of this view — the mapped RFC 2866 termination cause.
        ...fieldsOf(info),
      };
    });

    // Per-cause count summary (built BEFORE the cause filter, so the chips always
    // show the full breakdown to pick from). Repeated NAS reboots or carrier
    // losses jump out here.
    const counts = new Map<string, { code: number; label: string; count: number; online: boolean; state: string }>();
    for (const it of items) {
      const key = it.sessionState === 'active' ? 'online'
        : it.sessionState === 'stale' || it.sessionState === 'unknown' ? it.sessionState
        : `${it.terminateCode}:${it.terminateLabel}`;
      const cur = counts.get(key) || {
        code: it.terminateCode,
        label: it.sessionState === 'active' ? 'Online'
          : it.sessionState === 'stale' ? 'Stale'
          : it.sessionState === 'unknown' ? 'Unknown state'
          : it.terminateLabel,
        count: 0,
        online: it.online,
        state: it.sessionState,
      };
      cur.count++;
      counts.set(key, cur);
    }
    const summary = Array.from(counts.values()).sort((a, b) => b.count - a.count);

    // Optional filter by a specific cause label (or "online").
    if (opts.cause) {
      const c = opts.cause.toLowerCase();
      items = items.filter((it) =>
        c === 'current' ? it.sessionState !== 'stopped'
          : c === 'online' ? it.sessionState === 'active'
          : c === 'stale' || c === 'unknown' ? it.sessionState === c
          : (it.sessionState === 'stopped' && it.terminateLabel.toLowerCase() === c),
      );
    }

    return { items, summary, total };
  }

  // ── Failed Activations ────────────────────────────────────────

  async getFailedActivations(
    actor: Actor,
    opts: { limit?: number; offset?: number; q?: string; sinceHours?: number; forUser?: number } = {},
  ) {
    try {
      const ids = opts.forUser
        ? await this.idsFor(actor, opts.forUser)
        : await this.subtreeIds(actor);
      const where: any = {};
      if (ids) where.createdById = { in: ids };
      if (opts.sinceHours && opts.sinceHours > 0) {
        where.createdAt = { gte: new Date(Date.now() - opts.sinceHours * 3600_000) };
      }
      const q = opts.q?.trim().slice(0, 100);
      if (q) {
        where.OR = ['username', 'fullName', 'reason'].map((field) => ({
          [field]: { contains: q, mode: 'insensitive' },
        }));
      }

      const [logs, total] = await Promise.all([
        this.prisma.failedActivation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
          take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
          skip: Math.max(opts.offset ?? 0, 0),
        }),
        this.prisma.failedActivation.count({ where }),
      ]);
      return { logs, total };
    } catch (e: any) {
      this.logger.warn(`Failed activation log query failed: ${e?.message || e}`);
      throw e;
    }
  }

  // ── RADIUS Diagnostics ────────────────────────────────────────

  /**
   * RADIUS health. A company checks its OWN routers, sessions and logins (as
   * the top account always could); the platform account checks the whole
   * server and gets numbers only — no customer, MAC, IP or router name.
   */
  async getRadiusDiagnostics(actor: Actor) {
    if (!this.scope.isOwner(actor?.role)) {
      throw new ForbiddenException(
        'Only ISP-level accounts can view RADIUS diagnostics.',
      );
    }
    const platform = this.scope.isAdmin(actor?.role);
    const ids = platform ? null : await this.scope.descendantIds(await this.scope.rootId(actor));
    const own = ids ? (ids.length ? ids : [-1]) : null;
    const userScope: any = own ? { userId: { in: own } } : {};
    const nasScope: any = own ? { nas: { ownerId: { in: own } } } : {};

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
      where: { status: 'FAILED', createdAt: { gte: fiveMinAgo }, ...userScope },
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
      where: { severity: 'ERROR', loggedAt: { gte: fiveMinAgo }, ...nasScope },
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
        where: { isActive: true, lastSeenAt: { lt: thirtyMinAgo }, ...nasScope },
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
    const nasCount = await this.prisma.nas.count({
      where: { isActive: true, ...(own ? { ownerId: { in: own } } : {}) },
    });
    addCheck('nas-count', 'Active NAS devices', 'OK',
      `${nasCount} NAS device(s) registered`);

    // 5. Active PPPoE sessions
    let activePppoe = 0;
    try {
      activePppoe = await this.prisma.pppoeSession.count({
        where: { isActive: true, lastSeenAt: { gte: thirtyMinAgo }, ...nasScope },
      });
    } catch (e) {}
    addCheck('active-sessions', 'Active PPPoE sessions', 'OK',
      `${activePppoe} currently active`);

    // 6. Last network log
    const lastNetworkLog = await this.prisma.networkLog.findFirst({
      where: nasScope,
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
          platform || !lastNetworkLog.nas?.nasname
            ? `${minsSince} minute(s) ago`
            : `${minsSince} minute(s) ago from ${lastNetworkLog.nas.nasname}`);
      }
    } else {
      addCheck('last-log', 'Last network event', 'WARN',
        'No network logs found — RADIUS may not be receiving data');
    }

    return {
      summary,
      checks,
      // The platform account gets the count (in `checks`), never the customers.
      staleSessions: platform ? [] : staleSessions.map((s: any) => ({
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
    if (!this.scope.isOwner(actor?.role)) {
      throw new ForbiddenException(
        'Only ISP-level accounts can close stale sessions.',
      );
    }
    // A company closes stale sessions on its own routers only.
    const ids = this.scope.isAdmin(actor?.role)
      ? null
      : await this.scope.descendantIds(await this.scope.rootId(actor));
    try {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
      const stale = await this.prisma.pppoeSession.findMany({
        where: {
          isActive: true, lastSeenAt: { lt: thirtyMinAgo },
          ...(ids ? { nas: { ownerId: { in: ids.length ? ids : [-1] } } } : {}),
        },
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
      type?: string;
      sinceHours?: number;
    } = {},
  ) {
    const limit = opts.limit ?? 100;
    const ids = await this.idsFor(actor, opts.forUser);
    const since = opts.sinceHours && opts.sinceHours > 0
      ? new Date(Date.now() - opts.sinceHours * 3600_000)
      : undefined;

    const loginWhere: any = {};
    if (ids) loginWhere.userId = { in: ids };
    if (since) loginWhere.createdAt = { gte: since };

    const activityWhere: any = {};
    if (ids) activityWhere.userId = { in: ids };
    if (since) activityWhere.createdAt = { gte: since };

    const networkWhere: any = {};
    const networkAnd: any[] = [];
    if (ids) {
      networkWhere.nas = { ownerId: { in: ids } };
      networkAnd.push({
        OR: [
          { subscriberId: null },
          { subscriber: { userId: { in: ids } } },
        ],
      });
    }
    if (since) networkWhere.loggedAt = { gte: since };

    const severity = opts.severity?.toUpperCase();
    const type = opts.type?.toLowerCase();
    if (severity) networkWhere.severity = severity;

    const [loginLogs, activityLogs, networkLogs, systemLogs] =
      await Promise.all([
        !type || type === 'login' ? this.prisma.loginLog.findMany({
          where: loginWhere,
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: { user: { select: { id: true, name: true } } },
        }) : Promise.resolve([]),
        !type || type === 'activity' ? this.prisma.activityLog.findMany({
          where: activityWhere,
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: { user: { select: { id: true, name: true } } },
        }) : Promise.resolve([]),
        !type || type === 'network' ? this.prisma.networkLog.findMany({
          where: { ...networkWhere, ...(networkAnd.length ? { AND: networkAnd } : {}) },
          orderBy: { loggedAt: 'desc' },
          take: limit,
          include: {
            nas: { select: { nasname: true, nasIp: true } },
            subscriber: { select: { id: true, fullName: true } },
          },
        }) : Promise.resolve([]),
        (!type || type === 'system') && this.scope.isAdmin(actor?.role)
          ? this.prisma.systemLog.findMany({
              where: since ? { createdAt: { gte: since } } : {},
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
        details: this.redactAuditDetails(a.details),
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
        subscriberId: n.subscriber?.id,
        eventType: n.eventType,
        message: n.message,
        sessionId: n.sessionId,
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
      // Server log volume is the platform's; a company sees its own counts only.
      ids ? Promise.resolve(0) : this.prisma.systemLog.count({ where: { createdAt: { gte: since } } }),
      this.prisma.loginLog.count({
        where: { ...where, status: 'FAILED', createdAt: { gte: since } },
      }),
      this.prisma.networkLog.count({
        where: { ...netWhere, severity: 'ERROR', loggedAt: { gte: since } },
      }),
      this.prisma.sessionLog.count({ where: { isActive: true, ...(ids ? { userId: { in: ids } } : {}) } }),
      ids
        ? this.prisma.$queryRaw<Array<{ hour: string; count: bigint }>>`
            SELECT to_char("createdAt", 'YYYY-MM-DD HH24') AS hour,
                   COUNT(*)::int AS count
            FROM "ActivityLog"
            WHERE "createdAt" >= ${since} AND "userId" = ANY(${ids.length ? ids : [-1]}::int[])
            GROUP BY hour
            ORDER BY hour ASC`
        : this.prisma.$queryRaw<Array<{ hour: string; count: bigint }>>`
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

/** Matching router-log lines to usernames without a LIKE scan. */
export class RouterLogScope {
  /** Words in a log line, lower-cased: "<pppoe-ali01>: authenticated" → [pppoe, ali01, authenticated]. */
  static tokens(message: string): string[] {
    return String(message || '').toLowerCase().split(/[^a-z0-9._@-]+/).filter(Boolean)
      .flatMap((t) => (t.startsWith('pppoe-') ? [t, t.slice(6)] : [t]));
  }

  static mentions(message: string, username: string): boolean {
    return RouterLogScope.tokens(message).includes(String(username || '').toLowerCase());
  }
}
