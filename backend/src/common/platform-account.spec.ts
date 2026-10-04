import { ensurePlatformAccount } from './platform-account';

/**
 * Boot-time separation of the platform account from the business it used to
 * run. Uses a small in-memory Prisma so the real queries are exercised.
 */
function match(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]: [string, any]) => {
    if (k === 'AND') return (cond as any[]).every((w) => match(row, w));
    if (k === 'OR') return (cond as any[]).some((w) => match(row, w));
    if (k === 'NOT') return !match(row, cond);
    const v = row[k] ?? null;
    if (cond === null) return v === null;
    if (typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(v);
      if ('not' in cond) return cond.not === null ? v !== null : v !== cond.not;
      if ('endsWith' in cond) return typeof v === 'string' && v.endsWith(cond.endsWith);
    }
    return v === cond;
  });
}

function table(rows: any[]) {
  let next = 1000;
  return {
    rows,
    findMany: async ({ where, orderBy }: any = {}) => {
      const r = rows.filter((x) => match(x, where));
      return orderBy?.id === 'asc' ? r.sort((a, b) => a.id - b.id) : r;
    },
    findFirst: async (a: any = {}) => (await table(rows).findMany(a))[0] ?? null,
    findUnique: async ({ where }: any) => rows.find((x) => match(x, where)) ?? null,
    count: async ({ where }: any = {}) => rows.filter((x) => match(x, where)).length,
    create: async ({ data }: any) => { const r = { id: next++, isDemo: false, parentId: null, ...data }; rows.push(r); return r; },
    update: async ({ where, data }: any) => { const r = rows.find((x) => match(x, where)); Object.assign(r, data); return r; },
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((x) => match(x, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
}

function db(users: any[], extra: Partial<Record<string, any[]>> = {}) {
  const p: any = {
    user: table(users.map((u) => ({ isActive: true, isDemo: false, parentId: null, password: 'HASH', ...u }))),
    subscriber: table(extra.subscriber ?? []),
    nas: table(extra.nas ?? []),
  };
  for (const m of ['package', 'ipPool', 'area', 'staticIp', 'inventoryItem', 'monitorTarget', 'networkDevice',
    'alertRule', 'prefixPool', 'prefixAllocation', 'uploadedFile', 'accessGroup', 'isp']) p[m] = table(extra[m] ?? []);
  return p;
}
const quiet = { warn: () => undefined };

describe('platform account at boot', () => {
  it('a SUPER_ADMIN that runs a business becomes that company; a platform login appears above it', async () => {
    const p = db(
      [
        { id: 1, email: 'owner@isp.pk', role: 'SUPER_ADMIN' },
        { id: 2, email: 'dealer@isp.pk', role: 'RESELLER', parentId: 1 },
        { id: 3, email: 'other@co.pk', role: 'ADMIN', parentId: 1 },
      ],
      {
        subscriber: [{ id: 50, userId: 1, email: 'a@b.pk' }, { id: 51, userId: null, email: 'x@y.pk' }, { id: 52, userId: null, email: 'demo@example.invalid' }],
        nas: [{ id: 7, ownerId: null, server: null }, { id: 8, ownerId: null, server: 'demo-radius' }],
        package: [{ id: 9, ownerId: null }],
      },
    );
    const r = await ensurePlatformAccount(p, quiet);
    expect(r).toEqual({ action: 'split', platformEmail: 'superadmin@isp.pk', companyEmail: 'owner@isp.pk' });

    const platform = p.user.rows.find((u: any) => u.email === 'superadmin@isp.pk');
    expect(platform).toMatchObject({ role: 'SUPER_ADMIN', password: 'HASH', mustChangePassword: true });
    // Same login, same data — now the company's ADMIN, under the platform.
    expect(p.user.rows.find((u: any) => u.id === 1)).toMatchObject({ role: 'ADMIN', parentId: platform.id });
    // Its dealer stays inside the company; the OTHER company moves up.
    expect(p.user.rows.find((u: any) => u.id === 2).parentId).toBe(1);
    expect(p.user.rows.find((u: any) => u.id === 3).parentId).toBe(platform.id);
    // Owner-less business rows go to the company; sandbox rows do not.
    expect(p.subscriber.rows.find((s: any) => s.id === 51).userId).toBe(1);
    expect(p.subscriber.rows.find((s: any) => s.id === 52).userId).toBeNull();
    expect(p.nas.rows.find((n: any) => n.id === 7).ownerId).toBe(1);
    expect(p.nas.rows.find((n: any) => n.id === 8).ownerId).toBeNull();
    expect(p.package.rows[0].ownerId).toBe(1);
  });

  it('a company left with the installer\'s default name takes its ISP\'s name', async () => {
    const p = db([{ id: 1, email: 'owner@isp.pk', role: 'SUPER_ADMIN', name: 'Super Admin' }], {
      subscriber: [{ id: 50, userId: 1 }],
      isp: [{ id: 4, name: 'FastNet Broadband', ownerId: null }],
    });
    await ensurePlatformAccount(p, quiet);
    expect(p.user.rows.find((u: any) => u.id === 1).name).toBe('FastNet Broadband');

    const q = db([{ id: 1, email: 'owner@isp.pk', role: 'SUPER_ADMIN', name: 'Ali Khan' }], { subscriber: [{ id: 50, userId: 1 }] });
    await ensurePlatformAccount(q, quiet);
    expect(q.user.rows.find((u: any) => u.id === 1).name).toBe('Ali Khan');
  });

  it('runs once: a second boot changes nothing', async () => {
    const p = db([{ id: 1, email: 'owner@isp.pk', role: 'SUPER_ADMIN' }], { subscriber: [{ id: 50, userId: 1 }] });
    await ensurePlatformAccount(p, quiet);
    const before = JSON.stringify(p.user.rows);
    expect(await ensurePlatformAccount(p, quiet)).toEqual({ action: 'none' });
    expect(JSON.stringify(p.user.rows)).toBe(before);
  });

  it('a pure platform owner hosting companies is left alone', async () => {
    const p = db([
      { id: 1, email: 'root@host.pk', role: 'SUPER_ADMIN' },
      { id: 3, email: 'co@co.pk', role: 'ADMIN', parentId: 1 },
    ], { subscriber: [{ id: 50, userId: 3 }, { id: 51, userId: null }] });
    expect(await ensurePlatformAccount(p, quiet)).toEqual({ action: 'none' });
    expect(p.user.rows).toHaveLength(2);
    expect(p.subscriber.rows.find((s: any) => s.id === 51).userId).toBeNull();
  });

  it('no SUPER_ADMIN, owner ran as ADMIN with a business: keeps it, platform login created above', async () => {
    const p = db([{ id: 4, email: 'boss@net.pk', role: 'ADMIN' }], { nas: [{ id: 1, ownerId: 4 }] });
    const r = await ensurePlatformAccount(p, quiet);
    expect(r).toMatchObject({ action: 'split', platformEmail: 'superadmin@net.pk' });
    const platform = p.user.rows.find((u: any) => u.role === 'SUPER_ADMIN');
    expect(p.user.rows.find((u: any) => u.id === 4)).toMatchObject({ role: 'ADMIN', parentId: platform.id });
  });

  it('no SUPER_ADMIN and an empty top-level admin: that account simply becomes the platform', async () => {
    const p = db([{ id: 4, email: 'boss@net.pk', role: 'ADMIN' }]);
    expect(await ensurePlatformAccount(p, quiet)).toEqual({ action: 'promoted', platformEmail: 'boss@net.pk' });
    expect(p.user.rows).toHaveLength(1);
    expect(p.user.rows[0].role).toBe('SUPER_ADMIN');
  });

  it('picks a free address when superadmin@ is taken', async () => {
    const p = db([
      { id: 1, email: 'owner@isp.pk', role: 'SUPER_ADMIN' },
      { id: 2, email: 'superadmin@isp.pk', role: 'ADMIN', parentId: 1 },
    ], { subscriber: [{ id: 50, userId: 1 }] });
    const r: any = await ensurePlatformAccount(p, quiet);
    expect(r.platformEmail).toBe('superadmin+1@isp.pk');
  });

  it('holds an advisory lock so parallel workers cannot split twice', async () => {
    const p = db([{ id: 1, email: 'owner@isp.pk', role: 'SUPER_ADMIN' }], { subscriber: [{ id: 50, userId: 1 }] });
    const exec = jest.fn(async () => 0);
    p.$transaction = async (fn: any) => fn({ ...p, $executeRawUnsafe: exec });
    await ensurePlatformAccount(p, quiet);
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'));
  });
});
