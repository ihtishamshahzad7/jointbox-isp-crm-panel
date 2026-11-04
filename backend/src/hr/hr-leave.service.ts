import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceStatus,
  EmployeeLeaveBalanceEntryType,
  EmployeeLeaveHistoryAction,
  EmployeeLeaveStatus,
  Prisma,
} from '@prisma/client';
import { ProductEntitlementService } from '../common/product-entitlement.service';
import { ScopeService, type Actor } from '../common/scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const MAX_PAGE_SIZE = 100;
const MAX_REQUEST_DAYS = 366;
const ACTIVE_REQUEST_STATUSES: EmployeeLeaveStatus[] = [
  EmployeeLeaveStatus.PENDING,
  EmployeeLeaveStatus.APPROVED,
];

export type LeaveRequestInput = {
  leaveTypeId?: unknown;
  dates?: unknown;
  reason?: unknown;
};

export type LeaveListQuery = {
  status?: unknown;
  employeeId?: unknown;
  year?: unknown;
  page?: unknown;
  pageSize?: unknown;
};

@Injectable()
export class HrLeaveService {
  private readonly logger = new Logger(HrLeaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly entitlements: ProductEntitlementService,
    private readonly notifications: NotificationsService,
  ) {}

  private async companyId(actor: Actor): Promise<number> {
    if (!actor || actor.role === 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Sign in as a company account to access leave management.',
      );
    }
    return (await this.entitlements.assertEnabled(actor, 'crm-advanced'))
      .companyId;
  }

  private actorId(actor: Actor): number {
    const id = this.scope.actorId(actor);
    if (!id) throw new ForbiddenException('Your account has no user identity.');
    return id;
  }

  private isCompanyAdmin(actor: Actor, companyId: number): boolean {
    return actor?.role === 'ADMIN' && this.scope.actorId(actor) === companyId;
  }

  private async hasPermission(
    actor: Actor,
    permission: string,
  ): Promise<boolean> {
    const role = actor?.role;
    if (!role) return false;
    const rows = await this.prisma.rolePermission.findMany({
      where: { role },
      select: { permission: true },
    });
    const grants = new Set(rows.map((row) => row.permission));
    if (
      !grants.has('*') &&
      !grants.has('hr.*') &&
      !grants.has(permission)
    ) {
      return false;
    }
    const userIds = await this.scope.ancestorIds(this.actorId(actor));
    const denied = await this.prisma.userPermission.findMany({
      where: {
        userId: { in: userIds },
        allowed: false,
        permission: { in: [permission, 'hr.read', 'hr.write'] },
      },
      select: { permission: true },
    });
    return denied.length === 0;
  }

  async access(actor: Actor) {
    const companyId = await this.companyId(actor);
    const isAdmin = this.isCompanyAdmin(actor, companyId);
    const userIds = await this.scope.ancestorIds(this.actorId(actor));
    const denied = new Set(
      (
        await this.prisma.userPermission.findMany({
          where: {
            userId: { in: userIds },
            allowed: false,
          },
          select: { permission: true },
        })
      ).map((row) => row.permission),
    );
    const roleCan = async (permission: string) =>
      isAdmin ||
      ((await this.hasPermission(actor, permission)) &&
        !denied.has('hr.read') &&
        !denied.has('hr.write') &&
        !denied.has(permission));
    return {
      canWrite: await roleCan('hr.leave.write'),
      canApprove: await roleCan('hr.leave.approve'),
      canManageTypes: await roleCan('hr.leave.manage_types'),
      canManageBalances: await roleCan('hr.leave.manage_balances'),
    };
  }

  private dateOnly(value: unknown, field: string): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(`${field} must use YYYY-MM-DD format.`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    ) {
      throw new BadRequestException(`${field} must be a valid calendar date.`);
    }
    const year = parsed.getUTCFullYear();
    if (year < 1900 || year > 2200) {
      throw new BadRequestException(
        `${field} year must be between 1900 and 2200.`,
      );
    }
    return value;
  }

  private decimalDays(value: unknown, field: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || Math.round(parsed * 100) !== parsed * 100) {
      throw new BadRequestException(
        `${field} must be a finite number with at most two decimal places.`,
      );
    }
    return parsed;
  }

  private dateInPakistan(): string {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type: string) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  private positiveInt(value: unknown, field: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`${field} must be a positive integer.`);
    }
    return parsed;
  }

  private parseDates(value: unknown): Date[] {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > MAX_REQUEST_DAYS
    ) {
      throw new BadRequestException(
        `Select between 1 and ${MAX_REQUEST_DAYS} leave dates.`,
      );
    }
    const dates = value
      .map(
        (item, index) =>
          new Date(
            `${this.dateOnly(item, `Leave date ${index + 1}`)}T00:00:00.000Z`,
          ),
      )
      .sort((left, right) => left.getTime() - right.getTime());
    if (
      new Set(dates.map((date) => date.toISOString())).size !== dates.length
    ) {
      throw new BadRequestException('Leave dates must not contain duplicates.');
    }
    if (dates[0].toISOString().slice(0, 10) <= this.dateInPakistan()) {
      throw new BadRequestException('Leave dates must start after today.');
    }
    return dates;
  }

  private async lockEmployee(
    tx: Prisma.TransactionClient,
    employeeId: number,
    companyId: number,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "EmployeeProfile"
      WHERE "id" = ${employeeId} AND "companyId" = ${companyId}
      FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Employee was not found.');
  }

  private async employeeForActor(
    companyId: number,
    actorId: number,
  ): Promise<{ id: number; userId: number | null; department: string | null }> {
    const employee = await this.prisma.employeeProfile.findFirst({
      where: { companyId, userId: actorId },
      select: { id: true, userId: true, department: true },
    });
    if (!employee) {
      throw new NotFoundException(
        'Your account is not linked to an employee profile.',
      );
    }
    return employee;
  }

  private async assertEmployeeScope(
    actor: Actor,
    companyId: number,
    employeeId: number,
    requireBalancePermission = false,
  ): Promise<void> {
    if (this.isCompanyAdmin(actor, companyId)) return;
    const actorUserId = this.actorId(actor);
    const target = await this.prisma.employeeProfile.findFirst({
      where: { id: employeeId, companyId },
      select: { id: true, userId: true, department: true },
    });
    if (!target) throw new NotFoundException('Employee was not found.');
    if (target.userId === actorUserId && !requireBalancePermission) return;

    const actorEmployee = await this.employeeForActor(companyId, actorUserId);
    const permission = requireBalancePermission
      ? 'hr.leave.manage_balances'
      : 'hr.leave.approve';
    if (
      !actorEmployee.department ||
      target.department !== actorEmployee.department ||
      !(await this.hasPermission(actor, permission))
    ) {
      throw new ForbiddenException(
        'You can only manage leave for employees in your department.',
      );
    }
  }

  private assertCanManageOwnRequest(
    actor: Actor,
    employee: { userId: number | null },
  ): void {
    if (employee.userId !== this.actorId(actor)) {
      throw new ForbiddenException(
        'You can only submit or cancel leave for your own employee profile.',
      );
    }
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actorId: number,
    action: string,
    entity: string,
    entityId: number,
    details: Record<string, unknown>,
  ): Promise<void> {
    await tx.activityLog.create({
      data: {
        userId: actorId,
        action,
        entity,
        entityId,
        details: JSON.stringify(details),
      },
    });
  }

  private async notify(
    recipient: string | null | undefined,
    subject: string,
    body: string,
    actorId: number,
  ): Promise<void> {
    if (!recipient) return;
    try {
      await this.notifications.send({
        channel: 'EMAIL',
        recipient,
        subject,
        body,
        event: 'HR_LEAVE',
        createdBy: actorId,
      });
    } catch (error) {
      this.logger.error(
        `Leave email notification could not be queued: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async listTypes(actor: Actor) {
    const companyId = await this.companyId(actor);
    const canManageTypes =
      this.isCompanyAdmin(actor, companyId) ||
      (await this.hasPermission(actor, 'hr.leave.manage_types'));
    return this.prisma.employeeLeaveType.findMany({
      where: {
        companyId,
        ...(canManageTypes ? {} : { isActive: true }),
      },
      orderBy: { name: 'asc' },
    });
  }

  async createType(
    actor: Actor,
    input: {
      name?: unknown;
      description?: unknown;
      isPaid?: unknown;
      annualAllocationDays?: unknown;
    },
  ) {
    const companyId = await this.companyId(actor);
    if (
      !this.isCompanyAdmin(actor, companyId) &&
      !(await this.hasPermission(actor, 'hr.leave.manage_types'))
    ) {
      throw new ForbiddenException('You cannot manage leave types.');
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) {
      throw new BadRequestException(
        'Leave type name is required and limited to 80 characters.',
      );
    }
    const description =
      input.description == null || input.description === ''
        ? null
        : typeof input.description === 'string'
          ? input.description.trim()
          : null;
    if (input.description != null && typeof input.description !== 'string') {
      throw new BadRequestException('Description must be text.');
    }
    if (description && description.length > 500) {
      throw new BadRequestException(
        'Description must be 500 characters or fewer.',
      );
    }
    if (typeof input.isPaid !== 'boolean') {
      throw new BadRequestException('Specify whether this leave type is paid.');
    }
    const allocation =
      input.annualAllocationDays == null || input.annualAllocationDays === ''
        ? null
        : this.decimalDays(input.annualAllocationDays, 'Annual allocation');
    if (
      allocation !== null &&
      (!Number.isFinite(allocation) || allocation <= 0 || allocation > 366)
    ) {
      throw new BadRequestException(
        'Annual allocation must be a positive number no greater than 366, or left blank.',
      );
    }
    try {
      return await this.prisma.employeeLeaveType.create({
        data: {
          companyId,
          name,
          description,
          isPaid: input.isPaid,
          annualAllocationDays:
            allocation === null ? null : new Prisma.Decimal(allocation),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A leave type with this name already exists.',
        );
      }
      throw error;
    }
  }

  async updateType(
    actor: Actor,
    leaveTypeId: number,
    input: {
      name?: unknown;
      description?: unknown;
      isPaid?: unknown;
      annualAllocationDays?: unknown;
      isActive?: unknown;
    },
  ) {
    const companyId = await this.companyId(actor);
    if (
      !this.isCompanyAdmin(actor, companyId) &&
      !(await this.hasPermission(actor, 'hr.leave.manage_types'))
    ) {
      throw new ForbiddenException('You cannot manage leave types.');
    }
    const existing = await this.prisma.employeeLeaveType.findFirst({
      where: { id: leaveTypeId, companyId },
    });
    if (!existing) throw new NotFoundException('Leave type was not found.');
    const data: Prisma.EmployeeLeaveTypeUpdateInput = {};
    if (input.name !== undefined) {
      if (
        typeof input.name !== 'string' ||
        !input.name.trim() ||
        input.name.trim().length > 80
      ) {
        throw new BadRequestException(
          'Leave type name is required and limited to 80 characters.',
        );
      }
      data.name = input.name.trim();
    }
    if (input.description !== undefined) {
      if (input.description !== null && typeof input.description !== 'string') {
        throw new BadRequestException('Description must be text.');
      }
      data.description =
        typeof input.description === 'string' ? input.description.trim() : null;
      if (data.description && data.description.length > 500) {
        throw new BadRequestException(
          'Description must be 500 characters or fewer.',
        );
      }
    }
    if (input.isPaid !== undefined) {
      if (typeof input.isPaid !== 'boolean')
        throw new BadRequestException('Paid must be boolean.');
      data.isPaid = input.isPaid;
    }
    if (input.isActive !== undefined) {
      if (typeof input.isActive !== 'boolean')
        throw new BadRequestException('Active must be boolean.');
      data.isActive = input.isActive;
    }
    if (input.annualAllocationDays !== undefined) {
      const allocation =
        input.annualAllocationDays == null || input.annualAllocationDays === ''
          ? null
          : this.decimalDays(input.annualAllocationDays, 'Annual allocation');
      if (
        allocation !== null &&
        (!Number.isFinite(allocation) || allocation <= 0 || allocation > 366)
      ) {
        throw new BadRequestException(
          'Annual allocation must be a positive number no greater than 366, or blank.',
        );
      }
      data.annualAllocationDays =
        allocation === null ? null : new Prisma.Decimal(allocation);
    }
    try {
      return await this.prisma.employeeLeaveType.update({
        where: { id: leaveTypeId },
        data,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A leave type with this name already exists.',
        );
      }
      throw error;
    }
  }

  async createRequest(actor: Actor, input: LeaveRequestInput) {
    const companyId = await this.companyId(actor);
    const actorId = this.actorId(actor);
    const employee = await this.employeeForActor(companyId, actorId);
    this.assertCanManageOwnRequest(actor, employee);
    const leaveTypeId = this.positiveInt(input.leaveTypeId, 'Leave type ID');
    const dates = this.parseDates(input.dates);
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 1000) {
      throw new BadRequestException(
        'Reason is required and limited to 1000 characters.',
      );
    }
    const leaveType = await this.prisma.employeeLeaveType.findFirst({
      where: { id: leaveTypeId, companyId, isActive: true },
      select: { id: true },
    });
    if (!leaveType)
      throw new NotFoundException('Active leave type was not found.');

    const startDate = dates[0];
    const endDate = dates[dates.length - 1];
    const request = await this.prisma.$transaction(async (tx) => {
      await this.entitlements.assertEnabledForTransaction(
        tx,
        companyId,
        'crm-advanced',
      );
      await this.lockEmployee(tx, employee.id, companyId);
      const activeType = await tx.employeeLeaveType.findFirst({
        where: { id: leaveTypeId, companyId, isActive: true },
        select: { id: true },
      });
      if (!activeType) {
        throw new ConflictException(
          'This leave type is no longer active; refresh and select an active type.',
        );
      }
      const candidates = await tx.employeeLeaveRequest.findMany({
        where: {
          companyId,
          employeeId: employee.id,
          status: { in: ACTIVE_REQUEST_STATUSES },
          startDate: { lte: endDate },
          endDate: { gte: startDate },
        },
        select: { id: true, leaveDates: true },
      });
      const requestedDateSet = new Set(dates.map((date) => date.toISOString()));
      if (
        candidates.some((candidate) =>
          candidate.leaveDates.some((date) =>
            requestedDateSet.has(date.toISOString()),
          ),
        )
      ) {
        throw new ConflictException(
          'One or more selected dates already have a pending or approved leave request.',
        );
      }
      const created = await tx.employeeLeaveRequest.create({
        data: {
          companyId,
          employeeId: employee.id,
          leaveTypeId,
          startDate,
          endDate,
          leaveDates: dates,
          requestedDays: dates.length,
          reason,
        },
        include: { leaveType: true },
      });
      await tx.employeeLeaveHistory.create({
        data: {
          companyId,
          requestId: created.id,
          actorUserId: actorId,
          action: EmployeeLeaveHistoryAction.SUBMITTED,
          newStatus: EmployeeLeaveStatus.PENDING,
        },
      });
      await this.audit(
        tx,
        actorId,
        'LEAVE_REQUEST_SUBMITTED',
        'EmployeeLeaveRequest',
        created.id,
        {
          employeeId: employee.id,
          leaveTypeId,
          dates: dates.map((date) => date.toISOString().slice(0, 10)),
        },
      );
      return created;
    });
    const companyAdmin = await this.prisma.user.findUnique({
      where: { id: companyId },
      select: { email: true },
    });
    await this.notify(
      companyAdmin?.email,
      'Leave request submitted',
      `A leave request for ${request.requestedDays} day(s) is awaiting review.`,
      actorId,
    );
    return request;
  }

  async listRequests(actor: Actor, query: LeaveListQuery = {}) {
    const companyId = await this.companyId(actor);
    let employeeId: number | undefined;
    if (!this.isCompanyAdmin(actor, companyId)) {
      const actorEmployee = await this.employeeForActor(
        companyId,
        this.actorId(actor),
      );
      if (actorEmployee.department) {
        const canApprove = await this.hasPermission(actor, 'hr.leave.approve');
        if (query.employeeId !== undefined && query.employeeId !== '') {
          employeeId = this.positiveInt(query.employeeId, 'Employee ID');
          await this.assertEmployeeScope(actor, companyId, employeeId);
        }
        const where: Prisma.EmployeeLeaveRequestWhereInput = {
          companyId,
          employee: canApprove
            ? {
                department: actorEmployee.department,
                ...(employeeId ? { id: employeeId } : {}),
              }
            : { id: actorEmployee.id },
        };
        return this.paginatedRequests(where, query);
      }
      employeeId = actorEmployee.id;
    }
    if (query.employeeId !== undefined && query.employeeId !== '') {
      const requestedId = this.positiveInt(query.employeeId, 'Employee ID');
      if (!this.isCompanyAdmin(actor, companyId)) {
        await this.assertEmployeeScope(actor, companyId, requestedId);
      }
      employeeId = requestedId;
    }
    return this.paginatedRequests(
      { companyId, ...(employeeId ? { employeeId } : {}) },
      query,
    );
  }

  async listMine(actor: Actor, query: LeaveListQuery = {}) {
    const companyId = await this.companyId(actor);
    const employee = await this.employeeForActor(
      companyId,
      this.actorId(actor),
    );
    return this.paginatedRequests(
      { companyId, employeeId: employee.id },
      query,
    );
  }

  private async paginatedRequests(
    baseWhere: Prisma.EmployeeLeaveRequestWhereInput,
    query: LeaveListQuery,
  ) {
    const page = this.positiveInt(query.page ?? 1, 'Page');
    const pageSize = this.positiveInt(query.pageSize ?? 25, 'Page size');
    if (pageSize > MAX_PAGE_SIZE) {
      throw new BadRequestException(
        `Page size must be ${MAX_PAGE_SIZE} or less.`,
      );
    }
    const where: Prisma.EmployeeLeaveRequestWhereInput = { ...baseWhere };
    if (query.status !== undefined && query.status !== '') {
      if (
        typeof query.status !== 'string' ||
        !Object.values(EmployeeLeaveStatus).includes(
          query.status.toUpperCase() as EmployeeLeaveStatus,
        )
      ) {
        throw new BadRequestException('Unknown leave request status.');
      }
      where.status = query.status.toUpperCase() as EmployeeLeaveStatus;
    }
    if (query.year !== undefined && query.year !== '') {
      const year = this.positiveInt(query.year, 'Year');
      if (year < 1900 || year > 2200) {
        throw new BadRequestException('Year must be between 1900 and 2200.');
      }
      where.startDate = { lte: new Date(Date.UTC(year, 11, 31)) };
      where.endDate = { gte: new Date(Date.UTC(year, 0, 1)) };
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.employeeLeaveRequest.findMany({
        where,
        include: {
          employee: { select: { id: true, name: true, department: true } },
          leaveType: { select: { id: true, name: true, isPaid: true } },
        },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.employeeLeaveRequest.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async getRequest(actor: Actor, requestId: number) {
    const companyId = await this.companyId(actor);
    const request = await this.prisma.employeeLeaveRequest.findFirst({
      where: { id: requestId, companyId },
      include: {
        employee: {
          select: { id: true, name: true, department: true, userId: true },
        },
        leaveType: true,
        history: { orderBy: { createdAt: 'asc' } },
        balanceEntries: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!request) throw new NotFoundException('Leave request was not found.');
    if (this.isCompanyAdmin(actor, companyId)) return request;
    const actorEmployee = await this.employeeForActor(
      companyId,
      this.actorId(actor),
    );
    if (
      request.employeeId !== actorEmployee.id &&
      (!actorEmployee.department ||
        request.employee.department !== actorEmployee.department ||
        !(await this.hasPermission(actor, 'hr.leave.approve')))
    ) {
      throw new ForbiddenException('You cannot view this leave request.');
    }
    return request;
  }

  async requestHistory(actor: Actor, requestId: number) {
    const request = await this.getRequest(actor, requestId);
    return request.history;
  }

  async approve(actor: Actor, requestId: number, comment?: unknown) {
    const companyId = await this.companyId(actor);
    const actorId = this.actorId(actor);
    const decisionComment = this.comment(comment);
    const request = await this.prisma.$transaction(async (tx) => {
      await this.entitlements.assertEnabledForTransaction(
        tx,
        companyId,
        'crm-advanced',
      );
      const current = await tx.employeeLeaveRequest.findFirst({
        where: { id: requestId, companyId },
        include: {
          employee: { select: { id: true, userId: true, department: true } },
        },
      });
      if (!current) throw new NotFoundException('Leave request was not found.');
      await this.assertEmployeeScope(actor, companyId, current.employeeId);
      if (current.employee.userId === actorId) {
        throw new ForbiddenException(
          'You cannot approve your own leave request.',
        );
      }
      await this.lockEmployee(tx, current.employeeId, companyId);
      const fresh = await tx.employeeLeaveRequest.findFirst({
        where: { id: requestId, companyId },
      });
      if (!fresh) throw new NotFoundException('Leave request was not found.');
      if (fresh.status !== EmployeeLeaveStatus.PENDING) {
        throw new ConflictException(
          'Only pending leave requests can be approved.',
        );
      }
      if (
        fresh.leaveDates.some(
          (date) => date.toISOString().slice(0, 10) <= this.dateInPakistan(),
        )
      ) {
        throw new ConflictException(
          'A request cannot be approved after one of its selected leave dates has begun.',
        );
      }
      const activeType = await tx.employeeLeaveType.findFirst({
        where: {
          id: fresh.leaveTypeId,
          companyId,
          isActive: true,
        },
        select: { id: true },
      });
      if (!activeType) {
        throw new ConflictException(
          'The leave type is inactive; this request cannot be approved.',
        );
      }
      const approved = await tx.employeeLeaveRequest.findMany({
        where: {
          companyId,
          employeeId: current.employeeId,
          id: { not: requestId },
          status: EmployeeLeaveStatus.APPROVED,
          startDate: { lte: fresh.endDate },
          endDate: { gte: fresh.startDate },
        },
        select: { leaveDates: true },
      });
      const approvedDates = new Set(
        approved.flatMap((item) =>
          item.leaveDates.map((date) => date.toISOString()),
        ),
      );
      if (
        fresh.leaveDates.some((date) => approvedDates.has(date.toISOString()))
      ) {
        throw new ConflictException(
          'These dates conflict with another approved leave request.',
        );
      }
      const datesByYear = this.datesByYear(fresh.leaveDates);
      const balances = await tx.employeeLeaveBalance.findMany({
        where: {
          companyId,
          employeeId: fresh.employeeId,
          leaveTypeId: fresh.leaveTypeId,
          periodYear: { in: [...datesByYear.keys()] },
        },
      });
      if (balances.length !== datesByYear.size) {
        throw new ConflictException(
          'Leave balance has not been explicitly allocated for every requested calendar year.',
        );
      }
      for (const balance of balances) {
        const days = datesByYear.get(balance.periodYear) ?? 0;
        const available =
          Number(balance.allocatedDays) +
          Number(balance.adjustmentDays) -
          Number(balance.usedDays);
        if (available < days) {
          throw new ConflictException(
            `Insufficient leave balance for ${balance.periodYear}. Available: ${available.toFixed(2)} day(s).`,
          );
        }
      }
      const now = new Date();
      for (const balance of balances) {
        const days = datesByYear.get(balance.periodYear) ?? 0;
        await tx.employeeLeaveBalance.update({
          where: { id: balance.id },
          data: { usedDays: { increment: new Prisma.Decimal(days) } },
        });
        await tx.employeeLeaveBalanceEntry.create({
          data: {
            companyId,
            balanceId: balance.id,
            leaveRequestId: fresh.id,
            actorUserId: actorId,
            entryType: EmployeeLeaveBalanceEntryType.LEAVE_APPROVAL,
            deltaDays: new Prisma.Decimal(-days),
            reason: `Approved leave request #${fresh.id}`,
          },
        });
      }
      const updated = await tx.employeeLeaveRequest.update({
        where: { id: fresh.id },
        data: {
          status: EmployeeLeaveStatus.APPROVED,
          decidedAt: now,
          decidedByUserId: actorId,
          decisionComment,
        },
        include: {
          employee: {
            select: { id: true, name: true, user: { select: { email: true } } },
          },
          leaveType: true,
        },
      });
      await tx.employeeLeaveHistory.create({
        data: {
          companyId,
          requestId: fresh.id,
          actorUserId: actorId,
          action: EmployeeLeaveHistoryAction.APPROVED,
          previousStatus: EmployeeLeaveStatus.PENDING,
          newStatus: EmployeeLeaveStatus.APPROVED,
          comment: decisionComment,
        },
      });
      const cancelledAttendance = await tx.employeeAttendance.findMany({
        where: {
          companyId,
          employeeId: fresh.employeeId,
          attendanceDate: { in: fresh.leaveDates },
          status: AttendanceStatus.CANCELLED_LEAVE,
          checkInAt: null,
          checkOutAt: null,
          leaveRequestId: null,
        },
        select: { id: true },
      });
      if (cancelledAttendance.length) {
        await tx.employeeAttendance.updateMany({
          where: { id: { in: cancelledAttendance.map((item) => item.id) } },
          data: {
            status: AttendanceStatus.APPROVED_LEAVE,
            leaveRequestId: fresh.id,
          },
        });
      }
      await tx.employeeAttendance.createMany({
        data: fresh.leaveDates.map((attendanceDate) => ({
          companyId,
          employeeId: fresh.employeeId,
          attendanceDate,
          status: AttendanceStatus.APPROVED_LEAVE,
          leaveRequestId: fresh.id,
          updatedAt: now,
        })),
        skipDuplicates: true,
      });
      await this.audit(
        tx,
        actorId,
        'LEAVE_REQUEST_APPROVED',
        'EmployeeLeaveRequest',
        fresh.id,
        {
          days: fresh.requestedDays,
          balanceYears: [...datesByYear.keys()],
        },
      );
      return updated;
    });
    await this.notify(
      request.employee.user?.email,
      'Leave request approved',
      `Your ${request.leaveType.name} leave request for ${request.requestedDays} day(s) was approved.`,
      actorId,
    );
    return request;
  }

  async reject(actor: Actor, requestId: number, comment?: unknown) {
    const companyId = await this.companyId(actor);
    const actorId = this.actorId(actor);
    const decisionComment = this.comment(comment);
    if (!decisionComment) {
      throw new BadRequestException('A rejection reason is required.');
    }
    const request = await this.prisma.$transaction(async (tx) => {
      await this.entitlements.assertEnabledForTransaction(
        tx,
        companyId,
        'crm-advanced',
      );
      const current = await tx.employeeLeaveRequest.findFirst({
        where: { id: requestId, companyId },
        include: {
          employee: { select: { id: true, userId: true, department: true } },
        },
      });
      if (!current) throw new NotFoundException('Leave request was not found.');
      await this.assertEmployeeScope(actor, companyId, current.employeeId);
      if (current.employee.userId === actorId) {
        throw new ForbiddenException(
          'You cannot reject your own leave request.',
        );
      }
      await this.lockEmployee(tx, current.employeeId, companyId);
      const fresh = await tx.employeeLeaveRequest.findFirst({
        where: { id: requestId, companyId },
      });
      if (!fresh || fresh.status !== EmployeeLeaveStatus.PENDING) {
        throw new ConflictException(
          'Only pending leave requests can be rejected.',
        );
      }
      const updated = await tx.employeeLeaveRequest.update({
        where: { id: fresh.id },
        data: {
          status: EmployeeLeaveStatus.REJECTED,
          decidedAt: new Date(),
          decidedByUserId: actorId,
          decisionComment,
        },
        include: {
          employee: { select: { id: true, user: { select: { email: true } } } },
          leaveType: true,
        },
      });
      await tx.employeeLeaveHistory.create({
        data: {
          companyId,
          requestId: fresh.id,
          actorUserId: actorId,
          action: EmployeeLeaveHistoryAction.REJECTED,
          previousStatus: EmployeeLeaveStatus.PENDING,
          newStatus: EmployeeLeaveStatus.REJECTED,
          comment: decisionComment,
        },
      });
      await this.audit(
        tx,
        actorId,
        'LEAVE_REQUEST_REJECTED',
        'EmployeeLeaveRequest',
        fresh.id,
        {
          comment: decisionComment,
        },
      );
      return updated;
    });
    await this.notify(
      request.employee.user?.email,
      'Leave request not approved',
      `Your ${request.leaveType.name} leave request was rejected. Reason: ${decisionComment}`,
      actorId,
    );
    return request;
  }

  async cancel(actor: Actor, requestId: number, comment?: unknown) {
    const companyId = await this.companyId(actor);
    const actorId = this.actorId(actor);
    const cancellationComment = this.comment(comment);
    const request = await this.prisma.$transaction(async (tx) => {
      await this.entitlements.assertEnabledForTransaction(
        tx,
        companyId,
        'crm-advanced',
      );
      const current = await tx.employeeLeaveRequest.findFirst({
        where: { id: requestId, companyId },
        include: {
          employee: {
            select: { id: true, userId: true, department: true },
          },
        },
      });
      if (!current) throw new NotFoundException('Leave request was not found.');
      const isAdmin = this.isCompanyAdmin(actor, companyId);
      if (!isAdmin) this.assertCanManageOwnRequest(actor, current.employee);
      await this.lockEmployee(tx, current.employeeId, companyId);
      const fresh = await tx.employeeLeaveRequest.findFirst({
        where: { id: requestId, companyId },
      });
      if (!fresh) throw new NotFoundException('Leave request was not found.');
      if (
        fresh.status !== EmployeeLeaveStatus.PENDING &&
        fresh.status !== EmployeeLeaveStatus.APPROVED
      ) {
        throw new ConflictException(
          'Only pending or approved leave requests can be cancelled.',
        );
      }
      if (
        fresh.status === EmployeeLeaveStatus.APPROVED &&
        fresh.leaveDates.some(
          (date) => date.toISOString().slice(0, 10) <= this.dateInPakistan(),
        )
      ) {
        throw new ConflictException(
          'Approved leave cannot be cancelled after any leave date has begun. Use a balance adjustment if a correction is needed.',
        );
      }
      if (fresh.status === EmployeeLeaveStatus.APPROVED) {
        await tx.$queryRaw<Array<{ id: number }>>`
          SELECT "id" FROM "EmployeeAttendance"
          WHERE "companyId" = ${companyId}
            AND "leaveRequestId" = ${fresh.id}
          FOR UPDATE`;
        const correctedAttendance = await tx.employeeAttendance.count({
          where: {
            companyId,
            leaveRequestId: fresh.id,
            OR: [
              { status: { not: AttendanceStatus.APPROVED_LEAVE } },
              { checkInAt: { not: null } },
              { checkOutAt: { not: null } },
            ],
          },
        });
        if (correctedAttendance > 0) {
          throw new ConflictException(
            'Attendance linked to this leave was manually corrected. Resolve that record before cancelling the request.',
          );
        }
        const datesByYear = this.datesByYear(fresh.leaveDates);
        const balances = await tx.employeeLeaveBalance.findMany({
          where: {
            companyId,
            employeeId: fresh.employeeId,
            leaveTypeId: fresh.leaveTypeId,
            periodYear: { in: [...datesByYear.keys()] },
          },
        });
        if (balances.length !== datesByYear.size) {
          throw new ConflictException(
            'The original leave balance records are missing; cancellation was not applied.',
          );
        }
        for (const balance of balances) {
          const days = datesByYear.get(balance.periodYear) ?? 0;
          if (Number(balance.usedDays) < days) {
            throw new ConflictException(
              'The original leave balance has changed; cancellation was not applied.',
            );
          }
          await tx.employeeLeaveBalance.update({
            where: { id: balance.id },
            data: { usedDays: { decrement: new Prisma.Decimal(days) } },
          });
          await tx.employeeLeaveBalanceEntry.create({
            data: {
              companyId,
              balanceId: balance.id,
              leaveRequestId: fresh.id,
              actorUserId: actorId,
              entryType: EmployeeLeaveBalanceEntryType.LEAVE_REVERSAL,
              deltaDays: new Prisma.Decimal(days),
              reason: `Cancelled approved leave request #${fresh.id}`,
            },
          });
        }
        await tx.employeeAttendance.updateMany({
          where: {
            companyId,
            leaveRequestId: fresh.id,
            status: AttendanceStatus.APPROVED_LEAVE,
            checkInAt: null,
            checkOutAt: null,
          },
          data: {
            status: AttendanceStatus.CANCELLED_LEAVE,
            leaveRequestId: null,
          },
        });
      }
      const updated = await tx.employeeLeaveRequest.update({
        where: { id: fresh.id },
        data: {
          status: EmployeeLeaveStatus.CANCELLED,
          cancelledAt: new Date(),
          decisionComment: cancellationComment,
        },
        include: {
          employee: {
            select: { id: true, name: true, user: { select: { email: true } } },
          },
          leaveType: true,
        },
      });
      await tx.employeeLeaveHistory.create({
        data: {
          companyId,
          requestId: fresh.id,
          actorUserId: actorId,
          action: EmployeeLeaveHistoryAction.CANCELLED,
          previousStatus: fresh.status,
          newStatus: EmployeeLeaveStatus.CANCELLED,
          comment: cancellationComment,
        },
      });
      await this.audit(
        tx,
        actorId,
        'LEAVE_REQUEST_CANCELLED',
        'EmployeeLeaveRequest',
        fresh.id,
        {
          previousStatus: fresh.status,
          reason: cancellationComment,
        },
      );
      return updated;
    });
    await this.notify(
      request.employee.user?.email,
      'Leave request cancelled',
      `Your ${request.leaveType.name} leave request was cancelled.`,
      actorId,
    );
    return request;
  }

  private comment(value: unknown): string | null {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') {
      throw new BadRequestException('Comment must be text.');
    }
    const comment = value.trim();
    if (comment.length > 1000) {
      throw new BadRequestException(
        'Comment must be 1000 characters or fewer.',
      );
    }
    return comment || null;
  }

  private datesByYear(dates: Date[]): Map<number, number> {
    const counts = new Map<number, number>();
    for (const date of dates) {
      const year = date.getUTCFullYear();
      counts.set(year, (counts.get(year) ?? 0) + 1);
    }
    return counts;
  }

  async listBalances(actor: Actor, query: LeaveListQuery = {}) {
    const companyId = await this.companyId(actor);
    let employeeId: number | undefined;
    if (this.isCompanyAdmin(actor, companyId)) {
      if (query.employeeId !== undefined && query.employeeId !== '') {
        employeeId = this.positiveInt(query.employeeId, 'Employee ID');
      }
    } else {
      const actorEmployee = await this.employeeForActor(
        companyId,
        this.actorId(actor),
      );
      if (
        actorEmployee.department &&
        ((await this.hasPermission(actor, 'hr.leave.approve')) ||
          (await this.hasPermission(actor, 'hr.leave.manage_balances')))
      ) {
        if (query.employeeId !== undefined && query.employeeId !== '') {
          const requestedEmployeeId = this.positiveInt(
            query.employeeId,
            'Employee ID',
          );
          await this.assertEmployeeScope(
            actor,
            companyId,
            requestedEmployeeId,
            true,
          );
          return this.prisma.employeeLeaveBalance.findMany({
            where: {
              companyId,
              employeeId: requestedEmployeeId,
              ...(query.year
                ? { periodYear: this.positiveInt(query.year, 'Year') }
                : {}),
            },
            include: {
              employee: {
                select: { id: true, name: true, department: true },
              },
              leaveType: {
                select: { id: true, name: true, isPaid: true },
              },
              entries: { orderBy: { createdAt: 'desc' } },
            },
            orderBy: [{ periodYear: 'desc' }, { employeeId: 'asc' }],
          });
        }
        return this.prisma.employeeLeaveBalance.findMany({
          where: {
            companyId,
            employee: { department: actorEmployee.department },
            ...(query.year
              ? { periodYear: this.positiveInt(query.year, 'Year') }
              : {}),
          },
          include: {
            employee: { select: { id: true, name: true, department: true } },
            leaveType: { select: { id: true, name: true, isPaid: true } },
            entries: { orderBy: { createdAt: 'desc' } },
          },
          orderBy: [{ periodYear: 'desc' }, { employeeId: 'asc' }],
        });
      }
      employeeId = actorEmployee.id;
    }
    const year =
      query.year === undefined || query.year === ''
        ? undefined
        : this.positiveInt(query.year, 'Year');
    return this.prisma.employeeLeaveBalance.findMany({
      where: {
        companyId,
        ...(employeeId ? { employeeId } : {}),
        ...(year ? { periodYear: year } : {}),
      },
      include: {
        employee: { select: { id: true, name: true, department: true } },
        leaveType: { select: { id: true, name: true, isPaid: true } },
        entries: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: [{ periodYear: 'desc' }, { employeeId: 'asc' }],
    });
  }

  async allocateBalance(
    actor: Actor,
    input: {
      employeeId?: unknown;
      leaveTypeId?: unknown;
      year?: unknown;
      days?: unknown;
      reason?: unknown;
    },
  ) {
    const companyId = await this.companyId(actor);
    const actorId = this.actorId(actor);
    const employeeId = this.positiveInt(input.employeeId, 'Employee ID');
    const leaveTypeId = this.positiveInt(input.leaveTypeId, 'Leave type ID');
    const year = this.positiveInt(input.year, 'Year');
    const days = this.decimalDays(input.days, 'Allocation');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (year < 1900 || year > 2200)
      throw new BadRequestException('Year must be between 1900 and 2200.');
    if (!Number.isFinite(days) || days < 0 || days > 366)
      throw new BadRequestException(
        'Allocation must be between 0 and 366 days.',
      );
    if (!reason || reason.length > 500)
      throw new BadRequestException(
        'Allocation reason is required and limited to 500 characters.',
      );
    await this.assertEmployeeScope(actor, companyId, employeeId, true);
    const leaveType = await this.prisma.employeeLeaveType.findFirst({
      where: { id: leaveTypeId, companyId, isActive: true },
      select: { id: true },
    });
    if (!leaveType)
      throw new NotFoundException('Active leave type was not found.');
    return this.prisma.$transaction(async (tx) => {
      await this.entitlements.assertEnabledForTransaction(
        tx,
        companyId,
        'crm-advanced',
      );
      await this.lockEmployee(tx, employeeId, companyId);
      const existing = await tx.employeeLeaveBalance.findUnique({
        where: {
          companyId_employeeId_leaveTypeId_periodYear: {
            companyId,
            employeeId,
            leaveTypeId,
            periodYear: year,
          },
        },
      });
      if (existing) {
        throw new ConflictException(
          'A balance already exists; use an adjustment to change it.',
        );
      }
      const balance = await tx.employeeLeaveBalance.create({
        data: {
          companyId,
          employeeId,
          leaveTypeId,
          periodYear: year,
          allocatedDays: new Prisma.Decimal(days),
        },
      });
      if (days > 0) {
        await tx.employeeLeaveBalanceEntry.create({
          data: {
            companyId,
            balanceId: balance.id,
            actorUserId: actorId,
            entryType: EmployeeLeaveBalanceEntryType.ALLOCATION,
            deltaDays: new Prisma.Decimal(days),
            reason,
          },
        });
      }
      await this.audit(
        tx,
        actorId,
        'LEAVE_BALANCE_ALLOCATED',
        'EmployeeLeaveBalance',
        balance.id,
        {
          employeeId,
          leaveTypeId,
          year,
          days,
          reason,
        },
      );
      return balance;
    });
  }

  async adjustBalance(
    actor: Actor,
    balanceId: number,
    input: { days?: unknown; reason?: unknown },
  ) {
    const companyId = await this.companyId(actor);
    const actorId = this.actorId(actor);
    const days = this.decimalDays(input.days, 'Adjustment');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 366) {
      throw new BadRequestException(
        'Adjustment must be a non-zero number no greater than 366 days in magnitude.',
      );
    }
    if (!reason || reason.length > 500)
      throw new BadRequestException(
        'Adjustment reason is required and limited to 500 characters.',
      );
    const existing = await this.prisma.employeeLeaveBalance.findFirst({
      where: { id: balanceId, companyId },
      select: { employeeId: true },
    });
    if (!existing) throw new NotFoundException('Leave balance was not found.');
    await this.assertEmployeeScope(actor, companyId, existing.employeeId, true);
    return this.prisma.$transaction(async (tx) => {
      await this.entitlements.assertEnabledForTransaction(
        tx,
        companyId,
        'crm-advanced',
      );
      await this.lockEmployee(tx, existing.employeeId, companyId);
      const balance = await tx.employeeLeaveBalance.findFirst({
        where: { id: balanceId, companyId },
      });
      if (!balance) throw new NotFoundException('Leave balance was not found.');
      const newAdjustment = Number(balance.adjustmentDays) + days;
      if (
        Number(balance.allocatedDays) +
          newAdjustment -
          Number(balance.usedDays) <
        0
      ) {
        throw new ConflictException(
          'Adjustment cannot reduce the available balance below zero.',
        );
      }
      const updated = await tx.employeeLeaveBalance.update({
        where: { id: balance.id },
        data: { adjustmentDays: new Prisma.Decimal(newAdjustment) },
      });
      await tx.employeeLeaveBalanceEntry.create({
        data: {
          companyId,
          balanceId: balance.id,
          actorUserId: actorId,
          entryType: EmployeeLeaveBalanceEntryType.ADJUSTMENT,
          deltaDays: new Prisma.Decimal(days),
          reason,
        },
      });
      await this.audit(
        tx,
        actorId,
        'LEAVE_BALANCE_ADJUSTED',
        'EmployeeLeaveBalance',
        balance.id,
        {
          days,
          reason,
        },
      );
      return updated;
    });
  }
}
