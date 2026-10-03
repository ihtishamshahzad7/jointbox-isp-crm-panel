import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BoostService } from './boost.service';
import { BoostController } from './boost.controller';

jest.mock('../common/cluster-util', () => ({ isPrimaryInstance: () => true }));

/**
 * BOOST TENANCY — a boost changes a live session's speed, so it must only
 * ever touch a subscriber the caller's company owns.
 *
 * Two companies: ISP A (user 10) owns subscriber 100, ISP B (user 20) owns
 * subscriber 200. The platform owner (user 1) sees both.
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ISP_A = { sub: 10, role: 'ADMIN' };
const ISP_B = { sub: 20, role: 'ADMIN' };
const SUB_OWNER: Record<number, number> = { 100: 10, 200: 20 };

function makeScope() {
  const isPlatformOwner = (a: any) => a?.role === 'SUPER_ADMIN';
  const assertViaSubscriber = jest.fn(async (a: any, id: any, what = 'Record') => {
    if (isPlatformOwner(a)) return;
    if (id == null || SUB_OWNER[Number(id)] !== a.sub) throw new NotFoundException(`${what} not found`);
  });
  return {
    isPlatformOwner,
    assertPlatformOwner: (a: any) => { if (!isPlatformOwner(a)) throw new ForbiddenException(); },
    assertViaSubscriber,
    assertSubscriberVisible: jest.fn((a: any, id: number) => assertViaSubscriber(a, id, 'Subscriber')),
    subscriberWhere: jest.fn(async (a: any) => (isPlatformOwner(a) ? {} : { userId: { in: [a.sub] } })),
  };
}

function make() {
  const prisma: any = {
    subscriber: { findUnique: jest.fn().mockResolvedValue({ package: { downloadSpeed: 10, uploadSpeed: 5 } }) },
    temporaryBoost: {
      findUnique: jest.fn().mockResolvedValue({
        id: 5, subscriberId: 100, reverted: false, originalDown: 10, originalUp: 5,
      }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: 9 }),
    },
  };
  const coa: any = { changeBandwidth: jest.fn().mockResolvedValue({ success: true, live: true }) };
  const scope = makeScope();
  const svc = new BoostService(prisma, coa, scope as any);
  const ctl = new BoostController(svc);
  return { prisma, coa, scope, svc, ctl };
}

describe('Boost tenancy', () => {
  it("another company's ADMIN cannot revert a boost on a subscriber it does not own", async () => {
    const { ctl, coa, prisma } = make();
    await expect(ctl.revert(5, { user: ISP_B })).rejects.toBeInstanceOf(NotFoundException);
    expect(coa.changeBandwidth).not.toHaveBeenCalled();
    expect(prisma.temporaryBoost.update).not.toHaveBeenCalled();
  });

  it('the owning company and the platform owner can revert it', async () => {
    for (const actor of [ISP_A, OWNER]) {
      const { ctl, coa } = make();
      await expect(ctl.revert(5, { user: actor })).resolves.toMatchObject({ ok: true });
      expect(coa.changeBandwidth).toHaveBeenCalledWith(100, 10, 5);
    }
  });

  it("cannot apply a boost to another company's subscriber", async () => {
    const { ctl, coa, prisma } = make();
    await expect(
      ctl.apply({ subscriberId: 100, downMbps: 50, upMbps: 20 }, { user: ISP_B }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(coa.changeBandwidth).not.toHaveBeenCalled();
    expect(prisma.temporaryBoost.create).not.toHaveBeenCalled();
  });

  it('the active list is filtered to the caller’s subscribers', async () => {
    const { ctl, prisma } = make();
    await ctl.active(undefined, { user: ISP_A });
    const where = prisma.temporaryBoost.findMany.mock.calls[0][0].where;
    expect(where.subscriber).toEqual({ userId: { in: [10] } });
    expect(where.reverted).toBe(false);
  });

  it('the platform owner’s active list is unchanged', async () => {
    const { ctl, prisma } = make();
    await ctl.active('100', { user: OWNER });
    const where = prisma.temporaryBoost.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ reverted: false, expiresAt: { not: null }, subscriberId: 100 });
  });

  it('the expiry cron (no actor) still reverts every due boost', async () => {
    const { svc, prisma, coa } = make();
    prisma.temporaryBoost.findMany.mockResolvedValue([
      { id: 1, subscriberId: 100, originalDown: 10, originalUp: 5 },
      { id: 2, subscriberId: 200, originalDown: 20, originalUp: 10 },
    ]);
    await svc.revertExpired();
    expect(coa.changeBandwidth).toHaveBeenCalledTimes(2);
  });
});
