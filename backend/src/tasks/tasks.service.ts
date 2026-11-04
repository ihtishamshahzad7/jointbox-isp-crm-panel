import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Actor, ScopeService } from '../common/scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isPrimaryInstance } from '../common/cluster-util';

const TASK_STATUSES = ['PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const LINK_FIELDS = ['subscriberId', 'leadId', 'ticketId', 'fieldJobId'] as const;
const MAX_TASK_REMINDER_ATTEMPTS = 3;

type TaskInput = Record<string, unknown>;

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly notifications: NotificationsService,
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
      throw new ForbiddenException('Tasks require a company account.');
    }
    const companyId = await this.scope.companyRootId(this.actorId(actor));
    if (!companyId) throw new ForbiddenException('A company scope is required.');
    return companyId;
  }

  private text(value: unknown, name: string, maximum: number, required = false) {
    if (value == null || value === '') {
      if (required) throw new BadRequestException(`${name} is required.`);
      return null;
    }
    if (typeof value !== 'string') throw new BadRequestException(`${name} must be text.`);
    const clean = value.trim();
    if (required && !clean) throw new BadRequestException(`${name} is required.`);
    if (clean.length > maximum) {
      throw new BadRequestException(`${name} must be ${maximum} characters or fewer.`);
    }
    return clean || null;
  }

  private id(value: unknown, name: string): number | null {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`${name} must be a positive integer.`);
    }
    return parsed;
  }

  private date(value: unknown, name: string): Date | null {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' && !(value instanceof Date)) {
      throw new BadRequestException(`${name} must be a valid date.`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${name} must be a valid date.`);
    return date;
  }

  private async canReadAll(actor: Actor): Promise<boolean> {
    if (actor?.role === 'ADMIN') return true;
    return this.hasAction(actor, 'tasks.readAll');
  }

  private async canManage(actor: Actor): Promise<boolean> {
    if (actor?.role === 'ADMIN') return true;
    // Managing company tasks requires both broad visibility and assignment authority.
    const [canReadAll, canAssign] = await Promise.all([
      this.canReadAll(actor),
      this.hasAction(actor, 'tasks.assign'),
    ]);
    return canReadAll && canAssign;
  }

  private async hasAction(actor: Actor, permission: string): Promise<boolean> {
    if (actor?.role === 'ADMIN') return true;
    const actorId = this.actorId(actor);
    const ancestors = await this.scope.ancestorIds(actorId);
    const denied = await this.prisma.userPermission.findFirst({
      where: { userId: { in: ancestors }, permission, allowed: false },
      select: { id: true },
    });
    if (denied) return false;
    return !!(await this.prisma.rolePermission.findFirst({
      where: { role: actor?.role ?? '', permission: { in: [permission, '*', 'tasks.*'] } },
      select: { id: true },
    }));
  }

  private async employeeForActor(companyId: number, actor: Actor) {
    return this.prisma.employeeProfile.findFirst({
      where: {
        companyId,
        userId: this.actorId(actor),
        status: 'ACTIVE',
      },
      select: { id: true },
    });
  }

  private async assertTaskAccess(actor: Actor, task: { companyId: number; assignedEmployeeId: number | null }) {
    const companyId = await this.companyId(actor);
    if (task.companyId !== companyId) throw new NotFoundException('Task not found.');
    if (await this.canReadAll(actor)) return;
    const employee = await this.employeeForActor(companyId, actor);
    if (!employee || task.assignedEmployeeId !== employee.id) {
      throw new NotFoundException('Task not found.');
    }
  }

  private include() {
    return {
      creator: { select: { id: true, name: true } },
      assignee: { select: { id: true, name: true, designation: true } },
      subscriber: { select: { id: true, fullName: true, username: true } },
      lead: { select: { id: true, name: true, stage: true } },
      ticket: { select: { id: true, ticketNo: true, subject: true, status: true } },
      fieldJob: { select: { id: true, jobNo: true, type: true, status: true } },
      activities: {
        orderBy: { createdAt: 'desc' as const },
        take: 100,
        include: { actor: { select: { id: true, name: true } } },
      },
    };
  }

  async options(actor: Actor) {
    const companyId = await this.companyId(actor);
    const [canCreate, canEdit, canComment, canStatus, canReport] = await Promise.all([
      this.hasAction(actor, 'tasks.create'),
      this.hasAction(actor, 'tasks.edit'),
      this.hasAction(actor, 'tasks.comment'),
      this.hasAction(actor, 'tasks.status'),
      this.hasAction(actor, 'tasks.report'),
    ]);
    const [canManage, canReadAll] = await Promise.all([
      this.canManage(actor),
      this.canReadAll(actor),
    ]);
    if (!canManage) {
      const employee = await this.employeeForActor(companyId, actor);
      return { canManage: false, canReadAll, canCreate, canEdit, canComment, canStatus, canReport, employees: employee ? await this.prisma.employeeProfile.findMany({
        where: { id: employee.id, companyId, status: 'ACTIVE' },
        select: { id: true, name: true, designation: true },
      }) : [] };
    }
    const employees = await this.prisma.employeeProfile.findMany({
      where: { companyId, status: 'ACTIVE' },
      select: { id: true, name: true, designation: true, department: true },
      orderBy: { name: 'asc' },
      take: 300,
    });
    return { canManage: true, canReadAll, canCreate, canEdit, canComment, canStatus, canReport, employees };
  }

  async list(actor: Actor, query: Record<string, unknown>) {
    const companyId = await this.companyId(actor);
    const canReadAll = await this.canReadAll(actor);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pageSize)) {
      throw new BadRequestException('Page values must be integers.');
    }
    const where: Prisma.TaskWhereInput = { companyId };
    if (!canReadAll) {
      const employee = await this.employeeForActor(companyId, actor);
      where.assignedEmployeeId = employee?.id ?? -1;
    } else if (query.assignedEmployeeId) {
      where.assignedEmployeeId = this.id(query.assignedEmployeeId, 'Assignee') ?? undefined;
    }
    if (query.status && query.status !== 'ALL') {
      if (!TASK_STATUSES.includes(String(query.status) as (typeof TASK_STATUSES)[number])) {
        throw new BadRequestException('Unknown task status.');
      }
      where.status = String(query.status) as (typeof TASK_STATUSES)[number];
    }
    if (query.priority && query.priority !== 'ALL') {
      if (!TASK_PRIORITIES.includes(String(query.priority) as (typeof TASK_PRIORITIES)[number])) {
        throw new BadRequestException('Unknown task priority.');
      }
      where.priority = String(query.priority) as (typeof TASK_PRIORITIES)[number];
    }
    const dueFrom = this.date(query.dueFrom, 'Due-from date');
    const dueTo = this.date(query.dueTo, 'Due-to date');
    if (dueFrom || dueTo) {
      where.dueAt = {
        ...(dueFrom ? { gte: dueFrom } : {}),
        ...(dueTo ? { lte: dueTo } : {}),
      };
    }
    const search = this.text(query.q, 'Search', 120);
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
      ];
    }
    const sort = String(query.sort ?? 'dueAt');
    const direction = query.direction === 'asc' ? 'asc' : 'desc';
    const orderBy: Prisma.TaskOrderByWithRelationInput =
      sort === 'createdAt' ? { createdAt: direction } :
      sort === 'priority' ? { priority: direction } :
      sort === 'title' ? { title: direction } :
      { dueAt: direction };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        include: this.include(),
        orderBy: [orderBy, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.task.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async summary(actor: Actor) {
    const companyId = await this.companyId(actor);
    const where: Prisma.TaskWhereInput = { companyId };
    const canReadAll = await this.canReadAll(actor);
    if (!canReadAll) {
      const employee = await this.employeeForActor(companyId, actor);
      where.assignedEmployeeId = employee?.id ?? -1;
    }
    const now = new Date();
    const [planned, inProgress, done, overdue, dueSoon, unassigned] = await Promise.all([
      this.prisma.task.count({ where: { ...where, status: 'PLANNED' } }),
      this.prisma.task.count({ where: { ...where, status: 'IN_PROGRESS' } }),
      this.prisma.task.count({ where: { ...where, status: 'DONE' } }),
      this.prisma.task.count({ where: { ...where, status: { in: ['PLANNED', 'IN_PROGRESS'] }, dueAt: { lt: now } } }),
      this.prisma.task.count({ where: { ...where, status: { in: ['PLANNED', 'IN_PROGRESS'] }, dueAt: { gte: now, lte: new Date(now.getTime() + 24 * 60 * 60 * 1000) } } }),
      canReadAll
        ? this.prisma.task.count({ where: { ...where, status: 'PLANNED', assignedEmployeeId: null } })
        : Promise.resolve(0),
    ]);
    return { planned, inProgress, done, overdue, dueSoon, unassigned };
  }

  async detail(actor: Actor, id: number) {
    const companyId = await this.companyId(actor);
    const task = await this.prisma.task.findFirst({
      where: { id, companyId },
      include: this.include(),
    });
    if (!task) throw new NotFoundException('Task not found.');
    await this.assertTaskAccess(actor, task);
    return task;
  }

  private async validateLinks(actor: Actor, companyId: number, input: TaskInput) {
    const linked = LINK_FIELDS
      .map((field) => [field, this.id(input[field], field)] as const)
      .filter((entry) => entry[1] !== null);
    if (linked.length > 1) {
      throw new BadRequestException('A task can be linked to only one subscriber, lead, ticket, or field job.');
    }
    const result: Record<string, number | null> = {
      subscriberId: null,
      leadId: null,
      ticketId: null,
      fieldJobId: null,
    };
    for (const [field, id] of linked) {
      if (id == null) continue;
      if (field === 'subscriberId') {
        await this.scope.assertSubscriber(actor, id);
      } else if (field === 'ticketId') {
        const ticket = await this.prisma.ticket.findUnique({
          where: { id },
          select: { subscriberId: true },
        });
        if (!ticket) throw new NotFoundException('Ticket not found.');
        await this.scope.assertSubscriber(actor, ticket.subscriberId);
      } else if (field === 'leadId') {
        const lead = await this.prisma.crmLead.findFirst({
          where: { id, companyId },
          select: { id: true },
        });
        if (!lead) throw new NotFoundException('Lead not found.');
      } else if (field === 'fieldJobId') {
        const job = await this.prisma.fieldJob.findUnique({
          where: { id },
          select: { id: true, subscriberId: true, assignedTo: true, createdById: true },
        });
        if (!job) throw new NotFoundException('Field job not found.');
        const visibleUsers = await this.scope.descendantIds(await this.scope.rootId(actor));
        if (
          !this.scope.isAdmin(actor?.role) &&
          !visibleUsers.includes(job.assignedTo ?? -1) &&
          !visibleUsers.includes(job.createdById ?? -1) &&
          (!job.subscriberId || !(await this.canSeeSubscriber(actor, job.subscriberId)))
        ) {
          throw new NotFoundException('Field job not found.');
        }
      }
      result[field] = id;
    }
    return result;
  }

  private async canSeeSubscriber(actor: Actor, subscriberId: number) {
    try {
      await this.scope.assertSubscriber(actor, subscriberId);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) return false;
      throw error;
    }
  }

  private async assertEmployee(companyId: number, value: unknown) {
    const employeeId = this.id(value, 'Assignee');
    if (employeeId == null) return null;
    const employee = await this.prisma.employeeProfile.findFirst({
      where: { id: employeeId, companyId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!employee) throw new BadRequestException('Select an active employee in this company.');
    return employee.id;
  }

  async create(actor: Actor, input: TaskInput) {
    const companyId = await this.companyId(actor);
    if (!(await this.hasAction(actor, 'tasks.create'))) {
      throw new ForbiddenException('Only a task manager may create tasks.');
    }
    const title = this.text(input.title, 'Title', 160, true)!;
    const description = this.text(input.description, 'Description', 10_000);
    const category = this.text(input.category, 'Category', 80);
    const priority = String(input.priority ?? 'NORMAL');
    if (!TASK_PRIORITIES.includes(priority as (typeof TASK_PRIORITIES)[number])) {
      throw new BadRequestException('Unknown task priority.');
    }
    const dueAt = this.date(input.dueAt, 'Due date');
    const reminderAt = this.date(input.reminderAt, 'Reminder time');
    const assignedEmployeeId = await this.assertEmployee(companyId, input.assignedEmployeeId);
    if (reminderAt && assignedEmployeeId == null) {
      throw new BadRequestException('Assign an employee before scheduling a reminder.');
    }
    if (!(await this.canManage(actor)) && assignedEmployeeId != null) {
      const ownEmployee = await this.employeeForActor(companyId, actor);
      if (assignedEmployeeId !== ownEmployee?.id) {
        throw new ForbiddenException('You may only assign a task to yourself.');
      }
    }
    const links = await this.validateLinks(actor, companyId, input);
    const actorUserId = this.actorId(actor);
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          companyId,
          createdById: actorUserId,
          assignedEmployeeId,
          title,
          description,
          category,
          priority: priority as (typeof TASK_PRIORITIES)[number],
          dueAt,
          reminderAt,
          ...links,
        },
      });
      await this.syncReminder(tx, { companyId, taskId: task.id, assignedEmployeeId, reminderAt });
      await tx.taskActivity.create({
        data: { companyId, taskId: task.id, actorUserId, type: 'CREATED', detail: 'Task created.' },
      });
      await tx.activityLog.create({
        data: { userId: actorUserId, action: 'TASK_CREATED', entity: 'Task', entityId: task.id, details: `Created task: ${title}` },
      });
      if (assignedEmployeeId) {
        await tx.taskActivity.create({
          data: { companyId, taskId: task.id, actorUserId, type: 'ASSIGNED', detail: `Assigned to employee #${assignedEmployeeId}.` },
        });
      }
      return tx.task.findUniqueOrThrow({ where: { id: task.id }, include: this.include() });
    });
  }

  async update(actor: Actor, id: number, input: TaskInput) {
    const task = await this.detail(actor, id);
    const manager = await this.canManage(actor);
    if (!manager) {
      if (Object.keys(input).some((key) => key !== 'description')) {
        throw new ForbiddenException('Employees may only update their task description.');
      }
    }
    if (task.status === 'DONE' || task.status === 'CANCELLED') {
      throw new ConflictException('Closed tasks cannot be edited.');
    }
    const companyId = await this.companyId(actor);
    const data: Prisma.TaskUpdateInput = {};
    if ('title' in input) data.title = this.text(input.title, 'Title', 160, true)!;
    if ('description' in input) data.description = this.text(input.description, 'Description', 10_000);
    if ('category' in input) data.category = this.text(input.category, 'Category', 80);
    if ('dueAt' in input) data.dueAt = this.date(input.dueAt, 'Due date');
    if ('reminderAt' in input) {
      const reminderAt = this.date(input.reminderAt, 'Reminder time');
      if (reminderAt && task.assignedEmployeeId == null) {
        throw new BadRequestException('Assign an employee before scheduling a reminder.');
      }
      data.reminderAt = reminderAt;
    }
    if ('priority' in input) {
      const priority = String(input.priority);
      if (!TASK_PRIORITIES.includes(priority as (typeof TASK_PRIORITIES)[number])) {
        throw new BadRequestException('Unknown task priority.');
      }
      data.priority = priority as (typeof TASK_PRIORITIES)[number];
    }
    if (LINK_FIELDS.some((field) => field in input)) {
      Object.assign(data, await this.validateLinks(actor, companyId, input));
    }
    const actorUserId = this.actorId(actor);
    return this.prisma.$transaction(async (tx) => {
      const update = await tx.task.updateMany({
        where: { id, companyId, updatedAt: task.updatedAt },
        data,
      });
      if (update.count !== 1) throw new ConflictException('Task changed while you were editing it. Reload and retry.');
      if ('reminderAt' in input) {
        await this.syncReminder(tx, {
          companyId,
          taskId: id,
          assignedEmployeeId: task.assignedEmployeeId,
          reminderAt: data.reminderAt instanceof Date ? data.reminderAt : null,
        });
      }
      await tx.taskActivity.create({
        data: { companyId, taskId: id, actorUserId, type: 'UPDATED', detail: 'Task details updated.' },
      });
      await tx.activityLog.create({
        data: { userId: actorUserId, action: 'TASK_UPDATED', entity: 'Task', entityId: id, details: `Updated task: ${task.title}` },
      });
      return tx.task.findFirstOrThrow({ where: { id, companyId }, include: this.include() });
    });
  }

  async assign(actor: Actor, id: number, input: TaskInput) {
    const task = await this.detail(actor, id);
    if (!(await this.canManage(actor))) throw new ForbiddenException('Only a task manager may assign tasks.');
    if (task.status === 'DONE' || task.status === 'CANCELLED') {
      throw new ConflictException('Closed tasks cannot be reassigned.');
    }
    const companyId = await this.companyId(actor);
    const assignedEmployeeId = await this.assertEmployee(companyId, input.assignedEmployeeId);
    const actorUserId = this.actorId(actor);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.task.updateMany({
        where: { id, companyId, updatedAt: task.updatedAt },
        data: { assignedEmployeeId },
      });
      if (updated.count !== 1) throw new ConflictException('Task changed while reassignment was being saved.');
      await this.syncReminder(tx, {
        companyId,
        taskId: id,
        assignedEmployeeId,
        reminderAt: task.reminderAt,
      });
      await tx.taskActivity.create({
        data: {
          companyId,
          taskId: id,
          actorUserId,
          type: 'ASSIGNED',
          detail: assignedEmployeeId == null ? 'Task unassigned.' : `Assigned to employee #${assignedEmployeeId}.`,
        },
      });
      await tx.activityLog.create({
        data: { userId: actorUserId, action: 'TASK_ASSIGNED', entity: 'Task', entityId: id, details: `Assignment changed for task: ${task.title}` },
      });
      return tx.task.findFirstOrThrow({ where: { id, companyId }, include: this.include() });
    });
  }

  async changeStatus(actor: Actor, id: number, input: TaskInput) {
    const task = await this.detail(actor, id);
    const manager = await this.canManage(actor);
    const employee = await this.employeeForActor(task.companyId, actor);
    if (!manager && task.assignedEmployeeId !== employee?.id) {
      throw new ForbiddenException('Only the assigned employee may update this task.');
    }
    const status = String(input.status);
    if (!TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])) {
      throw new BadRequestException('Unknown task status.');
    }
    const next = status as (typeof TASK_STATUSES)[number];
    const allowed = manager
      ? {
          PLANNED: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
          IN_PROGRESS: ['PLANNED', 'DONE', 'CANCELLED'],
          DONE: ['PLANNED'],
          CANCELLED: ['PLANNED'],
        }[task.status]
      : {
          PLANNED: ['IN_PROGRESS'],
          IN_PROGRESS: ['DONE'],
          DONE: [],
          CANCELLED: [],
        }[task.status];
    if (!allowed.includes(next)) throw new ConflictException(`Cannot move a ${task.status} task to ${next}.`);
    const detail = this.text(input.detail, 'Status note', 2_000);
    if (next === 'CANCELLED' && !detail) {
      throw new BadRequestException('A reason is required to cancel a task.');
    }
    const actorUserId = this.actorId(actor);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.task.updateMany({
        where: { id, companyId: task.companyId, updatedAt: task.updatedAt },
        data: { status: next, completedAt: next === 'DONE' ? new Date() : null },
      });
      if (updated.count !== 1) throw new ConflictException('Task changed while its status was being updated.');
      if (next === 'DONE' || next === 'CANCELLED') {
        await this.syncReminder(tx, {
          companyId: task.companyId,
          taskId: id,
          assignedEmployeeId: task.assignedEmployeeId,
          reminderAt: null,
        });
      } else if (task.reminderAt && task.assignedEmployeeId) {
        await this.syncReminder(tx, {
          companyId: task.companyId,
          taskId: id,
          assignedEmployeeId: task.assignedEmployeeId,
          reminderAt: task.reminderAt,
        });
      }
      await tx.taskActivity.create({
        data: { companyId: task.companyId, taskId: id, actorUserId, type: 'STATUS_CHANGED', detail: `${task.status} → ${next}${detail ? `: ${detail}` : ''}` },
      });
      await tx.activityLog.create({
        data: { userId: actorUserId, action: 'TASK_STATUS_CHANGED', entity: 'Task', entityId: id, details: `Task "${task.title}" changed to ${next}.` },
      });
      return tx.task.findFirstOrThrow({ where: { id, companyId: task.companyId }, include: this.include() });
    });
  }

  async comment(actor: Actor, id: number, input: TaskInput) {
    const task = await this.detail(actor, id);
    if (!(await this.hasAction(actor, 'tasks.comment'))) {
      throw new ForbiddenException('You may not comment on this task.');
    }
    const detail = this.text(input.detail, 'Comment', 4_000, true)!;
    const actorUserId = this.actorId(actor);
    await this.prisma.$transaction(async (tx) => {
      await tx.taskActivity.create({
        data: { companyId: task.companyId, taskId: id, actorUserId, type: 'COMMENT', detail },
      });
      await tx.activityLog.create({
        data: { userId: actorUserId, action: 'TASK_COMMENT', entity: 'Task', entityId: id, details: `Comment added to task "${task.title}".` },
      });
    });
    return this.detail(actor, id);
  }

  private async syncReminder(
    tx: Prisma.TransactionClient,
    input: { companyId: number; taskId: number; assignedEmployeeId: number | null; reminderAt: Date | null },
  ) {
    const activeStatuses = ['PENDING', 'FAILED', 'PROCESSING', 'QUEUED'];
    const obsoleteWhere = {
      taskId: input.taskId,
      companyId: input.companyId,
      status: { in: activeStatuses },
      ...(!input.reminderAt || !input.assignedEmployeeId
        ? {}
        : {
            OR: [
              { scheduledAt: { not: input.reminderAt } },
              { assignedEmployeeId: { not: input.assignedEmployeeId } },
            ],
          }),
    };
    const obsolete = await tx.taskReminder.findMany({
      where: obsoleteWhere,
      select: { id: true, messageId: true },
    });
    const queuedMessageIds = obsolete.flatMap((reminder) => reminder.messageId == null ? [] : [reminder.messageId]);
    if (queuedMessageIds.length) {
      await tx.message.updateMany({
        where: { id: { in: queuedMessageIds }, status: 'QUEUED' },
        data: { status: 'CANCELLED', error: 'Task reminder was cancelled or rescheduled.' },
      });
    }
    if (obsolete.length) {
      await tx.taskReminder.updateMany({
        where: { id: { in: obsolete.map((reminder) => reminder.id) }, status: { in: activeStatuses } },
        data: { status: 'CANCELLED', lockedUntil: null },
      });
    }
    if (!input.reminderAt || !input.assignedEmployeeId) return;
    const existing = await tx.taskReminder.findUnique({
      where: { taskId_scheduledAt: { taskId: input.taskId, scheduledAt: input.reminderAt } },
    });
    if (existing) {
      if (existing.status === 'DELIVERED') return;
      if (existing.status === 'CANCELLED') {
        await tx.taskReminder.update({
          where: { id: existing.id },
          data: {
            assignedEmployeeId: input.assignedEmployeeId,
            idempotencyKey: `task-reminder:${input.taskId}:${input.reminderAt.getTime()}:${input.assignedEmployeeId}:${randomUUID()}`,
            status: 'PENDING',
            attempts: 0,
            lockedUntil: null,
            messageId: null,
            deliveredAt: null,
            lastError: null,
          },
        });
      } else if (existing.assignedEmployeeId !== input.assignedEmployeeId) {
        await tx.message.updateMany({
          where: { id: existing.messageId ?? -1, status: 'QUEUED' },
          data: { status: 'CANCELLED', error: 'Task reminder was reassigned.' },
        });
        await tx.taskReminder.update({
          where: { id: existing.id },
          data: {
            assignedEmployeeId: input.assignedEmployeeId,
            idempotencyKey: `task-reminder:${input.taskId}:${input.reminderAt.getTime()}:${input.assignedEmployeeId}:${randomUUID()}`,
            status: 'PENDING',
            attempts: 0,
            lockedUntil: null,
            messageId: null,
            deliveredAt: null,
            lastError: null,
          },
        });
      } else if (existing.status === 'FAILED') {
        await tx.taskReminder.update({
          where: { id: existing.id },
          data: { status: 'PENDING', attempts: 0, lockedUntil: null, lastError: null },
        });
      }
      return;
    }
    await tx.taskReminder.create({
      data: {
        companyId: input.companyId,
        taskId: input.taskId,
        assignedEmployeeId: input.assignedEmployeeId,
        scheduledAt: input.reminderAt,
        idempotencyKey: `task-reminder:${input.taskId}:${input.reminderAt.getTime()}:${input.assignedEmployeeId}:${randomUUID()}`,
      },
    });
  }

  @Cron('* * * * *')
  async cronTaskReminders(): Promise<void> {
    if (!isPrimaryInstance()) return;
    const global = await this.prisma.productFeature.findUnique({
      where: { key: 'crm-advanced' },
      select: { enabled: true },
    });
    if (!global?.enabled) return;
    const now = new Date();
    const plans = await this.prisma.companyPlan.findMany({
      where: {
        planId: { not: null },
        features: { has: 'crm-advanced' },
        OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
      },
      select: { companyId: true },
    });
    const companyIds = [...new Set(plans.map((plan) => plan.companyId))];
    if (!companyIds.length) return;

    const due = await this.prisma.taskReminder.findMany({
      where: {
        companyId: { in: companyIds },
        scheduledAt: { lte: now },
        OR: [
          { status: 'PENDING', attempts: { lt: MAX_TASK_REMINDER_ATTEMPTS } },
          { status: 'FAILED', attempts: { lt: MAX_TASK_REMINDER_ATTEMPTS } },
          { status: 'PROCESSING', OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
          { status: 'QUEUED' },
        ],
      },
      include: {
        task: {
          select: {
            id: true,
            companyId: true,
            title: true,
            dueAt: true,
            reminderAt: true,
            assignedEmployeeId: true,
            status: true,
            assignee: {
              select: {
                id: true,
                name: true,
                status: true,
                userId: true,
                user: {
                  select: {
                    id: true,
                    name: true,
                    phone: true,
                    email: true,
                    isActive: true,
                    smsEnabled: true,
                    emailEnabled: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { scheduledAt: 'asc' },
      take: 100,
    });

    for (const reminder of due) {
      if (reminder.status === 'PROCESSING' && reminder.attempts >= MAX_TASK_REMINDER_ATTEMPTS) {
        const message = reminder.messageId == null
          ? await this.prisma.message.findUnique({
              where: { idempotencyKey: reminder.idempotencyKey },
              select: { id: true, status: true, sentAt: true, attempts: true, error: true },
            })
          : await this.prisma.message.findUnique({
              where: { id: reminder.messageId },
              select: { id: true, status: true, sentAt: true, attempts: true, error: true },
            });
        const staleClaim: Prisma.TaskReminderWhereInput = {
          id: reminder.id,
          status: 'PROCESSING',
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        };
        if (message?.status === 'SENT') {
          await this.prisma.taskReminder.updateMany({
            where: staleClaim,
            data: { status: 'DELIVERED', messageId: message.id, deliveredAt: message.sentAt ?? now, lockedUntil: null },
          });
        } else if (message?.status === 'SIMULATED') {
          await this.prisma.taskReminder.updateMany({
            where: staleClaim,
            data: {
              status: 'SIMULATED',
              messageId: message.id,
              deliveredAt: null,
              lockedUntil: null,
              lastError: 'No external notification gateway was configured; no delivery was confirmed.',
            },
          });
        } else if (message?.status === 'CANCELLED') {
          await this.prisma.taskReminder.updateMany({
            where: staleClaim,
            data: { status: 'CANCELLED', messageId: message.id, lockedUntil: null },
          });
        } else if (message && ['QUEUED', 'SENDING'].includes(message.status)) {
          await this.prisma.taskReminder.updateMany({
            where: staleClaim,
            data: { status: 'QUEUED', messageId: message.id, deliveredAt: null, lockedUntil: null },
          });
        } else {
          await this.prisma.taskReminder.updateMany({
            where: staleClaim,
            data: {
              status: 'FAILED_FINAL',
              messageId: message?.id ?? reminder.messageId,
              lockedUntil: null,
              lastError: message?.status === 'UNKNOWN'
                ? 'Notification outcome is unknown after a stale sending claim; automatic retry was stopped to avoid duplicate delivery.'
                : message?.error || 'The bounded reminder retry limit was reached.',
            },
          });
        }
        continue;
      }

      if (reminder.status === 'QUEUED') {
        const message = reminder.messageId == null
          ? null
          : await this.prisma.message.findUnique({
              where: { id: reminder.messageId },
              select: { status: true, sentAt: true, attempts: true, error: true },
            });
        if (!message) {
          await this.prisma.taskReminder.updateMany({
            where: { id: reminder.id, status: 'QUEUED', messageId: reminder.messageId },
            data: { status: 'FAILED_FINAL', lockedUntil: null, lastError: 'The queued notification record was not found.' },
          });
          continue;
        }
        if (message.status === 'SENT') {
          await this.prisma.taskReminder.updateMany({
            where: { id: reminder.id, status: 'QUEUED', messageId: reminder.messageId },
            data: { status: 'DELIVERED', deliveredAt: message.sentAt ?? now, lockedUntil: null },
          });
          continue;
        }
        if (message.status === 'SIMULATED') {
          await this.prisma.taskReminder.updateMany({
            where: { id: reminder.id, status: 'QUEUED', messageId: reminder.messageId },
            data: {
              status: 'SIMULATED',
              deliveredAt: null,
              lockedUntil: null,
              lastError: 'No external notification gateway was configured; no delivery was confirmed.',
            },
          });
          continue;
        }
        if (message?.status === 'CANCELLED') {
          await this.prisma.taskReminder.updateMany({
            where: { id: reminder.id, status: 'QUEUED', messageId: reminder.messageId },
            data: { status: 'CANCELLED', lockedUntil: null },
          });
          continue;
        }
        if (
          message.status === 'UNKNOWN' ||
          message.status === 'FAILED_FINAL' ||
          (message.status === 'FAILED' && message.attempts >= MAX_TASK_REMINDER_ATTEMPTS) ||
          reminder.attempts >= MAX_TASK_REMINDER_ATTEMPTS
        ) {
          await this.prisma.taskReminder.updateMany({
            where: { id: reminder.id, status: 'QUEUED', messageId: reminder.messageId },
            data: {
              status: 'FAILED_FINAL',
              lockedUntil: null,
              lastError: message.status === 'UNKNOWN'
                ? 'Notification outcome is unknown after a stale sending claim; automatic retry was stopped to avoid duplicate delivery.'
                : message.error || 'The bounded notification retry limit was reached.',
            },
          });
          continue;
        }
        if (message?.status !== 'FAILED') continue;
      }
      const claimed = await this.prisma.taskReminder.updateMany({
        where: reminder.status === 'QUEUED'
          ? { id: reminder.id, status: 'QUEUED', messageId: reminder.messageId }
          : {
              id: reminder.id,
              OR: [
                { status: 'PENDING', attempts: { lt: MAX_TASK_REMINDER_ATTEMPTS } },
                { status: 'FAILED', attempts: { lt: MAX_TASK_REMINDER_ATTEMPTS } },
                {
                  status: 'PROCESSING',
                  attempts: { lt: MAX_TASK_REMINDER_ATTEMPTS },
                  OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
                },
              ],
            },
        data: {
          status: 'PROCESSING',
          attempts: { increment: 1 },
          lockedUntil: new Date(now.getTime() + 5 * 60 * 1000),
        },
      });
      if (claimed.count !== 1) continue;

      const task = await this.prisma.task.findFirst({
        where: { id: reminder.taskId, companyId: reminder.companyId },
        select: {
          id: true,
          companyId: true,
          title: true,
          dueAt: true,
          reminderAt: true,
          assignedEmployeeId: true,
          status: true,
          assignee: {
            select: {
              id: true,
              name: true,
              status: true,
              userId: true,
              user: {
                select: {
                  id: true,
                  name: true,
                  phone: true,
                  email: true,
                  isActive: true,
                  smsEnabled: true,
                  emailEnabled: true,
                },
              },
            },
          },
        },
      });
      if (!task) {
        await this.prisma.taskReminder.updateMany({
          where: { id: reminder.id, status: 'PROCESSING' },
          data: { status: 'CANCELLED', lockedUntil: null },
        });
        continue;
      }
      const employee = task.assignee;
      if (
        !employee ||
        employee.status !== 'ACTIVE' ||
        !employee.user?.isActive ||
        task.status === 'DONE' ||
        task.status === 'CANCELLED' ||
        task.assignedEmployeeId !== reminder.assignedEmployeeId ||
        task.reminderAt?.getTime() !== reminder.scheduledAt.getTime()
      ) {
        await this.prisma.taskReminder.updateMany({
          where: { id: reminder.id, status: 'PROCESSING' },
          data: { status: 'CANCELLED', lockedUntil: null },
        });
        continue;
      }

      const user = employee.user;
      const channel: 'SMS' | 'EMAIL' | null =
        user.smsEnabled && user.phone ? 'SMS' : user.emailEnabled && user.email ? 'EMAIL' : null;
      const recipient = channel === 'SMS' ? user.phone : channel === 'EMAIL' ? user.email : null;
      if (!channel || !recipient) {
        await this.prisma.taskReminder.updateMany({
          where: { id: reminder.id, status: 'PROCESSING' },
          data: {
            status: reminder.attempts + 1 >= MAX_TASK_REMINDER_ATTEMPTS ? 'FAILED_FINAL' : 'FAILED',
            lockedUntil: null,
            lastError: 'The assigned employee has no enabled notification channel with contact details.',
          },
        });
        this.logger.warn(`Task reminder ${reminder.id} cannot be delivered because the assigned employee has no eligible contact channel.`);
        continue;
      }

      try {
        const message = await this.notifications.send({
          channel,
          recipient,
          subject: `Task reminder: ${task.title}`,
          body: `Reminder: "${task.title}" is due${task.dueAt ? ` at ${task.dueAt.toISOString()} (UTC)` : ''}.`,
          event: 'TASK_REMINDER',
          createdBy: user.id,
          idempotencyKey: reminder.idempotencyKey,
        });
        await this.prisma.$transaction(async (tx) => {
          await tx.taskReminder.updateMany({
            where: { id: reminder.id, status: 'PROCESSING' },
            data: {
              status: 'QUEUED',
              lockedUntil: null,
              messageId: message.id,
              deliveredAt: null,
              lastError: null,
            },
          });
          await tx.activityLog.create({
            data: {
              userId: user.id,
              action: 'TASK_REMINDER_QUEUED',
              entity: 'Task',
              entityId: task.id,
              details: `Task reminder queued for "${task.title}".`,
            },
          });
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 500) : 'Notification queue failed.';
        await this.prisma.taskReminder.updateMany({
          where: { id: reminder.id, status: 'PROCESSING' },
          data: {
            status: reminder.attempts + 1 >= MAX_TASK_REMINDER_ATTEMPTS ? 'FAILED_FINAL' : 'FAILED',
            lockedUntil: null,
            lastError: detail,
          },
        });
        this.logger.error(`Task reminder ${reminder.id} failed to queue: ${detail}`);
      }
    }
  }
}
