import { terminateInfo, endedInfo, TERMINATE_TABLE, TERMINATE_CATEGORIES } from './radius-terminate';
import { DisconnectsService } from '../logs/disconnects.service';
import { LogsService } from '../logs/logs.service';

// RFC 2866 §5.10 — the table operators read, word for word.
const RFC: Array<[number, string, string]> = [
  [1, 'User Request', 'User initiated the disconnect (logout).'],
  [2, 'Lost Carrier', 'DCD was dropped on the port.'],
  [3, 'Lost Service', 'Service can no longer be provided; for example, the user’s connection to a host was interrupted.'],
  [4, 'Idle Timeout', 'Idle timer expired.'],
  [5, 'Session Timeout', 'Subscriber reached the maximum continuous time allowed for the service or session.'],
  [6, 'Admin Reset', 'System administrator reset the port or session.'],
  [7, 'Admin Reboot', 'System administrator terminated the session on the NAS; for example, prior to rebooting the NAS.'],
  [8, 'Port Error', 'NAS detected an error on the port that required ending the session.'],
  [9, 'NAS Error', 'NAS detected an error (other than on the port) that required ending the session.'],
  [10, 'NAS Request', 'NAS ended the session for a non-error reason.'],
  [11, 'NAS Reboot', 'NAS ended the session due to a non-administrative reboot.'],
  [12, 'Port Unneeded', 'NAS ended the session because the resource usage fell below the low threshold; for example, the bandwidth-on-demand algorithm determined that the port was no longer needed.'],
  [13, 'Port Preempted', 'NAS ended the session to allocate the port to a higher-priority use.'],
  [14, 'Port Suspended', 'NAS ended the session to suspend a virtual session.'],
  [15, 'Service Unavailable', 'NAS was unable to provide the requested service.'],
  [16, 'Callback', 'NAS is terminating the current session in order to perform callback for a new session.'],
  [17, 'User Error', 'Error in the user input caused the session to be terminated.'],
  [18, 'Host Request', 'Login host terminated the session normally.'],
];

describe('RADIUS Acct-Terminate-Cause catalog', () => {
  it('lists all eighteen standard causes with the RFC wording', () => {
    expect(TERMINATE_TABLE.map((t) => [t.code, t.label, t.description])).toEqual(RFC);
  });

  it('resolves the number, the RFC string and loose spellings to the same entry', () => {
    for (const t of TERMINATE_TABLE) {
      expect(terminateInfo(t.code).key).toBe(t.key);
      expect(terminateInfo(String(t.code)).key).toBe(t.key);
      expect(terminateInfo(t.key).key).toBe(t.key);
      expect(terminateInfo(t.key.toUpperCase().replace(/-/g, '_')).key).toBe(t.key);
      expect(terminateInfo(t.label).key).toBe(t.key);
    }
  });

  it('gives every cause a meaning, an action, a category and a customer line', () => {
    const cats = new Set(TERMINATE_CATEGORIES.map((c) => c.id));
    for (const t of TERMINATE_TABLE) {
      expect(t.meaning.length).toBeGreaterThan(10);
      expect(t.action.length).toBeGreaterThan(5);
      expect(cats.has(t.category)).toBe(true);
      expect(t.customer).not.toMatch(/-/);
    }
  });

  it('never calls an ended session "still open"', () => {
    expect(terminateInfo(null).category).toBe('open');
    expect(endedInfo(null).key).toBe('Not-Reported');
    expect(endedInfo('').key).toBe('Not-Reported');
  });

  it('keeps vendor values readable and bounded', () => {
    const t = terminateInfo('X'.repeat(200));
    expect(t.category).toBe('other');
    expect(t.label.length).toBeLessThanOrEqual(32);
  });

  it('explains the panel’s own causes', () => {
    expect(endedInfo('Reconciled-NotOnRouter').category).toBe('panel');
    expect(endedInfo('Stale-Session').category).toBe('panel');
  });
});

describe('Disconnect report tenancy', () => {
  const mkPrisma = () => {
    const calls: any[] = [];
    const prisma: any = {
      radAcct: {
        groupBy: jest.fn(async (a: any) => { calls.push(a.where); return []; }),
        findMany: jest.fn(async (a: any) => { calls.push(a.where); return []; }),
        count: jest.fn(async (a: any) => { calls.push(a.where); return 0; }),
      },
      nas: { findMany: jest.fn(async () => []) },
      subscriber: { findMany: jest.fn(async () => []) },
    };
    return { prisma, calls };
  };
  const scope: any = {
    isAdmin: (r: string) => r === 'SUPER_ADMIN',
    radiusWhere: async () => ({}),
    subscriberWhere: async () => ({ userId: { in: [7, 8] } }),
    nasWhere: async () => ({ ownerId: 7 }),
  };

  it('limits every query to the caller’s own customers, even with a username filter', async () => {
    const { prisma, calls } = mkPrisma();
    const svc = new DisconnectsService(prisma, scope);
    const out = await svc.report({ id: 7, role: 'ADMIN' } as any, { username: 'someone-else', sinceHours: 24 });
    expect(calls.length).toBeGreaterThan(4);
    for (const w of calls) {
      expect(JSON.stringify(w)).toContain('"subscriber":{"is":{"userId":{"in":[7,8]}}}');
    }
    expect(out.causes.filter((c: any) => c.standard)).toHaveLength(18);
    expect(out.totals.ended).toBe(0);
  });

  it('ignores a malformed router address instead of passing it to the database', async () => {
    const { prisma, calls } = mkPrisma();
    const svc = new DisconnectsService(prisma, scope);
    await svc.report({ id: 7, role: 'ADMIN' } as any, { nasIp: "1.1.1.1' OR 1=1" });
    expect(JSON.stringify(calls)).not.toContain('nasipaddress');
  });

  it('folds raw spellings onto one cause and counts customers', async () => {
    const { prisma } = mkPrisma();
    prisma.radAcct.groupBy = jest.fn(async (a: any) => {
      if (a.by.length === 1) return [
        { acctterminatecause: 'Lost-Carrier', _count: { _all: 3 }, _avg: { acctsessiontime: 100 }, _max: { acctstoptime: new Date() } },
        { acctterminatecause: '2', _count: { _all: 1 }, _avg: { acctsessiontime: 500 }, _max: { acctstoptime: new Date() } },
        { acctterminatecause: 'User-Request', _count: { _all: 4 }, _avg: { acctsessiontime: 60 }, _max: { acctstoptime: new Date() } },
      ];
      if (a.by.includes('username')) return [
        { username: 'a', acctterminatecause: 'Lost-Carrier', _count: { _all: 3 }, _max: { acctstoptime: new Date() } },
        { username: 'b', acctterminatecause: '2', _count: { _all: 1 }, _max: { acctstoptime: new Date() } },
        { username: 'a', acctterminatecause: 'User-Request', _count: { _all: 4 }, _max: { acctstoptime: new Date() } },
      ];
      return [];
    });
    const svc = new DisconnectsService(prisma, scope);
    const out = await svc.report({ id: 7, role: 'ADMIN' } as any, { cause: 'Lost-Carrier' });
    const lc: any = out.causes.find((c: any) => c.key === 'Lost-Carrier');
    expect(lc.count).toBe(4);
    expect(lc.customers).toBe(2);
    expect(lc.avgSessionSec).toBe(200);
    expect(out.totals.abnormal).toBe(4);
    expect(out.customers.map((c: any) => c.username).sort()).toEqual(['a', 'b']);
    expect(out.customers.find((c: any) => c.username === 'a')?.count).toBe(3);
  });
});

describe('Disconnect log — how each session ended', () => {
  const stop = new Date('2026-10-04T02:38:15Z');
  const row = (over: any = {}) => ({
    radacctid: BigInt(1), acctsessionid: 's1', username: 'sara', nasipaddress: '10.0.0.1',
    acctstarttime: new Date(stop.getTime() - 3600_000), acctstoptime: stop, acctsessiontime: 3600,
    acctterminatecause: 'Admin-Reset', callingstationid: 'AA:BB:CC:DD:EE:FF', framedipaddress: '100.64.0.2',
    subscriber: { id: 9, fullName: 'Sara' }, ...over,
  });
  const mk = (logs: any[], users: any[] = []) => {
    const where: any[] = [];
    const prisma: any = {
      radAcct: {
        groupBy: jest.fn(async () => []),
        findMany: jest.fn(async (a: any) => { where.push(a.where); return a.include ? [row()] : []; }),
        count: jest.fn(async () => 1),
      },
      nas: { findMany: jest.fn(async () => []) },
      subscriber: { findMany: jest.fn(async () => []) },
      systemLog: { findMany: jest.fn(async () => logs) },
      user: { findMany: jest.fn(async () => users) },
      radPostAuth: { findMany: jest.fn(async () => []) },
      routerLog: { findMany: jest.fn(async () => []) },
      activityLog: { findMany: jest.fn(async () => []) },
    };
    const scope: any = {
      isAdmin: () => false,
      radiusWhere: async () => ({}),
      subscriberWhere: async () => ({ userId: { in: [7] } }),
      nasWhere: async () => ({}),
      rootId: async () => 7,
      descendantIds: async () => [7, 8],
    };
    return { svc: new DisconnectsService(prisma, scope), where };
  };

  it('names the operator who pressed Disconnect, by session id', async () => {
    const { svc } = mk(
      [{ createdAt: stop, metadata: JSON.stringify({ actorId: 8, username: 'sara', acctSessionId: 's1', method: 'radius-coa', why: 'operator-kick', attempts: ['radius-coa: ACK'] }) }],
      [{ id: 8, name: 'Staff One', email: 'staff@isp.pk' }],
    );
    const out = await svc.report({ id: 7, role: 'ADMIN' } as any, {});
    const how = (out.records[0] as any).how;
    expect(how.by).toBe('operator');
    expect(how.actor).toEqual({ name: 'Staff One', email: 'staff@isp.pk' });
    expect(how.method).toBe('RADIUS CoA');
    expect(how.steps).toEqual(['radius-coa: ACK']);
  });

  it('hides the name of an operator outside the viewer’s tree', async () => {
    const { svc } = mk(
      [{ createdAt: stop, metadata: JSON.stringify({ actorId: 1, username: 'sara', acctSessionId: 's1', why: 'operator-kick' }) }],
      [{ id: 1, name: 'Upstream Owner', email: 'owner@isp.pk' }],
    );
    const out = await svc.report({ id: 7, role: 'RESELLER' } as any, {});
    expect((out.records[0] as any).how.actor).toEqual({ name: 'Your provider', email: null });
  });

  it('ignores another customer’s panel event that reuses the session id', async () => {
    const { svc } = mk([{ createdAt: stop, metadata: JSON.stringify({ actorId: 8, username: 'someone-else', acctSessionId: 's1', why: 'operator-kick' }) }]);
    const out = await svc.report({ id: 7, role: 'ADMIN' } as any, {});
    expect((out.records[0] as any).how.source).toBe('cause');
  });

  it('falls back to the cause when the panel recorded nothing', async () => {
    const { svc } = mk([]);
    const out = await svc.report({ id: 7, role: 'ADMIN' } as any, {});
    const how = (out.records[0] as any).how;
    expect(how.source).toBe('cause');
    expect(how.title).toMatch(/administrator/i);
  });

  it('searches username, MAC (any separator) and IP — inside the caller’s scope', async () => {
    const { svc, where } = mk([]);
    await svc.report({ id: 7, role: 'ADMIN' } as any, { search: 'aabbcc' });
    const w = JSON.stringify(where[0]);
    expect(w).toContain('"subscriber":{"is":{"userId":{"in":[7]}}}');
    expect(w).toContain('"callingstationid":{"contains":"aa:bb:cc","mode":"insensitive"}');
    const before = where.length;
    await svc.report({ id: 7, role: 'ADMIN' } as any, { search: '100.64.0.2' });
    expect(JSON.stringify(where[before])).toContain('"framedipaddress":"100.64.0.2"');
  });
});

describe('RADIUS session log username filter', () => {
  it('cannot widen the caller’s list to another company’s customer', async () => {
    const prisma: any = {
      subscriber: { findMany: jest.fn(async () => [{ username: 'mine' }]) },
      radAcct: { findMany: jest.fn(async () => [{ radacctid: 1, username: 'theirs' }]) },
    };
    const scope: any = {
      isAdmin: () => false,
      subscriberWhere: async () => ({ userId: { in: [7] } }),
      radiusWhere: async () => ({}),
    };
    const svc = new LogsService(prisma, scope, {} as any);
    const out = await svc.getRadiusSessions({ id: 7, role: 'ADMIN' } as any, { username: 'theirs' });
    expect(out.items).toEqual([]);
    expect(prisma.radAcct.findMany).not.toHaveBeenCalled();
  });
});

describe('Disconnect log helpers', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { detectMassDrops, likelyReject, vlanOf, describeAction } = require('../logs/disconnects.service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { macInfo, normaliseMac } = require('./mac-vendor');

  it('finds a mass drop on one router and ignores scattered single drops', () => {
    const t = Date.UTC(2026, 9, 4, 14, 32, 0);
    const rows = [
      ...['a', 'b', 'c', 'd'].map((u, i) => ({ nasipaddress: '10.0.0.1', acctstoptime: new Date(t + i * 10_000), username: u, acctterminatecause: 'NAS-Reboot' })),
      { nasipaddress: '10.0.0.1', acctstoptime: new Date(t + 3600_000), username: 'e', acctterminatecause: 'User-Request' },
      { nasipaddress: '10.0.0.2', acctstoptime: new Date(t), username: 'f', acctterminatecause: 'Lost-Carrier' },
    ];
    const out = detectMassDrops(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ nasIp: '10.0.0.1', customers: 4, topKey: 'NAS-Reboot' });
  });

  it('explains a refused login from the account state', () => {
    const now = Date.now();
    expect(likelyReject({ status: 'SUSPENDED' }, null, now).key).toBe('suspended');
    expect(likelyReject({ status: 'ACTIVE', expiryDate: new Date(now - 1000) }, null, now).key).toBe('expired');
    expect(likelyReject({ status: 'ACTIVE', macLocked: 'AA:AA:AA:AA:AA:AA' }, 'BB:BB:BB:BB:BB:BB', now).key).toBe('mac-locked');
    expect(likelyReject({ status: 'ACTIVE' }, null, now).key).toBe('unknown');
  });

  it('reads VLANs, MAC makers and panel actions', () => {
    expect(vlanOf('ether1-vlan34')).toBe('34');
    expect(vlanOf('ether2.300')).toBe('300');
    expect(vlanOf('ether1')).toBeNull();
    expect(normaliseMac('4c-5e-0c-11-22-33')).toBe('4C:5E:0C:11:22:33');
    expect(macInfo('4C:5E:0C:11:22:33').maker).toBe('MikroTik');
    expect(macInfo('DA:A1:19:00:00:01').privateMac).toBe(true);
    expect(macInfo('00:11:22:33:44:55').maker).toBeNull();
    expect(describeAction('SUBSCRIBERS.SUSPEND', null)).toBe('Suspended');
    expect(describeAction('UPDATE', '{"packageId":3}')).toBe('Package changed');
  });
});
