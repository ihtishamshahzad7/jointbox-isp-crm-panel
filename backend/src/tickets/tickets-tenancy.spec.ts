import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../common/scope.service';
import { TicketsService } from './tickets.service';
import { TicketSlaService } from './ticket-sla.service';
import { TicketsController } from './tickets.controller';

/**
 * Ticket routes vs. tenancy.
 *
 * Company A (ADMIN 10, dealer 11) and company B (ADMIN 20). Subscriber 100
 * belongs to A's dealer; ticket 5 is about subscriber 100. The real
 * ScopeService runs against a hand-rolled prisma.
 */
const TREE: Record<number, number[]> = { 10: [10, 11], 20: [20], 1: [1] };
const SUBSCRIBER_OWNER: Record<number, number> = { 100: 11 };
const TICKETS: Record<number, any> = { 5: { id: 5, subscriberId: 100 } };

const ADMIN_A = { sub: 10, role: 'ADMIN' };
const ADMIN_B = { sub: 20, role: 'ADMIN' };
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };

function makePrisma() {
  return {
    $queryRaw: jest.fn(async (q: any, ...vals: any[]) => {
      if (Array.isArray(q) && q.join('').includes('WITH RECURSIVE sub')) {
        return (TREE[vals[0]] ?? [vals[0]]).map((id) => ({ id }));
      }
      return [{ avg_hours: 2 }];
    }),
    user: { findUnique: jest.fn(async () => null) },
    subscriber: {
      findUnique: jest.fn(async ({ where }: any) =>
        SUBSCRIBER_OWNER[where.id] ? { userId: SUBSCRIBER_OWNER[where.id] } : null),
    },
    ticket: {
      findUnique: jest.fn(async ({ where }: any) => TICKETS[where.id] ?? null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: any) => ({ id: 9, ...data })),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
    },
    ticketMessage: { create: jest.fn(async () => ({ id: 1 })) },
  } as any;
}

function make() {
  const prisma = makePrisma();
  const scope = new ScopeService(prisma);
  const sla = new TicketSlaService(prisma, { fireEvent: jest.fn() } as any, scope);
  const service = new TicketsService(prisma, sla, scope);
  const controller = new TicketsController(service, sla, scope);
  return { prisma, controller };
}

describe('tickets tenancy', () => {
  it('another company gets 404 on update / delete / reply for a ticket it does not own', async () => {
    const { prisma, controller } = make();
    await expect(controller.update('5', { status: 'CLOSED' }, { user: ADMIN_B })).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.delete('5', { user: ADMIN_B })).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.addMessage('5', { message: 'hi', sentBy: 20 }, { user: ADMIN_B })).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.findBySubscriber('100', { user: ADMIN_B })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.ticket.update).not.toHaveBeenCalled();
    expect(prisma.ticket.delete).not.toHaveBeenCalled();
    expect(prisma.ticketMessage.create).not.toHaveBeenCalled();
    expect(prisma.ticket.findMany).not.toHaveBeenCalled();
  });

  it('a tenant cannot open a ticket on another company\x27s subscriber or assign it outside its tree', async () => {
    const { prisma, controller } = make();
    await expect(controller.create({ subscriberId: 100, subject: 's', description: 'd' }, { user: ADMIN_B }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.create({ subscriberId: 100, subject: 's', description: 'd', assignedTo: 20 }, { user: ADMIN_A }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.ticket.create).not.toHaveBeenCalled();
    await controller.create({ subscriberId: 100, subject: 's', description: 'd', assignedTo: 11 }, { user: ADMIN_A });
    expect(prisma.ticket.create).toHaveBeenCalledTimes(1);
  });

  it('the owning company and the platform owner pass', async () => {
    const { prisma, controller } = make();
    await controller.update('5', { status: 'IN_PROGRESS' }, { user: ADMIN_A });
    await controller.update('5', { status: 'RESOLVED' }, { user: OWNER });
    await controller.findBySubscriber('100', { user: ADMIN_A });
    expect(prisma.ticket.update).toHaveBeenCalledTimes(2);
    expect(prisma.ticket.findMany).toHaveBeenCalledTimes(1);
  });

  it('SLA backfill is platform-owner only', async () => {
    const { prisma, controller } = make();
    expect(() => controller.slaBackfill({ user: ADMIN_A })).toThrow(ForbiddenException);
    await controller.slaBackfill({ user: OWNER });
    expect(prisma.ticket.findMany).toHaveBeenCalledTimes(1);
  });

  it('the SLA report is counted over the caller\x27s subscribers only', async () => {
    const { prisma, controller } = make();
    await controller.slaReport({ user: ADMIN_A }, '30');
    for (const [arg] of prisma.ticket.count.mock.calls) {
      expect(arg.where.AND[0]).toEqual({ subscriber: { userId: { in: [10, 11] } } });
    }
    const avg = prisma.$queryRaw.mock.calls.find((c: any[]) => Array.isArray(c[0]) && c[0].join('').includes('AVG('));
    expect(avg[2].sql).toContain('"Subscriber"');
    expect(avg[2].values).toEqual([[10, 11]]);
  });

  it('the platform owner\x27s SLA report is unchanged (unscoped)', async () => {
    const { prisma, controller } = make();
    await controller.slaReport({ user: OWNER }, '30');
    expect(prisma.ticket.count.mock.calls[0][0]).toEqual({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } });
  });
});
