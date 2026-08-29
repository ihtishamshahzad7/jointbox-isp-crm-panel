import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NasService } from './nas.service';

/**
 * NAS WRITE SCOPING — who may change or delete a router.
 *
 * THE HOLE THIS CLOSES
 * `update()`, `remove()`, `toggleStatus()` and `setMonitoredPorts()` took no
 * actor at all, and the controller passed none. So any account holding the
 * `nas.write` permission could edit or delete ANY router in the database by
 * guessing an id — a sibling franchise's, or the ISP's own. The Nas model has
 * carried the comment "Only the owner may edit or delete it" since it was
 * written; nothing enforced it.
 *
 * WHY IT IS WORSE THAN AN ORDINARY DATA LEAK
 * A NAS row is live network configuration, not a record. Changing `secret` or
 * `nasIp` on somebody else's router de-authenticates every subscriber behind
 * it; deleting the row takes the whole site off FreeRADIUS. It is a one-request
 * outage of a network you do not own, and the victim's only symptom is "RADIUS
 * stopped working", with nothing in their own panel to explain it.
 *
 * THE RULE, AND WHY READ AND WRITE DIFFER
 * Visibility is deliberately broad — `nasWhere()` includes routers shared down
 * to you and those owned by your ancestors, because you must be able to SEE a
 * router to put subscribers on it. Reusing that for writes would let a dealer
 * who was merely LENT a router re-key it out from under the franchise that
 * owns it. So the write test is ownership, not visibility.
 */
describe('NasService — write scoping', () => {
  const ADMIN = { role: 'ADMIN', sub: 1 } as any;
  const FRANCHISE = { role: 'RESELLER', sub: 5 } as any;

  function makeService(opts: { nas?: any } = {}) {
    const prisma: any = {
      nas: {
        // findFirst is what the guard uses (visibility + id).
        findFirst: jest.fn().mockResolvedValue(opts.nas ?? null),
        findUnique: jest.fn().mockResolvedValue(opts.nas ?? null),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ canAddNas: true }) },
    };
    const scope: any = {
      isAdmin: jest.fn((r: string) => r === 'ADMIN' || r === 'SUPER_ADMIN'),
      actorId: jest.fn((a: any) => Number(a?.id ?? a?.sub)),
      rootId: jest.fn().mockResolvedValue(5),
      nasWhere: jest.fn().mockResolvedValue({ ownerId: { in: [5, 6] } }),
    };
    const svc = new NasService(prisma, {} as any, {} as any, scope, {} as any);
    return { prisma, scope, svc };
  }

  const guard = (svc: NasService, actor: any) => (svc as any).assertNasOwner(7, actor);

  // ───────────────────────────────────────────────────────────────
  // The rule itself
  // ───────────────────────────────────────────────────────────────
  it('lets the owner through', async () => {
    const { svc } = makeService({ nas: { id: 7, ownerId: 5, shortname: 'booni' } });
    await expect(guard(svc, FRANCHISE)).resolves.toBeUndefined();
  });

  it('REFUSES a router that is merely shared with you', async () => {
    // The core of the fix: visible, usable for subscribers — and still not
    // yours to re-key or delete.
    const { svc } = makeService({ nas: { id: 7, ownerId: 99, shortname: 'mastuj' } });
    await expect(guard(svc, FRANCHISE)).rejects.toThrow(ForbiddenException);
  });

  it('reports a router outside your scope as NOT FOUND, so ids stay unenumerable', async () => {
    // A different message here would let someone sweep ids to discover how
    // many routers the network has and which exist.
    const { svc } = makeService({ nas: null });
    await expect(guard(svc, FRANCHISE)).rejects.toThrow(NotFoundException);
  });

  it('explains WHY when the router is visible but not yours', async () => {
    // Not a leak — actionable. The caller can see this router already.
    const { svc } = makeService({ nas: { id: 7, ownerId: 99 } });
    await expect(guard(svc, FRANCHISE)).rejects.toThrow(/only its owner/i);
  });

  it('lets the ISP through without a lookup', async () => {
    const { svc, prisma } = makeService({ nas: { id: 7, ownerId: 99 } });
    await expect(guard(svc, ADMIN)).resolves.toBeUndefined();
    expect(prisma.nas.findFirst).not.toHaveBeenCalled();
  });

  it('scopes the ownership lookup by visibility, not by id alone', async () => {
    // Looking the row up unscoped would confirm the existence of routers the
    // caller cannot see, even while refusing the write.
    const { svc, scope, prisma } = makeService({ nas: { id: 7, ownerId: 5 } });
    await guard(svc, FRANCHISE);
    expect(scope.nasWhere).toHaveBeenCalledWith(FRANCHISE);
    expect(JSON.stringify(prisma.nas.findFirst.mock.calls[0][0].where)).toContain('ownerId');
  });

  // ───────────────────────────────────────────────────────────────
  // Every write path must actually be behind it
  // ───────────────────────────────────────────────────────────────
  describe('the guard is wired to every mutating route', () => {
    const NOT_MINE = { id: 7, ownerId: 99, shortname: 'someone-else' };

    it('blocks update()', async () => {
      const { svc, prisma } = makeService({ nas: NOT_MINE });
      await expect(svc.update(7, { secret: 'hijack' }, FRANCHISE)).rejects.toThrow(
        ForbiddenException,
      );
      // The point: nothing was written. Changing `secret` on a stranger's
      // router de-authenticates every subscriber behind it.
      expect(prisma.nas.update).not.toHaveBeenCalled();
    });

    it('blocks remove()', async () => {
      const { svc, prisma } = makeService({ nas: NOT_MINE });
      await expect(svc.remove(7, FRANCHISE)).rejects.toThrow(ForbiddenException);
      expect(prisma.nas.delete).not.toHaveBeenCalled();
    });

    it('blocks toggleStatus()', async () => {
      const { svc, prisma } = makeService({ nas: NOT_MINE });
      await expect(svc.toggleStatus(7, FRANCHISE)).rejects.toThrow(ForbiddenException);
      expect(prisma.nas.update).not.toHaveBeenCalled();
    });

    it('blocks setMonitoredPorts()', async () => {
      const { svc, prisma } = makeService({ nas: NOT_MINE });
      await expect(svc.setMonitoredPorts(7, ['ether1'], FRANCHISE)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.nas.update).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Internal callers must keep working
  // ───────────────────────────────────────────────────────────────
  it('stays open to internal callers that pass no actor', async () => {
    // Background jobs (normalizeNasRecords, importers) act as the system and
    // have no session. Making the guard fail closed on `undefined` would break
    // them silently at boot — which is why absence of an actor is treated as
    // "server-side", not as "anonymous".
    const { svc } = makeService({ nas: { id: 7, ownerId: 99 } });
    await expect(guard(svc, undefined)).resolves.toBeUndefined();
  });
});
