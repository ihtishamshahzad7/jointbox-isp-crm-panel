/**
 * NasL2tpClientService — SIMULATION tests. Database = FakeDb (shared by two
 * service instances to model two PM2 workers), router = FakeRouter, host
 * dialer = controllable stub. No real database, router or VPN is involved.
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  NasL2tpClientService,
  NEVER_RETURNED,
} from './nas-l2tp-client.service';
import {
  FakeDb,
  FakeRouter,
  fakeSecrets,
  HOST_INVENTORY,
  SharedHost,
  hostLocks,
} from './nas-vpn-fakes.testkit-spec';

const PSK = 'Uplinko-Psk-2026';
const PASS = 'Uplinko-Ppp-2026';
const ACTOR = { sub: 2, role: 'ADMIN' };
const FULL = {
  publicHost: '45.76.10.20',
  pppUsername: 'uplinko-mgmt',
  pppPassword: PASS,
  ipsecPsk: PSK,
  localAddress: '10.255.7.2',
  remoteAddress: '10.255.7.1',
};
const ENV = {
  UPLINKO_PUBLIC_IP: '198.199.0.10',
  L2TP_MGMT_VPN_ENABLED: 'true',
  L2TP_PROTECTED_CIDRS: '10.255.200.0/24',
} as any;

function makeDialer(locks: ReturnType<typeof hostLocks>) {
  return {
    acquireHostLock: jest.fn(locks.acquireHostLock),
    releaseHostLock: jest.fn(locks.releaseHostLock),
    ifName: (id: number) => `ulnas${id}`,
    inventory: jest.fn(async () => HOST_INVENTORY as any),
    dial: jest.fn(async (p: any, _o?: any): Promise<any> => ({
      state: 'connected',
      interface: `ulnas${p.nasId}`,
      localAddress: p.localAddress,
      remoteAddress: p.remoteAddress,
      ipsec: 'established',
      l2tp: 'up',
      attempts: 1,
    })),
    hangup: jest.fn(async () => ({
      state: 'disconnected',
      ipsec: 'down',
      l2tp: 'down',
    })),
    status: jest.fn(async () => ({
      state: 'disconnected',
      ipsec: 'down',
      l2tp: 'down',
    })),
    tooling: jest.fn(async () => ({ ok: true, detail: 'ok' })),
    purge: jest.fn(async () => ({ clean: true, remaining: [] as string[] })),
    hasHostFootprint: jest.fn(async () => false),
  };
}

function setup(
  opts: {
    denied?: boolean;
    db?: FakeDb;
    router?: FakeRouter;
    host?: SharedHost;
    pid?: number;
  } = {},
) {
  const db = opts.db ?? new FakeDb();
  if (!db.nasRows.length)
    db.nasRows = [7, 8, 9].map((id) => ({
      id,
      nasIp: `45.76.20.${id}/32`,
      nasname: `45.76.20.${id}`,
      apiUsername: 'uplinko-api',
      apiPassword: 'enc:eA==',
    }));
  const router = opts.router ?? new FakeRouter();
  const config = {
    assertNasAccess: jest.fn(async () => {
      if (opts.denied)
        throw new ForbiddenException(
          'Only the NAS owner can manage its VPN configuration.',
        );
      return { id: 7 };
    }),
  };
  const shared = opts.host ?? ((db as any).sharedHost ??= new SharedHost());
  const dialer = makeDialer(
    hostLocks(shared, opts.pid ?? 1000 + Math.floor(Math.random() * 1e6)),
  );
  const svc = new NasL2tpClientService(
    db as any,
    fakeSecrets() as any,
    config as any,
    dialer as any,
  );
  svc.env = ENV;
  svc.rosConnect = async () => router.connect;
  return { svc, db, dialer, router, config };
}

function expectNoSecrets(obj: unknown) {
  const json = JSON.stringify(obj);
  for (const s of [PSK, PASS, 'enc:']) expect(json).not.toContain(s);
  for (const k of NEVER_RETURNED) expect(json).not.toContain(`"${k}"`);
}

afterEach(() => jest.useRealTimers());

/** The background operation reaches the dialer only after the host lock; wait for it. */
async function untilCalled(m: jest.Mock, n = 1) {
  for (let i = 0; i < 500 && m.mock.calls.length < n; i++)
    await new Promise((r) => setImmediate(r));
  if (m.mock.calls.length < n) throw new Error('dialer was never called');
}

describe('NasL2tpClientService (simulation)', () => {
  describe('secrets and legacy separation', () => {
    it('stores PSK/password encrypted in the management columns, never in the legacy ones, and never returns them', async () => {
      const { svc, db } = setup();
      db.rows.set(7, {
        nasId: 7,
        publicHost: 'legacy.example',
        ipsecPskEnc: 'enc:bGVnYWN5',
        state: 'approved',
        clientState: 'disconnected',
        mgmtApplyState: 'none',
      });
      const v = await svc.save(7, ACTOR, FULL);
      const row = db.rows.get(7)!;
      expect(row.mgmtIpsecPskEnc).toMatch(/^enc:/);
      expect(row.pppPasswordEnc).toMatch(/^enc:/);
      expect(row).toMatchObject({
        publicHost: 'legacy.example',
        ipsecPskEnc: 'enc:bGVnYWN5',
        state: 'approved',
      }); // legacy untouched
      expect(v).toMatchObject({
        publicHost: '45.76.10.20',
        hasIpsecPsk: true,
        hasPppPassword: true,
        tunnelUsedForRouterAccess: false,
      });
      expectNoSecrets(v);
      expectNoSecrets(await svc.getView(7, ACTOR));
    });

    it('a successful router apply does not change the legacy approval state', async () => {
      const { svc, db } = setup();
      db.rows.set(7, {
        nasId: 7,
        state: 'approved',
        clientState: 'disconnected',
        mgmtApplyState: 'none',
      });
      await svc.save(7, ACTOR, FULL);
      await svc.applyNas(7, ACTOR);
      expect(db.rows.get(7)).toMatchObject({
        state: 'approved',
        mgmtApplyState: 'applied',
      });
    });
  });

  describe('authorization before anything else', () => {
    it.each([
      'getView',
      'status',
      'connect',
      'disconnect',
      'reconnect',
      'cancel',
      'previewNas',
      'applyNas',
      'rollbackNas',
      'purgeHost',
    ])(
      '%s refused for a non-owner before DB writes, router calls or host commands',
      async (m) => {
        const { svc, db, dialer, router } = setup({ denied: true });
        const spy = jest.spyOn(db.nasL2tpConfig, 'updateMany');
        await expect((svc as any)[m](7, ACTOR, {})).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(spy).not.toHaveBeenCalled();
        expect(dialer.dial).not.toHaveBeenCalled();
        expect(dialer.hangup).not.toHaveBeenCalled();
        expect(dialer.purge).not.toHaveBeenCalled();
        expect(router.log).toHaveLength(0);
      },
    );
    it('save refused for a non-owner', async () => {
      const { svc, db } = setup({ denied: true });
      await expect(svc.save(7, ACTOR, FULL)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(db.rows.size).toBe(0);
    });
  });

  describe('HIGH: address policy enforced on the backend before any router or host change', () => {
    it.each([
      ['8.8.8.8 tunnel address', { remoteAddress: '8.8.8.8' }],
      [
        '192.168.1.1 (host gateway) tunnel address',
        { remoteAddress: '192.168.1.1' },
      ],
      ['host interface address', { localAddress: '192.168.1.167' }],
      ['private router endpoint', { publicHost: '10.0.0.5' }],
      ['host gateway as endpoint', { publicHost: '192.168.1.1' }],
      ['protected infrastructure range', { remoteAddress: '10.255.200.4' }],
      [
        'tunnel address equal to an existing NAS address',
        { publicHost: '45.76.10.21', remoteAddress: '45.76.20.8' },
      ],
    ])('%s is rejected and nothing is stored', async (_l, over) => {
      const { svc, db, router, dialer } = setup();
      await expect(
        svc.save(7, ACTOR, { ...FULL, ...over }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(db.rows.size).toBe(0);
      expect(router.log).toHaveLength(0);
      expect(dialer.dial).not.toHaveBeenCalled();
    });

    it('overlap with another NAS (another tenant) — remote, local and endpoint', async () => {
      const db = new FakeDb();
      const a = setup({ db });
      await a.svc.save(8, ACTOR, {
        ...FULL,
        publicHost: '45.76.10.21',
        localAddress: '10.255.8.2',
        remoteAddress: '10.255.8.1',
      });
      const b = setup({ db });
      await expect(
        b.svc.save(7, ACTOR, { ...FULL, remoteAddress: '10.255.8.1' }),
      ).rejects.toThrow(/another NAS tunnel/);
      await expect(
        b.svc.save(7, ACTOR, { ...FULL, localAddress: '10.255.8.1' }),
      ).rejects.toThrow(/another NAS tunnel/);
      await expect(
        b.svc.save(7, ACTOR, { ...FULL, remoteAddress: '10.255.8.2' }),
      ).rejects.toThrow(/another NAS tunnel/);
      await expect(
        b.svc.save(7, ACTOR, { ...FULL, publicHost: '45.76.10.21' }),
      ).rejects.toThrow(/Another NAS already uses/);
      expect(db.rows.has(7)).toBe(false);
    });

    it('fails closed when the host network inventory cannot be read', async () => {
      const { svc, db, dialer } = setup();
      dialer.inventory.mockResolvedValueOnce(null as any);
      await expect(svc.save(7, ACTOR, FULL)).rejects.toThrow(
        /inventory could not be read/,
      );
      expect(db.rows.size).toBe(0);
    });

    it('addresses are re-checked at connect time (host network changed since save)', async () => {
      const { svc, dialer } = setup();
      await svc.save(7, ACTOR, FULL);
      dialer.inventory.mockResolvedValueOnce({
        ...HOST_INVENTORY,
        networks: [
          ...HOST_INVENTORY.networks,
          { net: 0x0aff0000, bits: 16, text: '10.255.0.0/16' },
        ],
      } as any);
      await expect(svc.connect(7, ACTOR)).rejects.toThrow(
        /overlaps a network on this server/,
      );
      expect(dialer.dial).not.toHaveBeenCalled();
    });

    it('valid addresses in the management pool are accepted', async () => {
      const { svc } = setup();
      await expect(svc.save(7, ACTOR, FULL)).resolves.toMatchObject({
        localAddress: '10.255.7.2',
        remoteAddress: '10.255.7.1',
      });
    });
  });

  describe('CRITICAL via the service: router key protection end to end', () => {
    it('API user without "sensitive": 400, router untouched, no false restore claim, state not "applied"', async () => {
      const { svc, router, db } = setup();
      router.groups[0].policy = 'read,write,api';
      router.server = {
        enabled: 'true',
        'use-ipsec': 'yes',
        'ipsec-secret': 'Customers-Key-99',
        authentication: 'mschap2',
      };
      await svc.save(7, ACTOR, FULL);
      const err: any = await svc
        .applyNas(7, ACTOR, { confirmServerChange: true })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify(err.getResponse())).not.toMatch(/restored/i);
      expect(router.mutations()).toHaveLength(0);
      expect(router.server['ipsec-secret']).toBe('Customers-Key-99');
      expect(db.rows.get(7)!.mgmtApplyState).toBe('none');
      expect(db.rows.get(7)!.mgmtSnapshotEnc ?? null).toBeNull();
    });

    it('apply failure with a verified restore is reported as such; unrestored as manual intervention', async () => {
      const { svc, router, db } = setup();
      router.recoverOnReconnect = true;
      router.faults.push({ cmd: '/ppp/secret/add', when: 'after' });
      await svc.save(7, ACTOR, FULL);
      const e1: any = await svc.applyNas(7, ACTOR).catch((e) => e);
      expect(e1.getResponse()).toMatchObject({
        applyOutcome: 'apply_failed_restored',
      });
      expect(db.rows.get(7)!.mgmtApplyState).toBe('apply_failed_restored');

      const s2 = setup();
      s2.router.faults.push({ cmd: '/ppp/secret/add', when: 'after' }); // router stays down
      await s2.svc.save(7, ACTOR, FULL);
      const e2: any = await s2.svc.applyNas(7, ACTOR).catch((e) => e);
      expect(e2.getResponse()).toMatchObject({
        applyOutcome: 'apply_failed_not_restored',
      });
      expect(e2.getResponse().message).toMatch(/manual intervention/);
      expect(s2.db.rows.get(7)!.mgmtApplyState).toBe('apply_failed_unrestored');
    });

    it('missing UPLINKO_PUBLIC_IP: the firewall guard cannot be built, so nothing is changed', async () => {
      const { svc, router } = setup();
      svc.env = { ...ENV, UPLINKO_PUBLIC_IP: '' };
      await svc.save(7, ACTOR, FULL);
      await expect(svc.applyNas(7, ACTOR)).rejects.toThrow(/public IP/);
      expect(router.log).toHaveLength(0);
    });

    it('rollback after an interrupted apply (no record of what was applied) is refused', async () => {
      const { svc, db, router } = setup();
      await svc.save(7, ACTOR, FULL);
      db.rows.get(7)!.mgmtSnapshotEnc = fakeSecrets().encryptValue(
        JSON.stringify({
          version: 1,
          nasId: 7,
          takenAt: 'x',
          server: {
            enabled: false,
            useIpsec: 'no',
            ipsecSecret: '',
            authentication: [],
          },
          secret: null,
          guardInstalled: false,
        }),
      );
      db.rows.get(7)!.mgmtApplyState = 'applying';
      await expect(svc.rollbackNas(7, ACTOR)).rejects.toThrow(
        /manual intervention/,
      );
      expect(router.mutations()).toHaveLength(0);
    });

    it('full cycle: apply then rollback restores the router and clears the rollback point', async () => {
      const { svc, router, db } = setup();
      const before = JSON.stringify({
        s: router.server,
        p: router.secrets,
        r: router.rules,
      });
      await svc.save(7, ACTOR, FULL);
      await svc.applyNas(7, ACTOR);
      expect(await svc.rollbackNas(7, ACTOR)).toMatchObject({
        rolledBack: true,
        confirmedByNas: true,
      });
      expect(
        JSON.stringify({
          s: router.server,
          p: router.secrets,
          r: router.rules,
        }),
      ).toBe(before);
      expect(db.rows.get(7)).toMatchObject({
        mgmtSnapshotEnc: null,
        mgmtDesiredEnc: null,
        mgmtApplyState: 'none',
      });
    });
  });

  describe('MEDIUM A/B/C: leases, background operations, cancellation', () => {
    it('connect returns an operation id immediately and the result arrives via status', async () => {
      const { svc, db, dialer } = setup();
      await svc.save(7, ACTOR, FULL);
      let release!: (v: any) => void;
      dialer.dial.mockImplementationOnce(
        () =>
          new Promise((r) => {
            release = r;
          }) as any,
      );
      const res = await svc.connect(7, ACTOR);
      expect(res).toMatchObject({ accepted: true, state: 'connecting' });
      expect(typeof res.operationId).toBe('string');
      expect(db.rows.get(7)).toMatchObject({
        clientState: 'connecting',
        clientOpId: res.operationId,
      });
      await untilCalled(dialer.dial);
      release({
        state: 'connected',
        interface: 'ulnas7',
        localAddress: '10.255.7.2',
        remoteAddress: '10.255.7.1',
      });
      await svc.waitForOperation(7);
      expect(db.rows.get(7)).toMatchObject({
        clientState: 'connected',
        clientLockOwner: null,
        clientOpId: null,
      });
    });

    it('a second worker cannot start a connect while the first runs', async () => {
      const db = new FakeDb();
      const w1 = setup({ db });
      const w2 = setup({ db });
      await w1.svc.save(7, ACTOR, FULL);
      let release!: (v: any) => void;
      w1.dialer.dial.mockImplementationOnce(
        () =>
          new Promise((r) => {
            release = r;
          }) as any,
      );
      await w1.svc.connect(7, ACTOR);
      await expect(w2.svc.connect(7, ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(w2.dialer.dial).not.toHaveBeenCalled();
      await untilCalled(w1.dialer.dial);
      release({ state: 'connected', interface: 'ulnas7' });
      await w1.svc.waitForOperation(7);
    });

    it('disconnect during a running connect (other worker) does NOT release the lease; it requests cancellation', async () => {
      const db = new FakeDb();
      const w1 = setup({ db });
      const w2 = setup({ db });
      await w1.svc.save(7, ACTOR, FULL);
      let cancelled = false;
      w1.dialer.dial.mockImplementationOnce(async (_p: any, o: any) => {
        for (let i = 0; i < 200 && !o.shouldCancel(); i++) {
          await new Promise((r) => setImmediate(r));
          if (i % 10 === 0)
            await (w1.svc as any).renew([...(w1.svc as any).leases][0]);
        }
        cancelled = o.shouldCancel();
        return {
          state: 'disconnected',
          errorCode: 'cancelled',
          error: 'cancelled',
        };
      });
      const op = await w1.svc.connect(7, ACTOR);
      const res = await w2.svc.disconnect(7, ACTOR);
      expect(res).toMatchObject({ state: 'cancelling', cancelRequested: true });
      expect(db.rows.get(7)!.clientLockOwner).toBe(op.operationId); // lease still owned by w1
      await expect(w2.svc.connect(7, ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      ); // no concurrent dial
      expect(w2.dialer.hangup).not.toHaveBeenCalled();
      await w1.svc.waitForOperation(7);
      expect(cancelled).toBe(true);
      expect(db.rows.get(7)).toMatchObject({
        clientState: 'disconnected',
        clientLockOwner: null,
      });
    });

    it("the lease is renewed while the operation runs, and a CRASHED worker's lease and host lock are taken over", async () => {
      const db = new FakeDb();
      const host = new SharedHost();
      const w1 = setup({ db, host, pid: 101 });
      await w1.svc.save(7, ACTOR, FULL);
      w1.dialer.dial.mockImplementationOnce(
        () => new Promise(() => undefined) as any,
      ); // worker hangs, then dies
      await w1.svc.connect(7, ACTOR);
      await untilCalled(w1.dialer.dial);
      const lease = [...(w1.svc as any).leases][0];
      const t0 = db.rows.get(7)!.clientLockUntil.getTime();
      await new Promise((r) => setTimeout(r, 5));
      await (w1.svc as any).renew(lease);
      expect(db.rows.get(7)!.clientLockUntil.getTime()).toBeGreaterThan(t0);
      // Worker 101 dies: no renewals, process gone.
      clearInterval(lease.timer);
      host.dead.add(101);
      db.rows.get(7)!.clientLockUntil = new Date(Date.now() - 1);
      const w2 = setup({ db, host, pid: 202 });
      const res = await w2.svc.connect(7, ACTOR);
      expect(res.accepted).toBe(true);
      await w2.svc.waitForOperation(7);
      expect(w2.dialer.dial).toHaveBeenCalled(); // stale host lock of a dead process was taken over
      expect(db.rows.get(7)!.clientState).toBe('connected');
      await (w1.svc as any).renew(lease);
      expect(lease.lost).toBe(true);
    });

    it('FENCING: a lease taken over from a still-running (alive) worker cannot touch the host; the old result never overwrites the new owner', async () => {
      const db = new FakeDb();
      const host = new SharedHost();
      const w1 = setup({ db, host, pid: 101 });
      await w1.svc.save(7, ACTOR, FULL);
      let finishOld!: (v: any) => void;
      w1.dialer.dial.mockImplementationOnce(
        () =>
          new Promise((r) => {
            finishOld = r;
          }) as any,
      ); // long system command
      await w1.svc.connect(7, ACTOR);
      await untilCalled(w1.dialer.dial);
      clearInterval([...(w1.svc as any).leases][0].timer); // heartbeat stalls; process still alive
      db.rows.get(7)!.clientLockUntil = new Date(Date.now() - 1);
      const w2 = setup({ db, host, pid: 202 });
      const op2 = await w2.svc.connect(7, ACTOR);
      await w2.svc.waitForOperation(7);
      expect(w2.dialer.dial).not.toHaveBeenCalled(); // host lock held by live pid 101
      expect(w2.dialer.hangup).not.toHaveBeenCalled();
      expect(db.rows.get(7)).toMatchObject({
        clientState: 'error',
        clientLockOwner: null,
      });
      expect(db.rows.get(7)!.lastClientError).toMatch(
        /still working on this NAS/,
      );
      // Old worker finishes later: it lost ownership, so nothing it reports is written.
      await (w1.svc as any).renew([...(w1.svc as any).leases][0]);
      finishOld({ state: 'connected', interface: 'ulnas7' });
      await w1.svc.waitForOperation(7);
      expect(db.rows.get(7)!.clientState).toBe('error');
      expect(op2.operationId).not.toBe(undefined);
      // Host lock released by its real owner → the NAS is usable again.
      const w3 = setup({ db, host, pid: 303 });
      await w3.svc.connect(7, ACTOR);
      await w3.svc.waitForOperation(7);
      expect(w3.dialer.dial).toHaveBeenCalled();
    });

    it('disconnect and purge cannot run while another live process holds the NAS host lock', async () => {
      const db = new FakeDb();
      const host = new SharedHost();
      const w1 = setup({ db, host, pid: 101 });
      await w1.svc.save(7, ACTOR, FULL);
      w1.dialer.dial.mockImplementationOnce(
        () => new Promise(() => undefined) as any,
      );
      await w1.svc.connect(7, ACTOR);
      await untilCalled(w1.dialer.dial);
      clearInterval([...(w1.svc as any).leases][0].timer);
      db.rows.get(7)!.clientLockUntil = new Date(Date.now() - 1);
      const w2 = setup({ db, host, pid: 202 });
      await expect(w2.svc.disconnect(7, ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(w2.dialer.hangup).not.toHaveBeenCalled();
      await expect(w2.svc.purgeHost(7, ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(w2.dialer.purge).not.toHaveBeenCalled();
      await expect(w2.svc.cleanupForNasDeletion(7)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('a lost lease aborts the dial (shouldCancel) and its result is discarded', async () => {
      const db = new FakeDb();
      const w1 = setup({ db });
      await w1.svc.save(7, ACTOR, FULL);
      let sawCancel = false;
      w1.dialer.dial.mockImplementationOnce(async (_p: any, o: any) => {
        db.rows.get(7)!.clientLockOwner = 'someone-else';
        await (w1.svc as any).renew([...(w1.svc as any).leases][0]);
        sawCancel = o.shouldCancel();
        return { state: 'connected', interface: 'ulnas7' };
      });
      await w1.svc.connect(7, ACTOR);
      await w1.svc.waitForOperation(7);
      expect(sawCancel).toBe(true);
      expect(db.rows.get(7)!.clientState).toBe('connecting'); // not overwritten with "connected"
    });
  });

  describe('status never invents a connection', () => {
    it('stored "connected" is replaced by live evidence', async () => {
      const { svc, db } = setup();
      await svc.save(7, ACTOR, FULL);
      db.rows.get(7)!.clientState = 'connected';
      const st = await svc.status(7, ACTOR);
      expect(st).toMatchObject({
        state: 'disconnected',
        connected: false,
        tunnelUsedForRouterAccess: false,
      });
      expect(db.rows.get(7)!.clientState).toBe('disconnected');
    });
    it('status passes the NAS public address so encryption can be verified', async () => {
      const { svc, dialer } = setup();
      await svc.save(7, ACTOR, FULL);
      await svc.status(7, ACTOR);
      expect(dialer.status).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ server: '45.76.10.20' }),
      );
    });
  });

  describe('MEDIUM G: NAS deletion cleanup', () => {
    it("removes this NAS's host tunnel; refuses when cleanup cannot be verified", async () => {
      const { svc, dialer } = setup();
      await svc.save(7, ACTOR, FULL);
      await expect(svc.cleanupForNasDeletion(7)).resolves.toMatchObject({
        hadConfig: true,
      });
      expect(dialer.purge).toHaveBeenCalledWith(7);
      dialer.purge.mockResolvedValueOnce({
        clean: false,
        remaining: ['interface ulnas7'],
      });
      await expect(svc.cleanupForNasDeletion(7)).rejects.toThrow(
        /was not deleted/,
      );
    });
    it('refuses while an operation is running (and asks it to stop)', async () => {
      const { svc, db, dialer } = setup();
      await svc.save(7, ACTOR, FULL);
      dialer.dial.mockImplementationOnce(
        () => new Promise(() => undefined) as any,
      );
      await svc.connect(7, ACTOR);
      await expect(svc.cleanupForNasDeletion(7)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(db.rows.get(7)!.clientCancelRequested).toBe(true);
      expect(dialer.purge).not.toHaveBeenCalled();
    });
  });

  describe('feature flag and safe deletion on servers that never used the VPN', () => {
    it.each([
      'getView',
      'save',
      'status',
      'connect',
      'reconnect',
      'cancel',
      'disconnect',
      'previewNas',
      'applyNas',
      'rollbackNas',
      'recoverNas',
      'purgeHost',
    ])(
      '%s is refused when L2TP_MGMT_VPN_ENABLED is not "true", with no side effects',
      async (m) => {
        const { svc, db, dialer, router } = setup();
        svc.env = { ...ENV, L2TP_MGMT_VPN_ENABLED: undefined };
        const spy = jest.spyOn(db.nasL2tpConfig, 'updateMany');
        await expect((svc as any)[m](7, ACTOR, FULL)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(spy).not.toHaveBeenCalled();
        expect(db.rows.size).toBe(0);
        expect(dialer.dial).not.toHaveBeenCalled();
        expect(dialer.purge).not.toHaveBeenCalled();
        expect(router.log).toHaveLength(0);
      },
    );

    it('NAS deletion on a server without the VPN (no row, no files): succeeds, runs no host command', async () => {
      const { svc, dialer } = setup();
      svc.env = { ...ENV, L2TP_MGMT_VPN_ENABLED: undefined };
      await expect(svc.cleanupForNasDeletion(7)).resolves.toEqual({
        hadConfig: false,
        routerSideApplied: false,
      });
      expect(dialer.purge).not.toHaveBeenCalled();
      expect(dialer.acquireHostLock).not.toHaveBeenCalled();
    });

    it('NAS deletion with only a legacy (old VPN screen) row: no host command', async () => {
      const { svc, db, dialer } = setup();
      db.rows.set(7, {
        nasId: 7,
        state: 'approved',
        publicHost: 'legacy.example',
        clientState: 'disconnected',
        mgmtApplyState: 'none',
      });
      await expect(svc.cleanupForNasDeletion(7)).resolves.toEqual({
        hadConfig: false,
        routerSideApplied: false,
      });
      expect(dialer.purge).not.toHaveBeenCalled();
    });

    it('NAS deletion still cleans up when host files exist even without a row', async () => {
      const { svc, dialer } = setup();
      dialer.hasHostFootprint.mockResolvedValueOnce(true);
      await svc.cleanupForNasDeletion(7);
      expect(dialer.purge).toHaveBeenCalledWith(7);
    });
  });
});
