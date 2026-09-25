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

  /** Builds one predicate fragment and parameter list reused by data and COUNT. */
  private async predicates(actor: Actor, opts: RadiusAccountingOptions) {
    const parts: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      parts.push(sql.replace('?', `$${values.length}`));
    };

    const isAdmin = this.scope.isAdmin(actor?.role);
    const ids = isAdmin
      ? null
      : await this.scope.descendantIds(await this.scope.rootId(actor));

    if (ids) {
      add(
        'EXISTS (SELECT 1 FROM "Subscriber" s_scope WHERE s_scope.username = a.username AND s_scope."userId" = ANY(?::int[]))',
        ids,
      );
      if (ids.length === 0) parts.push('FALSE');
    }

    // Keep the same demo policy used by the other radacct readers. The
    // ScopeService call is deliberately made here so this path remains tied to
    // the canonical Prisma visibility policy as well as its raw-SQL equivalent.
    const radiusWhere = await this.scope.radiusWhere(actor);
    if (isAdmin && Object.keys(radiusWhere).length > 0) {
      const demo = this.scope.demoSessionSql('a').trim();
      if (demo) parts.push(demo.replace(/^AND\s+/, ''));
    }

    const q = opts.q?.trim();
    if (q) {
      const placeholder = `$${values.length + 1}`;
      values.push(`%${q}%`);
      parts.push(`(
        a.username ILIKE ${placeholder}
        OR a.realm ILIKE ${placeholder}
        OR a.callingstationid ILIKE ${placeholder}
        OR a.calledstationid ILIKE ${placeholder}
        OR a.framedipaddress::text ILIKE ${placeholder}
        OR a.nasipaddress::text ILIKE ${placeholder}
        OR a.acctsessionid ILIKE ${placeholder}
        OR a.servicetype ILIKE ${placeholder}
        OR EXISTS (
          SELECT 1 FROM nas n_search
          WHERE n_search.nasname ILIKE ${placeholder}
            AND n_search.nasIp::text = a.nasipaddress::text
        )
      )`);
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
    const requestedPage = Number(opts.page);
    const requestedLimit = Number(opts.limit);
    const page = Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1);
    const pageSize = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_LIMIT),
    );
    const offset = (page - 1) * pageSize;
    const sort = ALLOWED_SORTS[opts.sortBy || ''] || ALLOWED_SORTS.acctstarttime;
    const direction = String(opts.sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const predicate = await this.predicates(actor, opts);
    const pageValues = [...predicate.values, pageSize, offset];
    const limitParam = pageValues.length - 1;
    const offsetParam = pageValues.length;

    const rowsSql = `SELECT a.radacctid::text AS id, a.acctsessionid, a.acctuniqueid, a.username, a.realm,
      a.nasipaddress::text AS nasipaddress, a.nasportid, a.nasporttype, a.acctstarttime, a.acctstoptime,
      a.acctsessiontime, a.acctauthentic, a.connectinfo_start, a.connectinfo_stop,
      a.acctinputoctets::text AS acctinputoctets, a.acctoutputoctets::text AS acctoutputoctets,
      a.calledstationid, a.callingstationid, a.acctterminatecause, a.servicetype, a.framedprotocol,
      a.framedipaddress::text AS framedipaddress, a.acctupdatetime,
      COALESCE(n.shortname, n.nasname) AS nasname
      FROM radacct a
      LEFT JOIN nas n ON n.nasIp::text = a.nasipaddress::text
      ${predicate.sql}
      ORDER BY ${sort} ${direction} NULLS LAST, a.radacctid DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`;
    const countSql = `SELECT COUNT(*)::bigint AS total FROM radacct a ${predicate.sql}`;

    try {
      const [rows, count] = await Promise.all([
        this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(rowsSql, ...pageValues),
        this.prisma.$queryRawUnsafe<{ total: bigint | string | number }[]>(countSql, ...predicate.values),
      ]);
      const total = Number(count?.[0]?.total ?? 0);
      return {
        items: (rows || []).map((row) => this.normalize(row)),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    } catch (error: any) {
      this.logger.error(`RADIUS accounting query failed: ${error?.message || error}`);
      throw error;
    }
  }

  private normalize(row: Record<string, unknown>) {
    const bigintFields = ['acctinputoctets', 'acctoutputoctets', 'acctsessiontime', 'radacctid'];
    const out = { ...row };
    for (const field of bigintFields) {
      if (out[field] !== null && out[field] !== undefined) out[field] = String(out[field]);
    }
    return out;
  }
}
