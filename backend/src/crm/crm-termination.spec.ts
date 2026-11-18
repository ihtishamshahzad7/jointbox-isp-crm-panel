import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CrmTerminationService } from './crm-termination.service';

const ACTOR = { sub: 50, role: 'ADMIN' } as any;

function make(o: { open?: any; pending?: any[]; deny?: string[]; ticketFails?: boolean; visible?: number[]; left?: number; openRows?: any[]; claimed?: number } = {}) {
  const calls: string[] = [];
  const prisma: any = {
    crmTermination: {
      findFirst: jest.fn(async () => o.open ?? null),
      create: jest.fn(async ({ data }: any) => { calls.push('audit'); return { id: 3, ...data }; }),
      update: jest.fn(async ({ data }: any) => ({ id: 3, status: 'RECOVERY_PENDING', ...data })),
      findMany: jest.fn(async () => o.openRows ?? []),
      updateMany: jest.fn(async () => ({ count: o.claimed ?? 1 })),
    },
    crmStockIssue: {
      findMany: jest.fn(async () => o.pending ?? []),
      count: jest.fn(async () => o.left ?? 0),
    },
    subscriber: { findUnique: jest.fn(async () => ({ id: 7, fullName: 'Ali Khan', username: 'ali01', package: { price: 2500 } })) },
    inventoryItem: { findMany: jest.fn(async () => [{ id: 3, serialNumber: 'ONU-3', type: 'ONU', model: 'HG8' }]) },
    ticket: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const scope: any = {
    assertSubscriberVisible: jest.fn(async (_a: any, id: number) => {
      if (!(o.visible ?? [7]).includes(id)) throw new NotFoundException('Subscriber not found');
    }),
  };
  const perms: any = {
    canActivate: jest.fn(async (ctx: any) => {
      const r = ctx.switchToHttp().getRequest();
      if (o.deny?.includes(`${r.method} ${r.url}`)) throw new ForbiddenException('no');
      return true;
    }),
  };
  const subscribers: any = { deactivateAndRelease: jest.fn(async () => { calls.push('disconnect'); return { released: ['10.0.0.5'] }; }) };
  const tickets: any = {
    create: jest.fn(async (d: any) => { calls.push('ticket'); if (o.ticketFails) throw new Error('assignee not in your account'); return { id: 88, ...d }; }),
  };
  const staff: any = { isOnLeave: jest.fn(async (id: number) => id === 66) };
  return { svc: new CrmTerminationService(prisma, scope, perms, subscribers, tickets, staff), prisma, subscribers, tickets, calls };
}

describe('termination', () => {
  it('uses Uplinko\'s own disconnect, records the audit with revenue lost, and opens a recovery ticket for equipment still out', async () => {
    const t = make({ pending: [{ id: 9, itemId: 3 }] });
    const r: any = await t.svc.terminate(ACTOR, 7, { reason: 'Moved city', assignTo: 61 });
    expect(t.calls).toEqual(['disconnect', 'audit', 'ticket']);
    expect(t.subscribers.deactivateAndRelease).toHaveBeenCalledWith(7, ACTOR, 'Moved city');
    expect(t.prisma.crmTermination.create.mock.calls[0][0].data).toMatchObject({ status: 'RECOVERY_PENDING', monthlyRevenueLoss: 2500, terminatedById: 50 });
    expect(t.tickets.create.mock.calls[0][0]).toMatchObject({ subscriberId: 7, category: 'DISCONNECTION', assignedTo: 61 });
    expect(t.tickets.create.mock.calls[0][0].description).toMatch(/ISS-9: ONU HG8 · S\/N ONU-3/);
    expect(t.tickets.create.mock.calls[0][1]).toBe(ACTOR); // ticket rules (assignee in tree) apply
    expect(r.ticketId).toBe(88);
  });

  it('no equipment out → no ticket', async () => {
    const t = make();
    const r: any = await t.svc.terminate(ACTOR, 7, { reason: 'Unpaid' });
    expect(r.status).toBe('NO_EQUIPMENT');
    expect(t.tickets.create).not.toHaveBeenCalled();
  });

  it('a retried Terminate returns the open recovery and does not disconnect again', async () => {
    const t = make({ open: { id: 3, status: 'RECOVERY_PENDING' } });
    const r: any = await t.svc.terminate(ACTOR, 7, { reason: 'x' });
    expect(r.replay).toBe(true);
    expect(t.subscribers.deactivateAndRelease).not.toHaveBeenCalled();
  });

  it('without ticket rights it refuses BEFORE disconnecting when equipment is out', async () => {
    const t = make({ pending: [{ id: 9, itemId: 3 }], deny: ['POST /tickets'] });
    await expect(t.svc.terminate(ACTOR, 7, { reason: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.subscribers.deactivateAndRelease).not.toHaveBeenCalled();
  });

  it('if the ticket cannot be opened, it says so (the customer is already disconnected)', async () => {
    const t = make({ pending: [{ id: 9, itemId: 3 }], ticketFails: true });
    const r: any = await t.svc.terminate(ACTOR, 7, { reason: 'x', assignTo: 999 });
    expect(r.ticketError).toMatch(/recovery ticket could not be opened/);
  });

  it('refuses to assign the recovery to someone on leave, before disconnecting', async () => {
    const t = make({ pending: [{ id: 9, itemId: 3 }] });
    await expect(t.svc.terminate(ACTOR, 7, { reason: 'x', assignTo: 66 })).rejects.toThrow('on leave');
    expect(t.subscribers.deactivateAndRelease).not.toHaveBeenCalled();
  });

  it('validates and scopes', async () => {
    await expect(make().svc.terminate(ACTOR, 7, { reason: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make().svc.terminate(ACTOR, 7, { reason: 'x'.repeat(2001) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make().svc.terminate(ACTOR, 7, { reason: 'x', assignTo: 'bob' })).rejects.toBeInstanceOf(BadRequestException);
    const t = make({ visible: [] });
    await expect(t.svc.terminate(ACTOR, 7, { reason: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(t.subscribers.deactivateAndRelease).not.toHaveBeenCalled();
  });
});

describe('recovery follow-up', () => {
  it('last unit back → recovery closed (conditionally) and its ticket resolved', async () => {
    const t = make({ openRows: [{ id: 3, ticketId: 88 }] });
    await t.svc.refresh(7);
    expect(t.prisma.crmTermination.updateMany.mock.calls[0][0].where).toEqual({ id: 3, status: 'RECOVERY_PENDING' });
    expect(t.prisma.ticket.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 88, status: { notIn: ['RESOLVED', 'CLOSED'] } },
      data: { status: 'RESOLVED' },
    });
  });
  it('units still out → nothing changes', async () => {
    const t = make({ left: 1, openRows: [{ id: 3, ticketId: 88 }] });
    await t.svc.refresh(7);
    expect(t.prisma.crmTermination.updateMany).not.toHaveBeenCalled();
  });
  it('a concurrent close already won → ticket not touched twice', async () => {
    const t = make({ openRows: [{ id: 3, ticketId: 88 }], claimed: 0 });
    await t.svc.refresh(7);
    expect(t.prisma.ticket.updateMany).not.toHaveBeenCalled();
  });
});
