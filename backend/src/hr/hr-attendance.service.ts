import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProductEntitlementService } from '../common/product-entitlement.service';
import { ScopeService, type Actor } from '../common/scope.service';

const ATTENDANCE_STATUSES = new Set<AttendanceStatus>(
  Object.values(AttendanceStatus),
);
const MAX_PAGE_SIZE = 100;
const MAX_DATE_RANGE_DAYS = 366;

export type AttendanceListQuery = {
  dateFrom?: unknown;
  dateTo?: unknown;
  employeeId?: unknown;
  department?: unknown;
  status?: unknown;
  page?: unknown;
  pageSize?: unknown;
};

export type AttendanceCorrectionInput = {
  reason?: unknown;
  status?: unknown;
  checkInAt?: unknown;
  checkOutAt?: unknown;
};

@Injectable()
export class HrAttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly entitlements: ProductEntitlementService,
  ) {}

  private async companyId(actor: Actor): Promise<number> {
    if (!actor || actor.role === 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Sign in as a company account to access attendance.',
      );
    }
    return (await this.entitlements.assertEnabled(actor, 'crm-advanced'))
      .companyId;
  }

  private isCompanyAdmin(actor: Actor, companyId: number): boolean {
    return actor?.role === 'ADMIN' && this.scope.actorId(actor) === companyId;
  }

  private assertCanRecordForEmployee(
    actor: Actor,
    companyId: number,
    employee: { userId: number | null },
  ): void {
    if (
      this.isCompanyAdmin(actor, companyId) ||
      employee.userId === this.scope.actorId(actor)
    ) {
      return;
    }
    throw new ForbiddenException(
      'You can only record attendance for your own employee profile.',
    );
  }

  private assertCompanyAdmin(actor: Actor, companyId: number): void {
    if (!this.isCompanyAdmin(actor, companyId)) {
      throw new ForbiddenException(
        'Only the company administrator can correct attendance records.',
      );
    }
  }

  private dateOnly(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(
        `${field} must be a valid YYYY-MM-DD date.`,
      );
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    ) {
      throw new BadRequestException(
        `${field} must be a valid YYYY-MM-DD date.`,
      );
    }
    return value;
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

  private pageNumber(value: unknown, field: string, fallback: number): number {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`${field} must be a positive integer.`);
    }
    return parsed;
  }

  private parseFilters(query: AttendanceListQuery = {}) {
    const dateFrom = this.dateOnly(query.dateFrom, 'Start date');
    const dateTo = this.dateOnly(query.dateTo, 'End date');
    const today = this.dateInPakistan();
    const start = dateFrom ?? dateTo ?? today;
    const end = dateTo ?? dateFrom ?? today;
    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T00:00:00.000Z`);
    if (startDate > endDate) {
      throw new BadRequestException('Start date must not be after end date.');
    }
    const rangeDays =
      Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
    if (rangeDays > MAX_DATE_RANGE_DAYS) {
      throw new BadRequestException(
        `Date range must be ${MAX_DATE_RANGE_DAYS} days or fewer.`,
      );
    }

    let employeeId: number | undefined;
    if (query.employeeId !== undefined && query.employeeId !== '') {
      employeeId = this.pageNumber(query.employeeId, 'Employee ID', 1);
    }
    if (query.department != null && typeof query.department !== 'string') {
      throw new BadRequestException('Department must be text.');
    }
    const department = String(query.department ?? '').trim();
    if (department.length > 80) {
      throw new BadRequestException(
        'Department must be 80 characters or fewer.',
      );
    }
    let status: AttendanceStatus | undefined;
    if (query.status !== undefined && query.status !== '') {
      if (typeof query.status !== 'string') {
        throw new BadRequestException('Attendance status must be text.');
      }
      const candidate = query.status.toUpperCase() as AttendanceStatus;
      if (!ATTENDANCE_STATUSES.has(candidate)) {
        throw new BadRequestException('Unknown attendance status.');
      }
      status = candidate;
    }
    const page = this.pageNumber(query.page, 'Page', 1);
    const pageSize = this.pageNumber(query.pageSize, 'Page size', 25);
    if (pageSize > MAX_PAGE_SIZE) {
      throw new BadRequestException(
        `Page size must be ${MAX_PAGE_SIZE} or fewer.`,
      );
    }
    if ((page - 1) * pageSize > 1_000_000) {
      throw new BadRequestException('Page is outside the supported range.');
    }
    return {
      where: {
        attendanceDate: { gte: startDate, lte: endDate },
        ...(employeeId ? { employeeId } : {}),
        ...(department
          ? {
              employee: {
                is: {
                  department: { contains: department, mode: 'insensitive' },
                },
              },
            }
          : {}),
        ...(status ? { status } : {}),
      } satisfies Prisma.EmployeeAttendanceWhereInput,
      page,
      pageSize,
    };
  }

  async findAll(actor: Actor, query: AttendanceListQuery = {}) {
    const companyId = await this.companyId(actor);
    const filters = this.parseFilters(query);
    const where: Prisma.EmployeeAttendanceWhereInput = {
      companyId,
      ...filters.where,
    };
    const [items, total, statusGroups, aggregate] = await Promise.all([
      this.prisma.employeeAttendance.findMany({
        where,
        include: {
          employee: {
            select: {
              id: true,
              employeeNumber: true,
              name: true,
              department: true,
            },
          },
        },
        orderBy: [{ attendanceDate: 'desc' }, { employee: { name: 'asc' } }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.employeeAttendance.count({ where }),
      this.prisma.employeeAttendance.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.employeeAttendance.aggregate({
        where,
        _count: { _all: true, checkInAt: true, checkOutAt: true },
        _sum: { durationMinutes: true },
      }),
    ]);
    const statusCounts = Object.fromEntries(
      [...ATTENDANCE_STATUSES].map((status) => [status, 0]),
    ) as Record<AttendanceStatus, number>;
    for (const group of statusGroups) {
      statusCounts[group.status] = group._count._all;
    }
    return {
      items,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      summary: {
        total: aggregate._count._all,
        checkedIn: aggregate._count.checkInAt,
        checkedOut: aggregate._count.checkOutAt,
        durationMinutes: aggregate._sum.durationMinutes ?? 0,
        statusCounts,
      },
    };
  }

  async employeeHistory(
    actor: Actor,
    employeeId: number,
    query: AttendanceListQuery = {},
  ) {
    const companyId = await this.companyId(actor);
    this.assertId(employeeId, 'Employee ID');
    const employee = await this.prisma.employeeProfile.findFirst({
      where: { id: employeeId, companyId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee profile not found.');
    return this.findAll(actor, { ...query, employeeId });
  }

  async correctionHistory(
    actor: Actor,
    attendanceId: number,
    query: Pick<AttendanceListQuery, 'page' | 'pageSize'> = {},
  ) {
    const companyId = await this.companyId(actor);
    this.assertId(attendanceId, 'Attendance ID');
    const page = this.pageNumber(query.page, 'Page', 1);
    const pageSize = this.pageNumber(query.pageSize, 'Page size', 25);
    if (pageSize > MAX_PAGE_SIZE) {
      throw new BadRequestException(
        `Page size must be ${MAX_PAGE_SIZE} or fewer.`,
      );
    }
    if ((page - 1) * pageSize > 1_000_000) {
      throw new BadRequestException('Page is outside the supported range.');
    }
    const attendance = await this.prisma.employeeAttendance.findFirst({
      where: { id: attendanceId, companyId },
      select: { id: true },
    });
    if (!attendance)
      throw new NotFoundException('Attendance record not found.');
    const [items, total] = await Promise.all([
      this.prisma.employeeAttendanceCorrection.findMany({
        where: { companyId, attendanceId },
        include: {
          actor: { select: { id: true, name: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.employeeAttendanceCorrection.count({
        where: { companyId, attendanceId },
      }),
    ]);
    return { items, total, page, pageSize };
  }

  async checkIn(actor: Actor, employeeId: number) {
    const companyId = await this.companyId(actor);
    this.assertId(employeeId, 'Employee ID');
    const now = new Date();
    const attendanceDate = new Date(`${this.dateInPakistan()}T00:00:00.000Z`);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.entitlements.assertEnabledForTransaction(
          tx,
          companyId,
          'crm-advanced',
        );
        const employee = await tx.employeeProfile.findFirst({
          where: { id: employeeId, companyId },
          select: { id: true, userId: true, status: true },
        });
        if (!employee) {
          throw new NotFoundException('Employee profile not found.');
        }
        this.assertCanRecordForEmployee(actor, companyId, employee);
        if (employee.status !== 'ACTIVE') {
          throw new ConflictException(
            'Attendance can only be recorded for an active employee.',
          );
        }
        const existing = await tx.employeeAttendance.findFirst({
          where: { companyId, employeeId, attendanceDate },
        });
        if (existing) {
          if (
            existing.status !== AttendanceStatus.CANCELLED_LEAVE ||
            existing.checkInAt ||
            existing.checkOutAt ||
            existing.leaveRequestId != null
          ) {
            throw new ConflictException(
              'An attendance record already exists for this employee and date.',
            );
          }
          const reopened = await tx.employeeAttendance.updateMany({
            where: {
              id: existing.id,
              companyId,
              status: AttendanceStatus.CANCELLED_LEAVE,
              checkInAt: null,
              checkOutAt: null,
              leaveRequestId: null,
            },
            data: {
              status: AttendanceStatus.PRESENT,
              checkInAt: now,
              checkOutAt: null,
              durationMinutes: null,
            },
          });
          if (reopened.count !== 1) {
            throw new ConflictException(
              'Attendance changed while recording check-in. Refresh and try again.',
            );
          }
          const attendance = await tx.employeeAttendance.findFirst({
            where: { id: existing.id, companyId },
            include: {
              employee: {
                select: {
                  id: true,
                  employeeNumber: true,
                  name: true,
                  department: true,
                },
              },
            },
          });
          if (!attendance) {
            throw new NotFoundException('Attendance record not found.');
          }
          await tx.employeeAttendanceCorrection.create({
            data: {
              companyId,
              attendanceId: existing.id,
              actorUserId: this.scope.actorId(actor),
              reason: 'Actual check-in superseded a cancelled leave marker.',
              previousStatus: AttendanceStatus.CANCELLED_LEAVE,
              newStatus: AttendanceStatus.PRESENT,
              previousCheckInAt: null,
              newCheckInAt: now,
              previousCheckOutAt: null,
              newCheckOutAt: null,
            },
          });
          await tx.activityLog.create({
            data: {
              userId: this.scope.actorId(actor),
              action: 'HR_ATTENDANCE_CHECK_IN',
              entity: 'EmployeeAttendance',
              entityId: attendance.id,
              details: JSON.stringify({
                employeeId,
                attendanceDate,
                supersededCancelledLeave: true,
              }),
            },
          });
          return attendance;
        }
        const attendance = await tx.employeeAttendance.create({
          data: {
            companyId,
            employeeId,
            attendanceDate,
            checkInAt: now,
            status: AttendanceStatus.PRESENT,
          },
          include: {
            employee: {
              select: {
                id: true,
                employeeNumber: true,
                name: true,
                department: true,
              },
            },
          },
        });
        await tx.activityLog.create({
          data: {
            userId: this.scope.actorId(actor),
            action: 'HR_ATTENDANCE_CHECK_IN',
            entity: 'EmployeeAttendance',
            entityId: attendance.id,
            details: JSON.stringify({ employeeId, attendanceDate }),
          },
        });
        return attendance;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'An attendance record already exists for this employee and date.',
        );
      }
      throw error;
    }
  }

  async checkOut(actor: Actor, employeeId: number) {
    const companyId = await this.companyId(actor);
    this.assertId(employeeId, 'Employee ID');
    const now = new Date();
    const attendanceDate = new Date(`${this.dateInPakistan()}T00:00:00.000Z`);
    return this.prisma.$transaction(async (tx) => {
      await this.entitlements.assertEnabledForTransaction(
        tx,
        companyId,
        'crm-advanced',
      );
      const employee = await tx.employeeProfile.findFirst({
        where: { id: employeeId, companyId },
        select: { id: true, userId: true, status: true },
      });
      if (!employee) throw new NotFoundException('Employee profile not found.');
      this.assertCanRecordForEmployee(actor, companyId, employee);
      const existing = await tx.employeeAttendance.findFirst({
        where: { companyId, employeeId, attendanceDate },
      });
      if (!existing || !existing.checkInAt) {
        throw new ConflictException(
          'A recorded check-in is required before checking out.',
        );
      }
      if (existing.checkOutAt) {
        throw new ConflictException(
          'This attendance record is already closed.',
        );
      }
      const durationMinutes = Math.floor(
        (now.getTime() - existing.checkInAt.getTime()) / 60_000,
      );
      if (durationMinutes < 1) {
        throw new ConflictException(
          'Check-out time must be after the recorded check-in.',
        );
      }
      const updated = await tx.employeeAttendance.updateMany({
        where: {
          id: existing.id,
          companyId,
          checkInAt: existing.checkInAt,
          checkOutAt: null,
        },
        data: { checkOutAt: now, durationMinutes },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          'Attendance changed while checking out. Refresh and try again.',
        );
      }
      const attendance = await tx.employeeAttendance.findFirst({
        where: { id: existing.id, companyId },
        include: {
          employee: {
            select: {
              id: true,
              employeeNumber: true,
              name: true,
              department: true,
            },
          },
        },
      });
      if (!attendance)
        throw new NotFoundException('Attendance record not found.');
      await tx.activityLog.create({
        data: {
          userId: this.scope.actorId(actor),
          action: 'HR_ATTENDANCE_CHECK_OUT',
          entity: 'EmployeeAttendance',
          entityId: attendance.id,
          details: JSON.stringify({ employeeId, durationMinutes }),
        },
      });
      return attendance;
    });
  }

  async correct(
    actor: Actor,
    attendanceId: number,
    input: AttendanceCorrectionInput,
  ) {
    const companyId = await this.companyId(actor);
    this.assertId(attendanceId, 'Attendance ID');
    this.assertCompanyAdmin(actor, companyId);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('Correction must be an object.');
    }
    if (typeof input.reason !== 'string') {
      throw new BadRequestException('A correction reason is required.');
    }
    const reason = input.reason.trim();
    if (!reason || reason.length > 500) {
      throw new BadRequestException(
        'Correction reason must be 1 to 500 characters.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await this.entitlements.assertEnabledForTransaction(
        tx,
        companyId,
        'crm-advanced',
      );
      const locked = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id" FROM "EmployeeAttendance"
        WHERE "id" = ${attendanceId} AND "companyId" = ${companyId}
        FOR UPDATE`;
      if (!locked.length) {
        throw new NotFoundException('Attendance record not found.');
      }
      const existing = await tx.employeeAttendance.findFirst({
        where: { id: attendanceId, companyId },
      });
      if (!existing)
        throw new NotFoundException('Attendance record not found.');
      if (
        existing.leaveRequestId != null ||
        existing.status === AttendanceStatus.CANCELLED_LEAVE
      ) {
        throw new ConflictException(
          'Leave-linked attendance is managed through the leave request and cannot be corrected here.',
        );
      }

      const status = this.correctedStatus(input.status, existing.status);
      if (
        (status === AttendanceStatus.APPROVED_LEAVE &&
          existing.status !== AttendanceStatus.APPROVED_LEAVE) ||
        status === AttendanceStatus.CANCELLED_LEAVE
      ) {
        throw new BadRequestException(
          'Leave attendance statuses are managed through Leave Management.',
        );
      }
      const checkInAt = this.correctedTimestamp(
        input.checkInAt,
        existing.checkInAt,
        'Check-in time',
      );
      const checkOutAt = this.correctedTimestamp(
        input.checkOutAt,
        existing.checkOutAt,
        'Check-out time',
      );
      this.assertValidAttendance(status, checkInAt, checkOutAt);
      const durationMinutes =
        checkInAt && checkOutAt
          ? Math.floor((checkOutAt.getTime() - checkInAt.getTime()) / 60_000)
          : null;
      const update = await tx.employeeAttendance.updateMany({
        where: { id: attendanceId, companyId },
        data: { status, checkInAt, checkOutAt, durationMinutes },
      });
      if (update.count !== 1) {
        throw new ConflictException(
          'Attendance changed while applying the correction.',
        );
      }
      const corrected = await tx.employeeAttendance.findFirst({
        where: { id: attendanceId, companyId },
        include: {
          employee: {
            select: {
              id: true,
              employeeNumber: true,
              name: true,
              department: true,
            },
          },
        },
      });
      if (!corrected)
        throw new NotFoundException('Attendance record not found.');
      await tx.employeeAttendanceCorrection.create({
        data: {
          companyId,
          attendanceId,
          actorUserId: this.scope.actorId(actor),
          reason,
          previousStatus: existing.status,
          newStatus: status,
          previousCheckInAt: existing.checkInAt,
          newCheckInAt: checkInAt,
          previousCheckOutAt: existing.checkOutAt,
          newCheckOutAt: checkOutAt,
        },
      });
      await tx.activityLog.create({
        data: {
          userId: this.scope.actorId(actor),
          action: 'HR_ATTENDANCE_CORRECTED',
          entity: 'EmployeeAttendance',
          entityId: attendanceId,
          details: JSON.stringify({
            reason,
            previousStatus: existing.status,
            newStatus: status,
          }),
        },
      });
      return corrected;
    });
  }

  private correctedStatus(
    value: unknown,
    fallback: AttendanceStatus,
  ): AttendanceStatus {
    if (value === undefined) return fallback;
    if (typeof value !== 'string') {
      throw new BadRequestException('Attendance status must be text.');
    }
    const status = value.toUpperCase() as AttendanceStatus;
    if (!ATTENDANCE_STATUSES.has(status)) {
      throw new BadRequestException('Unknown attendance status.');
    }
    return status;
  }

  private correctedTimestamp(
    value: unknown,
    fallback: Date | null,
    field: string,
  ): Date | null {
    if (value === undefined) return fallback;
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
      throw new BadRequestException(
        `${field} must include an ISO 8601 timezone.`,
      );
    }
    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime())) {
      throw new BadRequestException(`${field} must be a valid date-time.`);
    }
    return timestamp;
  }

  private assertValidAttendance(
    status: AttendanceStatus,
    checkInAt: Date | null,
    checkOutAt: Date | null,
  ): void {
    if (checkOutAt && !checkInAt) {
      throw new BadRequestException(
        'A check-out time requires a recorded check-in time.',
      );
    }
    if (checkInAt && checkOutAt && checkOutAt <= checkInAt) {
      throw new BadRequestException(
        'Check-out time must be after check-in time.',
      );
    }
    if (
      (status === AttendanceStatus.ABSENT ||
        status === AttendanceStatus.APPROVED_LEAVE ||
        status === AttendanceStatus.CANCELLED_LEAVE) &&
      (checkInAt || checkOutAt)
    ) {
      throw new BadRequestException(
        'Absent and approved leave records cannot contain check-in or check-out times.',
      );
    }
  }

  private assertId(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new BadRequestException(`${field} must be a positive integer.`);
    }
  }
}
