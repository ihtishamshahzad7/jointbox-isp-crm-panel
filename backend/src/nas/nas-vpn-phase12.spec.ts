/**
 * Phase 1.2 regression tests — SIMULATION / UNIT (FakeRouter, FakeDb, fake
 * host filesystem). No real MikroTik, Linux VPN stack or database.
 *
 *   1. Firewall: the UDP 1701 drop rule only drops NEW inbound sessions.
 *   2. Existing router L2TP clients: detected, never touched, apply refused.
 *   4. Host lock / fencing: per-NAS host lock and cancel checkpoints.
 *   5. Restart / interrupted apply recovery.
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ConflictException } from '@nestjs/common';
import {
  FakeDb,
  FakeRouter,
  fakeSecrets,
  HOST_INVENTORY,
  SharedHost,
  hostLocks,
} from './nas-vpn-fakes.testkit-spec';
import {
  ApplyInput,
  RouterOsMgmtApplier,
  guardComment,
  guardRules,
} from './routeros-mgmt-applier';
import { L2tpClientDialer } from './l2tp-client-dialer.service';
import { NasL2tpClientService } from './nas-l2tp-client.service';

const PSK = 'Uplinko-Psk-2026';
const PASS = 'Uplinko-Ppp-2026';
const HOST_IP = '198.199.0.10';
const ACTOR = { sub: 2, role: 'ADMIN' };

function applyInput(over: Partial<ApplyInput> = {}): ApplyInput {
  return {
    nasId: 7,
    apiUser: 'uplinko-api',
    psk: PSK,
    pppUser: 'uplinko-mgmt',
    pppPassword: PASS,
    profile: 'default',
    nasTunnelIp: '10.255.7.1',
    hostTunnelIp: '10.255.7.2',
    hostPublicIp: HOST_IP,
    confirmServerChange: false,
    existingSnapshot: null,
    persistSnapshot: async () => undefined,
    ...over,
  };
}

function router() {
  const r = new FakeRouter();
  r.server = {
    enabled: 'false',
    'use-ipsec': 'no',
    'ipsec-secret': '',
    authentication: 'mschap2',
  };
  r.rules = [
    {
      '.id': '*A',
      chain: 'input',
      action: 'accept',
      'connection-state': 'established,related',
      disabled: 'false',
      comment: 'admin: established',
    },
    {
      '.id': '*B',
      chain: 'input',
      action: 'accept',
      protocol: 'udp',
      'dst-port': '500,4500',
      'src-address': '203.0.113.99',
      disabled: 'false',
      comment: 'admin: site-to-site IKE',
    },
    {
      '.id': '*C',
      chain: 'input',
      action: 'drop',
      disabled: 'false',
      comment: 'admin: drop rest',
    },
  ];
  return r;
}
const snapshotOf = (r: FakeRouter) =>
  JSON.parse(
    JSON.stringify({
      server: r.server,
      rules: r.rules,
      secrets: r.secrets,
      l2tp: r.l2tpClients,
    }),
  );

describe('1. HIGH — UDP 1701 guard drops only NEW inbound sessions (simulation)', () => {
  it('rule 4 carries connection-state=new; rules are placed above the admin established-accept rule', async () => {
    const r = router();
    const res = await new RouterOsMgmtApplier(r.connect).apply(applyInput());
    expect(res.ok).toBe(true);
    const rule4 = r.rules.find((x) => x.comment === guardComment(7, 4))!;
    expect(rule4).toMatchObject({
      chain: 'input',
      protocol: 'udp',
      'dst-port': '1701',
      'connection-state': 'new',
      action: 'drop',
    });
    expect(r.rules.slice(0, 4).map((x) => x.comment)).toEqual(
      [1, 2, 3, 4].map((k) => guardComment(7, k)),
    );
    expect(r.rules.slice(4).map((x) => x['.id'])).toEqual(['*A', '*B', '*C']); // admin rules: same order, untouched
    expect(guardRules(HOST_IP)[3]['connection-state']).toBe('new');
  });

  it("the previous reproduction: replies to the router's OWN outgoing L2TP client are still accepted", async () => {
    const r = router();
    const reply = () =>
      r.packetAllowed({
        protocol: 'udp',
        dstPort: 1701,
        src: '203.0.113.77',
        state: 'established',
      });
    expect(reply()).toBe(true);
    await new RouterOsMgmtApplier(r.connect).apply(applyInput());
    expect(reply()).toBe(true);
    expect(
      r.packetAllowed({
        protocol: 'udp',
        dstPort: 1701,
        src: '203.0.113.77',
        state: 'related',
      }),
    ).toBe(true);
  });

  it('a NEW unauthorized inbound L2TP session is dropped; Uplinko over IPsec is allowed', async () => {
    const r = router();
    await new RouterOsMgmtApplier(r.connect).apply(applyInput());
    expect(
      r.packetAllowed({
        protocol: 'udp',
        dstPort: 1701,
        src: '8.8.4.4',
        state: 'new',
      }),
    ).toBe(false);
    expect(
      r.packetAllowed({
        protocol: 'udp',
        dstPort: 1701,
        src: HOST_IP,
        state: 'new',
        viaIpsec: false,
      }),
    ).toBe(false);
    expect(
      r.packetAllowed({
        protocol: 'udp',
        dstPort: 1701,
        src: HOST_IP,
        state: 'new',
        viaIpsec: true,
      }),
    ).toBe(true);
    expect(
      r.canL2tpLogin({
        srcIp: HOST_IP,
        psk: PSK,
        user: 'uplinko-mgmt',
        password: PASS,
      }),
    ).toBe(true);
  });

  it('unrelated IPsec traffic keeps its previous verdict', async () => {
    const r = router();
    const ike = () =>
      r.packetAllowed({
        protocol: 'udp',
        dstPort: 500,
        src: '203.0.113.99',
        state: 'new',
      });
    const esp = () =>
      r.packetAllowed({
        protocol: 'ipsec-esp',
        src: '203.0.113.99',
        state: 'established',
      });
    const before = [ike(), esp()];
    await new RouterOsMgmtApplier(r.connect).apply(applyInput());
    expect([ike(), esp()]).toEqual(before);
  });

  it('repeated apply does not duplicate or move rules; rollback restores the exact firewall', async () => {
    const r = router();
    const before = snapshotOf(r);
    const a = new RouterOsMgmtApplier(r.connect);
    const res = await a.apply(applyInput());
    if (!res.ok) throw new Error('apply failed');
    const again = await a.apply(applyInput({ existingSnapshot: res.snapshot }));
    expect(again.ok).toBe(true);
    expect(
      r.rules.filter((x) => String(x.comment).startsWith('uplinko-mgmt-vpn')),
    ).toHaveLength(4);
    expect(
      (
        await a.restore(7, res.snapshot, res.desired, {
          requireNoForeignChange: true,
        })
      ).outcome,
    ).toBe('restored');
    expect(snapshotOf(r)).toEqual(before);
  });

  it('a guard rule missing connection-state=new on the router fails read-back and is restored', async () => {
    const r = router();
    r.faults.push({ cmd: '/ip/firewall/filter/add', nth: 1, when: 'ignore' }); // rule 4 (added first) silently not created
    const before = snapshotOf(r);
    const res = await new RouterOsMgmtApplier(r.connect).apply(applyInput());
    expect(res).toMatchObject({
      ok: false,
      stage: 'failed',
      code: 'verify_failed',
    });
    expect(snapshotOf(r)).toEqual(before);
  });
});

describe('2. HIGH — existing router L2TP clients (simulation)', () => {
  it.each([
    [
      'configured and running',
      [
        {
          '.id': '*L1',
          name: 'l2tp-upstream',
          'connect-to': '203.0.113.77',
          running: 'true',
          disabled: 'false',
        },
      ],
    ],
    [
      'configured, not running',
      [
        {
          '.id': '*L1',
          name: 'l2tp-site-b',
          running: 'false',
          disabled: 'false',
        },
      ],
    ],
    [
      'configured but disabled (inactive)',
      [{ '.id': '*L1', name: 'l2tp-old', running: 'false', disabled: 'true' }],
    ],
  ])(
    '%s → apply refused, nothing changed, clients untouched',
    async (_label, clients) => {
      const r = router();
      r.l2tpClients = clients;
      const before = snapshotOf(r);
      const res = await new RouterOsMgmtApplier(r.connect).apply(
        applyInput({ confirmServerChange: true }),
      );
      expect(res).toMatchObject({
        ok: false,
        stage: 'refused',
        code: 'l2tp_clients_present',
      });
      if (!res.ok && res.stage === 'refused')
        expect(res.message).toContain(clients[0].name);
      expect(r.mutations()).toHaveLength(0);
      expect(snapshotOf(r)).toEqual(before);
    },
  );

  it('empty client list → apply proceeds', async () => {
    const r = router();
    expect(
      (await new RouterOsMgmtApplier(r.connect).apply(applyInput())).ok,
    ).toBe(true);
  });

  it.each([
    ['API error', 'error'],
    ['malformed rows', 'malformed'],
  ])('unreadable inventory (%s) → refused (fail closed)', async (_l, mode) => {
    const r = router();
    r.l2tpClientsMode = mode as any;
    const res = await new RouterOsMgmtApplier(r.connect).apply(applyInput());
    expect(res).toMatchObject({
      ok: false,
      stage: 'refused',
      code: 'l2tp_clients_unreadable',
    });
    expect(r.mutations()).toHaveLength(0);
  });

  it('preview reports the refusal too (inspect)', async () => {
    const r = router();
    r.l2tpClients = [
      {
        '.id': '*L1',
        name: 'l2tp-upstream',
        running: 'true',
        disabled: 'false',
      },
    ];
    await expect(
      new RouterOsMgmtApplier(r.connect).inspect({
        nasId: 7,
        apiUser: 'uplinko-api',
        psk: PSK,
        pppUser: 'uplinko-mgmt',
        hostPublicIp: HOST_IP,
      }),
    ).rejects.toMatchObject({ code: 'l2tp_clients_present' });
  });
});

describe('4. MEDIUM — host lock and cancel checkpoints (unit, real lock code)', () => {
  function dialer(host: SharedHost, pid: number) {
    const d = new L2tpClientDialer();
    const l = hostLocks(host, pid);
    return { d, l };
  }
  it('second live process cannot take the NAS host lock; a dead holder is taken over; release is ownership-checked', async () => {
    const host = new SharedHost();
    const a = hostLocks(host, 101);
    const b = hostLocks(host, 202);
    expect(await a.acquireHostLock(7, { token: 't1', pid: 0 })).toBe(true);
    expect(await b.acquireHostLock(7, { token: 't2', pid: 0 })).toBe(false);
    expect(await b.acquireHostLock(8, { token: 't3', pid: 0 })).toBe(true); // other NAS unaffected
    await b.releaseHostLock(7, { token: 't2', pid: 0 }); // not the owner → no effect
    expect(await b.acquireHostLock(7, { token: 't2', pid: 0 })).toBe(false);
    host.dead.add(101);
    expect(await b.acquireHostLock(7, { token: 't2', pid: 0 })).toBe(true);
    await a.releaseHostLock(7, { token: 't1', pid: 0 }); // stale former owner cannot remove the new owner's lock
    expect(
      await hostLocks(host, 303).acquireHostLock(7, { token: 't9', pid: 0 }),
    ).toBe(false);
    void dialer;
  });

  it('a dial stops issuing host commands as soon as it is cancelled / loses its lease', async () => {
    const d = new L2tpClientDialer();
    const cmds: string[] = [];
    d.run = async (cmd, args) => {
      cmds.push(`${cmd} ${args.join(' ')}`);
      return { code: 0, stdout: cmd === 'which' ? '/x' : '', stderr: '' };
    };
    d.sleep = async () => undefined;
    d.files = {
      writeSecret: async () => undefined,
      read: async () => null,
      remove: async () => undefined,
      lockCreate: async () => 'ok',
      lockRemove: async () => undefined,
    };
    let lost = false;
    const origRun = d.run;
    d.run = async (cmd, args, t) => {
      const r = await origRun(cmd, args, t);
      if (cmd === 'swanctl' && args[0] === '--load-all') lost = true; // lease lost during a long command
      return r;
    };
    const res = await d.dial(
      {
        nasId: 7,
        server: '45.76.10.20',
        ipsecPsk: PSK,
        pppUsername: 'uplinko-mgmt',
        pppPassword: PASS,
        localAddress: '10.255.7.2',
        remoteAddress: '10.255.7.1',
        timeoutSec: 10,
      },
      { shouldCancel: () => lost },
    );
    expect(res.errorCode).toBe('cancelled');
    expect(cmds.some((c) => c.startsWith('swanctl --initiate'))).toBe(false);
    expect(
      cmds.some(
        (c) =>
          c.startsWith('xl2tpd-control') &&
          !/disconnect-lac|remove-lac/.test(c),
      ),
    ).toBe(false);
  });
});

describe('5. MEDIUM — restart and interrupted-apply recovery (simulation)', () => {
  const FULL = {
    publicHost: '45.76.10.20',
    pppUsername: 'uplinko-mgmt',
    pppPassword: PASS,
    ipsecPsk: PSK,
    localAddress: '10.255.7.2',
    remoteAddress: '10.255.7.1',
  };
  function svcFor(db: FakeDb, r: FakeRouter, host: SharedHost, pid: number) {
    if (!db.nasRows.length)
      db.nasRows = [
        {
          id: 7,
          nasIp: '45.76.20.7/32',
          nasname: '45.76.20.7',
          apiUsername: 'uplinko-api',
          apiPassword: 'enc:eA==',
        },
      ];
    const locks = hostLocks(host, pid);
    const dialer: any = {
      ifName: (id: number) => `ulnas${id}`,
      inventory: async () => HOST_INVENTORY,
      dial: jest.fn(),
      hangup: jest.fn(async () => ({ state: 'disconnected' })),
      status: jest.fn(async () => ({ state: 'disconnected' })),
      tooling: async () => ({ ok: true, detail: 'ok' }),
      purge: jest.fn(async () => ({ clean: true, remaining: [] })),
      hasHostFootprint: async () => false,
      acquireHostLock: locks.acquireHostLock,
      releaseHostLock: locks.releaseHostLock,
    };
    const svc = new NasL2tpClientService(
      db as any,
      fakeSecrets() as any,
      { assertNasAccess: async () => ({ id: 7 }) } as any,
      dialer,
    );
    svc.env = { UPLINKO_PUBLIC_IP: HOST_IP, L2TP_MGMT_VPN_ENABLED: 'true' };
    svc.rosConnect = async () => r.connect;
    return svc;
  }

  /** Apply that "crashes" right after `afterMutations` router changes (worker dies; nothing else runs). */
  async function crashedApply(afterMutations: number) {
    const db = new FakeDb();
    const r = router();
    const host = new SharedHost();
    const w1 = svcFor(db, r, host, 101);
    await w1.save(7, ACTOR, FULL);
    r.downAfterCalls = null;
    const origSend = r.send.bind(r);
    let count = 0;
    let hang!: () => void;
    const stuck = new Promise<void>((res) => {
      hang = res;
    });
    r.send = async (w: string[]) => {
      if (/\/(set|add|remove)$/.test(w[0])) {
        if (count === afterMutations) await stuck; // the worker never gets further
        count++;
      }
      return origSend(w);
    };
    void w1.applyNas(7, ACTOR).catch(() => undefined);
    for (let i = 0; i < 500 && count < afterMutations; i++)
      await new Promise((x) => setImmediate(x));
    await new Promise((x) => setTimeout(x, 5));
    // Crash: process gone, heartbeat stopped, lease expired.
    for (const l of (w1 as any).leases) clearInterval(l.timer);
    host.dead.add(101);
    db.rows.get(7)!.clientLockUntil = new Date(Date.now() - 1);
    r.send = origSend;
    void hang;
    return { db, r, host };
  }

  it('after a worker restart the view shows no stale operation and the apply as recovery_required', async () => {
    const { db, r, host } = await crashedApply(2);
    const w2 = svcFor(db, r, host, 202);
    const v = await w2.getView(7, ACTOR);
    expect(v.operation).toBeNull();
    expect(v.nasApplyState).toBe('recovery_required');
  });

  it('a new apply is refused until recovery, and makes no router change', async () => {
    const { db, r, host } = await crashedApply(2);
    const w2 = svcFor(db, r, host, 202);
    const n = r.mutations().length;
    await expect(w2.applyNas(7, ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(r.mutations()).toHaveLength(n);
    expect(db.rows.get(7)!.mgmtApplyState).toBe('recovery_required');
  });

  it('interrupted mid-way (mixed) → recovery reports rollback-safe; rollback then restores the original router', async () => {
    const before = snapshotOf(router());
    const { db, r, host } = await crashedApply(3);
    const w2 = svcFor(db, r, host, 202);
    const rec = await w2.recoverNas(7, ACTOR);
    expect(rec).toMatchObject({
      routerState: 'mixed',
      rollbackSafe: true,
      nasApplyState: 'recovery_required',
    });
    expect(await w2.rollbackNas(7, ACTOR)).toMatchObject({
      rolledBack: true,
      confirmedByNas: true,
    });
    expect(snapshotOf(r)).toEqual(before);
    expect(db.rows.get(7)!.mgmtApplyState).toBe('none');
  });

  it('interrupted before any change (at snapshot) → recovered to "none" without touching the router', async () => {
    const { db, r, host } = await crashedApply(0);
    const w2 = svcFor(db, r, host, 202);
    const n = r.mutations().length;
    expect(await w2.recoverNas(7, ACTOR)).toMatchObject({
      routerState: 'at_snapshot',
      nasApplyState: 'none',
    });
    expect(r.mutations()).toHaveLength(n);
  });

  it('interrupted after the last change (router fully configured) → recovered to "applied", read-only', async () => {
    const { db, r, host } = await crashedApply(99); // never hangs → apply completes its mutations; simulate crash before release
    db.rows.get(7)!.mgmtApplyState = 'applying';
    db.rows.get(7)!.clientLockUntil = new Date(Date.now() - 1);
    const w2 = svcFor(db, r, host, 202);
    const n = r.mutations().length;
    expect(await w2.recoverNas(7, ACTOR)).toMatchObject({
      routerState: 'at_desired',
      nasApplyState: 'applied',
    });
    expect(r.mutations()).toHaveLength(n);
  });

  it('router changed by someone else meanwhile → recovery_required (manual), rollback refused', async () => {
    const { db, r, host } = await crashedApply(3);
    r.server['ipsec-secret'] = 'Admin-Changed';
    const w2 = svcFor(db, r, host, 202);
    expect(await w2.recoverNas(7, ACTOR)).toMatchObject({
      routerState: 'foreign',
      rollbackSafe: false,
    });
    const n = r.mutations().length;
    await expect(w2.rollbackNas(7, ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(r.mutations()).toHaveLength(n);
  });

  it('a stale worker that lost its lease cannot persist its snapshot (apply aborted before any router change)', async () => {
    const db = new FakeDb();
    const r = router();
    const host = new SharedHost();
    const w1 = svcFor(db, r, host, 101);
    await w1.save(7, ACTOR, FULL);
    const origAcquire = (w1 as any).acquire.bind(w1);
    (w1 as any).acquire = async (...a: any[]) => {
      const lease = await origAcquire(...a);
      db.rows.get(7)!.clientLockOwner = 'other-worker'; // ownership changes right after
      return lease;
    };
    await expect(w1.applyNas(7, ACTOR)).rejects.toThrow();
    expect(r.mutations()).toHaveLength(0);
  });
});

describe('server without strongSwan/xl2tpd (unit)', () => {
  it('purge of a NAS that never used the VPN reports clean (no false "IPsec state unknown")', async () => {
    const d = new L2tpClientDialer();
    d.run = async (cmd) => ({
      code: cmd === 'ip' ? 1 : 127,
      stdout: '',
      stderr: 'not found',
    });
    d.files = {
      writeSecret: async () => undefined,
      read: async () => null,
      remove: async () => undefined,
      lockCreate: async () => 'ok',
      lockRemove: async () => undefined,
    };
    expect(await d.purge(7)).toEqual({ clean: true, remaining: [] });
    expect(await d.hasHostFootprint(7)).toBe(false);
  });
  it('with strongSwan installed but not answering, purge is NOT reported clean', async () => {
    const d = new L2tpClientDialer();
    d.run = async (cmd) => ({
      code: cmd === 'which' ? 0 : 1,
      stdout: '',
      stderr: '',
    });
    d.files = {
      writeSecret: async () => undefined,
      read: async () => null,
      remove: async () => undefined,
      lockCreate: async () => 'ok',
      lockRemove: async () => undefined,
    };
    expect((await d.purge(7)).clean).toBe(false);
  });
});
