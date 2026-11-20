/**
 * NAS deletion × management VPN — UNIT test with mocks (no database or host).
 * Deleting a NAS must stop and remove ONLY its own host tunnel first, and must
 * not delete the NAS when that cleanup cannot be verified.
 */
import { ConflictException } from '@nestjs/common';
import { NasService } from './nas.service';

function makeService(cleanup: jest.Mock) {
  const tx = {
    networkLog: { deleteMany: jest.fn() },
    pppoeSession: { deleteMany: jest.fn() },
    subscriber: { updateMany: jest.fn() },
    ipPool: { updateMany: jest.fn() },
    nas: {
      findUnique: jest.fn().mockResolvedValue({ id: 7 }),
      delete: jest.fn().mockResolvedValue({ id: 7, nasname: 'r7' }),
    },
  };
  const prisma: any = {
    nas: {
      findUnique: jest.fn().mockResolvedValue({
        id: 7,
        nasname: 'r7',
        nasIp: '45.76.20.7',
        _count: {
          networkLogs: 0,
          pppoeSessions: 0,
          subscribers: 0,
          ipPools: 0,
        },
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const scope: any = { isAdmin: () => true };
  const svc = new NasService(
    prisma,
    {} as any,
    {} as any,
    scope,
    {} as any,
    {} as any,
    { apply: async () => ({ ok: true }) } as any,
    { cleanupForNasDeletion: cleanup } as any,
  );
  return { svc, prisma, tx };
}

describe('NasService.remove — management VPN cleanup (unit, mocked)', () => {
  it('cleans up the NAS tunnel before deleting the row', async () => {
    const order: string[] = [];
    const cleanup = jest.fn(async () => {
      order.push('cleanup');
      return { hadConfig: true, routerSideApplied: false };
    });
    const { svc, prisma } = makeService(cleanup);
    prisma.$transaction.mockImplementation(async (fn: any) => {
      order.push('delete');
      return fn({
        networkLog: {},
        pppoeSession: {},
        subscriber: {},
        ipPool: {},
        nas: {
          findUnique: async () => ({ id: 7 }),
          delete: async () => ({ id: 7 }),
        },
      });
    });
    await svc.remove(7, { role: 'ADMIN', sub: 1 });
    expect(cleanup).toHaveBeenCalledWith(7);
    expect(order).toEqual(['cleanup', 'delete']);
  });

  it('does NOT delete the NAS when its tunnel cannot be removed, and keeps the reason', async () => {
    const cleanup = jest.fn(async () => {
      throw new ConflictException(
        'The management VPN for this NAS could not be removed from the server (interface ulnas7). The NAS was not deleted.',
      );
    });
    const { svc, prisma, tx } = makeService(cleanup);
    await expect(svc.remove(7, { role: 'ADMIN', sub: 1 })).rejects.toThrow(
      /was not deleted/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.nas.delete).not.toHaveBeenCalled();
  });

  it('warns that router-side settings remain when the VPN had been applied to the router', async () => {
    const cleanup = jest.fn(async () => ({
      hadConfig: true,
      routerSideApplied: true,
    }));
    const { svc } = makeService(cleanup);
    const res: any = await svc.remove(7, { role: 'ADMIN', sub: 1 });
    expect(res.warning).toMatch(/remain on the router/);
  });
});
