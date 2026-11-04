import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceStatus, Prisma } from '@prisma/client';
import { HrAttendanceService } from './hr-attendance.service';

const ADMIN = { sub: 10, role: 'ADMIN' };
const EMPLOYEE = { sub: 11, role: 'SALES' };
const CHECK_IN = new Date(Date.now() - 3_600_000);
const RECORD: {
  id: number;
  companyId: number;
  employeeId: number;
  attendanceDate: Date;
  status: AttendanceStatus;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  durationMinutes: number | null;
  leaveRequestId?: number | null;
} = {
  id: 21,
  companyId: 10,
  employeeId: 11,
  attendanceDate: new Date('2026-11-02T00:00:00.000Z'),
  status: AttendanceStatus.PRESENT,
  checkInAt: CHECK_IN,
  checkOutAt: null,
  durationMinutes: null,
};

function make() {
  const tx = {
    $queryRaw: jest.fn(() => Promise.resolve([{ id: RECORD.id }])),
    employeeProfile: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 11,
          companyId: 10,
          userId: 11,
          status: 'ACTIVE',
        }),
      ),
    },
    employeeAttendance: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        void args;
        return Promise.resolve(RECORD);
      }),
      findFirst: jest.fn((): Promise<typeof RECORD | null> => Promise.resolve(RECORD)),
      updateMany: jest.fn(
        (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          void args;
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    employeeAttendanceCorrection: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        void args;
        return Promise.resolve({ id: 1 });
      }),
    },
    activityLog: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        void args;
        return Promise.resolve({ id: 1 });
      }),
    },
  };
  const prisma = {
    employeeProfile: {
      findFirst: jest.fn(
        (): Promise<{ id: number; companyId: number } | null> =>
          Promise.resolve({ id: 11, companyId: 10 }),
      ),
    },
    employeeAttendance: {
      findMany: jest.fn(
        (args: {
          where: Record<string, unknown>;
          skip: number;
          take: number;
        }) => {
          void args;
          return Promise.resolve([RECORD]);
        },
      ),
      findFirst: jest.fn(() => Promise.resolve(RECORD)),
      count: jest.fn(() => Promise.resolve(1)),
      groupBy: jest.fn(() =>
        Promise.resolve([
          { status: AttendanceStatus.PRESENT, _count: { _all: 1 } },
        ]),
      ),
      aggregate: jest.fn(() =>
        Promise.resolve({
          _count: { _all: 1, checkInAt: 1, checkOutAt: 0 },
          _sum: { durationMinutes: 0 },
        }),
      ),
    },
    employeeAttendanceCorrection: {
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
    },
    $transaction: jest.fn((work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };
  const scope = {
    actorId: jest.fn((actor: { sub: number }) => actor.sub),
  };
  const entitlements = {
    assertEnabled: jest.fn(() =>
      Promise.resolve({ companyId: 10, enabled: true }),
    ),
    assertEnabledForTransaction: jest.fn(() => Promise.resolve()),
  };
  return {
    service: new HrAttendanceService(
      prisma as never,
      scope as never,
      entitlements as never,
    ),
    prisma,
    tx,
    scope,
    entitlements,
  };
}

describe('HrAttendanceService', () => {
  it('returns tenant-scoped summaries and bounded filtered pages', async () => {
    const { service, prisma } = make();
    const result = await service.findAll(ADMIN, {
      dateFrom: '2026-11-01',
      dateTo: '2026-11-03',
      employeeId: '11',
      department: 'network',
      status: 'present',
      page: '2',
      pageSize: '20',
    });

    const args = prisma.employeeAttendance.findMany.mock.calls[0]?.[0];
    expect(args?.where).toMatchObject({
      companyId: 10,
      employeeId: 11,
      status: AttendanceStatus.PRESENT,
      employee: { is: { department: { contains: 'network' } } },
    });
    expect(args?.skip).toBe(20);
    expect(args?.take).toBe(20);
    expect(result.summary).toMatchObject({
      total: 1,
      checkedIn: 1,
      checkedOut: 0,
      statusCounts: { PRESENT: 1, ABSENT: 0 },
    });
  });

  it('rejects invalid and overlong date filters', async () => {
    const { service } = make();
    await expect(
      service.findAll(ADMIN, { dateFrom: '2026-02-30' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.findAll(ADMIN, {
        dateFrom: '2025-01-01',
        dateTo: '2026-11-02',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records a check-in and audit event inside the transaction', async () => {
    const { service, prisma, tx, entitlements } = make();
    tx.employeeAttendance.findFirst.mockResolvedValueOnce(null);
    await service.checkIn(ADMIN, 11);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(entitlements.assertEnabledForTransaction).toHaveBeenCalledWith(
      tx,
      10,
      'crm-advanced',
    );
    expect(tx.employeeAttendance.create.mock.calls[0]?.[0].data).toMatchObject({
      companyId: 10,
      employeeId: 11,
      status: AttendanceStatus.PRESENT,
    });
    expect(
      tx.employeeAttendance.create.mock.calls[0]?.[0].data.checkInAt,
    ).toBeInstanceOf(Date);
    expect(tx.activityLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'HR_ATTENDANCE_CHECK_IN',
      entityId: RECORD.id,
    });
  });

  it('reopens a cancelled leave marker for a real check-in with history', async () => {
    const { service, tx } = make();
    tx.employeeAttendance.findFirst.mockResolvedValueOnce({
      ...RECORD,
      status: AttendanceStatus.CANCELLED_LEAVE,
      checkInAt: null,
      checkOutAt: null,
      leaveRequestId: null,
    });

    await service.checkIn(EMPLOYEE, 11);

    expect(tx.employeeAttendance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: AttendanceStatus.CANCELLED_LEAVE,
          leaveRequestId: null,
        }),
        data: expect.objectContaining({
          status: AttendanceStatus.PRESENT,
          checkInAt: expect.any(Date),
        }),
      }),
    );
    expect(tx.employeeAttendanceCorrection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        previousStatus: AttendanceStatus.CANCELLED_LEAVE,
        newStatus: AttendanceStatus.PRESENT,
      }),
    });
  });

  it('allows employee self-service but denies recording another employee', async () => {
    const { service, tx } = make();
    tx.employeeAttendance.findFirst.mockResolvedValueOnce(null);
    await service.checkIn(EMPLOYEE, 11);
    expect(tx.employeeAttendance.create).toHaveBeenCalledTimes(1);

    tx.employeeProfile.findFirst.mockResolvedValue({
      id: 12,
      companyId: 10,
      userId: 12,
      status: 'ACTIVE',
    });
    await expect(service.checkIn(EMPLOYEE, 12)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('prevents a duplicate employee attendance record', async () => {
    const { service, tx } = make();
    tx.employeeAttendance.findFirst.mockResolvedValueOnce(null);
    tx.employeeAttendance.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.checkIn(ADMIN, 11)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.activityLog.create).not.toHaveBeenCalled();
  });

  it('requires a recorded check-in and prevents a second check-out', async () => {
    const { service, tx } = make();
    tx.employeeAttendance.findFirst.mockResolvedValueOnce({
      ...RECORD,
      checkInAt: null,
    });
    await expect(service.checkOut(ADMIN, 11)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.employeeAttendance.updateMany).not.toHaveBeenCalled();

    tx.employeeAttendance.findFirst.mockResolvedValueOnce({
      ...RECORD,
      checkOutAt: new Date(),
    });
    await expect(service.checkOut(ADMIN, 11)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('records a check-out and its duration only after a check-in', async () => {
    const { service, tx } = make();
    await service.checkOut(ADMIN, 11);

    expect(tx.employeeAttendance.updateMany).toHaveBeenCalledTimes(1);
    expect(
      tx.employeeAttendance.updateMany.mock.calls[0]?.[0].where,
    ).toMatchObject({
      id: RECORD.id,
      companyId: 10,
      checkOutAt: null,
    });
    expect(
      tx.employeeAttendance.updateMany.mock.calls[0]?.[0].data.checkOutAt,
    ).toBeInstanceOf(Date);
    expect(
      typeof tx.employeeAttendance.updateMany.mock.calls[0]?.[0].data
        .durationMinutes,
    ).toBe('number');
    expect(tx.activityLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'HR_ATTENDANCE_CHECK_OUT',
      entityId: RECORD.id,
    });
  });

  it('records authorized corrections, snapshots and audit events atomically', async () => {
    const { service, tx } = make();
    await service.correct(ADMIN, RECORD.id, {
      status: 'LATE',
      reason: 'Supervisor approved the corrected check-in.',
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(
      tx.employeeAttendanceCorrection.create.mock.calls[0]?.[0].data,
    ).toMatchObject({
      companyId: 10,
      attendanceId: RECORD.id,
      actorUserId: 10,
      reason: 'Supervisor approved the corrected check-in.',
      previousStatus: AttendanceStatus.PRESENT,
      newStatus: AttendanceStatus.LATE,
      previousCheckInAt: CHECK_IN,
    });
    expect(tx.activityLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'HR_ATTENDANCE_CORRECTED',
      entityId: RECORD.id,
    });
  });

  it('restricts corrections, rejects conflicting values, and scopes records by company', async () => {
    const { service, tx, prisma } = make();
    await expect(
      service.correct(EMPLOYEE, RECORD.id, { reason: 'Wrong time' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.correct(ADMIN, RECORD.id, {
        status: 'ABSENT',
        reason: 'Mark absent',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.employeeAttendanceCorrection.create).not.toHaveBeenCalled();

    prisma.employeeProfile.findFirst.mockResolvedValue(null);
    await expect(service.employeeHistory(ADMIN, 999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('denies a write if the CRM entitlement changes before transaction completion', async () => {
    const { service, tx, entitlements } = make();
    entitlements.assertEnabledForTransaction.mockRejectedValue(
      new ForbiddenException('disabled'),
    );
    await expect(service.checkIn(ADMIN, 11)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tx.employeeAttendance.create).not.toHaveBeenCalled();
  });

  it('propagates audit failures so the database transaction can roll back', async () => {
    const { service, tx, prisma } = make();
    tx.employeeAttendance.findFirst.mockResolvedValueOnce(null);
    tx.activityLog.create.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.checkIn(ADMIN, 11)).rejects.toThrow(
      'audit unavailable',
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.employeeAttendance.create).toHaveBeenCalledTimes(1);
  });
});
