import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { HrEmployeesService } from './hr-employees.service';

const ACTOR = { id: 10, sub: 10, role: 'ADMIN' };
const PROFILE = {
  id: 1,
  companyId: 10,
  userId: 11,
  employeeNumber: 'EMP-01',
  name: 'Technician One',
  department: 'Network',
  designation: 'Technician',
  hiredAt: null,
  status: 'ACTIVE',
};

function make() {
  const tx = {
    employeeProfile: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        void args;
        return Promise.resolve(PROFILE);
      }),
      update: jest.fn(() => Promise.resolve(PROFILE)),
      delete: jest.fn(() => Promise.resolve(PROFILE)),
    },
    activityLog: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        void args;
        return Promise.resolve({});
      }),
    },
  };
  const prisma = {
    employeeProfile: {
      findMany: jest.fn(
        (args: { where: Record<string, unknown>; take: number }) => {
          void args;
          return Promise.resolve([PROFILE]);
        },
      ),
      findFirst: jest.fn(() => Promise.resolve({ id: 1 })),
    },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) =>
      Promise.resolve(work(tx)),
    ),
  };
  const scope = {
    actorId: jest.fn(() => 10),
    descendantIds: jest.fn(() => Promise.resolve([10, 11])),
  };
  const entitlements = {
    assertEnabled: jest.fn(() => Promise.resolve({ companyId: 10 })),
    assertEnabledForTransaction: jest.fn(() => Promise.resolve()),
  };
  return {
    service: new HrEmployeesService(
      prisma as never,
      scope as never,
      entitlements as never,
    ),
    prisma,
    scope,
    tx,
    entitlements,
  };
}

describe('HrEmployeesService', () => {
  it('scopes profile listing to the caller company and bounds results', async () => {
    const { service, prisma } = make();
    await service.findAll(ACTOR, { search: 'tech', status: 'active' });
    const args = prisma.employeeProfile.findMany.mock.calls[0]?.[0];
    expect(args?.where).toMatchObject({ companyId: 10, status: 'ACTIVE' });
    expect(args?.take).toBe(500);
  });

  it('creates a profile and audit record in the same transaction', async () => {
    const { service, prisma, tx, entitlements } = make();
    await service.create(ACTOR, {
      employeeNumber: 'EMP-01',
      name: 'Technician One',
      userId: 11,
      department: 'Network',
      designation: 'Technician',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(entitlements.assertEnabledForTransaction).toHaveBeenCalledWith(
      tx,
      10,
      'crm-advanced',
    );
    const createData = tx.employeeProfile.create.mock.calls[0]?.[0].data;
    expect(createData).toMatchObject({ companyId: 10, userId: 11 });
    const auditData = tx.activityLog.create.mock.calls[0]?.[0].data;
    expect(auditData).toMatchObject({
      action: 'HR_EMPLOYEE_PROFILE_CREATED',
      entityId: PROFILE.id,
    });
  });

  it('does not allow a linked account outside the company tree', async () => {
    const { service, tx } = make();
    await expect(
      service.create(ACTOR, {
        employeeNumber: 'EMP-02',
        name: 'External User',
        userId: 99,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.employeeProfile.create).not.toHaveBeenCalled();
  });

  it('rechecks the feature entitlement under database locks before writing', async () => {
    const { service, tx, entitlements } = make();
    entitlements.assertEnabledForTransaction.mockRejectedValue(
      new ForbiddenException('disabled'),
    );
    await expect(
      service.create(ACTOR, {
        employeeNumber: 'EMP-03',
        name: 'Staff',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(entitlements.assertEnabledForTransaction).toHaveBeenCalledWith(
      tx,
      10,
      'crm-advanced',
    );
    expect(tx.employeeProfile.create).not.toHaveBeenCalled();
  });

  it('restricts writes to the company administrator and validates status', async () => {
    const { service, tx } = make();
    await expect(
      service.create(
        { ...ACTOR, role: 'SALES' },
        {
          employeeNumber: 'EMP-02',
          name: 'Staff',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.create(ACTOR, {
        employeeNumber: 'EMP-02',
        name: 'Staff',
        status: 'TERMINATED',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.employeeProfile.create).not.toHaveBeenCalled();
  });
});
