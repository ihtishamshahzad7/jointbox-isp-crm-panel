import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AccountingService } from './accounting.service';
import { ScopeService } from '../common/scope.service';

/**
 * Each company closes ITS OWN books. Company A closing September must not
 * stop company B posting a September payment — which is what the old
 * installation-wide singleton did.
 *
 *   1 platform · 10 company A (11 franchise) · 20 company B
 *   subscriber 500 belongs to A's franchise, 600 to B
 */
const COMPANY: Record<number, number | null> = { 1: null, 10: 10, 11: 10, 20: 20 };

function make() {
  const locks = new Map<number, any>();
  let global: any = null;
  const prisma: any = {
    accountingLock: {
      findUnique: jest.fn(async () => global),
      upsert: jest.fn(async ({ update }: any) => (global = { id: 1, ...update })),
    },
    companyPeriodLock: {
      findUnique: jest.fn(async ({ where }: any) => locks.get(where.companyId) ?? null),
      upsert: jest.fn(async ({ where, update }: any) => {
        const row = { companyId: where.companyId, ...update };
        locks.set(where.companyId, row);
        return row;
      }),
    },
    subscriber: { findUnique: jest.fn(async ({ where }: any) => ({ userId: where.id === 500 ? 11 : 20 })) },
    activityLog: { create: jest.fn(() => ({ catch: () => undefined })) },
  };
  const scope = new ScopeService(prisma);
  jest.spyOn(scope, 'companyRootId').mockImplementation(async (id: number) => COMPANY[id] ?? null);
  jest.spyOn(scope, 'rootId').mockImplementation(async (a: any) => Number(a.sub));
  return { svc: new AccountingService(prisma, {} as any, scope, {} as any), prisma };
}

describe('period lock is per company', () => {
  it("company A's lock blocks A's postings only", async () => {
    const { svc } = make();
    await svc.setPeriodLock('2026-09-30', { sub: 10, role: 'ADMIN' } as any);
    await expect(svc.assertPeriodOpen('2026-09-15', { subscriberId: 500 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.assertPeriodOpen('2026-09-15', { subscriberId: 600 })).resolves.toBeUndefined();
    await expect(svc.assertPeriodOpen('2026-10-02', { subscriberId: 500 })).resolves.toBeUndefined();
  });

  it("a franchise cannot close its company's books", async () => {
    const { svc } = make();
    await expect(svc.setPeriodLock('2026-09-30', { sub: 11, role: 'RESELLER' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('each company reads its own date', async () => {
    const { svc } = make();
    await svc.setPeriodLock('2026-09-30', { sub: 10, role: 'ADMIN' } as any);
    expect((await svc.getPeriodLock({ sub: 20, role: 'ADMIN' } as any)).lockedThrough).toBeNull();
    expect((await svc.getPeriodLock({ sub: 11, role: 'RESELLER' } as any)).lockedThrough).toBeTruthy();
  });

  it('the platform lock still closes everyone', async () => {
    const { svc, prisma } = make();
    await svc.setPeriodLock('2026-08-31', { sub: 1, role: 'SUPER_ADMIN' } as any);
    expect(prisma.accountingLock.upsert).toHaveBeenCalled();
    expect(prisma.companyPeriodLock.upsert).not.toHaveBeenCalled();
    await expect(svc.assertPeriodOpen('2026-08-15', { subscriberId: 600 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
