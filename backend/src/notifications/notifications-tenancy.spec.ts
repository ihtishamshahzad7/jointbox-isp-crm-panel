import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../common/scope.service';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

/**
 * Communication routes vs. tenancy.
 *
 * Two companies on one installation: company A (ADMIN 10, dealer 11) and
 * company B (ADMIN 20). Subscriber 100 belongs to A. The real ScopeService
 * runs against a hand-rolled prisma, so the asserts exercised here are the
 * production ones.
 */
const TREE: Record<number, number[]> = { 10: [10, 11], 20: [20], 1: [1] };
const SUBSCRIBER_OWNER: Record<number, number> = { 100: 11 };

const ADMIN_A = { sub: 10, role: 'ADMIN' };
const ADMIN_B = { sub: 20, role: 'ADMIN' };
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };

function makePrisma() {
  const messages: Record<number, any> = {
    5: { id: 5, subscriberId: 100, createdBy: 10 },  // about A's subscriber
    6: { id: 6, subscriberId: null, createdBy: 1 },  // installation-level test send
  };
  return {
    $queryRaw: jest.fn(async (q: any, ...vals: any[]) => {
      if (Array.isArray(q) && q.join('').includes('WITH RECURSIVE sub')) {
        return (TREE[vals[0]] ?? [vals[0]]).map((id) => ({ id }));
      }
      if (Array.isArray(q) && q.join('').includes('WITH RECURSIVE up')) {
        return vals[0] === 11 ? [{ id: 11 }, { id: 10 }, { id: 1 }] : vals[0] === 1 ? [{ id: 1 }] : [{ id: vals[0] }, { id: 1 }];
      }
      return [{ id: 5 }]; // the scoped message page
    }),
    subscriber: {
      findUnique: jest.fn(async ({ where }: any) =>
        SUBSCRIBER_OWNER[where.id] ? { userId: SUBSCRIBER_OWNER[where.id] } : null),
    },
    message: {
      findUnique: jest.fn(async ({ where }: any) => messages[where.id] ?? null),
      findMany: jest.fn(async () => [messages[5]]),
      update: jest.fn(async () => ({})),
    },
    messageTemplate: {
      count: jest.fn(async () => 1),
      create: jest.fn(async () => ({ id: 1 })),
      delete: jest.fn(async () => ({})),
      // 1 = platform default, 2 = company A's own
      findUnique: jest.fn(async ({ where }: any) => ({ 1: { ownerId: null }, 2: { ownerId: 10 } } as any)[where.id] ?? null),
    },
    user: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async ({ where }: any) =>
        where.id.in.map((id: number) => ({ id, role: id === 1 ? 'SUPER_ADMIN' : id === 11 ? 'RESELLER' : 'ADMIN' })),
      ),
    },
  } as any;
}

function make() {
  const prisma = makePrisma();
  const scope = new ScopeService(prisma);
  const queue: any = { registerProcessor: jest.fn(), add: jest.fn(async () => undefined) };
  const service = new NotificationsService(prisma, queue, scope);
  const alerts: any = {
    status: jest.fn(async () => ({ discord: true, keys: [{ key: 'DISCORD_WEBHOOK_URL', maskedHint: 'https://discord…' }] })),
    send: jest.fn(async () => ({ discord: true })),
  };
  const controller = new NotificationsController(service, alerts, {} as any, scope);
  return { prisma, queue, service, alerts, controller };
}

describe('notifications tenancy', () => {
  it('another company cannot retry a message about a subscriber it does not own (404)', async () => {
    const { prisma, queue, controller } = make();
    await expect(controller.retry('5', { user: ADMIN_B })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a subscriber-less message is installation-level: a tenant gets 404', async () => {
    const { prisma, controller } = make();
    await expect(controller.retry('6', { user: ADMIN_A })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('the owning company and the platform owner can retry', async () => {
    const { prisma, controller } = make();
    await expect(controller.retry('5', { user: ADMIN_A })).resolves.toEqual({ queued: true });
    await expect(controller.retry('6', { user: OWNER })).resolves.toEqual({ queued: true });
    expect(prisma.message.update).toHaveBeenCalledTimes(2);
  });

  it('the message log is scoped to the caller subtree for a tenant', async () => {
    const { prisma, controller } = make();
    const out: any = await controller.messages({ limit: '50', status: 'FAILED' }, { user: ADMIN_A });
    const sqlCall = prisma.$queryRaw.mock.calls.find((c: any[]) => !Array.isArray(c[0]));
    expect(sqlCall).toBeTruthy();
    const sql = sqlCall[0];
    expect(sql.sql).toContain('"Subscriber"');
    expect(sql.sql).toContain('"createdBy"');
    expect(sql.values).toEqual(expect.arrayContaining([[10, 11], 'FAILED']));
    expect(prisma.message.findMany).toHaveBeenCalledWith({ where: { id: { in: [5] } }, orderBy: { id: 'desc' } });
    expect(out.items).toHaveLength(1);
  });

  it('the platform owner still reads the whole log through Prisma', async () => {
    const { prisma, controller } = make();
    await controller.messages({}, { user: OWNER });
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    expect(prisma.$queryRaw.mock.calls.some((c: any[]) => !Array.isArray(c[0]))).toBe(false);
  });

  it('the shared alert channel stays a platform-owner matter', async () => {
    const { alerts, controller } = make();
    await expect(controller.alertTest({ user: ADMIN_A })).rejects.toBeInstanceOf(ForbiddenException);
    expect(() => controller.alertStatus({ user: ADMIN_A })).toThrow(ForbiddenException);
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it("templates: a company makes its own, edits only its own, and can't touch a platform default", async () => {
    const { prisma, controller } = make();
    await controller.createTemplate({ name: 'x', body: 'y' }, { user: ADMIN_A });
    expect(prisma.messageTemplate.create.mock.calls[0][0].data.ownerId).toBe(10);
    await expect(controller.deleteTemplate('1', { user: ADMIN_A })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.deleteTemplate('2', { user: ADMIN_B })).rejects.toBeInstanceOf(NotFoundException);
    await controller.deleteTemplate('2', { user: ADMIN_A });
    expect(prisma.messageTemplate.delete).toHaveBeenCalledWith({ where: { id: 2 } });
    // A dealer may not change its whole company's wording.
    await expect(controller.createTemplate({ name: 'z', body: 'y' }, { user: { sub: 11, role: 'RESELLER' } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await controller.createTemplate({ name: 'x', body: 'y' }, { user: OWNER });
    expect(prisma.messageTemplate.create.mock.calls[1][0].data.ownerId).toBeNull();
  });

  it("a company's own template replaces the platform default for ITS customers only", async () => {
    const { prisma, service } = make();
    prisma.messageTemplate.findMany = jest.fn(async ({ where }: any) => {
      const all = [
        { id: 1, ownerId: null, channel: 'SMS', event: 'WELCOME', isActive: true },
        { id: 3, ownerId: null, channel: 'EMAIL', event: 'WELCOME', isActive: true },
        { id: 2, ownerId: 10, channel: 'SMS', event: 'WELCOME', isActive: true },
        { id: 4, ownerId: 20, channel: 'SMS', event: 'WELCOME', isActive: true },
      ];
      const allowed = where.OR ? [null, where.OR[1].ownerId] : [null];
      return all.filter((t) => allowed.includes(t.ownerId));
    });
    const forA = await service.templatesFor('WELCOME', { id: 100, userId: 11 });
    expect(forA.map((t: any) => t.id).sort()).toEqual([2, 3]); // own SMS, default email
    const unowned = await service.templatesFor('WELCOME', { id: 999 });
    expect(unowned.map((t: any) => t.id).sort()).toEqual([1, 3]);
  });

  it('status hides the installation alert credentials from a tenant', async () => {
    const { controller } = make();
    const tenant: any = await controller.status({ user: ADMIN_A });
    expect(tenant).toHaveProperty('sms');
    expect(tenant).not.toHaveProperty('alerts');
    const owner: any = await controller.status({ user: OWNER });
    expect(owner.alerts).toBeTruthy();
  });
});
