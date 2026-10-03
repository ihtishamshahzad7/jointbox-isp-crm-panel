import { NotFoundException } from '@nestjs/common';
import { ScopeService } from '../common/scope.service';
import { OutagesService } from './outages.service';

/**
 * OUTAGES — an outage and a load-shedding schedule both belong to an AREA,
 * and areas are per-company.
 *
 *   company A = ADMIN 10 (downline 11), owns area 1, outage 100, schedule 7
 *   company B = ADMIN 20 (downline 21), owns area 2, outage 200
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const A = { sub: 10, role: 'ADMIN' };
const B = { sub: 20, role: 'ADMIN' };
const TREE: Record<number, number[]> = { 1: [1], 10: [10, 11], 20: [20, 21] };

const AREAS: Record<number, { ownerId: number; customersOf: number[] }> = {
  1: { ownerId: 10, customersOf: [11] },
  2: { ownerId: 20, customersOf: [21] },
};
const OUTAGES: Record<number, any> = {
  100: { id: 100, areaId: 1, createdBy: null, type: 'UNSCHEDULED', area: { id: 1, name: 'A-town' } },
  200: { id: 200, areaId: 2, createdBy: null, type: 'UNSCHEDULED', area: { id: 2, name: 'B-town' } },
};
const SCHEDULES: Record<number, any> = { 7: { id: 7, areaId: 1, area: { ownerId: 10 } } };

/**
 * Just enough of Prisma's semantics to evaluate the outage scope the service
 * builds: { AND: [{ id }, { OR: [{ area: { is: <reach> } }, { createdBy }] }] }.
 */
function inScope(row: any, scope: any): boolean {
  const [byArea, byCreator] = scope.OR;
  const ids: number[] = byCreator.createdBy.in;
  const area = AREAS[row.areaId];
  const reach = byArea.area.is.OR;
  const owned = area && reach[0].ownerId.in.includes(area.ownerId);
  const served = area && area.customersOf.some((u) => reach[1].subscribers.some.userId.in.includes(u));
  return !!(owned || served || (row.createdBy != null && ids.includes(row.createdBy)));
}

function makeService() {
  const scope = new ScopeService({} as any);
  jest.spyOn(scope, 'rootId').mockImplementation(async (a: any) => Number(a?.sub ?? a?.id));
  jest.spyOn(scope, 'descendantIds').mockImplementation(async (id: number) => TREE[id] ?? [id]);

  const prisma: any = {
    powerOutage: {
      findFirst: jest.fn(async ({ where }: any) => {
        const [{ id }, s] = where.AND;
        const row = OUTAGES[id];
        return row && inScope(row, s) ? { id } : null;
      }),
      findUnique: jest.fn(async ({ where }: any) => OUTAGES[where.id] ?? null),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ where, data }: any) => ({ ...OUTAGES[where.id], ...data })),
    },
    powerSchedule: {
      findUnique: jest.fn(async ({ where }: any) => SCHEDULES[where.id] ?? null),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => data),
      update: jest.fn(async ({ data }: any) => data),
      delete: jest.fn(async () => ({})),
    },
    area: {
      findUnique: jest.fn(async ({ where }: any) => (AREAS[where.id] ? { ownerId: AREAS[where.id].ownerId } : null)),
    },
    subscriber: {
      findMany: jest.fn(async () => [{ id: 1, fullName: 'x', phone: '0300' }]),
    },
  };
  const notifications = { send: jest.fn(async () => ({})) };
  const svc = new OutagesService(prisma, scope, notifications as any, {} as any, {} as any);
  return { svc, prisma, notifications };
}

describe('OutagesService — tenancy', () => {
  describe('another company is told the outage does not exist', () => {
    it('cannot read, reclassify, close, confirm or notify company A\'s outage', async () => {
      const { svc, prisma, notifications } = makeService();
      await expect(svc.getAttribution(100, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.attribute(100, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.confirmAttribution(100, 'FIBER_CUT', B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.classify(100, 'NETWORK', undefined, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.close(100, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.notifyArea(100, 'hi', B)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.powerOutage.update).not.toHaveBeenCalled();
      expect(notifications.send).not.toHaveBeenCalled();
    });

    it('cannot see or change company A\'s load-shedding schedule', async () => {
      const { svc, prisma } = makeService();
      await expect(svc.updateSchedule(7, { startTime: '10:00' }, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.removeSchedule(7, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.createSchedule({ areaId: 1, startTime: '10:00', endTime: '12:00' }, B),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.powerSchedule.update).not.toHaveBeenCalled();
      expect(prisma.powerSchedule.delete).not.toHaveBeenCalled();
      expect(prisma.powerSchedule.create).not.toHaveBeenCalled();
    });
  });

  describe('the owning company and the platform owner pass', () => {
    it('company A closes its own outage and texts only its own customers', async () => {
      const { svc, prisma, notifications } = makeService();
      await expect(svc.close(100, A)).resolves.toBeTruthy();
      await expect(svc.notifyArea(100, 'hi', A)).resolves.toEqual({ notified: 1, total: 1 });
      expect(prisma.subscriber.findMany.mock.calls[0][0].where).toEqual({
        AND: [{ areaId: 1, status: 'ACTIVE' }, { userId: { in: [10, 11] } }],
      });
      expect(notifications.send).toHaveBeenCalledTimes(1);
    });

    it('company A manages its own area\'s schedule', async () => {
      const { svc, prisma } = makeService();
      await svc.updateSchedule(7, { startTime: '10:00' }, A);
      await svc.createSchedule({ areaId: 1, startTime: '10:00', endTime: '12:00' }, A);
      expect(prisma.powerSchedule.update).toHaveBeenCalled();
      expect(prisma.powerSchedule.create).toHaveBeenCalled();
    });

    it('the platform owner reaches any outage, unscoped', async () => {
      const { svc, prisma } = makeService();
      await expect(svc.close(200, OWNER)).resolves.toBeTruthy();
      await svc.notifyArea(200, 'hi', OWNER);
      expect(prisma.powerOutage.findFirst).not.toHaveBeenCalled();
      expect(prisma.subscriber.findMany.mock.calls[0][0].where).toEqual({ areaId: 2, status: 'ACTIVE' });
    });
  });

  describe('lists are filtered in the query', () => {
    it('listOutages keeps the scope even when an areaId is passed', async () => {
      const { svc, prisma } = makeService();
      await svc.listOutages(B, { areaId: '1' });
      const where = prisma.powerOutage.findMany.mock.calls[0][0].where;
      // ?areaId used to REPLACE the scope; it must only narrow it.
      expect(where.areaId).toBe(1);
      expect(where.AND).toHaveLength(1);
      expect(inScope(OUTAGES[100], where.AND[0])).toBe(false);
      expect(inScope(OUTAGES[200], where.AND[0])).toBe(true);
    });

    it('uptime and schedules are computed over the caller\'s areas only', async () => {
      const { svc, prisma } = makeService();
      await svc.uptimeReport(30, A);
      const where = prisma.powerOutage.findMany.mock.calls[0][0].where;
      expect(where.AND).toHaveLength(2);
      expect(inScope(OUTAGES[100], where.AND[1])).toBe(true);
      expect(inScope(OUTAGES[200], where.AND[1])).toBe(false);

      await svc.listSchedules(undefined, A);
      expect(prisma.powerSchedule.findMany.mock.calls[0][0].where).toEqual({
        area: { is: { ownerId: { in: [10, 11] } } },
      });
    });

    it('the platform owner gets the unfiltered lists', async () => {
      const { svc, prisma } = makeService();
      await svc.listOutages(OWNER, {});
      expect(prisma.powerOutage.findMany.mock.calls[0][0].where).toEqual({});
      await svc.listSchedules(undefined, OWNER);
      expect(prisma.powerSchedule.findMany.mock.calls[0][0].where).toEqual({});
    });
  });
});
