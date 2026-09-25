import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

export type RadiusAccountingOptions = {
  page?: number;
  limit?: number;
  q?: string;
  nasIp?: string;
  username?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  sortBy?: string;
  sortOrder?: string;
};

export type RadiusAccountingPage = {
  items: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ALLOWED_SORTS: Record<string, string> = {
  radacctid: 'a.radacctid',
  username: 'a.username',
  acctstarttime: 'a.acctstarttime',
  acctstoptime: 'a.acctstoptime',
  acctupdatetime: 'a.acctupdatetime',
  nasipaddress: 'a.nasipaddress',
  framedipaddress: 'a.framedipaddress',
  acctsessiontime: 'a.acctsessiontime',
};

@Injectable()
export class RadiusAccountingService {
  private readonly logger = new Logger(RadiusAccountingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** Builds the same predicates for both page data and COUNT(*). */
  private async predicates(actor: Actor, opts: RadiusAccountingOptions) {
    const parts: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value?: unknown) => {
      if (value === undefined) parts.push(sql);
      else {
        values.push(value);
        parts.push(sql.replace('?', `$${values.length}`));
      }
    };

    const ids = this.scope.isAdmin(actor?.role)
      ? null
      : await this.scope.descendantIds(await this.scope.rootId(actor));

    if (ids) add('EXISTS (SELECT 1 FROM "Subscriber" s_scope WHERE s_scope.username = a.username AND s_scope."userId" = ANY(?::int[]))', ids);
    if (ids && ids.length === 0) parts.push('FALSE');
    if (this.scope.isAdmin(actor?.role)) {
      const demo = this.scope.demoSessionSql('a').trim();
      if (demo) parts.push(demo.replace(/^AND\s+/, ''));
    }

    const q = opts.q?.trim();
    if (q) {
      add(`(a.username ILIKE ? OR a.realm ILIKE $${values.length + 1} OR a.callingstationid ILIKE $${values.length + 1} OR a.calledstationid ILIKE $${values.length + 1} OR a.framedipaddress::text ILIKE $${values.length + 1} OR a.nasipaddress::text ILIKE $${values.length + 1} OR a.acctsessionid ILIKE $${values.length + 1} OR a.servicetype ILIKE $${values.length + 1} OR EXISTS (SELECT 1 FROM nas n_search WHERE n_search.nasname ILIKE $${values.length + 1} AND n_search.nasIp::text = a.nasipaddress::text))`, `%${q}%`);
    }
    if (opts.nasIp?.trim()) add('a.nasipaddress::text = ?', opts.nasIp.trim());
    if (opts.username?.trim()) add('a.username ILIKE ?', `%${opts.username.trim()}%`);
    if (opts.status === 'active') parts.push('a.acctstoptime IS NULL');
    if (opts.status === 'stopped') parts.push('a.acctstoptime IS NOT NULL');

    const start = this.dateValue(opts.startDate);
    const end = this.dateValue(opts.endDate, true);
    if (start) add('a.acctstarttime >= ?', start);
    if (end) add('a.acctstarttime < ?', end);

    return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', values };
  }

  private dateValue(value?: string, end = false): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    if (end && /^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }

  async getPage(actor: Actor, opts: RadiusAccountingOptions = {}): Promise<RadiusAccountingPage> {
    const page = Math.max(1, Number.isFinite(Number(opts.page)) ? Math.floor(Number(opts.page)) : 1);
    const pageSize = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(Number(opts.limit)) ? Math.floor(Number(opts.limit)) : DEFAULT_LIMIT));
    const offset = (page - 1) * pageSize;
    const sort = ALLOWED_SORTS[opts.sortBy || ''] || ALLOWED_SORTS.acctstarttime;
    const direction = String(opts.sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const predicates = await this.predicates(actor, opts);
    const values = [...predicates.values, pageSize, offset];
    const limitParam = values.length - 1;
    const offsetParam = values.length;

    const rowsSql = `SELECT a.radacctid::text AS id, a.acctsessionid, a.acctuniqueid, a.username, a.realm,
      a.nasipaddress::text AS nasipaddress, a.nasportid, a.nasporttype, a.acctstarttime, a.acctstoptime,
      a.acctsessiontime, a.acctauthentic, a.connectinfo_start, a.connectinfo_stop, a.acctinputoctets::text AS acctinputoctets,
      a.acctoutputoctets::text AS acctoutputoctets, a.calledstationid, a.callingstationid, a.acctterminatecause,
      a.servicetype, a.framedprotocol, a.framedipaddress::text AS framedipaddress, a.acctupdatetime,
      COALESCE(n.shortname, n.nasname) AS nasname
      FROM radacct a LEFT JOIN nas n ON n.nasIp::text = a.nasipaddress::text
      ${predicates.sql} ORDER BY ${sort} ${direction} NULLS LAST, a.radacctid DESC LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const countSql = `SELECT COUNT(*)::bigint AS total FROM radacct a ${predicates.sql}`;

    try {
      const [rows, count] = await Promise.all([
        this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(rowsSql, ...values),
        this.prisma.$queryRawUnsafe<{ total: bigint | string | number }[]>(countSql, ...predicates.values),
      ]);
      const total = Number(count?.[0]?.total ?? 0);
      const items = (rows || []).map((row) => this.normalize(row));
      return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
    } catch (error: any) {
      this.logger.error(`RADIUS accounting query failed: ${error?.message || error}`);
      throw error;
    }
  }

  private normalize(row: Record<string, unknown>) {
    const bigintFields = ['acctinputoctets', 'acctoutputoctets', 'acctsessiontime', 'radacctid'];
    const out = { ...row };
    for (const field of bigintFields) if (out[field] !== null && out[field] !== undefined) out[field] = String(out[field]);
    return out;
  }
}
