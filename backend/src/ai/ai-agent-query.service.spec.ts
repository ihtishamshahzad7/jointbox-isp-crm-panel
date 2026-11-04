import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AiAgentQueryService } from './ai-agent-query.service';

const ACTOR = { sub: 10, role: 'ADMIN' };

function make(
  grants: string[],
  denials: string[] = [],
  crmEnabled = true,
) {
  let ticketCountCalls = 0;
  const ticketWheres: Prisma.TicketWhereInput[] = [];
  const employeeGroupBy = jest
    .fn()
    .mockResolvedValue([{ status: 'ACTIVE', _count: { _all: 4 } }]);
  const inventoryMovementGroupBy = jest
    .fn()
    .mockResolvedValue([{ toStatus: 'AVAILABLE', _count: { _all: 2 } }]);
  const inventoryMovementWheres: Prisma.InventoryMovementWhereInput[] = [];
  const prisma = {
    rolePermission: {
      findMany: () =>
        Promise.resolve(grants.map((permission) => ({ permission }))),
    },
    userPermission: {
      findMany: () =>
        Promise.resolve(denials.map((permission) => ({ permission }))),
    },
    subscriber: { count: () => Promise.resolve(3) },
    employeeProfile: { groupBy: employeeGroupBy },
    employeeAttendance: {
      groupBy: jest.fn().mockResolvedValue([]),
    },
    inventoryItem: {
      groupBy: jest.fn().mockResolvedValue([]),
    },
    inventoryMovement: {
      groupBy: ({
        where,
      }: {
        where: Prisma.InventoryMovementWhereInput;
      }) => {
        inventoryMovementWheres.push(where);
        return inventoryMovementGroupBy();
      },
    },
    ticket: {
      count: ({ where }: { where: Prisma.TicketWhereInput }) => {
        ticketCountCalls++;
        ticketWheres.push(where);
        return Promise.resolve(2);
      },
    },
    ticketCountCalls: () => ticketCountCalls,
    ticketWheres,
    employeeGroupBy,
    inventoryMovementWheres,
  };
  const scope = {
    actorId: jest.fn(() => 10),
    ancestorIds: jest.fn(() => Promise.resolve([10])),
    subscriberWhere: jest.fn(() =>
      Promise.resolve({ userId: { in: [10, 11] } }),
    ),
    rootId: jest.fn(() => Promise.resolve(10)),
    descendantIds: jest.fn(() => Promise.resolve([10, 11])),
  };
  const entitlements = {
    companyState: jest.fn(() =>
      Promise.resolve({ enabled: crmEnabled, companyId: 20 }),
    ),
  };
  return {
    service: new AiAgentQueryService(
      prisma as never,
      scope as never,
      entitlements as never,
    ),
    prisma,
    scope,
  };
}

describe('AiAgentQueryService', () => {
  it('refuses to query topics without their native read permission', async () => {
    const { service, prisma } = make(['ai-agent.read']);
    await expect(
      service.summarize(ACTOR, 'How many tickets?'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.ticketCountCalls()).toBe(0);
  });

  it('applies subscriber-tree scope to read-authorized ticket summaries', async () => {
    const { service, prisma } = make(['tickets.read']);
    const summary = await service.summarize(ACTOR, 'How many tickets?');
    expect(summary.metrics).toEqual({
      tickets: { createdInPeriod: 2, openInPeriod: 2, slaBreached: 2 },
    });
    expect(prisma.ticketWheres[0]).toMatchObject({
      subscriber: { is: { userId: { in: [10, 11] } } },
    });
  });

  it('compares ticket creation counts over equal adjacent date windows', async () => {
    const { service, prisma } = make(['tickets.read']);
    const summary = await service.summarize(
      ACTOR,
      'Compare tickets for the last 7 days',
      new Date('2026-07-14T12:00:00.000Z'),
    );
    expect(prisma.ticketCountCalls()).toBe(4);
    expect(summary.visuals).toContainEqual({
      title: 'Tickets created',
      unit: 'count',
      series: [
        {
          label: 'last 7 days',
          points: [{ label: 'Created', value: 2 }],
        },
        {
          label: '2026-07-01 to 2026-07-07',
          points: [{ label: 'Created', value: 2 }],
        },
      ],
    });
  });

  it('honors inherited per-user read denials despite a role grant', async () => {
    const { service, prisma } = make(['tickets.read'], ['tickets.read']);
    await expect(
      service.summarize(ACTOR, 'How many tickets?'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.ticketCountCalls()).toBe(0);
  });

  it('scopes employee summaries to the entitled company and exposes only aggregates', async () => {
    const { service, prisma } = make(['hr.read']);
    const summary = await service.summarize(ACTOR, 'How many employees?');
    expect(prisma.employeeGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 20 } }),
    );
    expect(summary.metrics.employees).toEqual([
      { status: 'ACTIVE', count: 4 },
    ]);
  });

  it('does not query employee records when the CRM entitlement is disabled', async () => {
    const { service, prisma } = make(['hr.read'], [], false);
    await expect(
      service.summarize(ACTOR, 'How many employees?'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.employeeGroupBy).not.toHaveBeenCalled();
  });

  it('scopes stock movement summaries through the existing inventory owner tree', async () => {
    const { service, prisma } = make(['inventory.read']);
    const summary = await service.summarize(ACTOR, 'Show stock movements');
    expect(summary.metrics.stockMovements).toEqual([
      { status: 'AVAILABLE', count: 2 },
    ]);
    expect(prisma.inventoryMovementWheres[0]).toMatchObject({
      item: { is: { ownerId: { in: [10, 11] } } },
    });
  });
});
