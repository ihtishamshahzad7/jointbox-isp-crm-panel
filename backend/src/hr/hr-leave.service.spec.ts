import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AttendanceStatus, EmployeeLeaveStatus } from '@prisma/client';
import { HrLeaveService } from './hr-leave.service';

const LEAVE_DATE = new Date('2099-03-15T00:00:00.000Z');
const REQUEST = {
  id: 31,
  companyId: 10,
  employeeId: 11,
  leaveTypeId: 4,
  startDate: LEAVE_DATE,
  endDate: LEAVE_DATE,
  leaveDates: [LEAVE_DATE],
  requestedDays: 1,
  reason: 'Personal appointment',
  status: EmployeeLeaveStatus.PENDING,
  employee: { id: 11, userId: 11, department: 'Support' },
};

function make(balanceDays = 3) {
  const updatedRequest = {
    ...REQUEST,
    status: EmployeeLeaveStatus.APPROVED,
    employee: {
      id: 11,
      name: 'Employee',
      user: { email: 'employee@example.test' },
    },
    leaveType: { id: 4, name: 'Personal', isPaid: true },
  };
  const tx = {
    $queryRaw: jest.fn(() => Promise.resolve([{ id: 11 }])),
    employeeLeaveRequest: {
      findFirst: jest.fn(() => Promise.resolve(REQUEST)),
      findMany: jest.fn(
        (): Promise<Array<{ id: number; leaveDates: Date[] }>> =>
          Promise.resolve([]),
      ),
      create: jest.fn(() => Promise.resolve(REQUEST)),
      update: jest.fn(() => Promise.resolve(updatedRequest)),
    },
    employeeLeaveType: {
      findFirst: jest.fn(() => Promise.resolve({ id: 4 })),
    },
    employeeLeaveBalance: {
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            id: 7,
            periodYear: 2099,
            allocatedDays: balanceDays,
            adjustmentDays: 0,
            usedDays: 0,
          },
        ]),
      ),
      update: jest.fn(() => Promise.resolve({ id: 7 })),
    },
    employeeLeaveBalanceEntry: {
      create: jest.fn(() => Promise.resolve({ id: 1 })),
    },
    employeeLeaveHistory: {
      create: jest.fn(() => Promise.resolve({ id: 1 })),
    },
    employeeAttendance: {
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      createMany: jest.fn(() => Promise.resolve({ count: 1 })),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    activityLog: {
      create: jest.fn(() => Promise.resolve({ id: 1 })),
    },
  };
  const prisma = {
    rolePermission: {
      findMany: jest.fn(() => Promise.resolve([{ permission: '*' }])),
    },
    employeeProfile: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 11,
          companyId: 10,
          userId: 11,
          department: 'Support',
        }),
      ),
    },
    employeeLeaveType: {
      findFirst: jest.fn(() => Promise.resolve({ id: 4 })),
    },
    user: {
      findUnique: jest.fn(() =>
        Promise.resolve({ email: 'admin@example.test' }),
      ),
    },
    employeeLeaveRequest: {
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
  const notifications = { send: jest.fn(() => Promise.resolve({ id: 1 })) };
  return {
    service: new HrLeaveService(
      prisma as never,
      scope as never,
      entitlements as never,
      notifications as never,
    ),
    prisma,
    tx,
    entitlements,
    notifications,
  };
}

describe('HrLeaveService', () => {
  it('rejects self-approval before changing the request or balance', async () => {
    const { service, tx } = make();

    await expect(
      service.approve({ sub: 11, role: 'SALES' }, REQUEST.id),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(tx.employeeLeaveRequest.update).not.toHaveBeenCalled();
    expect(tx.employeeLeaveBalance.update).not.toHaveBeenCalled();
  });

  it('rejects a selected date already held by a pending request', async () => {
    const { service, tx } = make();
    tx.employeeLeaveRequest.findMany.mockResolvedValueOnce([
      { id: 30, leaveDates: [LEAVE_DATE] },
    ]);

    await expect(
      service.createRequest(
        { sub: 11, role: 'SALES' },
        {
          leaveTypeId: 4,
          dates: ['2099-03-15'],
          reason: 'Personal appointment',
        },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.employeeLeaveRequest.create).not.toHaveBeenCalled();
  });

  it('requires explicit balance and does not partially approve an overspend', async () => {
    const { service, tx, entitlements } = make(0);

    await expect(
      service.approve({ sub: 10, role: 'ADMIN' }, REQUEST.id),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(entitlements.assertEnabledForTransaction).toHaveBeenCalled();
    expect(tx.employeeLeaveBalance.update).not.toHaveBeenCalled();
    expect(tx.employeeLeaveRequest.update).not.toHaveBeenCalled();
    expect(tx.employeeAttendance.createMany).not.toHaveBeenCalled();
  });

  it('deducts the allocated balance and creates leave-only attendance atomically', async () => {
    const { service, tx, entitlements, notifications } = make();

    await service.approve({ sub: 10, role: 'ADMIN' }, REQUEST.id);

    expect(entitlements.assertEnabledForTransaction).toHaveBeenCalledWith(
      tx,
      10,
      'crm-advanced',
    );
    expect(tx.employeeLeaveBalance.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { usedDays: { increment: expect.anything() } },
    });
    expect(tx.employeeLeaveBalanceEntry.create).toHaveBeenCalled();
    expect(tx.employeeAttendance.createMany).toHaveBeenCalledWith({
      data: [
        {
          companyId: 10,
          employeeId: 11,
          attendanceDate: LEAVE_DATE,
          status: AttendanceStatus.APPROVED_LEAVE,
          leaveRequestId: REQUEST.id,
          updatedAt: expect.any(Date),
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.activityLog.create).toHaveBeenCalled();
    expect(notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'employee@example.test' }),
    );
  });
});
