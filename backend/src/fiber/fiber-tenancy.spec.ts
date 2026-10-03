import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../common/scope.service';
import { FiberService } from './fiber.service';

/**
 * FIBER — OLTs are scoped through their NAS, ports and ONUs through their OLT,
 * and an ONU bound to a customer through that customer.
 *
 * Two companies on one installation:
 *   company A = ADMIN 10 (downline 11), owns NAS 100, OLT 1, subscriber 500
 *   company B = ADMIN 20 (downline 21), owns NAS 200, OLT 2, subscriber 600
 *   OLT 3 has no NAS — installation-level, platform owner only.
 *
 * The real ScopeService is used for its pure rules; only the calls that would
 * reach the database are stubbed.
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const A = { sub: 10, role: 'ADMIN' };
const B = { sub: 20, role: 'ADMIN' };

const TREE: Record<number, number[]> = { 1: [1], 10: [10, 11], 20: [20, 21] };
const NAS_OWNER: Record<number, number> = { 100: 10, 200: 20 };
const SUB_OWNER: Record<number, number> = { 500: 10, 600: 20 };

const OLTS: Record<number, any> = {
  1: { id: 1, name: 'A-OLT', nasId: 100 },
  2: { id: 2, name: 'B-OLT', nasId: 200 },
  3: { id: 3, name: 'HQ-OLT', nasId: null },
};
const PORTS: Record<number, any> = { 7: { id: 7, oltId: 1, portName: '0/1/1', onus: [] } };
const ONUS: Record<number, any> = {
  // unassigned, on A's OLT
  40: { id: 40, oltId: 1, subscriberId: null, onuIndex: '1', olt: { vendor: 'huawei' }, ponPort: { portName: '0/1/1' } },
  // bound to A's customer
  41: { id: 41, oltId: 1, subscriberId: 500, onuIndex: '2', olt: { vendor: 'huawei' }, ponPort: { portName: '0/1/1' } },
};

function makeScope() {
  const scope = new ScopeService({} as any);
  const sees = (actor: any, userId: number) => (TREE[actor.sub] ?? []).includes(userId);
  jest.spyOn(scope, 'rootId').mockImplementation(async (a: any) => Number(a?.sub ?? a?.id));
  jest.spyOn(scope, 'descendantIds').mockImplementation(async (id: number) => TREE[id] ?? [id]);
  jest.spyOn(scope, 'ancestorIds').mockImplementation(async (id: number) => [id]);
  jest.spyOn(scope, 'canAccessNas').mockImplementation(async (a: any, nasId: number) =>
    scope.isPlatformOwner(a) || sees(a, NAS_OWNER[nasId]));
  jest.spyOn(scope, 'canAccessSubscriber').mockImplementation(async (a: any, id: number) =>
    scope.isPlatformOwner(a) || sees(a, SUB_OWNER[id]));
  return scope;
}

function makeService() {
  const prisma: any = {
    olt: {
      findUnique: jest.fn(async ({ where }: any) => OLTS[where.id] ? { ...OLTS[where.id], onus: [] } : null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: any) => ({ id: 99, ...data })),
      update: jest.fn(async ({ data }: any) => data),
      delete: jest.fn(async () => ({})),
    },
    ponPort: {
      findUnique: jest.fn(async ({ where }: any) => PORTS[where.id] ?? null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      update: jest.fn(async ({ data }: any) => data),
      delete: jest.fn(async () => ({})),
    },
    onu: {
      findUnique: jest.fn(async ({ where }: any) => ONUS[where.id] ?? null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      update: jest.fn(async ({ data }: any) => data),
      delete: jest.fn(async () => ({})),
    },
    area: { findUnique: jest.fn(async () => null) },
  };
  const provision = {
    generateProvisionCommands: jest.fn(() => ['cmd']),
    generateUnprovisionCommands: jest.fn(() => ['cmd']),
    generateDiagnosticCommands: jest.fn(() => ['cmd']),
  };
  const scope = makeScope();
  const svc = new FiberService(prisma, scope, {} as any, provision as any);
  return { svc, prisma, scope, provision };
}

describe('FiberService — tenancy', () => {
  describe('another company is told the record does not exist', () => {
    it('cannot read, change or delete company A\'s OLT', async () => {
      const { svc, prisma } = makeService();
      await expect(svc.getOlt(1, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.getFiberTree(1, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.updateOlt(1, { name: 'x' }, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.deleteOlt(1, B)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.olt.update).not.toHaveBeenCalled();
      expect(prisma.olt.delete).not.toHaveBeenCalled();
    });

    it('cannot add or change ports on company A\'s OLT', async () => {
      const { svc, prisma } = makeService();
      await expect(svc.createPort({ oltId: 1, portName: '0/1/9' }, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.updatePort(7, { portName: 'x' }, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.deletePort(7, B)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.ponPort.update).not.toHaveBeenCalled();
      expect(prisma.ponPort.delete).not.toHaveBeenCalled();
    });

    it('cannot touch company A\'s ONUs or generate their OLT commands', async () => {
      const { svc, prisma, provision } = makeService();
      await expect(svc.unassignOnu(41, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.updateOnu(40, { notes: 'x' }, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.deleteOnu(40, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.generateProvisionCommands(40, 100, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.generateUnprovisionCommands(41, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.generateDiagnosticCommands(41, B)).rejects.toBeInstanceOf(NotFoundException);
      // nor claim A's unassigned ONU for one of its own customers
      await expect(svc.assignOnu(40, 600, B)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.onu.update).not.toHaveBeenCalled();
      expect(prisma.onu.delete).not.toHaveBeenCalled();
      expect(provision.generateProvisionCommands).not.toHaveBeenCalled();
    });

    it('cannot point a new OLT at another company\'s NAS, or leave it NAS-less', async () => {
      const { svc, prisma } = makeService();
      await expect(svc.createOlt({ name: 'new', nasId: 100 }, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.createOlt({ name: 'new' }, B)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.updateOlt(2, { nasId: 100 }, B)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.olt.create).not.toHaveBeenCalled();
      expect(prisma.olt.update).not.toHaveBeenCalled();
    });

    it('treats a NAS-less OLT as installation-level', async () => {
      const { svc } = makeService();
      await expect(svc.getOlt(3, A)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('the owning company and the platform owner pass', () => {
    it('company A works on its own OLT, ports and ONUs', async () => {
      const { svc, prisma } = makeService();
      await expect(svc.getOlt(1, A)).resolves.toBeTruthy();
      await expect(svc.unassignOnu(41, A)).resolves.toBeTruthy();
      await expect(svc.generateProvisionCommands(40, 100, A)).resolves.toEqual(['cmd']);
      await svc.createOlt({ name: 'A-OLT-2', nasId: 100 }, A);
      expect(prisma.olt.create).toHaveBeenCalled();
    });

    it('the platform owner reaches every OLT, including a NAS-less one', async () => {
      const { svc, prisma } = makeService();
      await expect(svc.getOlt(1, OWNER)).resolves.toBeTruthy();
      await expect(svc.getOlt(3, OWNER)).resolves.toBeTruthy();
      await expect(svc.deleteOlt(2, OWNER)).resolves.toEqual({ deleted: true });
      await svc.createOlt({ name: 'HQ-2' }, OWNER);
      expect(prisma.olt.create).toHaveBeenCalled();
    });
  });

  describe('lists are filtered in the query', () => {
    it('listOlts / listPorts filter through the caller\'s NAS scope', async () => {
      const { svc, prisma } = makeService();
      await svc.listOlts(A);
      const oltWhere = prisma.olt.findMany.mock.calls[0][0].where;
      expect(oltWhere).toEqual({ nas: { is: expect.objectContaining({ OR: expect.any(Array) }) } });
      expect(JSON.stringify(oltWhere)).toContain('"ownerId":10');

      await svc.listPorts(undefined, A);
      expect(prisma.ponPort.findMany.mock.calls[0][0].where).toEqual({ olt: { is: oltWhere } });
    });

    it('the summary counts only the caller\'s OLTs and ONUs', async () => {
      const { svc, prisma } = makeService();
      await svc.getFiberSummary(B);
      const where = JSON.stringify(prisma.olt.count.mock.calls[0][0].where);
      expect(where).toContain('"ownerId":20');
      const onuWhere = JSON.stringify(prisma.onu.count.mock.calls[0][0].where);
      expect(onuWhere).toContain('"userId":{"in":[20,21]}');
    });

    it('listOnus hides other companies\' customers and other companies\' spare ONUs', async () => {
      const { svc, prisma } = makeService();
      await svc.listOnus({}, B);
      const and = prisma.onu.findMany.mock.calls[0][0].where.AND;
      expect(and[0]).toEqual({
        OR: [
          { subscriber: { is: { userId: { in: [20, 21] } } } },
          { subscriberId: null, olt: { is: { nas: { is: expect.any(Object) } } } },
        ],
      });
    });

    it('the platform owner gets the unfiltered lists', async () => {
      const { svc, prisma } = makeService();
      await svc.listOlts(OWNER);
      expect(prisma.olt.findMany.mock.calls[0][0].where).toBeUndefined();
      await svc.listPorts(undefined, OWNER);
      expect(prisma.ponPort.findMany.mock.calls[0][0].where).toEqual({});
    });
  });
});
