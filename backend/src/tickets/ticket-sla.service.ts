import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TicketPriority } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

const PRIORITIES: TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const RECORD_TYPES = ['TICKET', 'FIELD_JOB'] as const;
const CLOCK_MODE = 'ELAPSED_UTC';
const PAGE_SIZE_MAX = 100;
const RANGE_DAYS_MAX = 366;

type CompanyScope = { companyId: number; userIds: number[] } | null;
type PolicyValues = {
  name: string;
  recordType: 'TICKET' | 'FIELD_JOB';
  priority: TicketPriority;
  active: boolean;
  effectiveFrom: Date;
  firstResponseTargetMinutes: number | null;
  resolutionTargetMinutes: number;
  firstResponseWarningMinutes: number | null;
  resolutionWarningMinutes: number | null;
  clockMode: typeof CLOCK_MODE;
  notes: string | null;
};

function parseDate(value: unknown, fallback: Date, label: string): Date {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${label} must be a valid date.`);
  }
  return parsed;
}

function minutes(value: unknown, label: string, nullable = false): number | null {
  if (nullable && (value == null || value === '')) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 525600) {
    throw new BadRequestException(`${label} must be between 1 and 525600 minutes.`);
  }
  return parsed;
}

@Injectable()
export class TicketSlaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  private actorId(actor: Actor): number {
    const id = this.scope.actorId(actor);
    if (!Number.isSafeInteger(id) || id < 1) throw new ForbiddenException('Your account has no user identity.');
    return id;
  }

  private async hasAction(actor: Actor, permission: string): Promise<boolean> {
    if (actor?.role === 'SUPER_ADMIN' || actor?.role === 'ADMIN') return true;
    if (!actor) return false;
    const ancestors = await this.scope.ancestorIds(this.actorId(actor));
    const denied = await this.prisma.userPermission.findFirst({
      where: {
        userId: { in: ancestors },
        permission: { in: [permission, 'tickets.*', '*'] },
        allowed: false,
      },
      select: { id: true },
    });
    if (denied) return false;
    return !!(await this.prisma.rolePermission.findFirst({
      where: {
        role: actor.role ?? '',
        permission: { in: [permission, 'tickets.*', '*'] },
      },
      select: { id: true },
    }));
  }

  private async requireAction(actor: Actor, permission: string): Promise<void> {
    if (!(await this.hasAction(actor, permission))) {
      throw new ForbiddenException(`You do not have permission to ${permission === 'tickets.sla.manage' ? 'manage SLA policies' : 'view SLA data'}.`);
    }
  }

  private async companyScope(actor: Actor): Promise<CompanyScope> {
    if (!actor) throw new ForbiddenException('An authenticated account is required.');
    if (actor.role === 'SUPER_ADMIN') return null;
    const companyId = await this.scope.companyRootId(await this.scope.rootId(actor));
    if (!companyId) throw new ForbiddenException('A company scope is required.');
    const userIds = await this.scope.descendantIds(companyId);
    if (!userIds.length) throw new ForbiddenException('A company scope is required.');
    return { companyId, userIds };
  }

  private async companyForPolicy(actor: Actor): Promise<{ companyId: number; actorId: number }> {
    if (!actor || actor.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('SLA policies must be managed from a company account.');
    }
    const actorId = this.actorId(actor);
    const companyId = await this.scope.companyRootId(await this.scope.rootId(actor));
    if (!companyId || companyId !== await this.scope.companyRootId(companyId)) {
      throw new ForbiddenException('A company root is required to manage SLA policies.');
    }
    return { companyId, actorId };
  }

  private async policyValues(input: Record<string, unknown>, base?: PolicyValues): Promise<PolicyValues> {
    const nameValue = input.name ?? base?.name;
    const name = typeof nameValue === 'string' ? nameValue.trim() : '';
    if (!name || name.length > 120) throw new BadRequestException('Policy name is required and must be 120 characters or fewer.');
    const recordTypeValue = String(input.recordType ?? base?.recordType ?? '');
    if (!RECORD_TYPES.includes(recordTypeValue as (typeof RECORD_TYPES)[number])) {
      throw new BadRequestException('Record type must be TICKET or FIELD_JOB.');
    }
    const recordType = recordTypeValue as PolicyValues['recordType'];
    const priorityValue = String(input.priority ?? base?.priority ?? '');
    if (!PRIORITIES.includes(priorityValue as TicketPriority)) throw new BadRequestException('Select a valid priority.');
    const priority = priorityValue as TicketPriority;
    const active = input.active === undefined ? base?.active ?? true : input.active === true;
    if (input.active !== undefined && typeof input.active !== 'boolean') {
      throw new BadRequestException('Active must be a boolean value.');
    }
    const effectiveFromValue = input.effectiveFrom ?? base?.effectiveFrom?.toISOString();
    const effectiveFrom = effectiveFromValue == null
      ? new Date()
      : new Date(String(effectiveFromValue));
    if (Number.isNaN(effectiveFrom.getTime())) throw new BadRequestException('Effective date must be a valid ISO date.');
    const responseTargetValue = Object.prototype.hasOwnProperty.call(input, 'firstResponseTargetMinutes')
      ? input.firstResponseTargetMinutes
      : base?.firstResponseTargetMinutes;
    const responseWarningValue = Object.prototype.hasOwnProperty.call(input, 'firstResponseWarningMinutes')
      ? input.firstResponseWarningMinutes
      : base?.firstResponseWarningMinutes;
    const resolutionWarningValue = Object.prototype.hasOwnProperty.call(input, 'resolutionWarningMinutes')
      ? input.resolutionWarningMinutes
      : base?.resolutionWarningMinutes;
    const responseTarget = minutes(
      responseTargetValue,
      'First-response target',
      true,
    );
    const resolutionTarget = minutes(
      input.resolutionTargetMinutes ?? base?.resolutionTargetMinutes,
      'Resolution target',
    )!;
    const responseWarning = minutes(
      responseWarningValue,
      'First-response warning',
      true,
    );
    const resolutionWarning = minutes(
      resolutionWarningValue,
      'Resolution warning',
      true,
    );
    if (recordType === 'FIELD_JOB' && (responseTarget != null || responseWarning != null)) {
      throw new BadRequestException('Field jobs do not have a recorded first-response event; configure resolution targets only.');
    }
    if (responseWarning != null && (responseTarget == null || responseWarning >= responseTarget)) {
      throw new BadRequestException('First-response warning must be shorter than its target.');
    }
    if (resolutionWarning != null && resolutionWarning >= resolutionTarget) {
      throw new BadRequestException('Resolution warning must be shorter than its target.');
    }
    const notesValue = input.notes === undefined ? base?.notes : input.notes;
    if (notesValue != null && (typeof notesValue !== 'string' || notesValue.trim().length > 500)) {
      throw new BadRequestException('Notes must be 500 characters or fewer.');
    }
    if (input.clockMode != null && input.clockMode !== CLOCK_MODE) {
      throw new BadRequestException('Only elapsed UTC time is currently supported.');
    }
    return {
      name,
      recordType,
      priority,
      active,
      effectiveFrom,
      firstResponseTargetMinutes: responseTarget,
      resolutionTargetMinutes: resolutionTarget,
      firstResponseWarningMinutes: responseWarning,
      resolutionWarningMinutes: resolutionWarning,
      clockMode: CLOCK_MODE,
      notes: typeof notesValue === 'string' ? notesValue.trim() || null : null,
    };
  }

  async snapshotPolicy(
    companyId: number | null,
    recordType: 'TICKET' | 'FIELD_JOB',
    priority: string,
    createdAt = new Date(),
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (!companyId || !PRIORITIES.includes(priority as TicketPriority)) return null;
    return db.slaPolicyVersion.findFirst({
      where: {
        companyId,
        recordType,
        priority: priority as TicketPriority,
        active: true,
        effectiveFrom: { lte: createdAt },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: createdAt } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    });
  }

  async markFirstResponse(
    ticketId: number,
    responseAt = new Date(),
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    await db.ticket.updateMany({
      where: { id: ticketId, firstResponseAt: null },
      data: { firstResponseAt: responseAt },
    });
  }

  async slaReport(days = 30, actor?: Actor, fromValue?: string, toValue?: string, priorityValue?: string) {
    await this.requireAction(actor, 'tickets.sla');
    const safeDays = Number(days);
    if (!Number.isSafeInteger(safeDays) || safeDays < 1 || safeDays > RANGE_DAYS_MAX) {
      throw new BadRequestException(`Days must be between 1 and ${RANGE_DAYS_MAX}.`);
    }
    const scope = await this.companyScope(actor);
    const now = new Date();
    const since = parseDate(fromValue, new Date(now.getTime() - (safeDays - 1) * 24 * 60 * 60 * 1000), 'Start date');
    const to = parseDate(toValue, now, 'End date');
    if (since > to || to.getTime() - since.getTime() >= RANGE_DAYS_MAX * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('The SLA date range must be ordered and no longer than 366 days.');
    }
    const toExclusive = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
    const priority = priorityValue && priorityValue !== 'ALL' ? priorityValue : null;
    if (priority && !PRIORITIES.includes(priority as TicketPriority)) throw new BadRequestException('Select a valid priority.');
    const scopeSql = scope
      ? Prisma.sql`AND s."userId" = ANY(${scope.userIds}::int[])`
      : Prisma.empty;
    const prioritySql = priority ? Prisma.sql`AND t."priority" = ${priority}::"TicketPriority"` : Prisma.empty;
    const [statsRows, durationRows, priorityRows] = await Promise.all([
      this.prisma.$queryRaw<Array<Record<string, number>>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE t."slaPolicyVersionId" IS NULL)::int AS "unconfigured",
          COUNT(*) FILTER (WHERE t."slaPolicyVersionId" IS NOT NULL
            AND (t."slaResponseTargetMinutes" IS NULL OR t."responseDueAt" IS NULL
              OR t."slaClockMode" IS DISTINCT FROM ${CLOCK_MODE}
              OR t."firstResponseAt" < t."createdAt"))::int AS "responseUnavailable",
          COUNT(*) FILTER (WHERE t."slaPolicyVersionId" IS NOT NULL
            AND (t."slaResolutionTargetMinutes" IS NULL OR t."resolutionDueAt" IS NULL
              OR t."slaClockMode" IS DISTINCT FROM ${CLOCK_MODE}
              OR t."firstResolvedAt" < t."createdAt"))::int AS "resolutionUnavailable",
          COUNT(*) FILTER (WHERE t."slaPolicyVersionId" IS NOT NULL AND (
            (t."slaResolutionTargetMinutes" IS NULL OR t."resolutionDueAt" IS NULL
              OR t."slaClockMode" IS DISTINCT FROM ${CLOCK_MODE}
              OR t."firstResolvedAt" < t."createdAt")
            OR (t."slaResponseTargetMinutes" IS NOT NULL
              AND (t."responseDueAt" IS NULL OR t."slaClockMode" IS DISTINCT FROM ${CLOCK_MODE}
                OR t."firstResponseAt" < t."createdAt"))
          ))::int AS "unavailable",
          COUNT(*) FILTER (
            WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaResponseTargetMinutes" IS NOT NULL
              AND t."responseDueAt" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
              AND ((t."firstResponseAt" IS NOT NULL AND t."firstResponseAt" >= t."createdAt")
                OR (t."firstResponseAt" IS NULL AND t."responseDueAt" <= ${now}))
          )::int AS "responseDenominator",
          COUNT(*) FILTER (
            WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaResponseTargetMinutes" IS NOT NULL
              AND t."responseDueAt" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
              AND t."firstResponseAt" IS NOT NULL AND t."responseDueAt" IS NOT NULL
              AND t."firstResponseAt" >= t."createdAt"
              AND t."firstResponseAt" <= t."responseDueAt"
          )::int AS "responseMet",
          COUNT(*) FILTER (
            WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaResolutionTargetMinutes" IS NOT NULL
              AND t."resolutionDueAt" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
              AND ((t."firstResolvedAt" IS NOT NULL AND t."firstResolvedAt" >= t."createdAt")
                OR (t."firstResolvedAt" IS NULL AND t."resolutionDueAt" <= ${now}))
          )::int AS "resolutionDenominator",
          COUNT(*) FILTER (
            WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaResolutionTargetMinutes" IS NOT NULL
              AND t."resolutionDueAt" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
              AND t."firstResolvedAt" IS NOT NULL AND t."resolutionDueAt" IS NOT NULL
              AND t."firstResolvedAt" >= t."createdAt"
              AND t."firstResolvedAt" <= t."resolutionDueAt"
          )::int AS "resolutionMet",
          COUNT(*) FILTER (
            WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
              AND t."slaResponseTargetMinutes" IS NOT NULL AND t."responseDueAt" IS NOT NULL
              AND ((t."firstResponseAt" IS NOT NULL AND t."firstResponseAt" > t."responseDueAt")
                OR (t."firstResponseAt" IS NULL AND t."responseDueAt" < ${now}))
          )::int AS "responseBreached",
          COUNT(*) FILTER (
            WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
              AND t."slaResolutionTargetMinutes" IS NOT NULL AND t."resolutionDueAt" IS NOT NULL
              AND ((t."firstResolvedAt" IS NOT NULL AND t."firstResolvedAt" > t."resolutionDueAt")
                OR (t."firstResolvedAt" IS NULL AND t."resolutionDueAt" < ${now}))
          )::int AS "resolutionBreached",
          COUNT(*) FILTER (
            WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaResponseTargetMinutes" IS NOT NULL
              AND t."slaClockMode" = ${CLOCK_MODE}
              AND t."firstResponseAt" IS NULL
              AND t."responseDueAt" > ${now}
              AND t."responseDueAt" <= ${now} + COALESCE(t."slaResponseWarningMinutes", 0) * INTERVAL '1 minute'
          )::int AS "responseAtRisk",
          COUNT(*) FILTER (
            WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaResolutionTargetMinutes" IS NOT NULL
              AND t."slaClockMode" = ${CLOCK_MODE}
              AND t."firstResolvedAt" IS NULL
              AND t."resolutionDueAt" > ${now}
              AND t."resolutionDueAt" <= ${now} + COALESCE(t."slaResolutionWarningMinutes", 0) * INTERVAL '1 minute'
          )::int AS "resolutionAtRisk",
          COUNT(*) FILTER (
            WHERE
              (t."slaPolicyVersionId" IS NOT NULL AND t."slaResponseTargetMinutes" IS NOT NULL
                AND t."responseDueAt" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
                AND ((t."firstResponseAt" IS NOT NULL AND t."firstResponseAt" > t."responseDueAt")
                  OR (t."firstResponseAt" IS NULL AND t."responseDueAt" < ${now})))
              OR
              (t."slaPolicyVersionId" IS NOT NULL AND t."slaResolutionTargetMinutes" IS NOT NULL
                AND t."resolutionDueAt" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
                AND ((t."firstResolvedAt" IS NOT NULL AND t."firstResolvedAt" > t."resolutionDueAt")
                  OR (t."firstResolvedAt" IS NULL AND t."resolutionDueAt" < ${now})))
          )::int AS "anyBreached",
          COUNT(*) FILTER (
            WHERE
              (t."slaPolicyVersionId" IS NOT NULL AND t."slaResponseTargetMinutes" IS NOT NULL
                AND t."slaClockMode" = ${CLOCK_MODE}
                AND t."firstResponseAt" IS NULL AND t."responseDueAt" > ${now}
                AND t."responseDueAt" <= ${now} + COALESCE(t."slaResponseWarningMinutes", 0) * INTERVAL '1 minute')
              OR
              (t."slaPolicyVersionId" IS NOT NULL AND t."slaResolutionTargetMinutes" IS NOT NULL
                AND t."slaClockMode" = ${CLOCK_MODE}
                AND t."firstResolvedAt" IS NULL AND t."resolutionDueAt" > ${now}
                AND t."resolutionDueAt" <= ${now} + COALESCE(t."slaResolutionWarningMinutes", 0) * INTERVAL '1 minute')
          )::int AS "anyAtRisk",
          COUNT(*) FILTER (WHERE t."slaPolicyVersionId" IS NOT NULL
            AND t."slaClockMode" = ${CLOCK_MODE}
            AND t."slaResponseTargetMinutes" IS NOT NULL AND t."firstResponseAt" IS NULL
            AND t."responseDueAt" > ${now})::int AS "responseNotYetDue",
          COUNT(*) FILTER (WHERE t."slaPolicyVersionId" IS NOT NULL
            AND t."slaClockMode" = ${CLOCK_MODE}
            AND t."slaResolutionTargetMinutes" IS NOT NULL AND t."firstResolvedAt" IS NULL
            AND t."resolutionDueAt" > ${now})::int AS "resolutionNotYetDue",
          COUNT(*) FILTER (WHERE t."reopenedCount" > 0)::int AS "reopened"
        FROM "Ticket" t
        JOIN "Subscriber" s ON s."id" = t."subscriberId"
        WHERE t."createdAt" >= ${since} AND t."createdAt" < ${toExclusive} ${scopeSql} ${prioritySql}
      `),
      this.prisma.$queryRaw<Array<{ avgResponse: number | null; medianResponse: number | null; avgResolution: number | null; medianResolution: number | null }>>(Prisma.sql`
        SELECT
          (AVG(EXTRACT(EPOCH FROM (t."firstResponseAt" - t."createdAt")) / 60)
            FILTER (WHERE t."slaResponseTargetMinutes" IS NOT NULL AND t."responseDueAt" IS NOT NULL
              AND t."firstResponseAt" >= t."createdAt"))::float8 AS "avgResponse",
          (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."firstResponseAt" - t."createdAt")) / 60)
            FILTER (WHERE t."slaResponseTargetMinutes" IS NOT NULL AND t."responseDueAt" IS NOT NULL
              AND t."firstResponseAt" >= t."createdAt"))::float8 AS "medianResponse",
          (AVG(EXTRACT(EPOCH FROM (t."firstResolvedAt" - t."createdAt")) / 60)
            FILTER (WHERE t."slaResolutionTargetMinutes" IS NOT NULL AND t."resolutionDueAt" IS NOT NULL
              AND t."firstResolvedAt" >= t."createdAt"))::float8 AS "avgResolution",
          (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."firstResolvedAt" - t."createdAt")) / 60)
            FILTER (WHERE t."slaResolutionTargetMinutes" IS NOT NULL AND t."resolutionDueAt" IS NOT NULL
              AND t."firstResolvedAt" >= t."createdAt"))::float8 AS "medianResolution"
        FROM "Ticket" t
        JOIN "Subscriber" s ON s."id" = t."subscriberId"
        WHERE t."createdAt" >= ${since} AND t."createdAt" < ${toExclusive}
          AND t."slaPolicyVersionId" IS NOT NULL
          AND t."slaClockMode" = ${CLOCK_MODE}
          ${scopeSql} ${prioritySql}
      `),
      this.prisma.$queryRaw<Array<{ priority: string; total: number; responseEligible: number; responseMet: number; resolutionEligible: number; resolutionMet: number }>>(Prisma.sql`
        SELECT t."priority"::text AS "priority", COUNT(*)::int AS "total",
          COUNT(*) FILTER (WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaResponseTargetMinutes" IS NOT NULL
            AND t."responseDueAt" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
            AND (t."firstResponseAt" IS NOT NULL OR t."responseDueAt" <= ${now}))::int AS "responseEligible",
          COUNT(*) FILTER (WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaResponseTargetMinutes" IS NOT NULL
            AND t."responseDueAt" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
            AND t."firstResponseAt" IS NOT NULL AND t."firstResponseAt" >= t."createdAt"
            AND t."firstResponseAt" <= t."responseDueAt")::int AS "responseMet",
          COUNT(*) FILTER (WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaResolutionTargetMinutes" IS NOT NULL
            AND t."resolutionDueAt" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
            AND (t."firstResolvedAt" IS NOT NULL OR t."resolutionDueAt" <= ${now}))::int AS "resolutionEligible",
          COUNT(*) FILTER (WHERE t."slaPolicyVersionId" IS NOT NULL AND t."slaResolutionTargetMinutes" IS NOT NULL
            AND t."resolutionDueAt" IS NOT NULL AND t."slaClockMode" = ${CLOCK_MODE}
            AND t."firstResolvedAt" IS NOT NULL AND t."firstResolvedAt" >= t."createdAt"
            AND t."firstResolvedAt" <= t."resolutionDueAt")::int AS "resolutionMet"
        FROM "Ticket" t JOIN "Subscriber" s ON s."id" = t."subscriberId"
        WHERE t."createdAt" >= ${since} AND t."createdAt" < ${toExclusive} ${scopeSql} ${prioritySql}
        GROUP BY t."priority" ORDER BY t."priority"
      `),
    ]);
    const metrics = statsRows[0] ?? {};
    const duration = durationRows[0] ?? { avgResponse: null, medianResponse: null, avgResolution: null, medianResolution: null };
    const responseDenominator = metrics.responseDenominator ?? 0;
    const resolutionDenominator = metrics.resolutionDenominator ?? 0;
    const responseMet = metrics.responseMet ?? 0;
    const resolutionMet = metrics.resolutionMet ?? 0;
    const responseBreached = metrics.responseBreached ?? 0;
    const resolutionBreached = metrics.resolutionBreached ?? 0;
    const round = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? null : Math.round(value);
    return {
      periodDays: safeDays,
      periodStart: since.toISOString(),
      periodEnd: to.toISOString(),
      openTickets: await this.prisma.ticket.count({
        where: {
          status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] },
          ...(scope ? { subscriber: { userId: { in: scope.userIds } } } : {}),
        },
      }),
      unconfigured: metrics.unconfigured ?? 0,
      unavailable: metrics.unavailable ?? 0,
      responseUnavailable: metrics.responseUnavailable ?? 0,
      resolutionUnavailable: metrics.resolutionUnavailable ?? 0,
      atRisk: metrics.anyAtRisk ?? 0,
      breached: metrics.anyBreached ?? 0,
      responseNotYetDue: metrics.responseNotYetDue ?? 0,
      resolutionNotYetDue: metrics.resolutionNotYetDue ?? 0,
      response: {
        eligible: responseDenominator,
        met: responseMet,
        breached: responseBreached,
        atRisk: metrics.responseAtRisk ?? 0,
        compliancePercent: responseDenominator ? Number(((responseMet / responseDenominator) * 100).toFixed(1)) : null,
        averageMinutes: round(duration.avgResponse),
        medianMinutes: round(duration.medianResponse),
      },
      resolution: {
        eligible: resolutionDenominator,
        met: resolutionMet,
        breached: resolutionBreached,
        atRisk: metrics.resolutionAtRisk ?? 0,
        compliancePercent: resolutionDenominator ? Number(((resolutionMet / resolutionDenominator) * 100).toFixed(1)) : null,
        averageMinutes: round(duration.avgResolution),
        medianMinutes: round(duration.medianResolution),
      },
      reopened: metrics.reopened ?? 0,
      byPriority: priorityRows.map((row) => ({
        priority: row.priority,
        total: row.total,
        responseEligible: row.responseEligible,
        responseMet: row.responseMet,
        resolutionEligible: row.resolutionEligible,
        resolutionMet: row.resolutionMet,
      })),
      // Compatibility aliases retain the route's established response shape.
      breachedOpen: metrics.anyBreached ?? 0,
      dueWithinHour: metrics.anyAtRisk ?? 0,
      resolvedInPeriod: resolutionMet,
      breachedInPeriod: metrics.anyBreached ?? 0,
      avgResolutionHours: duration.avgResolution == null ? null : Number((duration.avgResolution / 60).toFixed(2)),
      slaCompliancePercent: resolutionDenominator ? Number(((resolutionMet / resolutionDenominator) * 100).toFixed(1)) : null,
    };
  }

  private ticketExpressions(now: Date) {
    const responseBreach = Prisma.sql`(
      t."slaResponseTargetMinutes" IS NOT NULL AND t."responseDueAt" IS NOT NULL
      AND t."slaClockMode" = ${CLOCK_MODE}
      AND (t."firstResponseAt" IS NULL OR t."firstResponseAt" >= t."createdAt") AND
      ((t."firstResponseAt" IS NOT NULL AND t."firstResponseAt" > t."responseDueAt")
        OR (t."firstResponseAt" IS NULL AND t."responseDueAt" < ${now}))
    )`;
    const resolutionBreach = Prisma.sql`(
      t."slaResolutionTargetMinutes" IS NOT NULL AND t."resolutionDueAt" IS NOT NULL
      AND t."slaClockMode" = ${CLOCK_MODE}
      AND (t."firstResolvedAt" IS NULL OR t."firstResolvedAt" >= t."createdAt") AND
      ((t."firstResolvedAt" IS NOT NULL AND t."firstResolvedAt" > t."resolutionDueAt")
        OR (t."firstResolvedAt" IS NULL AND t."resolutionDueAt" < ${now}))
    )`;
    const responseRisk = Prisma.sql`(
      t."slaResponseTargetMinutes" IS NOT NULL AND t."firstResponseAt" IS NULL
      AND t."slaClockMode" = ${CLOCK_MODE}
      AND t."responseDueAt" > ${now}
      AND t."responseDueAt" <= ${now} + COALESCE(t."slaResponseWarningMinutes", 0) * INTERVAL '1 minute'
    )`;
    const resolutionRisk = Prisma.sql`(
      t."slaResolutionTargetMinutes" IS NOT NULL AND t."firstResolvedAt" IS NULL
      AND t."slaClockMode" = ${CLOCK_MODE}
      AND t."resolutionDueAt" > ${now}
      AND t."resolutionDueAt" <= ${now} + COALESCE(t."slaResolutionWarningMinutes", 0) * INTERVAL '1 minute'
    )`;
    const overall = Prisma.sql`CASE
      WHEN t."slaPolicyVersionId" IS NULL OR
        (t."slaResponseTargetMinutes" IS NULL AND t."slaResolutionTargetMinutes" IS NULL) THEN 'NOT_CONFIGURED'
      WHEN t."slaClockMode" IS DISTINCT FROM ${CLOCK_MODE}
        OR (t."slaResponseTargetMinutes" IS NOT NULL AND t."responseDueAt" IS NULL)
        OR (t."slaResolutionTargetMinutes" IS NOT NULL AND t."resolutionDueAt" IS NULL)
        OR (t."slaResponseTargetMinutes" IS NOT NULL AND t."firstResponseAt" < t."createdAt")
        OR (t."slaResolutionTargetMinutes" IS NOT NULL AND t."firstResolvedAt" < t."createdAt") THEN 'UNAVAILABLE'
      WHEN ${responseBreach} OR ${resolutionBreach} THEN 'BREACHED'
      WHEN ${responseRisk} OR ${resolutionRisk} THEN 'AT_RISK'
      WHEN (t."slaResponseTargetMinutes" IS NULL OR t."firstResponseAt" IS NOT NULL)
        AND (t."slaResolutionTargetMinutes" IS NULL OR t."firstResolvedAt" IS NOT NULL) THEN 'MEETING_TARGET'
      ELSE 'ON_TRACK'
    END`;
    return { responseBreach, resolutionBreach, responseRisk, resolutionRisk, overall };
  }

  async slaRecords(actor: Actor, query: Record<string, unknown>) {
    await this.requireAction(actor, 'tickets.sla');
    const scope = await this.companyScope(actor);
    const now = new Date();
    const fallbackFrom = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    const from = parseDate(query.from, fallbackFrom, 'Start date');
    const to = parseDate(query.to, now, 'End date');
    if (from > to || to.getTime() - from.getTime() >= RANGE_DAYS_MAX * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('The SLA date range must be ordered and no longer than 366 days.');
    }
    const toExclusive = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
    const page = Number(query.page ?? 1);
    const pageSize = Number(query.pageSize ?? 25);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new BadRequestException('Page and page size must be positive integers.');
    }
    const limit = Math.min(pageSize, PAGE_SIZE_MAX);
    if ((page - 1) * limit > 1_000_000) throw new BadRequestException('Requested page is too far into the result set.');
    const priority = query.priority == null || query.priority === '' || query.priority === 'ALL'
      ? null
      : String(query.priority);
    if (priority && !PRIORITIES.includes(priority as TicketPriority)) throw new BadRequestException('Select a valid priority.');
    const state = String(query.state ?? 'ALL');
    if (!['ALL', 'NOT_CONFIGURED', 'UNAVAILABLE', 'ON_TRACK', 'AT_RISK', 'BREACHED', 'MEETING_TARGET'].includes(state)) {
      throw new BadRequestException('Select a valid SLA status.');
    }
    const companySql = scope ? Prisma.sql`AND s."userId" = ANY(${scope.userIds}::int[])` : Prisma.empty;
    const assignedUserScopeSql = scope
      ? Prisma.sql`u."id" = ANY(${scope.userIds}::int[])`
      : Prisma.sql`TRUE`;
    const prioritySql = priority ? Prisma.sql`AND t."priority" = ${priority}::"TicketPriority"` : Prisma.empty;
    const { overall } = this.ticketExpressions(now);
    const stateSql = state === 'ALL' ? Prisma.empty : Prisma.sql`AND (${overall}) = ${state}`;
    const where = Prisma.sql`
      t."createdAt" >= ${from} AND t."createdAt" < ${toExclusive}
      ${companySql} ${prioritySql} ${stateSql}
    `;
    const canReadTicket = await this.hasAction(actor, 'tickets.read');
    const canReadSubscriber = await this.hasAction(actor, 'subscribers.read');
    const canReadUsers = await this.hasAction(actor, 'users.read');
    const [countRows, rows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS total
        FROM "Ticket" t JOIN "Subscriber" s ON s."id" = t."subscriberId"
        WHERE ${where}
      `),
      this.prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT t."id", t."ticketNo", t."priority"::text AS "priority", t."status"::text AS "status",
          t."createdAt", t."responseDueAt", t."resolutionDueAt", t."firstResponseAt", t."firstResolvedAt",
          t."slaResponseTargetMinutes", t."slaResolutionTargetMinutes", t."slaResponseWarningMinutes",
          t."slaResolutionWarningMinutes", t."slaClockMode", t."reopenedCount",
          CASE WHEN ${canReadTicket} THEN t."subject" ELSE NULL END AS "subject",
          CASE WHEN ${canReadSubscriber} THEN s."id" ELSE NULL END AS "subscriberId",
          CASE WHEN ${canReadSubscriber} THEN s."fullName" ELSE NULL END AS "subscriberName",
          CASE WHEN ${canReadUsers} AND ${assignedUserScopeSql} THEN u."id" ELSE NULL END AS "assignedUserId",
          CASE WHEN ${canReadUsers} AND ${assignedUserScopeSql} THEN u."name" ELSE NULL END AS "assignedUserName",
          (${overall}) AS "slaStatus",
          CASE
            WHEN t."slaPolicyVersionId" IS NULL OR t."slaResponseTargetMinutes" IS NULL
              OR t."responseDueAt" IS NULL OR t."slaClockMode" IS DISTINCT FROM ${CLOCK_MODE}
              OR t."firstResponseAt" < t."createdAt" THEN 'UNAVAILABLE'
            WHEN t."firstResponseAt" IS NOT NULL AND t."firstResponseAt" <= t."responseDueAt" THEN 'MET'
            WHEN ${this.ticketExpressions(now).responseBreach} THEN 'BREACHED'
            WHEN ${this.ticketExpressions(now).responseRisk} THEN 'AT_RISK'
            WHEN t."firstResponseAt" IS NULL THEN 'ON_TRACK'
            ELSE 'MET'
          END AS "responseStatus",
          CASE
            WHEN t."slaPolicyVersionId" IS NULL OR t."slaResolutionTargetMinutes" IS NULL
              OR t."resolutionDueAt" IS NULL OR t."slaClockMode" IS DISTINCT FROM ${CLOCK_MODE}
              OR t."firstResolvedAt" < t."createdAt" THEN 'UNAVAILABLE'
            WHEN t."firstResolvedAt" IS NOT NULL AND t."firstResolvedAt" <= t."resolutionDueAt" THEN 'MET'
            WHEN ${this.ticketExpressions(now).resolutionBreach} THEN 'BREACHED'
            WHEN ${this.ticketExpressions(now).resolutionRisk} THEN 'AT_RISK'
            WHEN t."firstResolvedAt" IS NULL THEN 'ON_TRACK'
            ELSE 'MET'
          END AS "resolutionStatus",
          CASE WHEN t."firstResponseAt" >= t."createdAt"
            THEN EXTRACT(EPOCH FROM (t."firstResponseAt" - t."createdAt")) / 60 END AS "responseMinutes",
          CASE WHEN t."firstResolvedAt" >= t."createdAt"
            THEN EXTRACT(EPOCH FROM (t."firstResolvedAt" - t."createdAt")) / 60 END AS "resolutionMinutes"
        FROM "Ticket" t
        JOIN "Subscriber" s ON s."id" = t."subscriberId"
        LEFT JOIN "User" u ON u."id" = t."assignedTo"
        WHERE ${where}
        ORDER BY t."createdAt" DESC, t."id" DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}
      `),
    ]);
    return {
      items: rows,
      total: countRows[0]?.total ?? 0,
      page,
      pageSize: limit,
      hasMore: page * limit < (countRows[0]?.total ?? 0),
      period: { from: from.toISOString(), to: to.toISOString() },
    };
  }

  async policies(actor: Actor) {
    await this.requireAction(actor, 'tickets.sla');
    const { companyId } = await this.companyForPolicy(actor);
    return this.prisma.slaPolicyVersion.findMany({
      where: { companyId },
      orderBy: [{ recordType: 'asc' }, { priority: 'asc' }, { effectiveFrom: 'desc' }, { version: 'desc' }],
      take: 500,
    });
  }

  async createPolicy(input: Record<string, unknown>, actor: Actor) {
    await this.requireAction(actor, 'tickets.sla.manage');
    const { companyId, actorId } = await this.companyForPolicy(actor);
    const values = await this.policyValues(input);
    const seriesId = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      if (values.active) await this.closeOverlappingPolicies(tx, companyId, values, values.effectiveFrom);
      const policy = await tx.slaPolicyVersion.create({
        data: { ...values, seriesId, version: 1, companyId, createdById: actorId },
      });
      await this.auditPolicy(tx, actorId, policy.id, 'SLA_POLICY_CREATED', policy);
      return policy;
    }, { isolationLevel: 'Serializable' });
  }

  async createPolicyVersion(seriesId: string, input: Record<string, unknown>, actor: Actor) {
    await this.requireAction(actor, 'tickets.sla.manage');
    const { companyId, actorId } = await this.companyForPolicy(actor);
    const latest = await this.prisma.slaPolicyVersion.findFirst({
      where: { companyId, seriesId },
      orderBy: { version: 'desc' },
    });
    if (!latest) throw new NotFoundException('SLA policy not found.');
    const base: PolicyValues = {
      name: latest.name,
      recordType: latest.recordType as PolicyValues['recordType'],
      priority: latest.priority,
      active: latest.active,
      effectiveFrom: latest.effectiveFrom,
      firstResponseTargetMinutes: latest.firstResponseTargetMinutes,
      resolutionTargetMinutes: latest.resolutionTargetMinutes,
      firstResponseWarningMinutes: latest.firstResponseWarningMinutes,
      resolutionWarningMinutes: latest.resolutionWarningMinutes,
      clockMode: CLOCK_MODE,
      notes: latest.notes,
    };
    const values = await this.policyValues(input, base);
    if (values.recordType !== latest.recordType || values.priority !== latest.priority) {
      throw new BadRequestException('A policy version cannot change record type or priority; create a separate policy.');
    }
    if (values.effectiveFrom <= latest.effectiveFrom) {
      throw new BadRequestException('A policy version must start after the latest version in its series.');
    }
    return this.prisma.$transaction(async (tx) => {
      await this.closeOverlappingPolicies(tx, companyId, values, values.effectiveFrom, seriesId, values.active);
      const policy = await tx.slaPolicyVersion.create({
        data: {
          ...values,
          seriesId,
          version: latest.version + 1,
          companyId,
          createdById: actorId,
        },
      });
      await this.auditPolicy(tx, actorId, policy.id, values.active ? 'SLA_POLICY_VERSIONED' : 'SLA_POLICY_DEACTIVATED', policy);
      return policy;
    }, { isolationLevel: 'Serializable' });
  }

  private async closeOverlappingPolicies(
    tx: Prisma.TransactionClient,
    companyId: number,
    values: PolicyValues,
    effectiveFrom: Date,
    exceptSeriesId?: string,
    closeCompetitors = true,
  ): Promise<void> {
    const later = closeCompetitors ? await tx.slaPolicyVersion.findFirst({
      where: {
        companyId,
        recordType: values.recordType,
        priority: values.priority,
        active: true,
        seriesId: exceptSeriesId ? { not: exceptSeriesId } : undefined,
        effectiveFrom: { gte: effectiveFrom },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }],
      },
      select: { id: true },
    }) : null;
    if (later) throw new ConflictException('An active policy already starts on or after this effective date.');
    if (closeCompetitors) {
      await tx.slaPolicyVersion.updateMany({
        where: {
          companyId,
          recordType: values.recordType,
          priority: values.priority,
          active: true,
          seriesId: exceptSeriesId ? { not: exceptSeriesId } : undefined,
          effectiveFrom: { lt: effectiveFrom },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }],
        },
        data: { effectiveTo: effectiveFrom },
      });
    }
    if (exceptSeriesId) {
      await tx.slaPolicyVersion.updateMany({
        where: {
          companyId,
          seriesId: exceptSeriesId,
          active: true,
          effectiveFrom: { lt: effectiveFrom },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }],
        },
        data: { effectiveTo: effectiveFrom },
      });
    }
  }

  private async auditPolicy(tx: Prisma.TransactionClient, actorId: number, policyId: number, action: string, policy: PolicyValues) {
    await tx.activityLog.create({
      data: {
        userId: actorId,
        action,
        entity: 'SlaPolicyVersion',
        entityId: policyId,
        details: JSON.stringify({
          name: policy.name,
          recordType: policy.recordType,
          priority: policy.priority,
          active: policy.active,
          effectiveFrom: policy.effectiveFrom.toISOString(),
          clockMode: policy.clockMode,
        }),
      },
    });
  }

  async backfill() {
    throw new BadRequestException('Historical records without a policy snapshot remain SLA not configured; no targets were backfilled.');
  }
}
