import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { FieldJobStatus, FieldJobType, Prisma, TicketPriority } from '@prisma/client';
import { Actor, ScopeService } from '../common/scope.service';
import { PrismaService } from '../prisma/prisma.service';

const STATUSES: FieldJobStatus[] = [
  'PENDING',
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];
const TYPES: FieldJobType[] = [
  'INSTALLATION',
  'FAULT_REPAIR',
  'MAINTENANCE',
  'DISCONNECTION',
  'SURVEY',
  'UPGRADE',
  'RELOCATION',
];
const PRIORITIES: TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const OPEN_STATUSES: FieldJobStatus[] = ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW'];
const DEFAULT_RANGE_DAYS = 30;

type ReportFilters = {
  from: Date;
  to: Date;
  toExclusive: Date;
  status: FieldJobStatus | null;
  priority: TicketPriority | null;
  type: FieldJobType | null;
  technicianId: number | null;
  subscriberId: number | null;
};

type ReportScope = {
  companyId: number;
  userIds: number[];
};

function positiveInteger(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new BadRequestException('Filter IDs must be positive integers.');
  }
  return parsed;
}

function parseDateOnly(value: unknown, fallback: Date, name: string): Date {
  if (value == null || value === '') {
    return fallback;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${name} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${name} must be a valid date.`);
  }
  return parsed;
}

function reportJobSqlWhere(filters: ReportFilters, scope: ReportScope): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`j."createdAt" >= ${filters.from}`,
    Prisma.sql`j."createdAt" < ${filters.toExclusive}`,
    Prisma.sql`(
      j."assignedTo" IN (${Prisma.join(scope.userIds)}) OR
      j."createdById" IN (${Prisma.join(scope.userIds)}) OR
      s."userId" IN (${Prisma.join(scope.userIds)}) OR
      ts."userId" IN (${Prisma.join(scope.userIds)}) OR
      l."companyId" = ${scope.companyId}
    )`,
  ];
  if (filters.status) clauses.push(Prisma.sql`j."status" = ${filters.status}::"FieldJobStatus"`);
  if (filters.type) clauses.push(Prisma.sql`j."type" = ${filters.type}::"FieldJobType"`);
  if (filters.priority) clauses.push(Prisma.sql`j."priority" = ${filters.priority}::"TicketPriority"`);
  if (filters.technicianId) clauses.push(Prisma.sql`j."assignedTo" = ${filters.technicianId}`);
  if (filters.subscriberId) {
    clauses.push(Prisma.sql`(j."subscriberId" = ${filters.subscriberId} OR t."subscriberId" = ${filters.subscriberId})`);
  }
  return Prisma.join(clauses, ' AND ');
}

@Injectable()
export class FieldJobReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  private actorId(actor: Actor): number {
    const id = this.scope.actorId(actor);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new ForbiddenException('Your account has no user identity.');
    }
    return id;
  }

  private async companyScope(actor: Actor): Promise<ReportScope> {
    if (!actor || actor.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('Field operations reports require a company account.');
    }
    const companyId = await this.scope.companyRootId(this.actorId(actor));
    if (!companyId) throw new ForbiddenException('A company scope is required.');
    const userIds = await this.scope.descendantIds(companyId);
    if (!userIds.length) throw new ForbiddenException('A company scope is required.');
    return { companyId, userIds };
  }

  private async hasAction(actor: Actor, permission: string): Promise<boolean> {
    if (actor?.role === 'SUPER_ADMIN' || actor?.role === 'ADMIN') return true;
    const actorId = this.actorId(actor);
    const ancestors = await this.scope.ancestorIds(actorId);
    const denied = await this.prisma.userPermission.findFirst({
      where: {
        userId: { in: ancestors },
        permission: { in: [permission, '*', 'field-jobs.*'] },
        allowed: false,
      },
      select: { id: true },
    });
    if (denied) return false;
    return !!(await this.prisma.rolePermission.findFirst({
      where: {
        role: actor?.role ?? '',
        permission: { in: [permission, '*', 'field-jobs.*'] },
      },
      select: { id: true },
    }));
  }

  private async requireReportPermission(actor: Actor): Promise<void> {
    if (!(await this.hasAction(actor, 'field-jobs.report'))) {
      throw new ForbiddenException('You do not have permission to view field-job reports.');
    }
  }

  private async filters(actor: Actor, query: Record<string, unknown>, scope: ReportScope): Promise<ReportFilters> {
    const now = new Date();
    const fallbackFrom = new Date(now.getTime() - (DEFAULT_RANGE_DAYS - 1) * 24 * 60 * 60 * 1000);
    const from = parseDateOnly(query.from, fallbackFrom, 'Start date');
    const to = parseDateOnly(query.to, now, 'End date');
    if (from > to) {
      throw new BadRequestException('Start date must not be after end date.');
    }
    if (to.getTime() - from.getTime() > 365 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('The reporting date range cannot exceed 366 days.');
    }
    const toExclusive = new Date(Date.UTC(
      to.getUTCFullYear(),
      to.getUTCMonth(),
      to.getUTCDate() + 1,
    ));

    const statusValue = query.status && query.status !== 'ALL' ? String(query.status) : null;
    const typeValue = query.type && query.type !== 'ALL' ? String(query.type) : null;
    const priorityValue = query.priority && query.priority !== 'ALL' ? String(query.priority) : null;
    if (statusValue && !STATUSES.includes(statusValue as FieldJobStatus)) {
      throw new BadRequestException('Unknown field-job status.');
    }
    if (typeValue && !TYPES.includes(typeValue as FieldJobType)) {
      throw new BadRequestException('Unknown field-job type.');
    }
    if (priorityValue && !PRIORITIES.includes(priorityValue as TicketPriority)) {
      throw new BadRequestException('Unknown field-job priority.');
    }

    const technicianId = positiveInteger(query.technicianId);
    if (technicianId != null) {
      const isCompanyTechnician = await this.prisma.employeeProfile.findFirst({
        where: { companyId: scope.companyId, userId: technicianId },
        select: { id: true },
      });
      if (!isCompanyTechnician) {
        throw new BadRequestException('Select a technician in this company.');
      }
    }

    const subscriberId = positiveInteger(query.subscriberId);
    if (subscriberId != null) {
      if (!(await this.hasAction(actor, 'subscribers.read'))) {
        throw new ForbiddenException('Subscriber filtering requires subscriber-read permission.');
      }
      await this.scope.assertSubscriber(actor, subscriberId);
    }

    return {
      from,
      to,
      toExclusive,
      status: statusValue as FieldJobStatus | null,
      type: typeValue as FieldJobType | null,
      priority: priorityValue as TicketPriority | null,
      technicianId,
      subscriberId,
    };
  }

  private buildWhere(filters: ReportFilters, scope: ReportScope, includeCreationDate = true): Prisma.FieldJobWhereInput {
    const conditions: Prisma.FieldJobWhereInput[] = [
      {
        OR: [
          { assignedTo: { in: scope.userIds } },
          { createdById: { in: scope.userIds } },
          { subscriber: { is: { userId: { in: scope.userIds } } } },
          { ticket: { is: { subscriber: { is: { userId: { in: scope.userIds } } } } } },
          { lead: { is: { companyId: scope.companyId } } },
        ],
      },
    ];

    if (includeCreationDate) {
      conditions.push({ createdAt: { gte: filters.from, lt: filters.toExclusive } });
    }
    if (filters.status) conditions.push({ status: filters.status });
    if (filters.type) conditions.push({ type: filters.type });
    if (filters.priority) conditions.push({ priority: filters.priority });
    if (filters.technicianId) conditions.push({ assignedTo: filters.technicianId });
    if (filters.subscriberId) {
      conditions.push({
        OR: [
          { subscriberId: filters.subscriberId },
          { ticket: { is: { subscriberId: filters.subscriberId } } },
        ],
      });
    }
    return { AND: conditions };
  }

  private async summaryCounts(where: Prisma.FieldJobWhereInput) {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const [statusRows, total, overdue, unassigned, approaching] = await Promise.all([
      this.prisma.fieldJob.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.fieldJob.count({ where }),
      this.prisma.fieldJob.count({
        where: {
          AND: [
            where,
            { status: { in: OPEN_STATUSES } },
            { OR: [{ appointmentEndsAt: { lt: now } }, { appointmentEndsAt: null, scheduledAt: { lt: now } }] },
          ],
        },
      }),
      this.prisma.fieldJob.count({
        where: { AND: [where, { status: { in: OPEN_STATUSES } }, { assignedTo: null }] },
      }),
      this.prisma.fieldJob.count({
        where: {
          AND: [
            where,
            { status: { in: OPEN_STATUSES } },
            {
              OR: [
                { appointmentEndsAt: { gte: now, lt: tomorrow } },
                { appointmentEndsAt: null, scheduledAt: { gte: now, lt: tomorrow } },
              ],
            },
          ],
        },
      }),
    ]);
    const byStatus: Record<string, number> = {};
    for (const row of statusRows) byStatus[row.status] = row._count._all;
    const denominator = total - (byStatus.CANCELLED ?? 0);

    return {
      total,
      byStatus,
      overdue,
      unassigned,
      approaching,
      completionRate: denominator > 0
        ? Number((((byStatus.COMPLETED ?? 0) / denominator) * 100).toFixed(1))
        : null,
    };
  }

  private async slaSummary(filters: ReportFilters, scope: ReportScope) {
    const now = new Date();
    const sqlWhere = reportJobSqlWhere(filters, scope);
    const [statsRows, priorityRows, typeRows, technicianRows, dateRows] = await Promise.all([
      this.prisma.$queryRaw<Array<Record<string, number | null>>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NULL
            OR j."slaResolutionTargetMinutes" IS NULL)::int AS "unconfigured",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL
            AND (j."slaResolutionDueAt" IS NULL OR j."slaClockMode" IS DISTINCT FROM 'ELAPSED_UTC'
              OR j."slaResolvedAt" < j."createdAt"))::int AS "unavailable",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC'
            AND (j."slaResolvedAt" IS NULL OR j."slaResolvedAt" >= j."createdAt")
            AND (j."slaResolvedAt" IS NOT NULL OR j."slaResolutionDueAt" <= ${now}))::int AS "eligible",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC' AND j."slaResolvedAt" >= j."createdAt"
            AND j."slaResolvedAt" <= j."slaResolutionDueAt")::int AS "met",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" < ${now}
            AND j."slaClockMode" = 'ELAPSED_UTC'
            AND (j."slaResolvedAt" IS NULL OR j."slaResolvedAt" > j."slaResolutionDueAt"))::int AS "breached",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC'
            AND j."slaResolvedAt" IS NULL AND j."slaResolutionDueAt" > ${now}
            AND j."slaResolutionDueAt" <= ${now} + COALESCE(j."slaResolutionWarningMinutes", 0) * INTERVAL '1 minute')::int AS "atRisk",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" > ${now}
            AND j."slaClockMode" = 'ELAPSED_UTC'
            AND j."slaResolvedAt" IS NULL)::int AS "notYetDue",
          (AVG(EXTRACT(EPOCH FROM (j."slaResolvedAt" - j."createdAt")) / 60)
            FILTER (WHERE j."slaResolvedAt" IS NOT NULL AND j."slaPolicyVersionId" IS NOT NULL
              AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
              AND j."slaClockMode" = 'ELAPSED_UTC' AND j."slaResolvedAt" >= j."createdAt"))::float8 AS "averageMinutes",
          (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (j."slaResolvedAt" - j."createdAt")) / 60)
            FILTER (WHERE j."slaResolvedAt" IS NOT NULL AND j."slaPolicyVersionId" IS NOT NULL
              AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
              AND j."slaClockMode" = 'ELAPSED_UTC' AND j."slaResolvedAt" >= j."createdAt"))::float8 AS "medianMinutes",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL AND j."slaResolvedAt" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC' AND j."slaResolvedAt" >= j."createdAt"
            AND j."slaResolvedAt" > j."slaResolutionDueAt")::int AS "lateResolved"
        FROM "FieldJob" j
        LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
        LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
        LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
        LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
        WHERE ${sqlWhere} AND j."status" <> 'CANCELLED'
      `),
      this.prisma.$queryRaw<Array<Record<string, number | string | null>>>(Prisma.sql`
        SELECT j."priority"::text AS "key",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC'
            AND (j."slaResolvedAt" IS NULL OR j."slaResolvedAt" >= j."createdAt")
            AND (j."slaResolvedAt" IS NOT NULL OR j."slaResolutionDueAt" <= ${now}))::int AS "eligible",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC' AND j."slaResolvedAt" >= j."createdAt"
            AND j."slaResolvedAt" <= j."slaResolutionDueAt")::int AS "met"
        FROM "FieldJob" j
        LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
        LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
        LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
        LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
        WHERE ${sqlWhere} AND j."status" <> 'CANCELLED'
        GROUP BY j."priority" ORDER BY j."priority"
      `),
      this.prisma.$queryRaw<Array<Record<string, number | string | null>>>(Prisma.sql`
        SELECT j."type"::text AS "key",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC'
            AND (j."slaResolvedAt" IS NULL OR j."slaResolvedAt" >= j."createdAt")
            AND (j."slaResolvedAt" IS NOT NULL OR j."slaResolutionDueAt" <= ${now}))::int AS "eligible",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC' AND j."slaResolvedAt" >= j."createdAt"
            AND j."slaResolvedAt" <= j."slaResolutionDueAt")::int AS "met"
        FROM "FieldJob" j
        LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
        LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
        LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
        LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
        WHERE ${sqlWhere} AND j."status" <> 'CANCELLED'
        GROUP BY j."type" ORDER BY j."type"
      `),
      this.prisma.$queryRaw<Array<Record<string, number | null>>>(Prisma.sql`
        SELECT j."assignedTo" AS "technicianId",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC'
            AND (j."slaResolvedAt" IS NULL OR j."slaResolvedAt" >= j."createdAt")
            AND (j."slaResolvedAt" IS NOT NULL OR j."slaResolutionDueAt" <= ${now}))::int AS "eligible",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC' AND j."slaResolvedAt" >= j."createdAt"
            AND j."slaResolvedAt" <= j."slaResolutionDueAt")::int AS "met"
        FROM "FieldJob" j
        LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
        LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
        LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
        LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
        WHERE ${sqlWhere} AND j."status" <> 'CANCELLED'
        GROUP BY j."assignedTo" ORDER BY j."assignedTo"
      `),
      this.prisma.$queryRaw<Array<Record<string, number | string | null>>>(Prisma.sql`
        SELECT DATE(j."createdAt")::text AS "date",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC'
            AND (j."slaResolvedAt" IS NULL OR j."slaResolvedAt" >= j."createdAt")
            AND (j."slaResolvedAt" IS NOT NULL OR j."slaResolutionDueAt" <= ${now}))::int AS "eligible",
          COUNT(*) FILTER (WHERE j."slaPolicyVersionId" IS NOT NULL
            AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
            AND j."slaClockMode" = 'ELAPSED_UTC' AND j."slaResolvedAt" >= j."createdAt"
            AND j."slaResolvedAt" <= j."slaResolutionDueAt")::int AS "met"
        FROM "FieldJob" j
        LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
        LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
        LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
        LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
        WHERE ${sqlWhere} AND j."status" <> 'CANCELLED'
        GROUP BY DATE(j."createdAt") ORDER BY DATE(j."createdAt")
      `),
    ]);
    const metric = statsRows[0] ?? {};
    const technicianIds = technicianRows
      .map((row) => row.technicianId == null ? null : Number(row.technicianId))
      .filter((id): id is number => id != null);
    const profiles = technicianIds.length
      ? await this.prisma.employeeProfile.findMany({
          where: { companyId: scope.companyId, userId: { in: technicianIds } },
          select: { userId: true, name: true },
        })
      : [];
    const profileNames = new Map(profiles.map((profile) => [profile.userId, profile.name]));
    const eligible = Number(metric.eligible ?? 0);
    const met = Number(metric.met ?? 0);
    const round = (value: number | null) => value == null || !Number.isFinite(value) ? null : Math.round(value);
    const group = (rows: Array<Record<string, number | string | null>>, keyName: string) => rows.map((row) => {
      const denominator = Number(row.eligible ?? 0);
      return {
        [keyName]: row.key,
        eligible: denominator,
        met: Number(row.met ?? 0),
        compliancePercent: denominator ? Number(((Number(row.met ?? 0) / denominator) * 100).toFixed(1)) : null,
      };
    });
    return {
      firstResponse: { available: false, reason: 'Field jobs have no recorded customer-response event.' },
      resolution: {
        eligible,
        met,
        breached: Number(metric.breached ?? 0),
        atRisk: Number(metric.atRisk ?? 0),
        notYetDue: Number(metric.notYetDue ?? 0),
        compliancePercent: eligible ? Number(((met / eligible) * 100).toFixed(1)) : null,
        averageMinutes: round(metric.averageMinutes as number | null),
        medianMinutes: round(metric.medianMinutes as number | null),
        lateResolved: Number(metric.lateResolved ?? 0),
      },
      unconfigured: Number(metric.unconfigured ?? 0),
      unavailable: Number(metric.unavailable ?? 0),
      byPriority: group(priorityRows, 'priority'),
      byType: group(typeRows, 'type'),
      byTechnician: technicianRows.map((row) => {
        const denominator = Number(row.eligible ?? 0);
        const technicianId = row.technicianId == null ? null : Number(row.technicianId);
        return {
          technicianId,
          name: technicianId == null ? 'Unassigned' : profileNames.get(technicianId) ?? null,
          eligible: denominator,
          met: Number(row.met ?? 0),
          compliancePercent: denominator ? Number(((Number(row.met ?? 0) / denominator) * 100).toFixed(1)) : null,
        };
      }),
      byDate: dateRows.map((row) => {
        const denominator = Number(row.eligible ?? 0);
        return {
          date: row.date,
          eligible: denominator,
          met: Number(row.met ?? 0),
          compliancePercent: denominator ? Number(((Number(row.met ?? 0) / denominator) * 100).toFixed(1)) : null,
        };
      }),
      reopened: null,
      reopenedUnavailableReason: 'Field-job reopen events are not recorded as a reliable lifecycle metric.',
      measurement: 'Dispatcher-approved completion time; technician submission and customer confirmation are not treated as resolution.',
    };
  }

  private async technicianBreakdown(filters: ReportFilters, scope: ReportScope) {
    const where = this.buildWhere(filters, scope);
    const [employees, statusRows, durationRows] = await Promise.all([
      this.prisma.employeeProfile.findMany({
        where: { companyId: scope.companyId, userId: { not: null } },
        select: { userId: true, name: true, user: { select: { name: true } } },
        orderBy: { name: 'asc' },
        take: 300,
      }),
      this.prisma.fieldJob.groupBy({
        by: ['assignedTo', 'status'],
        where: { AND: [where, { assignedTo: { not: null } }] },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<Array<{ technicianId: number; averageMinutes: number | null }>>(Prisma.sql`
        SELECT j."assignedTo" AS "technicianId",
          AVG(EXTRACT(EPOCH FROM (j."completedAt" - j."startedAt")) / 60)::float8 AS "averageMinutes"
        FROM "FieldJob" j
        LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
        LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
        LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
        LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
        WHERE ${reportJobSqlWhere(filters, scope)}
          AND j."status" = 'COMPLETED'
          AND j."assignedTo" IS NOT NULL
          AND j."startedAt" IS NOT NULL
          AND j."completedAt" IS NOT NULL
          AND j."completedAt" >= j."startedAt"
        GROUP BY j."assignedTo"
      `),
    ]);
    const ids = new Set<number>(employees.flatMap((employee) => employee.userId == null ? [] : [employee.userId]));
    for (const row of statusRows) if (row.assignedTo != null) ids.add(row.assignedTo);
    const names = new Map(employees.flatMap((employee) => employee.userId == null
      ? []
      : [[employee.userId, employee.name || employee.user?.name || 'Technician'] as const]));
    const durations = new Map(durationRows.map((row) => [row.technicianId, row.averageMinutes]));
    const overdueByTech = await this.prisma.fieldJob.groupBy({
      by: ['assignedTo'],
      where: {
        AND: [
          where,
          { assignedTo: { not: null }, status: { in: OPEN_STATUSES } },
          { OR: [{ appointmentEndsAt: { lt: new Date() } }, { appointmentEndsAt: null, scheduledAt: { lt: new Date() } }] },
        ],
      },
      _count: { _all: true },
    });
    const result = Array.from(ids, (technicianId) => {
      const rows = statusRows.filter((row) => row.assignedTo === technicianId);
      const count = (status: FieldJobStatus) =>
        rows.find((row) => row.status === status)?._count._all ?? 0;
      const assigned = rows.reduce((sum, row) => sum + row._count._all, 0);
      const cancelled = count('CANCELLED');
      const denominator = assigned - cancelled;
      const average = durations.get(technicianId);
      return {
        technicianId,
        name: names.get(technicianId) ?? 'Technician',
        assigned,
        completed: count('COMPLETED'),
        open: OPEN_STATUSES.reduce((sum, status) => sum + count(status), 0),
        overdue: overdueByTech.find((row) => row.assignedTo === technicianId)?._count._all ?? 0,
        completionRate: denominator > 0 ? Number(((count('COMPLETED') / denominator) * 100).toFixed(1)) : null,
        averageCompletionMinutes: average != null && Number.isFinite(average) ? Math.round(average) : null,
      };
    });
    return {
      items: result.sort((left, right) => left.name.localeCompare(right.name)),
      options: Array.from(names, ([id, name]) => ({ id, name })),
    };
  }

  private scheduleFilters(filters: ReportFilters, scope: ReportScope): Prisma.FieldJobScheduleWhereInput {
    const conditions: Prisma.FieldJobScheduleWhereInput[] = [{ companyId: scope.companyId }];
    if (filters.type) conditions.push({ type: filters.type });
    if (filters.priority) conditions.push({ priority: filters.priority });
    if (filters.subscriberId) {
      conditions.push({
        OR: [
          { subscriberId: filters.subscriberId },
          { ticket: { is: { subscriberId: filters.subscriberId } } },
        ],
      });
    }
    return { AND: conditions };
  }

  private async delayGroups(filters: ReportFilters, scope: ReportScope) {
    return this.prisma.$queryRaw<Array<{ key: string; count: number; averageMinutes: number }>>(Prisma.sql`
      WITH delayed AS (
        SELECT EXTRACT(EPOCH FROM (COALESCE(j."completedAt", CURRENT_TIMESTAMP) - COALESCE(j."appointmentEndsAt", j."scheduledAt"))) / 60 AS "delayMinutes"
        FROM "FieldJob" j
        LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
        LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
        LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
        LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
        WHERE ${reportJobSqlWhere(filters, scope)}
          AND COALESCE(j."appointmentEndsAt", j."scheduledAt") IS NOT NULL
          AND (
            (j."status" IN ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW')
              AND COALESCE(j."appointmentEndsAt", j."scheduledAt") < CURRENT_TIMESTAMP)
            OR
            (j."status" = 'COMPLETED' AND j."completedAt" IS NOT NULL
              AND j."completedAt" > COALESCE(j."appointmentEndsAt", j."scheduledAt"))
          )
      )
      SELECT CASE
        WHEN "delayMinutes" <= 1440 THEN 'UP_TO_1_DAY'
        WHEN "delayMinutes" <= 10080 THEN '1_TO_7_DAYS'
        ELSE 'OVER_7_DAYS'
      END AS "key",
      COUNT(*)::int AS "count",
      AVG("delayMinutes")::float8 AS "averageMinutes"
      FROM delayed
      GROUP BY "key"
      ORDER BY "key"
    `);
  }

  private async overdueBreakdowns(where: Prisma.FieldJobWhereInput) {
    const overdueWhere: Prisma.FieldJobWhereInput = {
      AND: [
        where,
        { status: { in: OPEN_STATUSES } },
        { OR: [{ appointmentEndsAt: { lt: new Date() } }, { appointmentEndsAt: null, scheduledAt: { lt: new Date() } }] },
      ],
    };
    const [byPriority, byType] = await Promise.all([
      this.prisma.fieldJob.groupBy({ by: ['priority'], where: overdueWhere, _count: { _all: true } }),
      this.prisma.fieldJob.groupBy({ by: ['type'], where: overdueWhere, _count: { _all: true } }),
    ]);
    return {
      byPriority: byPriority.map((row) => ({ key: row.priority, count: row._count._all })),
      byType: byType.map((row) => ({ key: row.type, count: row._count._all })),
    };
  }

  private async repeatedReschedules(filters: ReportFilters, scope: ReportScope): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS "total"
      FROM "FieldJob" j
      LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
      LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
      LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
      LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
      WHERE ${reportJobSqlWhere(filters, scope)}
        AND EXISTS (
          SELECT 1 FROM "FieldJobActivity" a
          WHERE a."fieldJobId" = j."id" AND a."action" = 'SCHEDULED'
          GROUP BY a."fieldJobId" HAVING COUNT(*) > 1
        )
    `);
    return rows[0]?.total ?? 0;
  }

  private async averageCompletionMinutes(filters: ReportFilters, scope: ReportScope): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ averageMinutes: number | null }>>(Prisma.sql`
      SELECT AVG(EXTRACT(EPOCH FROM (j."completedAt" - j."startedAt")) / 60)::float8 AS "averageMinutes"
      FROM "FieldJob" j
      LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
      LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
      LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
      LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
      WHERE ${reportJobSqlWhere(filters, scope)}
        AND j."status" = 'COMPLETED'
        AND j."startedAt" IS NOT NULL
        AND j."completedAt" IS NOT NULL
        AND j."completedAt" >= j."startedAt"
    `);
    const average = rows[0]?.averageMinutes;
    return average != null && Number.isFinite(average) ? Math.round(average) : null;
  }

  async summary(actor: Actor, query: Record<string, unknown>) {
    await this.requireReportPermission(actor);
    const scope = await this.companyScope(actor);
    const filters = await this.filters(actor, query, scope);
    const where = this.buildWhere(filters, scope);
    const summary = await this.summaryCounts(where);
    const scheduleWhere = this.scheduleFilters(filters, scope);
    const occurrenceWhere: Prisma.FieldJobOccurrenceWhereInput = {
      occurrenceAt: { gte: filters.from, lt: filters.toExclusive },
      schedule: { is: scheduleWhere },
      fieldJob: {
        is: {
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.technicianId ? { assignedTo: filters.technicianId } : {}),
        },
      },
    };
    const upcomingAvailable = filters.status == null && filters.technicianId == null;
    const scheduleStatesAvailable = filters.status == null && filters.technicianId == null;
    const [generated, scheduledCompleted, upcoming, scheduleStates, technicianSummary, delayGroups, canFilterSubscribers, averageCompletionMinutes, overdueBreakdowns, rescheduled, serviceQuality] = await Promise.all([
      this.prisma.fieldJobOccurrence.count({ where: occurrenceWhere }),
      filters.status && filters.status !== 'COMPLETED'
        ? Promise.resolve(0)
        : this.prisma.fieldJobOccurrence.count({
            where: { ...occurrenceWhere, fieldJob: { is: { status: 'COMPLETED', ...(filters.technicianId ? { assignedTo: filters.technicianId } : {}) } } },
          }),
      upcomingAvailable
        ? this.prisma.fieldJobSchedule.count({
            where: {
              AND: [
                scheduleWhere,
                { status: 'ACTIVE', nextRunAt: { gte: filters.from, lt: filters.toExclusive } },
              ],
            },
          })
        : Promise.resolve(null),
      scheduleStatesAvailable
        ? this.prisma.fieldJobSchedule.groupBy({
            by: ['status'],
            where: {
              AND: [
                scheduleWhere,
                { createdAt: { gte: filters.from, lt: filters.toExclusive } },
              ],
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      this.technicianBreakdown(filters, scope),
      this.delayGroups(filters, scope),
      this.hasAction(actor, 'subscribers.read'),
      this.averageCompletionMinutes(filters, scope),
      this.overdueBreakdowns(where),
      this.repeatedReschedules(filters, scope),
      this.slaSummary(filters, scope),
    ]);
    return {
      period: {
        from: filters.from.toISOString(),
        to: filters.to.toISOString(),
      },
      filters: {
        status: filters.status,
        priority: filters.priority,
        type: filters.type,
        technicianId: filters.technicianId,
        subscriberId: filters.subscriberId,
      },
      canFilterSubscribers,
      technicianOptions: technicianSummary.options,
      overview: {
        total: summary.total,
        open: (summary.byStatus.PENDING ?? 0) + (summary.byStatus.ASSIGNED ?? 0) + (summary.byStatus.IN_PROGRESS ?? 0) + (summary.byStatus.PENDING_REVIEW ?? 0),
        assigned: summary.byStatus.ASSIGNED ?? 0,
        inProgress: summary.byStatus.IN_PROGRESS ?? 0,
        completed: summary.byStatus.COMPLETED ?? 0,
        overdue: summary.overdue,
        unassigned: summary.unassigned,
        cancelled: summary.byStatus.CANCELLED ?? 0,
        awaitingReview: summary.byStatus.PENDING_REVIEW ?? 0,
        completionRate: summary.completionRate,
        averageCompletionMinutes,
      },
      metrics: {
        completionRateDenominator: summary.total - (summary.byStatus.CANCELLED ?? 0),
        approaching: summary.approaching,
      },
      byStatus: STATUSES.map((status) => ({ key: status, count: summary.byStatus[status] ?? 0 })),
      technicians: technicianSummary.items,
      delayGroups: ['UP_TO_1_DAY', '1_TO_7_DAYS', 'OVER_7_DAYS'].map((key) => ({
        key,
        count: delayGroups.find((group) => group.key === key)?.count ?? 0,
      })),
      averageDelayMinutes: delayGroups.length
        ? Math.round(delayGroups.reduce((sum, group) => sum + group.averageMinutes * group.count, 0) /
            delayGroups.reduce((sum, group) => sum + group.count, 0))
        : null,
      overdueByPriority: overdueBreakdowns.byPriority,
      overdueByType: overdueBreakdowns.byType,
      repeatedlyRescheduled: rescheduled,
      serviceQuality,
      schedules: {
        generated,
        completed: scheduledCompleted,
        upcoming,
        upcomingAvailable,
        skipped: null,
        failed: null,
        statesAvailable: scheduleStatesAvailable,
        states: {
          active: scheduleStatesAvailable ? scheduleStates.find((row) => row.status === 'ACTIVE')?._count._all ?? 0 : null,
          paused: scheduleStatesAvailable ? scheduleStates.find((row) => row.status === 'PAUSED')?._count._all ?? 0 : null,
          cancelled: scheduleStatesAvailable ? scheduleStates.find((row) => row.status === 'CANCELLED')?._count._all ?? 0 : null,
        },
      },
    };
  }

  async slaJobs(actor: Actor, query: Record<string, unknown>) {
    await this.requireReportPermission(actor);
    const scope = await this.companyScope(actor);
    const filters = await this.filters(actor, query, scope);
    const page = Number(query.page ?? 1);
    const requestedPageSize = Number(query.pageSize ?? 25);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1) {
      throw new BadRequestException('Page and page size must be positive integers.');
    }
    const pageSize = Math.min(requestedPageSize, 100);
    if ((page - 1) * pageSize > 1_000_000) {
      throw new BadRequestException('The requested SLA page is too far into the result set.');
    }
    const state = String(query.slaState ?? 'ALL');
    if (!['ALL', 'NOT_CONFIGURED', 'UNAVAILABLE', 'ON_TRACK', 'AT_RISK', 'BREACHED', 'MEETING_TARGET'].includes(state)) {
      throw new BadRequestException('Unknown field-job SLA status.');
    }
    const now = new Date();
    const notConfigured = Prisma.sql`(
      j."slaPolicyVersionId" IS NULL OR j."slaResolutionTargetMinutes" IS NULL
    )`;
    const unavailable = Prisma.sql`(
      j."slaPolicyVersionId" IS NOT NULL AND j."slaResolutionTargetMinutes" IS NOT NULL
      AND (j."slaResolutionDueAt" IS NULL OR j."slaClockMode" IS DISTINCT FROM 'ELAPSED_UTC'
        OR j."slaResolvedAt" < j."createdAt")
    )`;
    const breached = Prisma.sql`(
      j."slaPolicyVersionId" IS NOT NULL AND j."slaResolutionTargetMinutes" IS NOT NULL
      AND j."slaClockMode" = 'ELAPSED_UTC'
      AND (j."slaResolvedAt" IS NULL OR j."slaResolvedAt" >= j."createdAt")
      AND j."slaResolutionDueAt" < ${now}
      AND (j."slaResolvedAt" IS NULL OR j."slaResolvedAt" > j."slaResolutionDueAt")
    )`;
    const atRisk = Prisma.sql`(
      j."slaPolicyVersionId" IS NOT NULL AND j."slaResolutionTargetMinutes" IS NOT NULL
      AND j."slaResolutionDueAt" IS NOT NULL AND j."slaClockMode" = 'ELAPSED_UTC'
      AND j."slaResolvedAt" IS NULL AND j."slaResolutionDueAt" > ${now}
      AND j."slaResolutionDueAt" <= ${now} + COALESCE(j."slaResolutionWarningMinutes", 0) * INTERVAL '1 minute'
    )`;
    const stateCondition = state === 'ALL' ? Prisma.empty
      : state === 'NOT_CONFIGURED' ? Prisma.sql`AND ${notConfigured}`
        : state === 'UNAVAILABLE' ? Prisma.sql`AND ${unavailable}`
          : state === 'BREACHED' ? Prisma.sql`AND ${breached}`
          : state === 'AT_RISK' ? Prisma.sql`AND ${atRisk}`
            : state === 'MEETING_TARGET'
              ? Prisma.sql`AND j."slaPolicyVersionId" IS NOT NULL
                AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" IS NOT NULL
                AND j."slaClockMode" = 'ELAPSED_UTC'
                AND j."slaResolvedAt" IS NOT NULL AND j."slaResolvedAt" >= j."createdAt"
                AND j."slaResolvedAt" <= j."slaResolutionDueAt"`
              : Prisma.sql`AND j."slaPolicyVersionId" IS NOT NULL
                AND j."slaResolutionTargetMinutes" IS NOT NULL AND j."slaResolutionDueAt" > ${now}
                AND j."slaClockMode" = 'ELAPSED_UTC'
                AND j."slaResolvedAt" IS NULL
                AND NOT ${atRisk}`;
    const where = reportJobSqlWhere(filters, scope);
    const [countRows, idRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS "total"
        FROM "FieldJob" j
        LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
        LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
        LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
        LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
        WHERE ${where} ${stateCondition}
      `),
      this.prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT j."id"
        FROM "FieldJob" j
        LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
        LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
        LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
        LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
        WHERE ${where} ${stateCondition}
        ORDER BY j."createdAt" DESC, j."id" DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `),
    ]);
    const total = countRows[0]?.total ?? 0;
    const ids = idRows.map((row) => row.id);
    if (!ids.length) return { items: [], total, page, pageSize, hasMore: page * pageSize < total };

    const canReadSubscribers = await this.hasAction(actor, 'subscribers.read');
    const canReadUsers = await this.hasAction(actor, 'users.read');
    const selected = await this.prisma.fieldJob.findMany({
      where: { AND: [this.buildWhere(filters, scope), { id: { in: ids } }] },
      select: {
        id: true,
        jobNo: true,
        type: true,
        status: true,
        priority: true,
        createdAt: true,
        scheduledAt: true,
        slaResolutionDueAt: true,
        slaResolvedAt: true,
        slaPolicyVersionId: true,
        slaResolutionTargetMinutes: true,
        slaResolutionWarningMinutes: true,
        slaClockMode: true,
        assignedTo: true,
        ...(canReadSubscribers ? {
          subscriber: { select: { id: true, fullName: true, username: true } },
        } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const technicianIds = canReadUsers
      ? [...new Set(selected.map((job) => job.assignedTo).filter((id): id is number => id != null))]
      : [];
    const profiles = technicianIds.length
      ? await this.prisma.employeeProfile.findMany({
          where: { companyId: scope.companyId, userId: { in: technicianIds } },
          select: { userId: true, name: true },
        })
      : [];
    const names = new Map(profiles.map((profile) => [profile.userId, profile.name]));
    const byId = new Map(selected.map((job) => [job.id, job]));
    const items = ids.map((id) => {
      const job = byId.get(id)!;
      const due = job.slaResolutionDueAt;
      let slaStatus = 'NOT_CONFIGURED';
      if (
        job.slaResolutionTargetMinutes != null
        && due
        && job.slaClockMode === 'ELAPSED_UTC'
        && (!job.slaResolvedAt || job.slaResolvedAt >= job.createdAt)
      ) {
        if (job.slaResolvedAt) slaStatus = job.slaResolvedAt <= due ? 'MEETING_TARGET' : 'BREACHED';
        else if (due < now) slaStatus = 'BREACHED';
        else if (
          job.slaResolutionWarningMinutes != null
          && due.getTime() <= now.getTime() + job.slaResolutionWarningMinutes * 60_000
        ) slaStatus = 'AT_RISK';
        else slaStatus = 'ON_TRACK';
      } else if (job.slaPolicyVersionId != null && job.slaResolutionTargetMinutes != null) {
        slaStatus = 'UNAVAILABLE';
      }
      const { assignedTo, ...safeJob } = job;
      return {
        ...safeJob,
        slaStatus,
        technician: canReadUsers && assignedTo != null && names.has(assignedTo)
          ? { id: assignedTo, name: names.get(assignedTo) }
          : null,
      };
    });
    return {
      items,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      period: { from: filters.from.toISOString(), to: filters.to.toISOString() },
    };
  }

  async jobs(actor: Actor, query: Record<string, unknown>) {
    await this.requireReportPermission(actor);
    const scope = await this.companyScope(actor);
    const filters = await this.filters(actor, query, scope);
    const bucket = String(query.bucket ?? 'ALL');
    const bucketWhere: Prisma.FieldJobWhereInput[] = [];
    const now = new Date();
    const overduePriority = bucket.startsWith('OVERDUE_PRIORITY_') ? bucket.slice('OVERDUE_PRIORITY_'.length) : null;
    const overdueType = bucket.startsWith('OVERDUE_TYPE_') ? bucket.slice('OVERDUE_TYPE_'.length) : null;
    const technicianDetail = bucket.startsWith('TECHNICIAN_') ? positiveInteger(bucket.slice('TECHNICIAN_'.length)) : null;
    if (bucket === 'OVERDUE' || overduePriority || overdueType) {
      bucketWhere.push({ status: { in: OPEN_STATUSES } }, { OR: [{ appointmentEndsAt: { lt: now } }, { appointmentEndsAt: null, scheduledAt: { lt: now } }] });
      if (overduePriority) {
        if (!PRIORITIES.includes(overduePriority as TicketPriority)) {
          throw new BadRequestException('Unknown overdue priority category.');
        }
        bucketWhere.push({ priority: overduePriority as TicketPriority });
      }
      if (overdueType) {
        if (!TYPES.includes(overdueType as FieldJobType)) {
          throw new BadRequestException('Unknown overdue job-type category.');
        }
        bucketWhere.push({ type: overdueType as FieldJobType });
      }
    } else if (bucket === 'APPROACHING') {
      bucketWhere.push({ status: { in: OPEN_STATUSES } }, { OR: [{ appointmentEndsAt: { gte: now, lt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } }, { appointmentEndsAt: null, scheduledAt: { gte: now, lt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } }] });
    } else if (bucket === 'UNASSIGNED') {
      bucketWhere.push({ status: { in: OPEN_STATUSES } }, { assignedTo: null });
    } else if (bucket.startsWith('TECHNICIAN_')) {
      if (technicianDetail == null) {
        throw new BadRequestException('Select a valid technician category.');
      }
      const isCompanyTechnician = await this.prisma.employeeProfile.findFirst({
        where: { companyId: scope.companyId, userId: technicianDetail },
        select: { id: true },
      });
      if (!isCompanyTechnician) {
        throw new BadRequestException('Select a technician in this company.');
      }
      bucketWhere.push({ assignedTo: technicianDetail });
    } else if (bucket === 'OPEN') {
      bucketWhere.push({ status: { in: OPEN_STATUSES } });
    } else if (bucket === 'COMPLETION_RATE') {
      bucketWhere.push({ status: { not: 'CANCELLED' } });
    } else if (bucket === 'SCHEDULED_GENERATED' || bucket === 'SCHEDULED_COMPLETED') {
      bucketWhere.push({
        recurringOccurrences: {
          some: {
            occurrenceAt: { gte: filters.from, lt: filters.toExclusive },
            schedule: { is: this.scheduleFilters(filters, scope) },
          },
        },
      });
      if (bucket === 'SCHEDULED_COMPLETED') bucketWhere.push({ status: 'COMPLETED' });
    } else if (bucket !== 'ALL' && STATUSES.includes(bucket as FieldJobStatus)) {
      bucketWhere.push({ status: bucket as FieldJobStatus });
    } else if (!['ALL', 'COMPLETED_TIMED', 'DELAY_ALL', 'DELAY_UP_TO_1_DAY', 'DELAY_1_TO_7_DAYS', 'DELAY_OVER_7_DAYS', 'RESCHEDULED'].includes(bucket)) {
      throw new BadRequestException('Unknown report detail category.');
    }
    const where = this.buildWhere(filters, scope, bucket !== 'SCHEDULED_GENERATED' && bucket !== 'SCHEDULED_COMPLETED');

    const page = Number(query.page ?? 1);
    const pageSize = Number(query.pageSize ?? 25);
    if (!Number.isSafeInteger(page) || page < 1) throw new BadRequestException('Page must be a positive integer.');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new BadRequestException('Page size must be a positive integer.');
    const limit = Math.min(pageSize, 100);
    if ((page - 1) * limit > 1_000_000) {
      throw new BadRequestException('The requested report page is too far into the result set.');
    }

    const delayCategory = bucket === 'DELAY_UP_TO_1_DAY'
      ? Prisma.sql`EXTRACT(EPOCH FROM (COALESCE(j."completedAt", CURRENT_TIMESTAMP) - COALESCE(j."appointmentEndsAt", j."scheduledAt"))) <= 86400`
      : bucket === 'DELAY_1_TO_7_DAYS'
        ? Prisma.sql`EXTRACT(EPOCH FROM (COALESCE(j."completedAt", CURRENT_TIMESTAMP) - COALESCE(j."appointmentEndsAt", j."scheduledAt"))) > 86400 AND EXTRACT(EPOCH FROM (COALESCE(j."completedAt", CURRENT_TIMESTAMP) - COALESCE(j."appointmentEndsAt", j."scheduledAt"))) <= 604800`
        : bucket === 'DELAY_OVER_7_DAYS'
          ? Prisma.sql`EXTRACT(EPOCH FROM (COALESCE(j."completedAt", CURRENT_TIMESTAMP) - COALESCE(j."appointmentEndsAt", j."scheduledAt"))) > 604800`
          : null;
    const repeatedRescheduleCategory = bucket === 'RESCHEDULED'
      ? Prisma.sql`EXISTS (
          SELECT 1 FROM "FieldJobActivity" a
          WHERE a."fieldJobId" = j."id" AND a."action" = 'SCHEDULED'
          GROUP BY a."fieldJobId" HAVING COUNT(*) > 1
        )`
      : null;
    const timedCompletionCategory = bucket === 'COMPLETED_TIMED'
      ? Prisma.sql`j."status" = 'COMPLETED' AND j."startedAt" IS NOT NULL AND j."completedAt" IS NOT NULL AND j."completedAt" >= j."startedAt"`
      : null;
    const allDelayCategory = bucket === 'DELAY_ALL' ? Prisma.sql`TRUE` : null;
    if (bucket.startsWith('DELAY_') && bucket !== 'DELAY_ALL' && !delayCategory) {
      throw new BadRequestException('Unknown delay category.');
    }

    const subscriberReadable = await this.hasAction(actor, 'subscribers.read');
    if (delayCategory || allDelayCategory || repeatedRescheduleCategory || timedCompletionCategory) {
      const delayState = Prisma.sql`COALESCE(j."appointmentEndsAt", j."scheduledAt") IS NOT NULL AND (
        (j."status" IN ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW')
          AND COALESCE(j."appointmentEndsAt", j."scheduledAt") < CURRENT_TIMESTAMP)
        OR
        (j."status" = 'COMPLETED' AND j."completedAt" IS NOT NULL
          AND j."completedAt" > COALESCE(j."appointmentEndsAt", j."scheduledAt"))
      )`;
      const specialCondition = delayCategory
        ? Prisma.sql`${delayState} AND ${delayCategory}`
        : allDelayCategory
          ? delayState
          : repeatedRescheduleCategory ?? timedCompletionCategory!;
      const sqlWhere = reportJobSqlWhere(filters, scope);
      const [rows, countRows] = await Promise.all([
        this.prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
          SELECT j."id"
          FROM "FieldJob" j
          LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
          LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
          LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
          LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
          WHERE ${sqlWhere} AND ${specialCondition}
          ORDER BY j."createdAt" DESC, j."id" DESC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}
        `),
        this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
          SELECT COUNT(*)::int AS "total"
          FROM "FieldJob" j
          LEFT JOIN "Subscriber" s ON s."id" = j."subscriberId"
          LEFT JOIN "Ticket" t ON t."id" = j."ticketId"
          LEFT JOIN "Subscriber" ts ON ts."id" = t."subscriberId"
          LEFT JOIN "CrmLead" l ON l."id" = j."leadId"
          WHERE ${sqlWhere} AND ${specialCondition}
        `),
      ]);
      const ids = rows.map((row) => row.id);
      const items = ids.length
        ? await this.prisma.fieldJob.findMany({
            where: { AND: [where, { id: { in: ids } }] },
            select: {
              id: true,
              jobNo: true,
              type: true,
              status: true,
              priority: true,
              scheduledAt: true,
              appointmentEndsAt: true,
              completedAt: true,
              technician: { select: { id: true, name: true } },
              ...(subscriberReadable ? { subscriber: { select: { id: true, fullName: true, username: true } } } : {}),
            },
          })
        : [];
      const byId = new Map(items.map((item) => [item.id, item]));
      return {
        items: ids.flatMap((id) => {
          const item = byId.get(id);
          return item ? [item] : [];
        }),
        total: countRows[0]?.total ?? 0,
        page,
        pageSize: limit,
      };
    }

    const combinedWhere: Prisma.FieldJobWhereInput = {
      AND: [where, ...bucketWhere],
    };
    const [items, total] = await Promise.all([
      this.prisma.fieldJob.findMany({
        where: combinedWhere,
        select: {
          id: true,
          jobNo: true,
          type: true,
          status: true,
          priority: true,
          scheduledAt: true,
          appointmentEndsAt: true,
          completedAt: true,
          technician: { select: { id: true, name: true } },
          ...(subscriberReadable ? { subscriber: { select: { id: true, fullName: true, username: true } } } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.fieldJob.count({ where: combinedWhere }),
    ]);
    return { items, total, page, pageSize: limit };
  }
}
