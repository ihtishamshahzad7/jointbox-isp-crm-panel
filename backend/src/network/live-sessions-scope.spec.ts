/**
 * P2 — server-side session scoping.
 *
 * Proves a non-admin's live-sessions page and total are computed in the DB with
 * the caller's own usernames pushed into the query (bounded pagination), not by
 * fetching every session on the server and filtering/slicing in Node. A platform
 * admin passes no restriction.
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { NetworkService } from './network.service';

function harness(opts: { admin: boolean; scopedUsernames?: string[]; rows?: any[]; total?: number }) {
  const calls: any = { get: [], count: [] };
  const radiusSync = {
    async getActiveSessions(nasIp: string | undefined, o: any = {}) { calls.get.push({ nasIp, o }); return opts.rows ?? []; },
    async countActiveSessions(nasIp: string | undefined, q: any, usernames: any) { calls.count.push({ nasIp, q, usernames }); return opts.total ?? 0; },
  };
  const scope = {
    isAdmin: () => opts.admin,
    subscriberWhere: async () => ({ userId: { in: [7, 8] } }),
  };
  const prisma = {
    subscriber: {
      async findMany() {
        return (opts.scopedUsernames ?? []).map((u) => ({ username: u }));
      },
    },
  };
  const svc: any = Object.create(NetworkService.prototype);
  svc.radiusSync = radiusSync; svc.scope = scope; svc.prisma = prisma;
  // enrichSessions is exercised elsewhere; stub it to echo the rows it is given.
  svc.enrichSessions = async (rows: any[]) => rows.map((r) => ({ username: r.username }));
  return { svc, calls };
}

describe('NetworkService.liveSessions scoping (P2)', () => {
  it('non-admin: pushes its own usernames into BOTH the page query and the count', async () => {
    const h = harness({ admin: false, scopedUsernames: ['a', 'b'], rows: [{ username: 'a' }], total: 1 });
    const res: any = await h.svc.liveSessions(undefined, { role: 'RESELLER' }, { page: 2, limit: 25 });
    // Page query carried the scope + real LIMIT/OFFSET — not a Node slice.
    expect(h.calls.get[0].o.usernames).toEqual(['a', 'b']);
    expect(h.calls.get[0].o.limit).toBe(25);
    expect(h.calls.get[0].o.offset).toBe(25); // (page 2 - 1) * 25
    // Count carried the same scope.
    expect(h.calls.count[0].usernames).toEqual(['a', 'b']);
    expect(res).toEqual({ items: [{ username: 'a' }], total: 1, page: 2, pageSize: 25 });
  });

  it('non-admin with no subscribers: empty scope is passed (DB returns nothing)', async () => {
    const h = harness({ admin: false, scopedUsernames: [], rows: [], total: 0 });
    const res: any = await h.svc.liveSessions(undefined, { role: 'SUB_RESELLER' }, { page: 1, limit: 50 });
    expect(h.calls.get[0].o.usernames).toEqual([]); // radius-sync short-circuits this to []
    expect(h.calls.count[0].usernames).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('platform admin: no username restriction (null), full server view', async () => {
    const h = harness({ admin: true, rows: [{ username: 'x' }], total: 1 });
    await h.svc.liveSessions(undefined, { role: 'SUPER_ADMIN' }, { page: 1, limit: 50 });
    expect(h.calls.get[0].o.usernames).toBeNull();
    expect(h.calls.count[0].usernames).toBeNull();
  });

  it('legacy (non-paged) non-admin call is also scoped in SQL', async () => {
    const h = harness({ admin: false, scopedUsernames: ['a'], rows: [{ username: 'a' }] });
    const res: any = await h.svc.liveSessions(undefined, { role: 'RETAILER' });
    expect(Array.isArray(res)).toBe(true); // legacy array shape
    expect(h.calls.get[0].o.usernames).toEqual(['a']);
    expect(h.calls.count.length).toBe(0); // no count in legacy shape
  });

  it('caps page size at 200', async () => {
    const h = harness({ admin: true, rows: [], total: 0 });
    await h.svc.liveSessions(undefined, { role: 'SUPER_ADMIN' }, { page: 1, limit: 99999 });
    expect(h.calls.get[0].o.limit).toBe(200);
  });
});
