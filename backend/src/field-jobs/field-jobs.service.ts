import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, FieldJobStatus, FieldJobType, TicketPriority } from '@prisma/client';
import { InventoryService } from '../inventory/inventory.service';
import { Actor, ScopeService } from '../common/scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { TicketSlaService } from '../tickets/ticket-sla.service';

const JOB_TYPES: FieldJobType[] = [
  'INSTALLATION',
  'FAULT_REPAIR',
  'MAINTENANCE',
  'DISCONNECTION',
  'SURVEY',
  'UPGRADE',
  'RELOCATION',
];
const JOB_STATUSES: FieldJobStatus[] = [
  'PENDING',
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];
const JOB_PRIORITIES: TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const OPEN_STATUSES: FieldJobStatus[] = ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW'];

type Input = Record<string, unknown>;
type VisibleJob = {
  status: FieldJobStatus;
  assignedTo: number | null;
  createdById: number | null;
  subscriber: { userId: number | null } | null;
  ticket: { subscriberId: number; subscriber: { userId: number | null } } | null;
  lead: { companyId: number } | null;
};

@Injectable()
export class FieldJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly inventory: InventoryService,
    private readonly sla: TicketSlaService,
  ) {}

  private actorId(actor: Actor): number {
    const id = this.scope.actorId(actor);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new ForbiddenException('Your account has no user identity.');
    }
    return id;
  }

  private async companyId(actor: Actor): Promise<number> {
    if (!actor || actor.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('Field operations require a company account.');
    }
    const companyId = await this.scope.companyRootId(this.actorId(actor));
    if (!companyId) throw new ForbiddenException('A company scope is required.');
    return companyId;
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

  private async requireAction(actor: Actor, permission: string) {
    if (!(await this.hasAction(actor, permission))) {
      throw new ForbiddenException(`You do not have permission to perform this field-job action.`);
    }
  }

  private text(value: unknown, name: string, maximum: number, required = false): string | null {
    if (value == null || value === '') {
      if (required) throw new BadRequestException(`${name} is required.`);
      return null;
    }
    if (typeof value !== 'string') throw new BadRequestException(`${name} must be text.`);
    const clean = value.trim();
    if (required && !clean) throw new BadRequestException(`${name} is required.`);
    if (clean.length > maximum) throw new BadRequestException(`${name} must be ${maximum} characters or fewer.`);
    return clean || null;
  }

  private positiveId(value: unknown, name: string): number | null {
    if (value == null || value === '') return null;
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new BadRequestException(`${name} must be a positive integer.`);
    }
    return id;
  }

  private date(value: unknown, name: string): Date | null {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' && !(value instanceof Date)) {
      throw new BadRequestException(`${name} must be a valid date.`);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${name} must be a valid date.`);
    return parsed;
  }

  private async companyUsers(actor: Actor): Promise<{ companyId: number; userIds: number[] }> {
    const companyId = await this.companyId(actor);
    return { companyId, userIds: await this.scope.descendantIds(companyId) };
  }

  private include() {
    return {
      subscriber: { select: { id: true, fullName: true, username: true, phone: true, address: true } },
      ticket: { select: { id: true, ticketNo: true, subject: true, status: true } },
      lead: { select: { id: true, name: true, phone: true, stage: true } },
      technician: { select: { id: true, name: true, phone: true } },
      activities: {
        orderBy: { createdAt: 'desc' as const },
        take: 100,
        include: { actor: { select: { id: true, name: true } } },
      },
      visits: {
        orderBy: { visitNumber: 'desc' as const },
        take: 30,
        include: { technician: { select: { id: true, name: true } } },
      },
      attachments: {
        orderBy: { createdAt: 'desc' as const },
        take: 50,
        include: { uploader: { select: { id: true, name: true } } },
      },
      inventoryMovements: {
        orderBy: { createdAt: 'desc' as const },
        take: 100,
        include: {
          item: { select: { id: true, serialNumber: true, type: true, status: true, ownerId: true } },
          employee: { select: { id: true, name: true } },
        },
      },
    };
  }

  private async rawJob(id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('Field job ID must be a positive integer.');
    const job = await this.prisma.fieldJob.findUnique({
      where: { id },
      include: {
        ...this.include(),
        subscriber: { select: { id: true, fullName: true, username: true, phone: true, address: true, userId: true } },
        lead: { select: { id: true, name: true, phone: true, stage: true, companyId: true } },
        ticket: {
          select: {
            id: true,
            ticketNo: true,
            subject: true,
            status: true,
            subscriberId: true,
            subscriber: { select: { userId: true } },
          },
        },
      },
    });
    if (!job) throw new NotFoundException('Field job not found.');
    return job;
  }

  private async assertVisible(actor: Actor, job: VisibleJob) {
    if (actor?.role === 'SUPER_ADMIN') return;
    const { companyId, userIds } = await this.companyUsers(actor);
    const visible =
      userIds.includes(job.assignedTo ?? -1) ||
      userIds.includes(job.createdById ?? -1) ||
      (job.subscriber?.userId != null && userIds.includes(job.subscriber.userId)) ||
      (job.ticket?.subscriberId != null &&
        (await this.scope.canAccessSubscriber(actor, job.ticket.subscriberId))) ||
      (job.lead?.companyId === companyId);
    if (!visible) throw new NotFoundException('Field job not found.');
  }

  private async employeeForUser(companyId: number, userId: number) {
    const employee = await this.prisma.employeeProfile.findFirst({
      where: {
        companyId,
        userId,
        status: 'ACTIVE',
        user: { is: { isActive: true } },
      },
      select: { id: true, userId: true, name: true },
    });
    if (!employee) throw new BadRequestException('Select an active employee in this company.');
    return employee;
  }

  private async validateLinks(actor: Actor, companyId: number, input: Input) {
    const subscriberId = this.positiveId(input.subscriberId, 'Subscriber');
    const ticketId = this.positiveId(input.ticketId, 'Ticket');
    const leadId = this.positiveId(input.leadId, 'Lead');
    if (ticketId && subscriberId) throw new BadRequestException('Choose a subscriber or a ticket, not both.');
    if (leadId && (subscriberId || ticketId)) {
      throw new BadRequestException('A field job can link to one subscriber, ticket, or lead.');
    }
    if (subscriberId) await this.scope.assertSubscriber(actor, subscriberId);
    if (ticketId) {
      const ticket = await this.prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { id: true, subscriberId: true },
      });
      if (!ticket) throw new NotFoundException('Ticket not found.');
      await this.scope.assertSubscriber(actor, ticket.subscriberId);
    }
    if (leadId) {
      const lead = await this.prisma.crmLead.findFirst({
        where: { id: leadId, companyId },
        select: { id: true },
      });
      if (!lead) throw new NotFoundException('Lead not found.');
    }
    const resolvedSubscriberId = subscriberId ?? (ticketId
      ? (await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, select: { subscriberId: true } })).subscriberId
      : null);
    return { subscriberId: resolvedSubscriberId, ticketId, leadId };
  }

  private async assertScheduleAvailable(
    tx: Prisma.TransactionClient,
    companyId: number,
    employeeId: number,
    technicianId: number,
    startsAt: Date | null,
    endsAt: Date | null,
    excludeJobId?: number,
  ) {
    if (!startsAt) return;
    const appointmentEnd = endsAt ?? new Date(startsAt.getTime() + 60 * 60 * 1000);
    if (appointmentEnd <= startsAt) {
      throw new BadRequestException('Appointment end must be after its start.');
    }
    const leaveRows = await tx.employeeLeaveRequest.findMany({
      where: {
        companyId,
        employeeId,
        status: 'APPROVED',
        startDate: { lte: appointmentEnd },
        endDate: { gte: startsAt },
      },
      select: { leaveDates: true },
    });
    const startDay = Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth(), startsAt.getUTCDate());
    const endDay = Date.UTC(appointmentEnd.getUTCFullYear(), appointmentEnd.getUTCMonth(), appointmentEnd.getUTCDate());
    if (leaveRows.some((row) => row.leaveDates.some((date) => {
      const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      return day >= startDay && day <= endDay;
    }))) {
      throw new ConflictException('This technician has approved leave during the appointment.');
    }
    const conflict = await tx.fieldJob.findFirst({
      where: {
        assignedTo: technicianId,
        status: { in: OPEN_STATUSES },
        id: excludeJobId == null ? undefined : { not: excludeJobId },
        scheduledAt: { lt: appointmentEnd },
        OR: [{ appointmentEndsAt: { gt: startsAt } }, { appointmentEndsAt: null }],
      },
      select: { id: true, jobNo: true },
    });
    if (conflict) throw new ConflictException(`Technician already has an overlapping appointment (${conflict.jobNo}).`);
  }

  private dispatchDay(value: unknown, name: string, fallback: Date): Date {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(`${name} must use YYYY-MM-DD.`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException(`${name} must be a valid date.`);
    }
    return parsed;
  }

  private dispatchVisibility(companyId: number, userIds: number[]): Prisma.FieldJobWhereInput {
    return {
      AND: [
        {
          OR: [
            { assignedTo: { in: userIds } },
            { createdById: { in: userIds } },
            { subscriber: { is: { userId: { in: userIds } } } },
            { ticket: { is: { subscriber: { is: { userId: { in: userIds } } } } } },
            { lead: { is: { companyId } } },
          ],
        },
        { OR: [{ leadId: null }, { lead: { is: { companyId: { in: userIds } } } }] },
        { OR: [{ assignedTo: null }, { assignedTo: { in: userIds } }] },
        { OR: [{ createdById: null }, { createdById: { in: userIds } }] },
        {
          OR: [
            { subscriberId: null },
            { subscriber: { is: { userId: { in: userIds } } } },
            { subscriber: { is: { userId: null } } },
          ],
        },
        {
          OR: [
            { ticketId: null },
            { ticket: { is: { subscriber: { is: { userId: { in: userIds } } } } } },
            { ticket: { is: { subscriber: { is: { userId: null } } } } },
          ],
        },
      ],
    };
  }

  private dispatchOwnerIds(
    job: Pick<VisibleJob, 'assignedTo' | 'createdById' | 'subscriber' | 'ticket' | 'lead'>,
  ): number[] {
    return [
      job.lead?.companyId,
      job.subscriber?.userId,
      job.ticket?.subscriber?.userId,
      job.assignedTo,
      job.createdById,
    ].filter((id): id is number => id != null);
  }

  private dispatchCompanyFromRoots(
    job: Pick<VisibleJob, 'assignedTo' | 'createdById' | 'subscriber' | 'ticket' | 'lead'>,
    rootsByOwnerId: Map<number, number | null>,
  ): number | null {
    const ownerIds = this.dispatchOwnerIds(job);
    if (!ownerIds.length) return null;
    const roots = [...new Set(ownerIds)].map((id) => rootsByOwnerId.get(id) ?? null);
    if (roots.some((root) => root == null) || new Set(roots).size !== 1) return null;
    return roots[0] ?? null;
  }

  private async dispatchCompanyId(
    job: Pick<VisibleJob, 'assignedTo' | 'createdById' | 'subscriber' | 'ticket' | 'lead'>,
  ): Promise<number | null> {
    const ownerIds = [...new Set(this.dispatchOwnerIds(job))];
    if (!ownerIds.length) return null;
    const roots = await Promise.all(ownerIds.map((id) => this.scope.companyRootId(id)));
    return this.dispatchCompanyFromRoots(job, new Map(ownerIds.map((id, index) => [id, roots[index]] as const)));
  }

  private async dispatchCompanyIds(
    jobs: Array<Pick<VisibleJob, 'assignedTo' | 'createdById' | 'subscriber' | 'ticket' | 'lead'>>,
  ): Promise<Array<number | null>> {
    const ownerIds = [...new Set(jobs.flatMap((job) => this.dispatchOwnerIds(job)))];
    const roots = await Promise.all(ownerIds.map((id) => this.scope.companyRootId(id)));
    const rootsByOwnerId = new Map(ownerIds.map((id, index) => [id, roots[index]] as const));
    return jobs.map((job) => this.dispatchCompanyFromRoots(job, rootsByOwnerId));
  }

  private async dispatchEligibleProfiles(companyId: number, userIds: number[], candidateIds: number[]) {
    const scopedIds = [...new Set(candidateIds.filter((id) => userIds.includes(id)))];
    if (!scopedIds.length) return [];
    return this.prisma.employeeProfile.findMany({
      where: {
        companyId,
        userId: { in: scopedIds },
        status: 'ACTIVE',
        user: { is: { id: { in: userIds }, isActive: true } },
      },
      select: {
        id: true,
        name: true,
        userId: true,
        user: { select: { id: true, name: true } },
      },
    });
  }

  private dispatchActivityDetail(action: string, detail: string): string {
    if (action === 'ASSIGNED') return 'Assignment recorded.';
    if (action === 'REASSIGNED') {
      const marker = detail.lastIndexOf('Reason:');
      return marker < 0 ? 'Reassignment recorded.' : `Reassignment reason: ${detail.slice(marker + 'Reason:'.length).trim()}`;
    }
    if (action === 'UNASSIGNED') return 'Assignment removed.';
    if (action === 'SCHEDULED') return 'Schedule updated.';
    return `${action.replaceAll('_', ' ')} recorded.`;
  }

  private async dispatchHistoryPage(fieldJobId: number, companyId: number, userIds: number[], cursor?: number) {
    const take = 100;
    const rows = await this.prisma.fieldJobActivity.findMany({
      where: {
        fieldJobId,
        action: { in: ['ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'SCHEDULED'] },
        ...(cursor == null ? {} : { id: { lt: cursor } }),
      },
      orderBy: { id: 'desc' },
      take: take + 1,
      select: {
        id: true,
        action: true,
        detail: true,
        createdAt: true,
        actor: { select: { id: true, name: true } },
      },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const actorIds = [...new Set(page.flatMap((row) => row.actor == null ? [] : [row.actor.id]))];
    const eligibleActors = await this.dispatchEligibleProfiles(companyId, userIds, actorIds);
    const eligibleActorIds = new Set(eligibleActors.flatMap((employee) => employee.userId == null ? [] : [employee.userId]));
    const activities = page.map((row) => ({
      ...row,
      detail: this.dispatchActivityDetail(row.action, row.detail),
      actor: row.actor && eligibleActorIds.has(row.actor.id) ? row.actor : null,
    }));
    return {
      activities,
      history: {
        hasMore,
        nextCursor: hasMore ? activities[activities.length - 1].id : null,
        returned: activities.length,
      },
    };
  }

  private async dispatchJobResponse(id: number, actor: Actor) {
    const job = await this.findOne(id, actor);
    const { companyId, userIds } = await this.companyUsers(actor);
    const jobCompanyId = await this.dispatchCompanyId(job);
    if (jobCompanyId == null || jobCompanyId !== companyId) {
      throw new NotFoundException('Field job not found.');
    }
    const employeeIds = [
      ...(job.assignedTo == null ? [] : [job.assignedTo]),
      ...(job.assignedById == null ? [] : [job.assignedById]),
      ...(job.createdById == null ? [] : [job.createdById]),
      ...job.activities.flatMap((activity) => activity.actor == null ? [] : [activity.actor.id]),
      ...job.visits.flatMap((visit) => visit.technicianId == null ? [] : [visit.technicianId]),
      ...job.attachments.map((attachment) => attachment.uploadedById),
    ];
    const eligibleProfiles = await this.dispatchEligibleProfiles(jobCompanyId, userIds, employeeIds);
    const eligibleProfileByUser = new Map(eligibleProfiles.flatMap((profile) =>
      profile.userId == null || profile.user == null ? [] : [[profile.userId, profile.user] as const],
    ));
    const activities = job.activities.map((activity) => ({
      ...activity,
      detail: this.dispatchActivityDetail(activity.action, activity.detail),
      actorUserId: activity.actorUserId != null && eligibleProfileByUser.has(activity.actorUserId) ? activity.actorUserId : null,
      actor: activity.actor && eligibleProfileByUser.has(activity.actor.id)
        ? { id: activity.actor.id, name: eligibleProfileByUser.get(activity.actor.id)?.name || activity.actor.name }
        : null,
    }));
    const movementEmployeeIds = [...new Set(job.inventoryMovements.flatMap((movement) =>
      movement.employee == null ? [] : [movement.employee.id],
    ))];
    const eligibleMovementProfiles = movementEmployeeIds.length
      ? await this.prisma.employeeProfile.findMany({
          where: {
            id: { in: movementEmployeeIds },
            companyId: jobCompanyId,
            userId: { in: userIds },
            status: 'ACTIVE',
            user: { is: { isActive: true } },
          },
          select: { id: true, name: true, user: { select: { id: true, name: true } } },
        })
      : [];
    const movementProfilesById = new Map(eligibleMovementProfiles.map((profile) => [
      profile.id,
      profile.user ? { id: profile.user.id, name: profile.user.name || profile.name } : null,
    ] as const));
    const canReadSubscriber = await this.hasAction(actor, 'subscribers.read');
    const {
      address: _siteAddress,
      createdById: _createdById,
      subscriber,
      technician: _technician,
      activities: _activities,
      visits: _visits,
      attachments: _attachments,
      inventoryMovements: _inventoryMovements,
      ...safeJob
    } = job;
    const safeSubscriber = canReadSubscriber ? subscriber : null;
    return {
      ...safeJob,
      createdById: job.createdById != null && eligibleProfileByUser.has(job.createdById) ? job.createdById : null,
      assignedById: job.assignedById != null && eligibleProfileByUser.has(job.assignedById) ? job.assignedById : null,
      subscriber: safeSubscriber,
      technician: job.assignedTo == null ? null : eligibleProfileByUser.get(job.assignedTo) ?? null,
      activities,
      visits: job.visits.map((visit) => ({
        ...visit,
        technicianId: visit.technicianId != null && eligibleProfileByUser.has(visit.technicianId) ? visit.technicianId : null,
        technician: visit.technicianId != null && eligibleProfileByUser.has(visit.technicianId)
          ? {
              id: visit.technicianId,
              name: eligibleProfileByUser.get(visit.technicianId)?.name || visit.technician?.name,
            }
          : null,
      })),
      attachments: job.attachments.map((attachment) => ({
        ...attachment,
        uploadedById: eligibleProfileByUser.has(attachment.uploadedById) ? attachment.uploadedById : null,
        uploader: eligibleProfileByUser.has(attachment.uploadedById)
          ? {
              id: attachment.uploadedById,
              name: eligibleProfileByUser.get(attachment.uploadedById)?.name || attachment.uploader.name,
            }
          : null,
      })),
      inventoryMovements: job.inventoryMovements.map((movement) => ({
        ...movement,
        employeeId: movement.employeeId != null && movementProfilesById.has(movement.employeeId) ? movement.employeeId : null,
        employee: movement.employee == null ? null : movementProfilesById.get(movement.employee.id) ?? null,
      })),
    };
  }

  private async record(
    tx: Prisma.TransactionClient,
    jobId: number,
    actorUserId: number,
    action: string,
    detail: string,
  ) {
    await tx.fieldJobActivity.create({
      data: { fieldJobId: jobId, actorUserId, action, detail: detail.slice(0, 4000) },
    });
    await tx.activityLog.create({
      data: {
        userId: actorUserId,
        action: `FIELD_JOB.${action}`,
        entity: 'FieldJob',
        entityId: jobId,
        details: detail.slice(0, 1000),
      },
    });
  }

  async options(actor: Actor) {
    await this.requireAction(actor, 'field-jobs.read');
    const { companyId } = await this.companyUsers(actor);
    const [canCreate, canDispatch, canTechnician, canReview, canMaterials, canDelete, canReport, canEvidence, canLocation, canSchedules, employees] =
      await Promise.all([
        this.hasAction(actor, 'field-jobs.write'),
        this.hasAction(actor, 'field-jobs.dispatch'),
        this.hasAction(actor, 'field-jobs.technician'),
        this.hasAction(actor, 'field-jobs.review'),
        this.hasAction(actor, 'field-jobs.materials'),
        this.hasAction(actor, 'field-jobs.delete'),
        this.hasAction(actor, 'field-jobs.report'),
        this.hasAction(actor, 'field-jobs.evidence'),
        this.hasAction(actor, 'field-jobs.location'),
        this.hasAction(actor, 'field-jobs.schedules'),
        this.prisma.employeeProfile.findMany({
          where: { companyId, status: 'ACTIVE', userId: { not: null }, user: { is: { isActive: true } } },
          include: { user: { select: { id: true, name: true, phone: true } } },
          orderBy: { name: 'asc' },
          take: 300,
        }),
      ]);
    const userIds = await this.scope.descendantIds(companyId);
    const inventoryItems = canMaterials
      ? await this.prisma.inventoryItem.findMany({
          where: {
            OR: [{ companyId }, { companyId: null, ownerId: { in: userIds } }],
            status: { in: ['IN_STOCK', 'ASSIGNED'] },
            fieldJobId: null,
            reservedForFieldJobId: null,
          },
          select: {
            id: true,
            serialNumber: true,
            type: true,
            brand: true,
            model: true,
            status: true,
            ownerId: true,
            fieldJobId: true,
            reservedForFieldJobId: true,
          },
          orderBy: { updatedAt: 'desc' },
          take: 200,
        })
      : [];
    const workload = await this.prisma.fieldJob.groupBy({
      by: ['assignedTo'],
      where: { assignedTo: { in: employees.map((employee) => employee.user!.id) }, status: { in: OPEN_STATUSES } },
      _count: { _all: true },
    });
    const workloadByUser = new Map(workload.map((row) => [row.assignedTo!, row._count._all]));
    return {
      canCreate,
      canDispatch,
      canTechnician,
      canReview,
      canMaterials,
      canDelete,
      canReport,
      canEvidence,
      canLocation,
      canSchedules,
      currentUserId: this.actorId(actor),
      inventoryItems,
      technicians: employees.map((employee) => ({
        id: employee.user!.id,
        employeeId: employee.id,
        name: employee.user!.name || employee.name,
        designation: employee.designation,
        workload: workloadByUser.get(employee.user!.id) ?? 0,
      })),
    };
  }

  async findAll(actor: Actor, query: Input) {
    await this.requireAction(actor, 'field-jobs.read');
    const page = Number(query.page ?? 1);
    const pageSize = Number(query.pageSize ?? query.limit ?? 25);
    if (!Number.isSafeInteger(page) || page < 1) throw new BadRequestException('Page must be a positive integer.');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new BadRequestException('Page size must be a positive integer.');
    const take = Math.min(pageSize, 100);
    const skip = (page - 1) * take;
    if (!Number.isSafeInteger(skip)) throw new BadRequestException('Page is outside the supported range.');
    const where: Prisma.FieldJobWhereInput = {};
    if (actor?.role !== 'SUPER_ADMIN') {
      const { companyId, userIds } = await this.companyUsers(actor);
      where.OR = [
        { assignedTo: { in: userIds } },
        { createdById: { in: userIds } },
        { subscriber: { is: { userId: { in: userIds } } } },
        { ticket: { is: { subscriber: { is: { userId: { in: userIds } } } } } },
        { lead: { is: { companyId } } },
      ];
    }
    if (query.status && query.status !== 'ALL') {
      const status = String(query.status) as FieldJobStatus;
      if (!JOB_STATUSES.includes(status)) throw new BadRequestException('Unknown field-job status.');
      where.status = status;
    }
    if (query.type && query.type !== 'ALL') {
      const type = String(query.type) as FieldJobType;
      if (!JOB_TYPES.includes(type)) throw new BadRequestException('Unknown field-job type.');
      where.type = type;
    }
    const technicianId = this.positiveId(query.technicianId ?? query.assignedTo, 'Technician');
    if (technicianId != null) where.assignedTo = technicianId;
    const subscriberId = this.positiveId(query.subscriberId, 'Subscriber');
    if (subscriberId != null) where.subscriberId = subscriberId;
    const from = this.date(query.from ?? query.dateFrom, 'Start date');
    const to = this.date(query.to ?? query.dateTo, 'End date');
    if (from && to && from > to) throw new BadRequestException('Start date must not be after end date.');
    if (from || to) {
      where.scheduledAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    }
    if (query.q) {
      const search = this.text(query.q, 'Search', 120);
      if (search) {
        const searchOr: Prisma.FieldJobWhereInput[] = [
          { jobNo: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { address: { contains: search, mode: 'insensitive' } },
          { subscriber: { is: { fullName: { contains: search, mode: 'insensitive' } } } },
          { subscriber: { is: { username: { contains: search, mode: 'insensitive' } } } },
          { ticket: { is: { subject: { contains: search, mode: 'insensitive' } } } },
          { lead: { is: { name: { contains: search, mode: 'insensitive' } } } },
        ];
        where.AND = [{ OR: searchOr }];
      }
    }
    const orderByField = String(query.sort ?? 'scheduledAt');
    const allowedSort = ['scheduledAt', 'createdAt', 'updatedAt', 'priority', 'status', 'visitOrder'];
    if (!allowedSort.includes(orderByField)) throw new BadRequestException('Unsupported field-job sort.');
    const direction = String(query.direction ?? 'desc').toLowerCase();
    if (direction !== 'asc' && direction !== 'desc') throw new BadRequestException('Sort direction must be asc or desc.');
    const [items, total] = await Promise.all([
      this.prisma.fieldJob.findMany({
        where,
        include: this.include(),
        orderBy: [{ [orderByField]: direction }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.fieldJob.count({ where }),
    ]);
    return { items, total, page, pageSize: take };
  }

  async myJobs(actor: Actor, all = false) {
    await this.requireAction(actor, 'field-jobs.read');
    const userId = this.actorId(actor);
    const where: Prisma.FieldJobWhereInput = { assignedTo: userId };
    if (!all) where.status = { in: OPEN_STATUSES };
    const items = await this.prisma.fieldJob.findMany({
      where,
      include: this.include(),
      orderBy: [{ scheduledAt: 'asc' }, { visitOrder: 'asc' }, { priority: 'desc' }],
      take: 100,
    });
    return { items, total: items.length };
  }

  async findOne(id: number, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.read');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    const canMaterials = await this.hasAction(actor, 'field-jobs.materials');
    const [issuedMaterialCount, reservedMaterialCount, issuedInventoryItems, reservedInventoryItems] = await Promise.all([
      this.prisma.inventoryItem.count({ where: { fieldJobId: id } }),
      this.prisma.inventoryItem.count({ where: { reservedForFieldJobId: id } }),
      canMaterials
        ? this.prisma.inventoryItem.findMany({
            where: { fieldJobId: id },
            orderBy: { updatedAt: 'desc' },
            take: 200,
            select: {
              id: true,
              serialNumber: true,
              type: true,
              brand: true,
              model: true,
              status: true,
              ownerId: true,
              fieldJobId: true,
              reservedForFieldJobId: true,
              updatedAt: true,
            },
          })
        : Promise.resolve([]),
      canMaterials
        ? this.prisma.inventoryItem.findMany({
            where: { reservedForFieldJobId: id },
            orderBy: { updatedAt: 'desc' },
            take: 200,
            select: {
              id: true,
              serialNumber: true,
              type: true,
              brand: true,
              model: true,
              status: true,
              ownerId: true,
              fieldJobId: true,
              reservedForFieldJobId: true,
              updatedAt: true,
            },
          })
        : Promise.resolve([]),
    ]);
    return {
      ...job,
      issuedMaterialCount,
      reservedMaterialCount,
      issuedInventoryItems,
      reservedInventoryItems,
    };
  }

  async stats(actor: Actor) {
    await this.requireAction(actor, 'field-jobs.report');
    const where: Prisma.FieldJobWhereInput = {};
    if (actor?.role !== 'SUPER_ADMIN') {
      const { companyId, userIds } = await this.companyUsers(actor);
      where.OR = [
        { assignedTo: { in: userIds } },
        { createdById: { in: userIds } },
        { subscriber: { is: { userId: { in: userIds } } } },
        { ticket: { is: { subscriber: { is: { userId: { in: userIds } } } } } },
        { lead: { is: { companyId } } },
      ];
    }
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const [groups, unassigned, overdue, scheduledToday, total] = await Promise.all([
      this.prisma.fieldJob.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.fieldJob.count({ where: { ...where, status: 'PENDING', assignedTo: null } }),
      this.prisma.fieldJob.count({
        where: { ...where, status: { in: OPEN_STATUSES }, scheduledAt: { lt: new Date() } },
      }),
      this.prisma.fieldJob.count({
        where: {
          ...where,
          scheduledAt: { gte: dayStart, lte: new Date(dayStart.getTime() + 24 * 60 * 60 * 1000) },
        },
      }),
      this.prisma.fieldJob.count({ where }),
    ]);
    const byStatus: Record<string, number> = {};
    for (const row of groups) byStatus[row.status] = row._count._all;
    return { total, byStatus, unassigned, overdue, scheduledToday };
  }

  async dispatchQueue(actor: Actor, query: Input) {
    await this.requireAction(actor, 'field-jobs.dispatch');
    const { companyId, userIds } = await this.companyUsers(actor);
    const now = new Date();
    const fallbackFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
    const fallbackTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const from = this.dispatchDay(query.from, 'Start date', fallbackFrom);
    const to = this.dispatchDay(query.to, 'End date', fallbackTo);
    if (from > to) throw new BadRequestException('Start date must not be after end date.');
    if (to.getTime() - from.getTime() > 365 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('The dispatch date range cannot exceed 366 days.');
    }
    const toExclusive = new Date(to.getTime() + 24 * 60 * 60 * 1000);
    const page = Number(query.page ?? 1);
    const pageSize = Number(query.pageSize ?? 25);
    if (!Number.isSafeInteger(page) || page < 1) throw new BadRequestException('Page must be a positive integer.');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new BadRequestException('Page size must be a positive integer.');
    const take = Math.min(pageSize, 100);
    const skip = (page - 1) * take;
    if (!Number.isSafeInteger(skip) || skip > 1_000_000) throw new BadRequestException('The requested dispatch page is too far into the result set.');

    const whereConditions: Prisma.FieldJobWhereInput[] = [
      this.dispatchVisibility(companyId, userIds),
      { createdAt: { gte: from, lt: toExclusive } },
    ];
    if (query.status && query.status !== 'ALL') {
      const status = String(query.status) as FieldJobStatus;
      if (!JOB_STATUSES.includes(status)) throw new BadRequestException('Unknown field-job status.');
      whereConditions.push({ status });
    }
    if (query.type && query.type !== 'ALL') {
      const type = String(query.type) as FieldJobType;
      if (!JOB_TYPES.includes(type)) throw new BadRequestException('Unknown field-job type.');
      whereConditions.push({ type });
    }
    if (query.priority && query.priority !== 'ALL') {
      const priority = String(query.priority) as TicketPriority;
      if (!JOB_PRIORITIES.includes(priority)) throw new BadRequestException('Unknown field-job priority.');
      whereConditions.push({ priority });
    }
    const technicianId = this.positiveId(query.technicianId, 'Technician');
    if (technicianId != null) {
      const employee = await this.prisma.employeeProfile.findFirst({
        where: { companyId, userId: technicianId, user: { is: { id: { in: userIds } } } },
        select: { id: true },
      });
      if (!employee) throw new BadRequestException('Select a technician in this company.');
      whereConditions.push({ assignedTo: technicianId });
    }
    const subscriberId = this.positiveId(query.subscriberId, 'Subscriber');
    if (subscriberId != null) {
      if (!(await this.hasAction(actor, 'subscribers.read'))) {
        throw new ForbiddenException('Subscriber filtering requires subscriber-read permission.');
      }
      await this.scope.assertSubscriber(actor, subscriberId);
      whereConditions.push({
        OR: [
          { subscriberId },
          { ticket: { is: { subscriberId } } },
        ],
      });
    }

    const where: Prisma.FieldJobWhereInput = { AND: whereConditions };
    const subscriberReadable = await this.hasAction(actor, 'subscribers.read');
    const employeeWhere = {
      companyId,
      userId: { in: userIds },
      status: 'ACTIVE' as const,
      user: { is: { id: { in: userIds }, isActive: true } },
    };
    const [items, total, statusGroups, unassigned, overdue, dueSoon, employees, employeeCount] = await Promise.all([
      this.prisma.fieldJob.findMany({
        where,
        select: {
          id: true,
          jobNo: true,
          type: true,
          status: true,
          priority: true,
          description: true,
          ...(subscriberReadable ? { address: true } : {}),
          assignedTo: true,
          scheduledAt: true,
          appointmentEndsAt: true,
          assignedAt: true,
          requiredSkills: true,
          createdById: true,
          lead: { select: { companyId: true } },
          subscriber: { select: { userId: true, ...(subscriberReadable ? { id: true, fullName: true, username: true } : {}) } },
          ticket: { select: { subscriberId: true, subscriber: { select: { userId: true } } } },
        },
        orderBy: [{ scheduledAt: 'asc' }, { priority: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.fieldJob.count({ where }),
      this.prisma.fieldJob.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.fieldJob.count({
        where: { AND: [where, { status: { in: ['PENDING', 'FAILED'] } }, { assignedTo: null }] },
      }),
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
        where: {
          AND: [
            where,
            { status: { in: OPEN_STATUSES } },
            {
              OR: [
                { appointmentEndsAt: { gte: now, lt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } },
                { appointmentEndsAt: null, scheduledAt: { gte: now, lt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } },
              ],
            },
          ],
        },
      }),
      this.prisma.employeeProfile.findMany({
        where: employeeWhere,
        select: {
          id: true,
          name: true,
          designation: true,
          status: true,
          userId: true,
          user: { select: { id: true, name: true, isActive: true } },
        },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      this.prisma.employeeProfile.count({ where: employeeWhere }),
    ]);

    const itemCompanies = await this.dispatchCompanyIds(items);
    if (itemCompanies.some((ownerCompanyId) => ownerCompanyId !== companyId)) {
      throw new NotFoundException('Field job not found.');
    }
    const assignedProfileIds = items.flatMap((item) => item.assignedTo == null ? [] : [item.assignedTo]);
    const assignedProfiles = await this.dispatchEligibleProfiles(companyId, userIds, assignedProfileIds);
    const assignedProfilesByUser = new Map(
      assignedProfiles.flatMap((profile) => profile.userId == null || profile.user == null
        ? []
        : [[profile.userId, { id: profile.user.id, name: profile.user.name || profile.name }] as const]),
    );
    const queueItems = items.map((item) => {
      const { createdById: _createdById, lead: _lead, subscriber, ticket: _ticket, ...safeItem } = item;
      return {
        ...safeItem,
        ...(subscriberReadable && subscriber && 'id' in subscriber
          && typeof subscriber.id === 'number'
          && typeof subscriber.fullName === 'string'
          && typeof subscriber.username === 'string'
          ? { subscriber: { id: subscriber.id, fullName: subscriber.fullName, username: subscriber.username } }
          : {}),
        technician: item.assignedTo == null ? null : assignedProfilesByUser.get(item.assignedTo) ?? null,
      };
    });

    const workloadWhere: Prisma.FieldJobWhereInput = {
      AND: [
        this.dispatchVisibility(companyId, userIds),
        { assignedTo: { in: userIds }, status: { in: OPEN_STATUSES } },
      ],
    };
    const upcomingFrom = from > now ? from : now;
    const [openGroups, overdueGroups, upcomingGroups, completedGroups] = await Promise.all([
      this.prisma.fieldJob.groupBy({ by: ['assignedTo', 'status'], where: workloadWhere, _count: { _all: true } }),
      this.prisma.fieldJob.groupBy({
        by: ['assignedTo'],
        where: {
          AND: [
            workloadWhere,
            { OR: [{ appointmentEndsAt: { lt: now } }, { appointmentEndsAt: null, scheduledAt: { lt: now } }] },
          ],
        },
        _count: { _all: true },
      }),
      this.prisma.fieldJob.groupBy({
        by: ['assignedTo'],
        where: {
          AND: [
            workloadWhere,
            { scheduledAt: { gte: upcomingFrom, lt: toExclusive } },
          ],
        },
        _count: { _all: true },
      }),
      this.prisma.fieldJob.groupBy({
        by: ['assignedTo'],
        where: {
          AND: [
            this.dispatchVisibility(companyId, userIds),
            {
              assignedTo: { in: userIds },
              status: 'COMPLETED',
              completedAt: { gte: from, lt: toExclusive },
            },
          ],
        },
        _count: { _all: true },
      }),
    ]);
    const openByUser = new Map<number, number>();
    const inProgressByUser = new Map<number, number>();
    for (const row of openGroups) {
      if (row.assignedTo == null) continue;
      const count = row._count._all;
      openByUser.set(row.assignedTo, (openByUser.get(row.assignedTo) ?? 0) + count);
      if (row.status === 'IN_PROGRESS') inProgressByUser.set(row.assignedTo, count);
    }
    const overdueByUser = new Map(overdueGroups.flatMap((row) => row.assignedTo == null ? [] : [[row.assignedTo, row._count._all] as const]));
    const upcomingByUser = new Map(upcomingGroups.flatMap((row) => row.assignedTo == null ? [] : [[row.assignedTo, row._count._all] as const]));
    const completedByUser = new Map(completedGroups.flatMap((row) => row.assignedTo == null ? [] : [[row.assignedTo, row._count._all] as const]));
    const workloadEmployees = employees.filter((employee) => employee.userId != null &&
      (technicianId == null || employee.userId === technicianId)).map((employee) => ({
        id: employee.userId!,
        employeeId: employee.id,
        name: employee.user?.name || employee.name,
        designation: employee.designation,
        employeeStatus: employee.status,
        active: employee.status === 'ACTIVE' && employee.user?.isActive === true,
        open: openByUser.get(employee.userId!) ?? 0,
        inProgress: inProgressByUser.get(employee.userId!) ?? 0,
        overdue: overdueByUser.get(employee.userId!) ?? 0,
        upcomingScheduled: upcomingByUser.get(employee.userId!) ?? 0,
        completedInPeriod: completedByUser.get(employee.userId!) ?? 0,
        availability: 'NOT_RECORDED',
        skills: null,
      }));
    const byStatus: Record<string, number> = {};
    for (const group of statusGroups) byStatus[group.status] = group._count._all;
    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      periodBasis: 'JOB_CREATED_AT',
      items: queueItems,
      total,
      page,
      pageSize: take,
      metrics: {
        total,
        byStatus,
        unassigned,
        overdue,
        dueSoon,
      },
      technicians: workloadEmployees,
      technicianRosterLimited: employeeCount > employees.length,
      canFilterSubscribers: subscriberReadable,
      workloadPeriod: { from: from.toISOString(), to: to.toISOString() },
      unavailableInputs: {
        availability: 'No technician working-hours or availability schedule is recorded on EmployeeProfile.',
        skills: 'EmployeeProfile has no skill records; job requiredSkills cannot be matched to technicians.',
      },
    };
  }

  async dispatchJob(actor: Actor, id: number) {
    await this.requireAction(actor, 'field-jobs.dispatch');
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('Field job ID must be a positive integer.');
    const { companyId, userIds } = await this.companyUsers(actor);
    const subscriberReadable = await this.hasAction(actor, 'subscribers.read');
    const visible = this.dispatchVisibility(companyId, userIds);
    const job = await this.prisma.fieldJob.findFirst({
      where: { AND: [{ id }, visible] },
      select: {
        id: true,
        jobNo: true,
        type: true,
        status: true,
        priority: true,
        description: true,
        assignedTo: true,
        createdById: true,
        assignedAt: true,
        assignedById: true,
        scheduledAt: true,
        appointmentEndsAt: true,
        arrivedAt: true,
        requiredSkills: true,
        lead: { select: { companyId: true } },
        subscriber: { select: { userId: true, ...(subscriberReadable ? { id: true, fullName: true, username: true } : {}) } },
        ticket: { select: { subscriberId: true, subscriber: { select: { userId: true } } } },
      },
    });
    if (!job) throw new NotFoundException('Field job not found.');

    const jobCompanyId = await this.dispatchCompanyId(job);
    if (jobCompanyId == null || jobCompanyId !== companyId) {
      throw new NotFoundException('Field job not found.');
    }

    const {
      lead: _lead,
      subscriber,
      ticket: _ticket,
      createdById: _createdById,
      ...jobDetails
    } = job;
    const detailProfiles = await this.dispatchEligibleProfiles(
      jobCompanyId,
      userIds,
      [job.assignedTo, job.assignedById].filter((id): id is number => id != null),
    );
    const detailProfilesByUser = new Map(detailProfiles.flatMap((profile) =>
      profile.userId == null || profile.user == null ? [] : [[profile.userId, profile.user] as const],
    ));
    const employees = await this.prisma.employeeProfile.findMany({
      where: { companyId: jobCompanyId, status: 'ACTIVE', userId: { in: userIds }, user: { is: { isActive: true } } },
      select: {
        id: true,
        name: true,
        designation: true,
        userId: true,
        user: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
      take: 500,
    });
    const candidates = employees.flatMap((employee) => employee.userId == null || employee.user == null
      ? []
      : [{
          id: employee.userId,
          employeeId: employee.id,
          name: employee.user.name || employee.name,
          designation: employee.designation,
        }]);
    const candidateIds = candidates.map((candidate) => candidate.id);
    const recommendationWorkloadWhere: Prisma.FieldJobWhereInput = {
      AND: [visible, { assignedTo: { in: candidateIds } }],
    };
    const [openGroups, overdueGroups, sameTypeGroups, scheduledGroups, overlappingJobs, leaveRows, inventoryCount] = await Promise.all([
      this.prisma.fieldJob.groupBy({
        by: ['assignedTo'],
        where: { AND: [recommendationWorkloadWhere, { status: { in: OPEN_STATUSES } }] },
        _count: { _all: true },
      }),
      this.prisma.fieldJob.groupBy({
        by: ['assignedTo'],
        where: {
          AND: [
            recommendationWorkloadWhere,
            {
              status: { in: OPEN_STATUSES },
              OR: [{ appointmentEndsAt: { lt: new Date() } }, { appointmentEndsAt: null, scheduledAt: { lt: new Date() } }],
            },
          ],
        },
        _count: { _all: true },
      }),
      this.prisma.fieldJob.groupBy({
        by: ['assignedTo'],
        where: { AND: [recommendationWorkloadWhere, { status: 'COMPLETED', type: job.type }] },
        _count: { _all: true },
      }),
      this.prisma.fieldJob.groupBy({
        by: ['assignedTo'],
        where: {
          AND: [
            recommendationWorkloadWhere,
            { status: { in: OPEN_STATUSES }, scheduledAt: { gte: new Date() } },
          ],
        },
        _count: { _all: true },
      }),
      job.scheduledAt
        ? this.prisma.fieldJob.findMany({
            where: {
              AND: [
                recommendationWorkloadWhere,
                {
                  status: { in: OPEN_STATUSES },
                  id: { not: job.id },
                  scheduledAt: { lt: job.appointmentEndsAt ?? new Date(job.scheduledAt.getTime() + 60 * 60 * 1000) },
                  OR: [{ appointmentEndsAt: { gt: job.scheduledAt } }, { appointmentEndsAt: null }],
                },
              ],
            },
            select: { id: true, jobNo: true, assignedTo: true, scheduledAt: true, appointmentEndsAt: true },
            orderBy: { scheduledAt: 'asc' },
            take: 1000,
          })
        : Promise.resolve([]),
      job.scheduledAt
        ? this.prisma.employeeLeaveRequest.findMany({
            where: {
              companyId: jobCompanyId,
              employeeId: { in: employees.map((employee) => employee.id) },
              status: 'APPROVED',
              startDate: { lte: job.appointmentEndsAt ?? new Date(job.scheduledAt.getTime() + 60 * 60 * 1000) },
              endDate: { gte: job.scheduledAt },
            },
            select: { employeeId: true, leaveDates: true },
          })
        : Promise.resolve([]),
      this.prisma.inventoryItem.count({ where: { OR: [{ fieldJobId: job.id }, { reservedForFieldJobId: job.id }] } }),
    ]);
    const openByUser = new Map(openGroups.flatMap((row) => row.assignedTo == null ? [] : [[row.assignedTo, row._count._all] as const]));
    const overdueByUser = new Map(overdueGroups.flatMap((row) => row.assignedTo == null ? [] : [[row.assignedTo, row._count._all] as const]));
    const sameTypeByUser = new Map(sameTypeGroups.flatMap((row) => row.assignedTo == null ? [] : [[row.assignedTo, row._count._all] as const]));
    const scheduledByUser = new Map(scheduledGroups.flatMap((row) => row.assignedTo == null ? [] : [[row.assignedTo, row._count._all] as const]));
    const conflictsByUser = new Map<number, typeof overlappingJobs>();
    for (const conflict of overlappingJobs) {
      if (conflict.assignedTo == null) continue;
      conflictsByUser.set(conflict.assignedTo, [...(conflictsByUser.get(conflict.assignedTo) ?? []), conflict]);
    }
    const leaveDatesByEmployee = new Map<number, Set<number>>();
    for (const leave of leaveRows) {
      leaveDatesByEmployee.set(leave.employeeId, new Set(leave.leaveDates.map((date) =>
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
      )));
    }
    const startDay = job.scheduledAt ? Date.UTC(job.scheduledAt.getUTCFullYear(), job.scheduledAt.getUTCMonth(), job.scheduledAt.getUTCDate()) : null;
    const endDate = job.appointmentEndsAt ?? (job.scheduledAt ? new Date(job.scheduledAt.getTime() + 60 * 60 * 1000) : null);
    const endDay = endDate ? Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()) : null;
    const assignableStatus = !['COMPLETED', 'CANCELLED', 'IN_PROGRESS', 'PENDING_REVIEW'].includes(job.status) && !job.arrivedAt;
    const recommendations = candidates.map((candidate) => {
      const conflicts = conflictsByUser.get(candidate.id) ?? [];
      const leaveDays = leaveDatesByEmployee.get(candidate.employeeId) ?? new Set<number>();
      const hasApprovedLeave = startDay != null && endDay != null &&
        Array.from(leaveDays).some((day) => day >= startDay && day <= endDay);
      const changesAssignee = job.assignedTo !== candidate.id;
      const blockedByMaterials = changesAssignee && inventoryCount > 0;
      const suitable = assignableStatus && conflicts.length === 0 && !hasApprovedLeave && !blockedByMaterials;
      const open = openByUser.get(candidate.id) ?? 0;
      const overdue = overdueByUser.get(candidate.id) ?? 0;
      const sameTypeCompleted = sameTypeByUser.get(candidate.id) ?? 0;
      const scheduledCommitments = scheduledByUser.get(candidate.id) ?? 0;
      const reasons = [
        `Job priority: ${job.priority}. No configured priority-weighting policy exists, so priority is surfaced for dispatcher judgment rather than assigned an invented score.`,
        `Current open workload: ${open}.`,
        `Current overdue workload: ${overdue}.`,
        `Upcoming scheduled commitments: ${scheduledCommitments}.`,
        `Recorded completed jobs of this type: ${sameTypeCompleted}. This is historical experience, not a skills certification.`,
      ];
      if (job.scheduledAt) {
        reasons.push(conflicts.length ? `${conflicts.length} overlapping scheduled job(s) found.` : 'No overlapping scheduled job found.');
        if (hasApprovedLeave) reasons.push('Approved leave overlaps this appointment.');
      } else {
        reasons.push('Schedule compatibility not evaluated because this job has no start time.');
      }
      if (job.requiredSkills.length) reasons.push('Required-skill match unavailable; technician skills are not recorded.');
      else reasons.push('No required skills are recorded for this job.');
      if (blockedByMaterials) reasons.push('Reassignment is blocked until reserved/issued materials are resolved.');
      if (!assignableStatus) reasons.push('Current job status does not allow assignment or reassignment.');
      reasons.push('Working-hour availability is not recorded; attendance is not inferred.');
      return {
        ...candidate,
        suitable,
        open,
        overdue,
        scheduledCommitments,
        sameTypeCompleted,
        conflicts,
        availability: 'NOT_RECORDED',
        skillsMatch: null,
        reasons,
      };
    }).sort((left, right) =>
      Number(right.suitable) - Number(left.suitable) ||
      left.open - right.open ||
      left.overdue - right.overdue ||
      right.sameTypeCompleted - left.sameTypeCompleted ||
      left.name.localeCompare(right.name),
    );
    const historyPage = await this.dispatchHistoryPage(job.id, jobCompanyId, userIds);
    return {
      job: {
        ...jobDetails,
        assignedById: job.assignedById != null && detailProfilesByUser.has(job.assignedById) ? job.assignedById : null,
        technician: job.assignedTo == null ? null : detailProfilesByUser.get(job.assignedTo) ?? null,
        ...(subscriberReadable && subscriber && 'id' in subscriber
          && typeof subscriber.id === 'number'
          && typeof subscriber.fullName === 'string'
          && typeof subscriber.username === 'string'
          ? {
              subscriber: {
                id: subscriber.id,
                fullName: subscriber.fullName,
                username: subscriber.username,
              },
            }
          : {}),
      },
      ...historyPage,
      assignable: assignableStatus,
      inventoryBlocksReassignment: inventoryCount > 0,
      recommendations,
      conflictsTruncated: overlappingJobs.length === 1000,
      unavailableInputs: {
        availability: 'No technician working-hours or availability schedule is recorded on EmployeeProfile.',
        skills: 'Technician skills are not recorded; same-type completed job counts are historical only.',
        geographicProximity: 'Not calculated; no routing provider is configured and location is not used.',
      },
    };
  }

  async dispatchHistory(actor: Actor, id: number, cursorInput?: unknown) {
    await this.requireAction(actor, 'field-jobs.dispatch');
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException('Field job ID must be a positive integer.');
    const cursor = this.positiveId(cursorInput, 'History cursor');
    const { companyId, userIds } = await this.companyUsers(actor);
    const job = await this.prisma.fieldJob.findFirst({
      where: { AND: [{ id }, this.dispatchVisibility(companyId, userIds)] },
      select: {
        id: true,
        assignedTo: true,
        createdById: true,
        subscriber: { select: { userId: true } },
        ticket: { select: { subscriberId: true, subscriber: { select: { userId: true } } } },
        lead: { select: { companyId: true } },
      },
    });
    if (!job) throw new NotFoundException('Field job not found.');
    const jobCompanyId = await this.dispatchCompanyId(job);
    if (jobCompanyId == null || jobCompanyId !== companyId) {
      throw new NotFoundException('Field job not found.');
    }
    return this.dispatchHistoryPage(id, jobCompanyId, userIds, cursor ?? undefined);
  }

  async technicianPerformance(actor: Actor, days = 30) {
    await this.requireAction(actor, 'field-jobs.report');
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
      throw new BadRequestException('Performance window must be between 1 and 365 days.');
    }
    const where: Prisma.FieldJobWhereInput = {
      completedAt: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
      assignedTo: { not: null },
    };
    if (actor?.role !== 'SUPER_ADMIN') {
      const { companyId, userIds } = await this.companyUsers(actor);
      where.AND = [
        { assignedTo: { in: userIds } },
        {
          OR: [
            { subscriber: { is: { userId: { in: userIds } } } },
            { ticket: { is: { subscriber: { is: { userId: { in: userIds } } } } } },
            { lead: { is: { companyId } } },
            { createdById: { in: userIds } },
          ],
        },
      ];
    }
    const jobs = await this.prisma.fieldJob.findMany({
      where,
      select: {
        assignedTo: true,
        status: true,
        startedAt: true,
        completedAt: true,
        technician: { select: { id: true, name: true } },
      },
    });
    const grouped = new Map<number, { name: string; completed: number; failed: number; totalMinutes: number; timed: number }>();
    for (const job of jobs) {
      if (!job.assignedTo || !job.technician) continue;
      const row = grouped.get(job.assignedTo) ?? {
        name: job.technician.name,
        completed: 0,
        failed: 0,
        totalMinutes: 0,
        timed: 0,
      };
      if (job.status === 'COMPLETED') row.completed += 1;
      if (job.status === 'FAILED') row.failed += 1;
      if (job.startedAt && job.completedAt) {
        row.totalMinutes += Math.max(0, (job.completedAt.getTime() - job.startedAt.getTime()) / 60_000);
        row.timed += 1;
      }
      grouped.set(job.assignedTo, row);
    }
    return [...grouped.entries()].map(([technicianId, row]) => ({
      technicianId,
      name: row.name,
      completed: row.completed,
      failed: row.failed,
      averageMinutesOnSite: row.timed ? Math.round(row.totalMinutes / row.timed) : null,
    }));
  }

  async create(input: Input, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.write');
    const companyId = await this.companyId(actor);
    const description = this.text(input.description, 'Description', 5000, true)!;
    const type = String(input.type ?? 'INSTALLATION') as FieldJobType;
    const priority = String(input.priority ?? 'MEDIUM') as TicketPriority;
    if (!JOB_TYPES.includes(type)) throw new BadRequestException('Unknown field-job type.');
    if (!JOB_PRIORITIES.includes(priority)) throw new BadRequestException('Unknown field-job priority.');
    const links = await this.validateLinks(actor, companyId, input);
    const technicianId = this.positiveId(input.assignedTo ?? input.technicianId, 'Technician');
    if (technicianId != null) {
      await this.requireAction(actor, 'field-jobs.dispatch');
      await this.employeeForUser(companyId, technicianId);
    }
    const scheduledAt = this.date(input.scheduledAt, 'Schedule');
    const appointmentEndsAt = this.date(input.appointmentEndsAt, 'Appointment end');
    if (appointmentEndsAt && !scheduledAt) throw new BadRequestException('A start time is required with an appointment end.');
    if (appointmentEndsAt && scheduledAt && appointmentEndsAt <= scheduledAt) {
      throw new BadRequestException('Appointment end must be after its start.');
    }
    const address = this.text(input.address, 'Address', 500);
    const workInstructions = this.text(input.workInstructions, 'Work instructions', 5000);
    const skills = input.requiredSkills == null ? [] : input.requiredSkills;
    if (!Array.isArray(skills) || skills.length > 30 || skills.some((skill) => typeof skill !== 'string' || skill.length > 80)) {
      throw new BadRequestException('Required skills must be a list of up to 30 short text values.');
    }
    const latitude = input.latitude == null || input.latitude === '' ? null : Number(input.latitude);
    const longitude = input.longitude == null || input.longitude === '' ? null : Number(input.longitude);
    if (latitude != null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
      throw new BadRequestException('Latitude must be between -90 and 90.');
    }
    if (longitude != null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
      throw new BadRequestException('Longitude must be between -180 and 180.');
    }
    const actorUserId = this.actorId(actor);
    const createdAt = new Date();

    return this.prisma.$transaction(async (tx) => {
      if (technicianId && scheduledAt) {
        const employee = await tx.employeeProfile.findFirst({
          where: { companyId, userId: technicianId, status: 'ACTIVE' },
          select: { id: true },
        });
        if (!employee) throw new BadRequestException('Select an active employee in this company.');
        await this.assertScheduleAvailable(tx, companyId, employee.id, technicianId, scheduledAt, appointmentEndsAt);
      }
      const policy = await this.sla.snapshotPolicy(companyId, 'FIELD_JOB', priority, createdAt, tx);
      const slaResolutionDueAt = policy
        ? new Date(createdAt.getTime() + policy.resolutionTargetMinutes * 60_000)
        : null;
      const placeholder = `FJ-TMP-${randomUUID()}`;
      const created = await tx.fieldJob.create({
        data: {
          jobNo: placeholder,
          type,
          status: technicianId ? 'ASSIGNED' : 'PENDING',
          priority,
          ...links,
          assignedTo: technicianId,
          assignedById: technicianId ? actorUserId : null,
          assignedAt: technicianId ? new Date() : null,
          scheduledAt,
          appointmentEndsAt,
          address,
          latitude,
          longitude,
          description,
          workInstructions,
          requiredSkills: skills.map((skill) => (skill as string).trim()).filter(Boolean),
          createdById: actorUserId,
          createdAt,
          slaPolicyVersionId: policy?.id ?? null,
          slaResolutionDueAt,
          slaResolutionTargetMinutes: policy?.resolutionTargetMinutes ?? null,
          slaResolutionWarningMinutes: policy?.resolutionWarningMinutes ?? null,
          slaClockMode: policy?.clockMode ?? null,
        },
      });
      const jobNo = `FJ-${new Date().getFullYear()}-${String(created.id).padStart(6, '0')}`;
      await tx.fieldJob.update({ where: { id: created.id }, data: { jobNo } });
      await this.record(tx, created.id, actorUserId, 'CREATED', `Field job ${jobNo} created.`);
      if (technicianId) {
        await this.record(tx, created.id, actorUserId, 'ASSIGNED', `Assigned to technician #${technicianId}.`);
      }
      return tx.fieldJob.findUniqueOrThrow({ where: { id: created.id }, include: this.include() });
    }, { isolationLevel: 'Serializable' });
  }

  async fromTicket(ticketId: number, input: Input, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.write');
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, subscriberId: true, subject: true, description: true, status: true },
    });
    if (!ticket) throw new NotFoundException('Ticket not found.');
    await this.scope.assertSubscriber(actor, ticket.subscriberId);
    const existing = await this.prisma.fieldJob.findFirst({
      where: { ticketId, status: { in: OPEN_STATUSES } },
      select: { id: true, jobNo: true },
    });
    if (existing) throw new ConflictException(`Ticket already has an open field job (${existing.jobNo}).`);
    return this.create({
      ...input,
      ticketId,
      description: input.description ?? `${ticket.subject}\n\n${ticket.description}`,
    }, actor);
  }

  async update(id: number, input: Input, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.write');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    if (job.status === 'COMPLETED' || job.status === 'CANCELLED') {
      throw new ConflictException('Closed field jobs cannot be edited.');
    }
    const companyId = await this.companyId(actor);
    const data: Prisma.FieldJobUpdateInput = {};
    const linkFields = ['subscriberId', 'ticketId', 'leadId'] as const;
    if (linkFields.some((field) => field in input)) {
      if (await this.prisma.inventoryItem.count({ where: { fieldJobId: id } })) {
        throw new ConflictException('Resolve issued materials before changing the linked customer record.');
      }
      const selectedLinks = linkFields.filter((field) => input[field] != null && input[field] !== '');
      if (selectedLinks.length > 1) {
        throw new BadRequestException('A field job can link to one subscriber, ticket, or lead.');
      }
      const selectedField = selectedLinks[0];
      if (!selectedField) {
        Object.assign(data, { subscriberId: null, ticketId: null, leadId: null });
      } else {
        Object.assign(data, await this.validateLinks(actor, companyId, { [selectedField]: input[selectedField] }));
      }
    }
    if ('description' in input) data.description = this.text(input.description, 'Description', 5000, true)!;
    if ('type' in input) {
      const type = String(input.type) as FieldJobType;
      if (!JOB_TYPES.includes(type)) throw new BadRequestException('Unknown field-job type.');
      data.type = type;
    }
    if ('priority' in input) {
      const priority = String(input.priority) as TicketPriority;
      if (!JOB_PRIORITIES.includes(priority)) throw new BadRequestException('Unknown field-job priority.');
      data.priority = priority;
    }
    if ('address' in input) data.address = this.text(input.address, 'Address', 500);
    if ('workInstructions' in input) data.workInstructions = this.text(input.workInstructions, 'Work instructions', 5000);
    if ('latitude' in input) {
      const value = input.latitude == null || input.latitude === '' ? null : Number(input.latitude);
      if (value != null && (!Number.isFinite(value) || value < -90 || value > 90)) {
        throw new BadRequestException('Latitude must be between -90 and 90.');
      }
      data.latitude = value;
    }
    if ('longitude' in input) {
      const value = input.longitude == null || input.longitude === '' ? null : Number(input.longitude);
      if (value != null && (!Number.isFinite(value) || value < -180 || value > 180)) {
        throw new BadRequestException('Longitude must be between -180 and 180.');
      }
      data.longitude = value;
    }
    if ('requiredSkills' in input) {
      const skills = input.requiredSkills;
      if (!Array.isArray(skills) || skills.length > 30 || skills.some((skill) => typeof skill !== 'string' || skill.length > 80)) {
        throw new BadRequestException('Required skills must be a list of up to 30 short text values.');
      }
      data.requiredSkills = skills.map((skill) => (skill as string).trim()).filter(Boolean);
    }
    if (!Object.keys(data).length) throw new BadRequestException('No editable field-job details were provided.');
    const actorUserId = this.actorId(actor);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.fieldJob.updateMany({
        where: { id, updatedAt: job.updatedAt },
        data,
      });
      if (changed.count !== 1) throw new ConflictException('Field job changed while you were editing it. Reload and retry.');
      await this.record(tx, id, actorUserId, 'UPDATED', `Updated field job ${job.jobNo}.`);
    });
    return this.findOne(id, actor);
  }

  async assign(
    id: number,
    technicianIdValue: number,
    actor: Actor,
    scheduledAtInput?: string,
    appointmentEndsAtInput?: string,
    visitOrderInput?: number,
    reasonInput?: string,
    expectedAssignedToInput?: number | null,
  ) {
    await this.requireAction(actor, 'field-jobs.dispatch');
    const technicianId = this.positiveId(technicianIdValue, 'Technician');
    if (technicianId == null) throw new BadRequestException('A technician is required.');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    if (expectedAssignedToInput !== undefined) {
      const expectedAssignedTo = this.positiveId(expectedAssignedToInput, 'Expected technician');
      if (expectedAssignedTo !== job.assignedTo) {
        throw new ConflictException('The technician assignment changed. Reload the job before assigning it.');
      }
    }
    if (job.status === 'COMPLETED' || job.status === 'CANCELLED') {
      throw new ConflictException('Closed field jobs cannot be reassigned.');
    }
    const { companyId, userIds } = await this.companyUsers(actor);
    const jobCompanyId = await this.dispatchCompanyId(job);
    if (jobCompanyId == null || jobCompanyId !== companyId) {
      throw new NotFoundException('Field job not found.');
    }
    if (!userIds.includes(technicianId)) {
      throw new BadRequestException('Select a technician in this company.');
    }
    const technician = await this.employeeForUser(jobCompanyId, technicianId);
    const scheduledAt = scheduledAtInput === undefined ? job.scheduledAt : this.date(scheduledAtInput, 'Schedule');
    const appointmentEndsAt = appointmentEndsAtInput === undefined
      ? job.appointmentEndsAt
      : this.date(appointmentEndsAtInput, 'Appointment end');
    if (appointmentEndsAt && !scheduledAt) throw new BadRequestException('A start time is required with an appointment end.');
    if (appointmentEndsAt && scheduledAt && appointmentEndsAt <= scheduledAt) {
      throw new BadRequestException('Appointment end must be after its start.');
    }
    const visitOrder = visitOrderInput == null || visitOrderInput === 0 ? null : Number(visitOrderInput);
    if (visitOrder != null && (!Number.isSafeInteger(visitOrder) || visitOrder < 1 || visitOrder > 1000)) {
      throw new BadRequestException('Planned visit order must be between 1 and 1000.');
    }
    if (job.status === 'IN_PROGRESS' || job.status === 'PENDING_REVIEW' || job.arrivedAt) {
      throw new ConflictException('An active visit cannot be reassigned or rescheduled.');
    }
    const reassignmentReason = this.text(reasonInput, 'Reassignment reason', 500, job.assignedTo != null && job.assignedTo !== technicianId);
    const actorUserId = this.actorId(actor);
    await this.prisma.$transaction(async (tx) => {
      const currentJob = await tx.fieldJob.findUnique({
        where: { id },
        select: {
          assignedTo: true,
          createdById: true,
          lead: { select: { companyId: true } },
          subscriber: { select: { userId: true } },
          ticket: { select: { subscriberId: true, subscriber: { select: { userId: true } } } },
        },
      });
      if (!currentJob || (await this.dispatchCompanyId(currentJob)) !== jobCompanyId) {
        throw new ConflictException('Field job ownership changed during assignment. Reload and retry.');
      }
      const currentEmployee = await tx.employeeProfile.findFirst({
        where: {
          id: technician.id,
          companyId: jobCompanyId,
          userId: technicianId,
          status: 'ACTIVE',
          user: { is: { id: { in: userIds }, isActive: true } },
        },
        select: { id: true },
      });
      if (!currentEmployee) throw new ConflictException('Technician is no longer active in this company.');
      if (job.assignedTo !== technicianId && await tx.inventoryItem.count({
        where: { OR: [{ fieldJobId: id }, { reservedForFieldJobId: id }] },
      })) {
        throw new ConflictException('Release reserved materials and return or report issued materials before reassigning this job.');
      }
      await this.assertScheduleAvailable(
        tx,
        jobCompanyId,
        technician.id,
        technicianId,
        scheduledAt,
        appointmentEndsAt,
        id,
      );
      if (visitOrder != null && scheduledAt) {
        const dayStart = new Date(Date.UTC(scheduledAt.getUTCFullYear(), scheduledAt.getUTCMonth(), scheduledAt.getUTCDate()));
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        const orderConflict = await tx.fieldJob.findFirst({
          where: {
            assignedTo: technicianId,
            status: { in: OPEN_STATUSES },
            id: { not: id },
            visitOrder,
            scheduledAt: { gte: dayStart, lt: dayEnd },
          },
          select: { id: true, jobNo: true },
        });
        if (orderConflict) throw new ConflictException(`Visit order ${visitOrder} is already assigned that day (${orderConflict.jobNo}).`);
      }
      const changed = await tx.fieldJob.updateMany({
        where: { id, updatedAt: job.updatedAt, status: job.status, assignedTo: job.assignedTo },
        data: {
          assignedTo: technicianId,
          assignedById: actorUserId,
          assignedAt: new Date(),
          scheduledAt,
          appointmentEndsAt,
          status: job.status === 'PENDING' || job.status === 'FAILED' ? 'ASSIGNED' : job.status,
          ...(job.status === 'FAILED'
            ? {
                arrivedAt: null,
                startedAt: null,
                completedAt: null,
                completionNotes: null,
                failureReason: null,
                resolution: null,
                nextAction: null,
              }
            : {}),
        },
      });
      if (changed.count !== 1) throw new ConflictException('Field job changed during assignment. Reload and retry.');
      const reassigned = job.assignedTo != null && job.assignedTo !== technicianId;
      const assignmentDetail = reassigned
        ? `Reassigned from ${job.technician?.name ?? `technician #${job.assignedTo}`} to ${technician.name}. Reason: ${reassignmentReason}`
        : `Assigned to technician ${technician.name}.`;
      await this.record(tx, id, actorUserId, reassigned ? 'REASSIGNED' : 'ASSIGNED', assignmentDetail);
      if (scheduledAt?.getTime() !== job.scheduledAt?.getTime()) {
        await this.record(tx, id, actorUserId, 'SCHEDULED', `Appointment scheduled for ${scheduledAt?.toISOString() ?? 'unscheduled'}.`);
      }
      if (visitOrder !== job.visitOrder) {
        await this.record(tx, id, actorUserId, 'VISIT_ORDER_SET', `Planned technician visit order set to ${visitOrder ?? 'automatic'}.`);
      }
    }, { isolationLevel: 'Serializable' });
    return this.dispatchJobResponse(id, actor);
  }

  async unassign(id: number, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.dispatch');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    const { companyId } = await this.companyUsers(actor);
    const jobCompanyId = await this.dispatchCompanyId(job);
    if (jobCompanyId == null || jobCompanyId !== companyId) {
      throw new NotFoundException('Field job not found.');
    }
    if (job.status !== 'ASSIGNED' && job.status !== 'PENDING') {
      throw new ConflictException('Only a pending or assigned field job can be unassigned.');
    }
    const actorUserId = this.actorId(actor);
    await this.prisma.$transaction(async (tx) => {
      const currentJob = await tx.fieldJob.findUnique({
        where: { id },
        select: {
          assignedTo: true,
          createdById: true,
          lead: { select: { companyId: true } },
          subscriber: { select: { userId: true } },
          ticket: { select: { subscriberId: true, subscriber: { select: { userId: true } } } },
        },
      });
      if (!currentJob || (await this.dispatchCompanyId(currentJob)) !== jobCompanyId) {
        throw new ConflictException('Field job ownership changed while being unassigned.');
      }
      if (await tx.inventoryItem.count({
        where: { OR: [{ fieldJobId: id }, { reservedForFieldJobId: id }] },
      })) {
        throw new ConflictException('Release reserved or issued materials before unassigning this job.');
      }
      const changed = await tx.fieldJob.updateMany({
        where: { id, updatedAt: job.updatedAt, status: job.status, assignedTo: job.assignedTo },
        data: { assignedTo: null, assignedById: actorUserId, assignedAt: null, scheduledAt: null, appointmentEndsAt: null, visitOrder: null, status: 'PENDING' },
      });
      if (changed.count !== 1) throw new ConflictException('Field job changed while being unassigned.');
      await this.record(tx, id, actorUserId, 'UNASSIGNED', 'Technician assignment and schedule cleared.');
    });
    return this.dispatchJobResponse(id, actor);
  }

  private async assertAssignedTechnician(actor: Actor, job: VisibleJob) {
    if (job.assignedTo === this.actorId(actor)) return;
    if (await this.hasAction(actor, 'field-jobs.dispatch')) return;
    throw new ForbiddenException('Only the assigned technician may update this job.');
  }

  async arrive(id: number, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.technician');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    await this.assertAssignedTechnician(actor, job);
    if (job.status !== 'ASSIGNED' || job.arrivedAt) {
      throw new ConflictException('Arrival can only be recorded once for an assigned visit.');
    }
    const now = new Date();
    const actorUserId = this.actorId(actor);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.fieldJob.updateMany({
        where: { id, status: 'ASSIGNED', arrivedAt: null, updatedAt: job.updatedAt },
        data: { arrivedAt: now },
      });
      if (changed.count !== 1) throw new ConflictException('Field job changed before arrival could be recorded.');
      const lastVisit = await tx.fieldJobVisit.aggregate({ where: { fieldJobId: id }, _max: { visitNumber: true } });
      await tx.fieldJobVisit.create({
        data: { fieldJobId: id, technicianId: job.assignedTo, visitNumber: (lastVisit._max.visitNumber ?? 0) + 1, arrivedAt: now },
      });
      await this.record(tx, id, actorUserId, 'ARRIVED', 'Technician arrival recorded.');
    }, { isolationLevel: 'Serializable' });
    return this.findOne(id, actor);
  }

  async start(id: number, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.technician');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    await this.assertAssignedTechnician(actor, job);
    if (job.status !== 'ASSIGNED' || !job.arrivedAt) {
      throw new ConflictException('Record arrival before starting the job.');
    }
    const now = new Date();
    const actorUserId = this.actorId(actor);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.fieldJob.updateMany({
        where: { id, status: 'ASSIGNED', arrivedAt: job.arrivedAt, updatedAt: job.updatedAt },
        data: { status: 'IN_PROGRESS', startedAt: now },
      });
      if (changed.count !== 1) throw new ConflictException('Field job changed before work could be started.');
      await tx.fieldJobVisit.updateMany({
        where: { fieldJobId: id, technicianId: job.assignedTo, visitNumber: { equals: (job.visits[0]?.visitNumber ?? 1) } },
        data: { startedAt: now },
      });
      await this.record(tx, id, actorUserId, 'STARTED', 'Technician started work.');
    });
    return this.findOne(id, actor);
  }

  async complete(id: number, input: Input, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.technician');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    await this.assertAssignedTechnician(actor, job);
    if (job.status !== 'IN_PROGRESS') throw new ConflictException('Only work in progress can be completed.');
    const success = input.success !== false;
    const notes = this.text(input.notes, 'Work notes', 5000);
    const failureReason = this.text(input.failureReason, 'Failure reason', 1000, !success);
    if (!success && !failureReason) throw new BadRequestException('A reason is required for an unsuccessful visit.');
    const resolution = this.text(input.resolution, 'Resolution', 3000);
    const nextAction = this.text(input.nextAction, 'Next action', 2000);
    const customerConfirmed = input.customerConfirmed === true;
    if (input.photoUrls != null) throw new BadRequestException('Attach job photos through the private evidence workflow.');
    if (input.checklist !== undefined) this.validateChecklist(input.checklist);
    const now = new Date();
    const actorUserId = this.actorId(actor);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.fieldJob.updateMany({
        where: { id, status: 'IN_PROGRESS', updatedAt: job.updatedAt },
        data: {
          status: success ? 'PENDING_REVIEW' : 'FAILED',
          completedAt: now,
          completionNotes: notes,
          failureReason,
          checklist: input.checklist === undefined ? undefined : input.checklist as Prisma.InputJsonValue,
          customerConfirmedAt: customerConfirmed ? now : null,
          resolution,
          nextAction,
        },
      });
      if (changed.count !== 1) throw new ConflictException('Field job changed before completion could be recorded.');
      await tx.fieldJobVisit.updateMany({
        where: { fieldJobId: id, technicianId: job.assignedTo, completedAt: null },
        data: {
          completedAt: now,
          outcome: success ? 'SUCCESS' : 'FAILED',
          notes: notes ?? failureReason,
          nextAction,
        },
      });
      await this.record(
        tx,
        id,
        actorUserId,
        success ? 'COMPLETION_SUBMITTED' : 'VISIT_FAILED',
        success ? 'Technician submitted work for dispatcher review.' : `Visit failed: ${failureReason}`,
      );
    });
    return this.findOne(id, actor);
  }

  private validateChecklist(value: unknown) {
    if (value == null) return;
    if (typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
      throw new BadRequestException('Checklist must be a JSON object or list.');
    }
    const serialized = JSON.stringify(value);
    if (serialized.length > 20_000) throw new BadRequestException('Checklist data is too large.');
  }

  async updateChecklist(id: number, value: unknown, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.technician');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    await this.assertAssignedTechnician(actor, job);
    if (!['ASSIGNED', 'IN_PROGRESS'].includes(job.status)) throw new ConflictException('Checklist can only be updated on active work.');
    this.validateChecklist(value);
    const actorUserId = this.actorId(actor);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.fieldJob.updateMany({
        where: { id, updatedAt: job.updatedAt, status: job.status },
        data: { checklist: value == null ? Prisma.JsonNull : value as Prisma.InputJsonValue },
      });
      if (changed.count !== 1) throw new ConflictException('Field job changed while the checklist was being updated.');
      await this.record(tx, id, actorUserId, 'CHECKLIST_UPDATED', 'Technician checklist updated.');
    });
    return this.findOne(id, actor);
  }

  async reviewCompletion(id: number, approved: boolean, reason: string, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.review');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    if (job.status !== 'PENDING_REVIEW') throw new ConflictException('This field job is not awaiting review.');
    const reviewReason = this.text(reason, 'Review note', 1000, !approved);
    const actorUserId = this.actorId(actor);
    const reviewedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (approved) {
        await this.assertNoOutstandingMaterials(tx, id);
      }
      const changed = await tx.fieldJob.updateMany({
        where: { id, status: 'PENDING_REVIEW', updatedAt: job.updatedAt },
        data: {
          status: approved ? 'COMPLETED' : 'FAILED',
          resolution: approved ? (job.resolution ?? job.completionNotes) : job.resolution,
          failureReason: approved ? null : reviewReason,
          slaResolvedAt: approved ? reviewedAt : undefined,
        },
      });
      if (changed.count !== 1) throw new ConflictException('Field job review was changed by another operator.');
      if (approved && job.ticketId) {
        const linkedTicket = await tx.ticket.findUnique({
          where: { id: job.ticketId },
          select: { firstResolvedAt: true },
        });
        await tx.ticket.updateMany({
          where: { id: job.ticketId, status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } },
          data: {
            status: 'RESOLVED',
            resolution: job.resolution ?? job.completionNotes ?? 'Resolved through field service.',
            resolvedAt: reviewedAt,
            firstResolvedAt: linkedTicket?.firstResolvedAt ?? reviewedAt,
          },
        });
      }
      await this.record(
        tx,
        id,
        actorUserId,
        approved ? 'COMPLETION_APPROVED' : 'COMPLETION_REJECTED',
        approved ? 'Dispatcher approved completion.' : `Dispatcher rejected completion: ${reviewReason}`,
      );
    }, { isolationLevel: 'Serializable' });
    return this.findOne(id, actor);
  }

  private async assertNoOutstandingMaterials(tx: Prisma.TransactionClient, id: number) {
    const outstanding = await tx.inventoryItem.count({
      where: { OR: [{ fieldJobId: id }, { reservedForFieldJobId: id }] },
    });
    if (outstanding) {
      throw new ConflictException(
        'Resolve every reserved or issued material by releasing, consuming/installing, returning, or reporting it before closing this job.',
      );
    }
  }

  async requestAssistance(id: number, detail: string, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.technician');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    await this.assertAssignedTechnician(actor, job);
    if (!['ASSIGNED', 'IN_PROGRESS'].includes(job.status)) throw new ConflictException('Assistance can only be requested for active work.');
    const request = this.text(detail, 'Assistance request', 1000, true)!;
    const actorUserId = this.actorId(actor);
    await this.prisma.$transaction(async (tx) => {
      await this.record(tx, id, actorUserId, 'ASSISTANCE_REQUESTED', request);
    });
    return this.findOne(id, actor);
  }

  async cancel(id: number, reason: string, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.dispatch');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    const { companyId } = await this.companyUsers(actor);
    const jobCompanyId = await this.dispatchCompanyId(job);
    if (jobCompanyId == null || jobCompanyId !== companyId) {
      throw new NotFoundException('Field job not found.');
    }
    if (!['PENDING', 'ASSIGNED'].includes(job.status)) {
      throw new ConflictException('Only pending or assigned jobs can be cancelled.');
    }
    const cancellationReason = this.text(reason, 'Cancellation reason', 500, true)!;
    const actorUserId = this.actorId(actor);
    await this.prisma.$transaction(async (tx) => {
      const currentJob = await tx.fieldJob.findUnique({
        where: { id },
        select: {
          assignedTo: true,
          createdById: true,
          lead: { select: { companyId: true } },
          subscriber: { select: { userId: true } },
          ticket: { select: { subscriberId: true, subscriber: { select: { userId: true } } } },
        },
      });
      if (!currentJob || (await this.dispatchCompanyId(currentJob)) !== jobCompanyId) {
        throw new ConflictException('Field job ownership changed while it was being cancelled.');
      }
      if (await tx.inventoryItem.count({ where: { fieldJobId: id } })) {
        throw new ConflictException('Return or report every issued material before cancelling this job.');
      }
      const reservedItems = await tx.inventoryItem.findMany({
        where: { reservedForFieldJobId: id },
        select: { id: true, status: true, ownerId: true, serialNumber: true },
      });
      for (const item of reservedItems) {
        const released = await tx.inventoryItem.updateMany({
          where: { id: item.id, reservedForFieldJobId: id },
          data: { reservedForFieldJobId: null },
        });
        if (released.count !== 1) throw new ConflictException('A reserved item changed while cancelling this job.');
        const employee = job.assignedTo
          ? await tx.employeeProfile.findFirst({ where: { companyId, userId: job.assignedTo }, select: { id: true } })
          : null;
        await tx.inventoryMovement.create({
          data: {
            itemId: item.id,
            fromUserId: item.ownerId,
            toUserId: item.ownerId,
            fromStatus: item.status,
            toStatus: item.status,
            byUserId: actorUserId,
            fieldJobId: id,
            employeeId: employee?.id ?? null,
            movementType: 'RELEASE',
            idempotencyKey: `field-job-${id}-cancel-${item.id}-${randomUUID()}`,
            notes: `Reservation released after job cancellation: ${cancellationReason}`,
          },
        });
      }
      const changed = await tx.fieldJob.updateMany({
        where: { id, status: job.status, updatedAt: job.updatedAt },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason },
      });
      if (changed.count !== 1) throw new ConflictException('Field job changed while it was being cancelled.');
      await this.record(tx, id, actorUserId, 'CANCELLED', cancellationReason);
    }, { isolationLevel: 'Serializable' });
    return this.dispatchJobResponse(id, actor);
  }

  async materials(id: number, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.read');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    return this.inventory.fieldJobMovements(actor, id);
  }

  async moveMaterial(id: number, input: { itemId: number; action: string; idempotencyKey: string; notes?: string }, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.materials');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    return this.inventory.applyFieldJobMovement(actor, id, input);
  }

  async attachEvidence(id: number, input: Input, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.evidence');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    if (!['ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW'].includes(job.status)) {
      throw new ConflictException('Evidence can only be attached to active or review-pending work.');
    }
    const filename = typeof input.filename === 'string' ? input.filename.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(filename) || filename.includes('..')) {
      throw new BadRequestException('A valid uploaded filename is required.');
    }
    const evidenceType = typeof input.evidenceType === 'string' ? input.evidenceType.trim().toUpperCase() : '';
    const evidenceTypes = ['BEFORE_WORK', 'AFTER_WORK', 'INSTALLATION', 'REPAIR', 'EQUIPMENT', 'SERIAL_NUMBER', 'OTHER'];
    if (!evidenceTypes.includes(evidenceType)) throw new BadRequestException('Choose a supported evidence category.');
    const note = this.text(input.note, 'Evidence note', 500);
    const actorUserId = this.actorId(actor);
    const companyId = await this.companyId(actor);
    return this.prisma.$transaction(async (tx) => {
      const file = await tx.uploadedFile.findUnique({
        where: { filename },
        select: { filename: true, ownerId: true, uploadedBy: true, mimeType: true, size: true },
      });
      if (!file || file.uploadedBy !== actorUserId || file.ownerId !== companyId) {
        throw new NotFoundException('Uploaded evidence is not available for this company.');
      }
      if (!file.mimeType?.startsWith('image/') || !file.size || file.size > 8 * 1024 * 1024) {
        throw new BadRequestException('Field-job evidence must be an image no larger than 8 MB.');
      }
      if (await tx.fieldJobAttachment.count({ where: { fieldJobId: id } }) >= 50) {
        throw new ConflictException('This field job has reached the 50-image evidence limit.');
      }
      const attachment = await tx.fieldJobAttachment.create({
        data: { fieldJobId: id, filename, evidenceType, note, uploadedById: actorUserId },
        include: { uploader: { select: { id: true, name: true } } },
      });
      await this.record(tx, id, actorUserId, 'EVIDENCE_ADDED', `${evidenceType.replaceAll('_', ' ')} photo added${note ? `: ${note}` : '.'}`);
      return attachment;
    }, { isolationLevel: 'Serializable' });
  }

  async recordLocationCapture(id: number, phaseValue: string, input: Input, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.location');
    await this.requireAction(actor, 'field-jobs.technician');
    const phase = phaseValue.toUpperCase().replaceAll('-', '_');
    if (phase !== 'CHECK_IN' && phase !== 'CHECK_OUT') throw new BadRequestException('Location phase must be check-in or check-out.');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    await this.assertAssignedTechnician(actor, job);

    const status = typeof input.status === 'string' ? input.status.toUpperCase() : '';
    const allowedStatuses = ['GRANTED', 'DENIED', 'UNAVAILABLE', 'ERROR', 'NOT_REQUESTED'];
    if (!allowedStatuses.includes(status)) throw new BadRequestException('Provide the explicit location capture outcome.');
    const latitude = input.latitude == null ? null : Number(input.latitude);
    const longitude = input.longitude == null ? null : Number(input.longitude);
    const accuracy = input.accuracy == null ? null : Number(input.accuracy);
    if (status === 'GRANTED') {
      if (latitude == null || longitude == null ||
        !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new BadRequestException('A granted location capture requires valid coordinates.');
      }
      if (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100_000)) {
        throw new BadRequestException('Location accuracy must be between 0 and 100000 meters.');
      }
    } else if (latitude != null || longitude != null || accuracy != null) {
      throw new BadRequestException('Coordinates may only be sent for a granted location capture.');
    }

    const actorUserId = this.actorId(actor);
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      if (phase === 'CHECK_IN') {
        if (job.status !== 'ASSIGNED' || job.arrivedAt) {
          throw new ConflictException('Check-in is only available once for an assigned visit.');
        }
        const changed = await tx.fieldJob.updateMany({
          where: { id, status: 'ASSIGNED', arrivedAt: null, updatedAt: job.updatedAt },
          data: { arrivedAt: now },
        });
        if (changed.count !== 1) throw new ConflictException('Field job changed before check-in could be recorded.');
        const lastVisit = await tx.fieldJobVisit.aggregate({ where: { fieldJobId: id }, _max: { visitNumber: true } });
        const visit = await tx.fieldJobVisit.create({
          data: {
            fieldJobId: id,
            technicianId: job.assignedTo,
            visitNumber: (lastVisit._max.visitNumber ?? 0) + 1,
            arrivedAt: now,
            checkInLocationStatus: status,
            checkInLatitude: latitude,
            checkInLongitude: longitude,
            checkInAccuracy: accuracy,
            checkInCapturedAt: now,
          },
        });
        await this.record(tx, id, actorUserId, 'CHECK_IN_RECORDED', `Technician check-in recorded; location outcome: ${status}.`);
        return visit;
      }

      if (job.status !== 'IN_PROGRESS') throw new ConflictException('Check-out location can only be recorded while work is in progress.');
      const visit = await tx.fieldJobVisit.findFirst({
        where: { fieldJobId: id, technicianId: job.assignedTo, completedAt: null },
        orderBy: { visitNumber: 'desc' },
      });
      if (!visit || visit.checkOutLocationStatus) {
        throw new ConflictException('There is no open visit awaiting a check-out location capture.');
      }
      const changed = await tx.fieldJobVisit.updateMany({
        where: { id: visit.id, completedAt: null, checkOutLocationStatus: null },
        data: {
          checkOutLocationStatus: status,
          checkOutLatitude: latitude,
          checkOutLongitude: longitude,
          checkOutAccuracy: accuracy,
          checkOutCapturedAt: now,
        },
      });
      if (changed.count !== 1) throw new ConflictException('Visit changed before check-out location could be recorded.');
      await this.record(tx, id, actorUserId, 'CHECK_OUT_LOCATION_RECORDED', `Technician check-out location outcome: ${status}.`);
      return tx.fieldJobVisit.findUniqueOrThrow({ where: { id: visit.id } });
    }, { isolationLevel: 'Serializable' });
  }

  async remove(id: number, actor: Actor) {
    await this.requireAction(actor, 'field-jobs.delete');
    const job = await this.rawJob(id);
    await this.assertVisible(actor, job);
    if (job.status !== 'PENDING') throw new ConflictException('Only an unassigned pending job can be deleted.');
    const movementCount = await this.prisma.inventoryMovement.count({ where: { fieldJobId: id } });
    if (movementCount) throw new ConflictException('A job with inventory history cannot be deleted.');
    if (await this.prisma.fieldJobAttachment.count({ where: { fieldJobId: id } })) {
      throw new ConflictException('A job with photo evidence cannot be deleted.');
    }
    const actorUserId = this.actorId(actor);
    await this.prisma.$transaction(async (tx) => {
      await tx.fieldJob.delete({ where: { id } });
      await tx.activityLog.create({
        data: { userId: actorUserId, action: 'FIELD_JOB.DELETED', entity: 'FieldJob', entityId: id, details: `Deleted pending field job ${job.jobNo}.` },
      });
    });
    return { deleted: true, id };
  }
}
