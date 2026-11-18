import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CrmTatService } from './crm-tat.service';
import { TicketSlaService } from '../tickets/ticket-sla.service';
import { invalidateCompanyPlan } from '../common/company-plan';

const OWNER = { sub: 10, role: 'ADMIN' } as any;
const STAFF = { sub: 12, role: 'SALES' } as any;

function make(o: { rows?: any[]; updated?: number; visible?: number[] } = {}) {
  const prisma: any = {
    crmTatSetting: {
      findMany: jest.fn(async () => o.rows ?? []),
      upsert: jest.fn(async (a: any) => a.create),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    ticket: {
      findUnique: jest.fn(async () => ({ id: 5, subscriberId: 7, createdAt: new Date('2026-11-01T00:00:00Z') })),
      updateMany: jest.fn(async () => ({ count: o.updated ?? 1 })),
    },
    activityLog: { create: jest.fn(async () => ({})) },
  };
  const scope: any = {
    actorId: (a: any) => a.sub,
    companyRootId: jest.fn(async () => 10),
    isOwner: (r?: string) => r === 'ADMIN' || r === 'SUPER_ADMIN',
    assertSubscriberVisible: jest.fn(async (_a: any, id: number) => {
      if (!(o.visible ?? [7]).includes(id)) throw new NotFoundException('x');
    }),
  };
  const perms: any = { canActivate: jest.fn(async () => true) };
  const sla: any = { defaultTargets: (p: string) => (p === 'URGENT' ? { response: 15, resolution: 240 } : { response: 240, resolution: 1440 }) };
  return { svc: new CrmTatService(prisma, scope, perms, sla), prisma };
}

describe('company TAT targets', () => {
  it('grid shows every category × priority, the company\'s own where set', async () => {
    const g = await make({ rows: [{ category: 'TECHNICAL', priority: 'URGENT', responseMinutes: 10, resolutionMinutes: 120 }] }).svc.grid(OWNER);
    expect(g).toHaveLength(24);
    expect(g.find((r) => r.category === 'TECHNICAL' && r.priority === 'URGENT')).toEqual({ category: 'TECHNICAL', priority: 'URGENT', responseMinutes: 10, resolutionMinutes: 120, custom: true });
    expect(g.find((r) => r.category === 'BILLING' && r.priority === 'URGENT')).toMatchObject({ resolutionMinutes: 240, custom: false });
  });
  it('only the company owner sets them; values are validated', async () => {
    const t = make();
    await expect(t.svc.set(STAFF, { category: 'TECHNICAL', priority: 'HIGH', responseMinutes: 30, resolutionMinutes: 60 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(t.svc.set(OWNER, { category: 'NOPE', priority: 'HIGH', responseMinutes: 30, resolutionMinutes: 60 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(t.svc.set(OWNER, { category: 'TECHNICAL', priority: 'HIGH', responseMinutes: 90, resolutionMinutes: 60 })).rejects.toThrow('cannot be longer');
    await expect(t.svc.set(OWNER, { category: 'TECHNICAL', priority: 'HIGH', responseMinutes: 30, resolutionMinutes: 50000 })).rejects.toBeInstanceOf(BadRequestException);
    await t.svc.set(OWNER, { category: 'TECHNICAL', priority: 'HIGH', responseMinutes: 30, resolutionMinutes: 60 });
    expect(t.prisma.crmTatSetting.upsert.mock.calls[0][0].where).toEqual({ companyId_category_priority: { companyId: 10, category: 'TECHNICAL', priority: 'HIGH' } });
  });
});

describe('one ticket\'s turnaround', () => {
  it('owner sets it from when the ticket was opened, only while open, and it is audited', async () => {
    const t = make();
    const r = await t.svc.setTicketTat(OWNER, 5, { hours: 48 });
    expect(r.resolutionDueAt.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(t.prisma.ticket.updateMany.mock.calls[0][0].where).toEqual({ id: 5, status: { notIn: ['RESOLVED', 'CLOSED'] } });
    expect(t.prisma.activityLog.create.mock.calls[0][0].data.action).toBe('TICKET_TAT');
  });
  it('sales staff cannot move a deadline; bad hours, closed tickets and other companies are refused', async () => {
    await expect(make().svc.setTicketTat(STAFF, 5, { hours: 48 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make().svc.setTicketTat(OWNER, 5, { hours: 721 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make({ updated: 0 }).svc.setTicketTat(OWNER, 5, { hours: 4 })).rejects.toBeInstanceOf(ConflictException);
    await expect(make({ visible: [] }).svc.setTicketTat(OWNER, 5, { hours: 4 })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ticket creation uses the company target only with crm-advanced', () => {
  const FROM = new Date('2026-11-01T00:00:00Z');
  const mk = (features: string[], row: any) => {
    invalidateCompanyPlan();
    const prisma: any = {
      subscriber: { findUnique: jest.fn(async () => ({ userId: 11 })) },
      $queryRaw: jest.fn(async () => [{ id: 10 }]),
      companyPlan: { findUnique: jest.fn(async () => ({ companyId: 10, features })) },
      crmTatSetting: { findUnique: jest.fn(async () => row) },
    };
    return new TicketSlaService(prisma, {} as any, {} as any);
  };
  it('company target applied', async () => {
    const d = await mk(['crm-advanced'], { responseMinutes: 10, resolutionMinutes: 120 }).dueDatesFor(7, 'TECHNICAL', 'HIGH', FROM);
    expect(d.resolutionDueAt.toISOString()).toBe('2026-11-01T02:00:00.000Z');
  });
  it('no crm-advanced → installation default, even if a row exists', async () => {
    const d = await mk([], { responseMinutes: 10, resolutionMinutes: 120 }).dueDatesFor(7, 'TECHNICAL', 'HIGH', FROM);
    expect(d.resolutionDueAt.toISOString()).toBe('2026-11-01T08:00:00.000Z'); // HIGH default 480 min
  });
  it('a lookup failure never breaks ticket creation', async () => {
    const s = mk(['crm-advanced'], null) as any;
    (s as any).prisma.subscriber.findUnique.mockRejectedValue(new Error('db'));
    const d = await s.dueDatesFor(7, 'TECHNICAL', 'LOW', FROM);
    expect(d.resolutionDueAt.toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });
});
