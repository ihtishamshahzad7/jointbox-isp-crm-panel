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
import { randomBytes } from 'node:crypto';
import { isPrimaryInstance } from '../common/cluster-util';
import { ProductEntitlementService } from '../common/product-entitlement.service';
import {
  DEMO_SUBSCRIBER_EMAIL_SUFFIX,
  ScopeService,
  type Actor,
} from '../common/scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscribersService } from '../subscribers/subscribers.service';

const LEAD_STAGES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'FOLLOW_UP',
  'INTERESTED',
  'WON',
  'LOST',
] as const;
const LEAD_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const ACTIVITY_TYPES = ['NOTE', 'CALL', 'EMAIL', 'MEETING', 'FOLLOW_UP'] as const;
const MAX_PAGE_SIZE = 100;

type LeadStage = (typeof LEAD_STAGES)[number];
type LeadPriority = (typeof LEAD_PRIORITIES)[number];
type ActivityType = (typeof ACTIVITY_TYPES)[number];
type LeadInput = Record<string, unknown>;

type LeadForMatching = {
  id: number;
  companyId: number;
  name: string;
  phone: string;
  phoneNormalized: string;
  email: string | null;
  emailNormalized: string | null;
  address: string | null;
  packageId: number | null;
  assignedEmployeeId: number | null;
  stage: LeadStage;
  convertedSubscriberId: number | null;
  conversionType: string | null;
  convertedAt: Date | null;
  archivedAt: Date | null;
};

type SubscriberMatch = {
  id: number;
  fullName: string;
  phone: string;
  email: string | null;
  username: string;
  status: string;
  phoneSuffix: string;
  normalizedEmail: string | null;
};

@Injectable()
export class CrmLeadsService {
  private readonly logger = new Logger(CrmLeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly entitlements: ProductEntitlementService,
    private readonly subscribers: SubscribersService,
  ) {}

  private async companyId(actor: Actor): Promise<number> {
    if (!actor || actor.role === 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Sign in as a company account to access CRM leads.',
      );
    }
    return (await this.entitlements.assertEnabled(actor, 'crm-advanced')).companyId;
  }

  private actorId(actor: Actor): number {
    const id = this.scope.actorId(actor);
    if (!id) throw new ForbiddenException('Your account has no user identity.');
    return id;
  }

  private text(
    value: unknown,
    field: string,
    maximum: number,
    required = false,
  ): string | null {
    if (value == null || value === '') {
      if (required) throw new BadRequestException(`${field} is required.`);
      return null;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be text.`);
    }
    const clean = value.trim();
    if (!clean && required) {
      throw new BadRequestException(`${field} is required.`);
    }
    if (clean.length > maximum) {
      throw new BadRequestException(
        `${field} must be ${maximum} characters or fewer.`,
      );
    }
    return clean || null;
  }

  private positiveId(value: unknown, field: string): number | null {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`${field} must be a positive integer.`);
    }
    return parsed;
  }

  private phone(value: unknown): { display: string; normalized: string } {
    const display = this.text(value, 'Phone', 40, true)!;
    const normalized = display.replace(/\D/g, '');
    if (normalized.length < 7 || normalized.length > 15) {
      throw new BadRequestException(
        'Phone must contain between 7 and 15 digits.',
      );
    }
    return { display, normalized };
  }

  private email(value: unknown): { display: string | null; normalized: string | null } {
    const display = this.text(value, 'Email', 254);
    if (!display) return { display: null, normalized: null };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(display)) {
      throw new BadRequestException('Enter a valid email address.');
    }
    return { display, normalized: display.toLowerCase() };
  }

  private date(value: unknown, field: string): Date | null {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a date string.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) {
      throw new BadRequestException(`${field} must be a valid ISO date.`);
    }
    const calendarDate = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
    if (
      Number.isNaN(calendarDate.getTime()) ||
      calendarDate.toISOString().slice(0, 10) !== value.slice(0, 10)
    ) {
      throw new BadRequestException(`${field} must be a valid calendar date.`);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} must be a valid date.`);
    }
    return parsed;
  }

  private inputData(input: LeadInput, creating: boolean) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('Lead must be an object.');
    }
    const data: Record<string, unknown> = {};
    if (creating || input.name !== undefined) {
      data.name = this.text(input.name, 'Name', 120, true)!;
    }
    if (creating || input.phone !== undefined) {
      const phone = this.phone(input.phone);
      data.phone = phone.display;
      data.phoneNormalized = phone.normalized;
    }
    if (creating || input.email !== undefined) {
      const email = this.email(input.email);
      data.email = email.display;
      data.emailNormalized = email.normalized;
    }
    const optionalTextFields: Array<[string, string, number]> = [
      ['address', 'Address', 500],
      ['serviceArea', 'Service area', 120],
      ['source', 'Lead source', 80],
      ['channel', 'Acquisition channel', 80],
      ['notes', 'Notes', 5000],
    ];
    for (const [key, label, maximum] of optionalTextFields) {
      if (creating || input[key] !== undefined) {
        data[key] = this.text(input[key], label, maximum);
      }
    }
    if (creating || input.estimatedMonthlyValue !== undefined) {
      if (
        input.estimatedMonthlyValue == null ||
        input.estimatedMonthlyValue === ''
      ) {
        data.estimatedMonthlyValue = null;
      } else {
        const amount = Number(input.estimatedMonthlyValue);
        if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
          throw new BadRequestException(
            'Estimated monthly value must be between 0 and 1,000,000,000.',
          );
        }
        data.estimatedMonthlyValue = new Prisma.Decimal(amount.toFixed(2));
      }
    }
    if (creating || input.priority !== undefined) {
      const priority = String(input.priority ?? 'NORMAL').toUpperCase();
      if (!LEAD_PRIORITIES.includes(priority as LeadPriority)) {
        throw new BadRequestException('Select a valid lead priority.');
      }
      data.priority = priority;
    }
    if (creating || input.packageId !== undefined) {
      data.packageId = this.positiveId(input.packageId, 'Package');
    }
    if (creating || input.assignedEmployeeId !== undefined) {
      data.assignedEmployeeId = this.positiveId(
        input.assignedEmployeeId,
        'Assigned employee',
      );
    }
    if (creating || input.followUpAt !== undefined) {
      data.followUpAt = this.date(input.followUpAt, 'Follow-up date');
      data.followUpRemindedAt = null;
    }
    return data;
  }

  private async assertReferences(
    actor: Actor,
    companyId: number,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (typeof data.packageId === 'number') {
      const packageWhere = await this.scope.packageWhere(actor);
      const availablePackage = await this.prisma.package.findFirst({
        where: {
          id: data.packageId,
          isActive: true,
          ...packageWhere,
        },
        select: { id: true },
      });
      if (!availablePackage) {
        throw new BadRequestException(
          'Choose an active package available to this account.',
        );
      }
      await this.subscribers.assertRefsInScope(actor, {
        packageId: data.packageId,
      });
    }
    if (typeof data.assignedEmployeeId === 'number') {
      const employee = await this.prisma.employeeProfile.findFirst({
        where: {
          id: data.assignedEmployeeId,
          companyId,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      if (!employee) {
        throw new BadRequestException(
          'Choose an active employee in this company.',
        );
      }
    }
  }

  private async assertAction(actor: Actor, permission: string): Promise<void> {
    if (!actor?.role) {
      throw new ForbiddenException('An operator role is required.');
    }
    const actorId = this.actorId(actor);
    const ancestors = await this.scope.ancestorIds(actorId);
    const denial = await this.prisma.userPermission.findFirst({
      where: {
        userId: { in: ancestors },
        permission,
        allowed: false,
      },
      select: { id: true },
    });
    if (denial) {
      throw new ForbiddenException(`Missing permission: ${permission}`);
    }
    const grants = await this.prisma.rolePermission.findMany({
      where: { role: actor.role },
      select: { permission: true },
    });
    const resource = permission.split('.')[0];
    const impliedRead =
      permission.endsWith('.read') &&
      grants.some((grant) => grant.permission === `${resource}.write`);
    if (
      !grants.some(
        (grant) =>
          grant.permission === '*' ||
          grant.permission === `${resource}.*` ||
          grant.permission === permission,
      ) &&
      !impliedRead
    ) {
      throw new ForbiddenException(`Missing permission: ${permission}`);
    }
  }

  private async event(
    tx: Prisma.TransactionClient,
    actor: Actor,
    companyId: number,
    leadId: number,
    type: 'NOTE' | 'CALL' | 'EMAIL' | 'MEETING' | 'FOLLOW_UP' | 'STATUS_CHANGE' | 'ASSIGNMENT' | 'CONVERSION',
    detail: string,
    stages: { from?: LeadStage; to?: LeadStage } = {},
  ): Promise<void> {
    const actorUserId = this.actorId(actor);
    await tx.crmLeadActivity.create({
      data: {
        companyId,
        leadId,
        actorUserId,
        type,
        detail,
        fromStage: stages.from,
        toStage: stages.to,
      },
    });
    await tx.activityLog.create({
      data: {
        userId: actorUserId,
        action: `CRM_LEAD_${type}`,
        entity: 'CrmLead',
        entityId: leadId,
        details: `Lead #${leadId}: ${type.toLowerCase()} activity recorded.`,
      },
    });
  }

  private async lead(
    companyId: number,
    id: number,
    includeActivities = false,
  ) {
    const result = await this.prisma.crmLead.findFirst({
      where: { id, companyId },
      include: {
        package: { select: { id: true, name: true, price: true } },
        assignedEmployee: {
          select: { id: true, name: true, department: true, designation: true },
        },
        convertedSubscriber: {
          select: { id: true, fullName: true, status: true },
        },
        ...(includeActivities
          ? {
              activities: {
                orderBy: { createdAt: 'desc' as const },
                include: { actor: { select: { id: true, name: true } } },
              },
            }
          : {}),
      },
    });
    if (!result) throw new NotFoundException('Lead not found.');
    return result;
  }

  private listWhere(companyId: number, query: Record<string, unknown>) {
    const where: Prisma.CrmLeadWhereInput = {
      companyId,
      archivedAt: query.archived === 'true' ? { not: null } : null,
    };
    if (typeof query.search === 'string' && query.search.trim()) {
      const search = query.search.trim().slice(0, 120);
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
        { address: { contains: search, mode: 'insensitive' } },
        { serviceArea: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (typeof query.stage === 'string' && query.stage.trim()) {
      const stage = query.stage.toUpperCase();
      if (!LEAD_STAGES.includes(stage as LeadStage)) {
        throw new BadRequestException('Select a valid pipeline stage filter.');
      }
      where.stage = stage as LeadStage;
    }
    if (typeof query.priority === 'string' && query.priority.trim()) {
      const priority = query.priority.toUpperCase();
      if (!LEAD_PRIORITIES.includes(priority as LeadPriority)) {
        throw new BadRequestException('Select a valid priority filter.');
      }
      where.priority = priority as LeadPriority;
    }
    const assignedEmployeeId = this.positiveId(
      query.assignedEmployeeId,
      'Assigned employee',
    );
    if (assignedEmployeeId != null) where.assignedEmployeeId = assignedEmployeeId;
    if (typeof query.source === 'string' && query.source.trim()) {
      where.source = query.source.trim().slice(0, 80);
    }
    if (typeof query.channel === 'string' && query.channel.trim()) {
      where.channel = query.channel.trim().slice(0, 80);
    }
    if (typeof query.from === 'string' || typeof query.to === 'string') {
      const createdAt: Prisma.DateTimeFilter = {};
      let fromValue: Date | null = null;
      let toValue: Date | null = null;
      if (typeof query.from === 'string') {
        const fromDate = this.dateOnly(query.from, 'Start date');
        fromValue = this.date(`${fromDate}T00:00:00.000Z`, 'Start date');
        if (fromValue) createdAt.gte = fromValue;
      }
      if (typeof query.to === 'string') {
        const toDate = this.dateOnly(query.to, 'End date');
        toValue = this.date(`${toDate}T23:59:59.999Z`, 'End date');
        if (toValue) createdAt.lte = toValue;
      }
      if (fromValue && toValue && fromValue > toValue) {
        throw new BadRequestException('Start date must not be after end date.');
      }
      where.createdAt = createdAt;
    }
    return where;
  }

  private dateOnly(value: string, field: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(`${field} must use YYYY-MM-DD.`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    ) {
      throw new BadRequestException(`${field} must be a valid calendar date.`);
    }
    return value;
  }

  async list(actor: Actor, query: Record<string, unknown>) {
    const companyId = await this.companyId(actor);
    const page = query.page == null ? 1 : Number(query.page);
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new BadRequestException('Page must be a positive integer.');
    }
    const pageSize = query.pageSize == null ? 25 : Number(query.pageSize);
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAX_PAGE_SIZE
    ) {
      throw new BadRequestException(
        `Page size must be between 1 and ${MAX_PAGE_SIZE}.`,
      );
    }
    if (page * pageSize > Number.MAX_SAFE_INTEGER) {
      throw new BadRequestException('Page is outside the supported range.');
    }
    const orderKey =
      typeof query.sort === 'string' &&
      ['name', 'createdAt', 'estimatedMonthlyValue', 'followUpAt'].includes(
        query.sort,
      )
        ? query.sort
        : 'createdAt';
    if (
      query.sort != null &&
      !['name', 'createdAt', 'estimatedMonthlyValue', 'followUpAt'].includes(
        String(query.sort),
      )
    ) {
      throw new BadRequestException('Select a supported lead sort field.');
    }
    const direction = query.direction === 'asc' ? 'asc' : 'desc';
    if (query.direction != null && !['asc', 'desc'].includes(String(query.direction))) {
      throw new BadRequestException('Sort direction must be asc or desc.');
    }
    const orderBy: Prisma.CrmLeadOrderByWithRelationInput =
      orderKey === 'name'
        ? { name: direction }
        : orderKey === 'estimatedMonthlyValue'
          ? { estimatedMonthlyValue: direction }
          : orderKey === 'followUpAt'
            ? { followUpAt: direction }
            : { createdAt: direction };
    const where = this.listWhere(companyId, query);
    const [items, total] = await Promise.all([
      this.prisma.crmLead.findMany({
        where,
        include: {
          package: { select: { id: true, name: true } },
          assignedEmployee: { select: { id: true, name: true } },
          convertedSubscriber: { select: { id: true, fullName: true } },
        },
        orderBy: [orderBy, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.crmLead.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async detail(actor: Actor, id: number) {
    return this.lead(await this.companyId(actor), id, true);
  }

  async options(actor: Actor) {
    const companyId = await this.companyId(actor);
    const packageWhere = await this.scope.packageWhere(actor);
    const [packages, employees] = await Promise.all([
      this.prisma.package.findMany({
        where: { ...packageWhere, isActive: true },
        select: { id: true, name: true, price: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.employeeProfile.findMany({
        where: { companyId, status: 'ACTIVE' },
        select: { id: true, name: true, department: true, designation: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { packages, employees, stages: LEAD_STAGES, priorities: LEAD_PRIORITIES };
  }

  async pipeline(actor: Actor, query: Record<string, unknown>) {
    const companyId = await this.companyId(actor);
    const baseWhere = this.listWhere(companyId, { ...query, archived: 'false' });
    const stages = await Promise.all(
      LEAD_STAGES.map(async (stage) => {
        const where = { ...baseWhere, stage };
        const [count, value] = await Promise.all([
          this.prisma.crmLead.count({ where }),
          this.prisma.crmLead.aggregate({
            where,
            _sum: { estimatedMonthlyValue: true },
          }),
        ]);
        return {
          stage,
          count,
          estimatedMonthlyValue: Number(
            value._sum.estimatedMonthlyValue ?? 0,
          ),
        };
      }),
    );
    const dueFollowUps = await this.prisma.crmLead.count({
      where: {
        ...baseWhere,
        followUpAt: { lte: new Date() },
        stage: { not: 'LOST' },
      },
    });
    return {
      stages,
      total: stages.reduce((sum, item) => sum + item.count, 0),
      dueFollowUps,
    };
  }

  async create(actor: Actor, input: LeadInput) {
    const companyId = await this.companyId(actor);
    const actorUserId = this.actorId(actor);
    const data = this.inputData(input, true);
    await this.assertReferences(actor, companyId, data);
    const created = await this.prisma.$transaction(async (tx) => {
      const lead = await tx.crmLead.create({
        data: {
          ...data,
          companyId,
          createdById: actorUserId,
        } as Prisma.CrmLeadUncheckedCreateInput,
      });
      await tx.crmLeadActivity.create({
        data: {
          companyId,
          leadId: lead.id,
          actorUserId,
          type: 'NOTE',
          detail: 'Lead created.',
        },
      });
      if (typeof data.notes === 'string' && data.notes) {
        await tx.crmLeadActivity.create({
          data: {
            companyId,
            leadId: lead.id,
            actorUserId,
            type: 'NOTE',
            detail: data.notes,
          },
        });
      }
      await tx.activityLog.create({
        data: {
          userId: actorUserId,
          action: 'CRM_LEAD_CREATED',
          entity: 'CrmLead',
          entityId: lead.id,
          details: `Lead #${lead.id} created.`,
        },
      });
      return lead;
    });
    return this.lead(companyId, created.id, true);
  }

  async update(actor: Actor, id: number, input: LeadInput) {
    const companyId = await this.companyId(actor);
    const current = await this.lead(companyId, id);
    if (input.assignedEmployeeId !== undefined) {
      throw new BadRequestException(
        'Use the lead assignment action to change the assigned employee.',
      );
    }
    if (current.convertedSubscriberId != null) {
      throw new ConflictException(
        'A converted lead is read-only. Edit the linked subscriber instead.',
      );
    }
    const data = this.inputData(input, false);
    await this.assertReferences(actor, companyId, data);
    await this.prisma.$transaction(async (tx) => {
      await tx.crmLead.updateMany({
        where: { id, companyId, convertedSubscriberId: null },
        data: data as Prisma.CrmLeadUpdateManyMutationInput,
      });
      await tx.crmLeadActivity.create({
        data: {
          companyId,
          leadId: id,
          actorUserId: this.actorId(actor),
          type:
            data.followUpAt !== undefined
              ? 'FOLLOW_UP'
              : data.assignedEmployeeId !== undefined
                ? 'ASSIGNMENT'
                : 'NOTE',
          detail:
            data.followUpAt !== undefined
              ? data.followUpAt
                ? `Follow-up scheduled for ${(data.followUpAt as Date).toISOString()}.`
                : 'Follow-up cleared.'
              : data.assignedEmployeeId !== undefined
                ? 'Lead assignment updated.'
                : 'Lead details updated.',
        },
      });
      await tx.activityLog.create({
        data: {
          userId: this.actorId(actor),
          action: 'CRM_LEAD_UPDATED',
          entity: 'CrmLead',
          entityId: id,
          details: `Lead #${id} updated.`,
        },
      });
    });
    return this.lead(companyId, id, true);
  }

  async assign(actor: Actor, id: number, input: LeadInput) {
    const companyId = await this.companyId(actor);
    const current = await this.lead(companyId, id);
    if (current.convertedSubscriberId != null) {
      throw new ConflictException(
        'A converted lead is read-only. Edit the linked subscriber instead.',
      );
    }
    const assignedEmployeeId = this.positiveId(
      input.assignedEmployeeId,
      'Assigned employee',
    );
    await this.assertReferences(actor, companyId, { assignedEmployeeId });
    await this.prisma.$transaction(async (tx) => {
      await tx.crmLead.updateMany({
        where: { id, companyId, convertedSubscriberId: null },
        data: { assignedEmployeeId },
      });
      await this.event(
        tx,
        actor,
        companyId,
        id,
        'ASSIGNMENT',
        assignedEmployeeId == null
          ? 'Lead assignment cleared.'
          : 'Lead assigned to an employee.',
      );
    });
    return this.lead(companyId, id, true);
  }

  async addActivity(actor: Actor, id: number, input: LeadInput) {
    const companyId = await this.companyId(actor);
    await this.lead(companyId, id);
    const type = String(input.type ?? 'NOTE').toUpperCase();
    if (!ACTIVITY_TYPES.includes(type as ActivityType)) {
      throw new BadRequestException('Select a valid activity type.');
    }
    const detail = this.text(input.detail, 'Activity details', 5000, true)!;
    await this.prisma.$transaction(async (tx) => {
      await this.event(
        tx,
        actor,
        companyId,
        id,
        type as ActivityType,
        detail,
      );
    });
    return this.lead(companyId, id, true);
  }

  async changeStage(actor: Actor, id: number, input: LeadInput) {
    const companyId = await this.companyId(actor);
    const current = await this.lead(companyId, id);
    if (current.convertedSubscriberId != null) {
      throw new ConflictException('A converted lead cannot change pipeline stage.');
    }
    const stage = String(input.stage ?? '').toUpperCase();
    if (!LEAD_STAGES.includes(stage as LeadStage)) {
      throw new BadRequestException('Select a valid pipeline stage.');
    }
    const nextStage = stage as LeadStage;
    const lostReason =
      nextStage === 'LOST'
        ? this.text(input.lostReason, 'Lost reason', 500, true)
        : null;
    if (current.stage === nextStage && current.lostReason === lostReason) {
      return this.lead(companyId, id, true);
    }
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.crmLead.updateMany({
        where: { id, companyId, stage: current.stage, convertedSubscriberId: null },
        data: {
          stage: nextStage,
          lostReason,
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException('Lead changed. Reload and try again.');
      }
      await this.event(
        tx,
        actor,
        companyId,
        id,
        'STATUS_CHANGE',
        `Stage changed from ${current.stage} to ${nextStage}.`,
        { from: current.stage, to: nextStage },
      );
    });
    return this.lead(companyId, id, true);
  }

  async archive(actor: Actor, id: number, archived: boolean) {
    const companyId = await this.companyId(actor);
    const current = await this.lead(companyId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.crmLead.update({
        where: { id },
        data: { archivedAt: archived ? new Date() : null },
      });
      await this.event(
        tx,
        actor,
        companyId,
        id,
        'NOTE',
        archived ? 'Lead archived.' : 'Lead restored.',
      );
      await tx.activityLog.create({
        data: {
          userId: this.actorId(actor),
          action: archived ? 'CRM_LEAD_ARCHIVED' : 'CRM_LEAD_RESTORED',
          entity: 'CrmLead',
          entityId: id,
          details: `Lead #${id} ${archived ? 'archived' : 'restored'}.`,
        },
      });
    });
    return this.lead(companyId, current.id, true);
  }

  private async matches(
    tx: Prisma.TransactionClient,
    companyId: number,
    lead: LeadForMatching,
  ) {
    const descendantIds = await this.scope.descendantIds(companyId);
    if (!descendantIds.length) return [];
    const owners = await tx.user.findMany({
      where: { id: { in: descendantIds }, isDemo: false },
      select: { id: true },
    });
    const ownerIds = owners.map((owner) => owner.id);
    if (!ownerIds.length) return [];
    const suffix = lead.phoneNormalized.slice(-7);
    const email = lead.emailNormalized;
    const emailPredicate = email
      ? Prisma.sql`OR lower(COALESCE("email", '')) = ${email}`
      : Prisma.empty;
    const matches = await tx.$queryRaw<SubscriberMatch[]>(Prisma.sql`
      SELECT
        id,
        "fullName",
        phone,
        email,
        username,
        status::text AS status,
        right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 7) AS "phoneSuffix",
        lower(COALESCE(email, '')) AS "normalizedEmail"
      FROM "Subscriber"
      WHERE "userId" IN (${Prisma.join(ownerIds)})
        AND (
          "email" IS NULL
          OR lower("email") NOT LIKE ${`%${DEMO_SUBSCRIBER_EMAIL_SUFFIX}`}
        )
        AND (
          right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 7) = ${suffix}
          ${emailPredicate}
        )
      ORDER BY id
      LIMIT 50
    `);
    return matches.map((candidate) => ({
      id: candidate.id,
      fullName: candidate.fullName,
      phone: candidate.phone,
      email: candidate.email,
      username: candidate.username,
      status: candidate.status,
      matchingReasons: [
        ...(candidate.phoneSuffix === suffix ? ['phone'] : []),
        ...(email && candidate.normalizedEmail === email ? ['email'] : []),
      ],
    }));
  }

  async conversionCandidates(actor: Actor, id: number) {
    await this.assertAction(actor, 'crm.leads.read');
    await this.assertAction(actor, 'subscribers.read');
    const companyId = await this.companyId(actor);
    const lead = (await this.lead(companyId, id)) as LeadForMatching;
    if (lead.convertedSubscriberId != null) {
      return { alreadyConverted: true, subscriberId: lead.convertedSubscriberId, candidates: [] };
    }
    return {
      alreadyConverted: false,
      candidates: await this.prisma.$transaction((tx) =>
        this.matches(tx, companyId, lead),
      ),
    };
  }

  async convert(actor: Actor, id: number, input: LeadInput) {
    await this.assertAction(actor, 'crm.leads.convert');
    await this.assertAction(actor, 'subscribers.read');
    await this.assertAction(actor, 'subscribers.write');
    const companyId = await this.companyId(actor);
    const requestedSubscriberId = this.positiveId(
      input.existingSubscriberId,
      'Subscriber',
    );
    const actorUserId = this.actorId(actor);
    await this.lead(companyId, id);
    const conversionKey = await this.prisma.crmLeadConversionKey.upsert({
      where: { leadId_companyId: { leadId: id, companyId } },
      update: {},
      create: {
        companyId,
        leadId: id,
        idempotencyKey: randomBytes(32).toString('hex'),
      },
      select: { idempotencyKey: true },
    });

    const conversion = await this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: number }>>`
          SELECT id FROM "CrmLead"
          WHERE id = ${id} AND "companyId" = ${companyId}
          FOR UPDATE
        `;
        if (!locked.length) throw new NotFoundException('Lead not found.');
        const lead = await tx.crmLead.findFirst({
          where: { id, companyId },
        }) as LeadForMatching | null;
        if (!lead) throw new NotFoundException('Lead not found.');
        if (lead.convertedSubscriberId != null) {
          return {
            subscriberId: lead.convertedSubscriberId,
            alreadyConverted: true,
          };
        }
        if (lead.archivedAt) {
          throw new ConflictException('Restore this lead before converting it.');
        }
        if (lead.stage !== 'QUALIFIED' && lead.stage !== 'WON') {
          throw new ConflictException(
            'Only qualified or won leads can be converted.',
          );
        }

        const identifiers = [
          `phone:${lead.phoneNormalized.slice(-7)}`,
          ...(lead.emailNormalized ? [`email:${lead.emailNormalized}`] : []),
        ].sort();
        for (const identifier of identifiers) {
          await tx.$queryRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`crm-lead-conversion:${companyId}:${identifier}`}))`,
          );
        }
        const priorCreation = await tx.subscriber.findUnique({
          where: { idempotencyKey: conversionKey.idempotencyKey },
          select: { id: true },
        });
        const candidates = priorCreation
          ? []
          : await this.matches(tx, companyId, lead);
        let subscriberId: number;
        let conversionType: 'MATCHED_EXISTING' | 'CREATED_NEW';
        if (priorCreation) {
          subscriberId = priorCreation.id;
          conversionType = 'CREATED_NEW';
        } else if (requestedSubscriberId != null) {
          if (!candidates.some((candidate) => candidate.id === requestedSubscriberId)) {
            throw new ConflictException(
              'The selected subscriber is not a current phone or email match for this lead.',
            );
          }
          subscriberId = requestedSubscriberId;
          conversionType = 'MATCHED_EXISTING';
        } else {
          if (candidates.length) {
            throw new ConflictException({
              code: 'POSSIBLE_SUBSCRIBER_DUPLICATES',
              message:
                'Review the possible subscriber matches and select the correct existing record before conversion.',
              candidates,
            });
          }
          const username = `lead_${id}_${randomBytes(8).toString('hex')}`;
          const password = randomBytes(32).toString('base64url');
          const createdSubscriber = await this.subscribers.create(
            {
              fullName: lead.name,
              phone: lead.phone,
              email: lead.email,
              address: lead.address ?? '',
              packageId: lead.packageId ?? undefined,
              salespersonId:
                lead.assignedEmployeeId == null
                  ? undefined
                  : (
                      await tx.employeeProfile.findFirst({
                        where: {
                          id: lead.assignedEmployeeId,
                          companyId,
                          status: 'ACTIVE',
                        },
                        select: { userId: true },
                      })
                    )?.userId ?? undefined,
              username,
              password,
              status: 'INACTIVE',
              activateNow: false,
              suppressWelcomeMessage: true,
              idempotencyKey: conversionKey.idempotencyKey,
            },
            actor,
          );
          subscriberId = Number(createdSubscriber.id);
          conversionType = 'CREATED_NEW';
        }

        const stageChanged = lead.stage !== 'WON';
        await tx.crmLead.update({
          where: { id },
          data: {
            stage: 'WON',
            lostReason: null,
            convertedSubscriberId: subscriberId,
            convertedAt: new Date(),
            conversionType,
          },
        });
        await tx.crmLeadActivity.create({
          data: {
            companyId,
            leadId: id,
            actorUserId,
            type: 'CONVERSION',
            detail:
              conversionType === 'MATCHED_EXISTING'
                ? `Lead linked to existing subscriber #${subscriberId}; subscriber details were not changed.`
                : `Lead registered as inactive subscriber #${subscriberId}; no service was activated or billed.`,
            fromStage: stageChanged ? lead.stage : undefined,
            toStage: stageChanged ? 'WON' : undefined,
          },
        });
        await tx.activityLog.create({
          data: {
            userId: actorUserId,
            action: 'CRM_LEAD_CONVERSION',
            entity: 'CrmLead',
            entityId: id,
            details: `Lead #${id} ${conversionType === 'MATCHED_EXISTING' ? 'linked to' : 'created'} subscriber #${subscriberId}.`,
          },
        });
        return { subscriberId, alreadyConverted: false };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    return {
      lead: await this.lead(companyId, id, true),
      subscriber: await this.prisma.subscriber.findFirst({
        where: {
          id: conversion.subscriberId,
          userId: { in: await this.scope.descendantIds(companyId) },
        },
        select: { id: true, fullName: true, status: true },
      }),
      alreadyConverted: conversion.alreadyConverted,
    };
  }

  @Cron('0 * * * *')
  async remindDueFollowUps(): Promise<void> {
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
    const due = await this.prisma.crmLead.findMany({
      where: {
        companyId: { in: companyIds },
        archivedAt: null,
        convertedSubscriberId: null,
        followUpAt: { lte: now },
        followUpRemindedAt: null,
        stage: { not: 'LOST' },
      },
      orderBy: { followUpAt: 'asc' },
      take: 100,
      select: {
        id: true,
        companyId: true,
        name: true,
        followUpAt: true,
      },
    });
    for (const lead of due) {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.crmLead.updateMany({
          where: {
            id: lead.id,
            companyId: lead.companyId,
            followUpRemindedAt: null,
          },
          data: { followUpRemindedAt: now },
        });
        if (claimed.count !== 1) return;
        const detail = `Follow-up due for lead #${lead.id} (${lead.name}).`;
        await tx.crmLeadActivity.create({
          data: {
            companyId: lead.companyId,
            leadId: lead.id,
            actorUserId: lead.companyId,
            type: 'FOLLOW_UP',
            detail: 'Scheduled follow-up reminder issued.',
          },
        });
        await tx.activityLog.create({
          data: {
            userId: lead.companyId,
            action: 'CRM.LEAD.FOLLOW_UP_DUE',
            entity: 'CrmLead',
            entityId: lead.id,
            details: detail,
          },
        });
      });
    }
    if (due.length) {
      this.logger.log(`Issued ${due.length} company-scoped lead follow-up reminder(s).`);
    }
  }
}
