import { generateKeyPairSync } from 'crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TunnelService } from './tunnel.service';

/**
 * WIREGUARD MANAGEMENT TUNNELS.
 *
 * WHAT THE FEATURE IS FOR
 * Nearly every ISP this panel is sold to sits behind CGNAT, so their routers
 * have no reachable address. Everything the panel does TOWARD a router — a CoA
 * disconnect for a defaulter, a speed change, an SNMP poll — works on the LAN
 * and silently stops the moment the router is remote. WireGuard reverses the
 * direction: the router dials out, and the panel gets a stable overlay address
 * it can reach forever after.
 *
 * WHY THESE PARTICULAR TESTS
 * A tunnel is standing remote access into a customer's network, so the failure
 * modes are not cosmetic:
 *
 *  1. KEY VALIDATION IS A SHELL BOUNDARY. Every key and address is handed to
 *     the `wg` binary. It goes through execFile with an argv array so there is
 *     no shell to inject into, but validation is the belt to that braces — and
 *     it must accept every VALID key, because a validator that rejects real
 *     keys turns into a provisioning failure nobody can explain. The first
 *     draft of the pattern here did exactly that, rejecting about one key in
 *     five; the generated-key test below is what caught it and is why it
 *     generates hundreds rather than one.
 *  2. ADDRESS UNIQUENESS. Two routers on one overlay IP does not raise an
 *     error anywhere — it silently routes one router's traffic to the other,
 *     so a disconnect meant for a defaulter in one town lands on a paying
 *     customer in another. Allocation must therefore survive a race.
 *  3. THE PRIVATE KEY IS NEVER PERSISTED. A hub does not need its peers'
 *     private keys. Storing them would make one database dump the identity of
 *     every router on the network.
 *  4. ROTATION KEEPS THE ADDRESS AND DROPS THE OLD PEER. `nasIp` points at the
 *     overlay address, so moving it during a re-key turns a routine credential
 *     rotation into a silent loss of reachability; and leaving the old peer in
 *     the kernel means a "revoked" key still works.
 *
 * WHAT THESE TESTS CANNOT PROVE: `wg` is stubbed, so they verify what we ask
 * the kernel to do, not that WireGuard is installed. Prisma is mocked, so the
 * NasTunnel table's constraints are proven separately — the migration was run
 * against a real PostgreSQL 16, where a duplicate overlayIp and a second
 * tunnel for one NAS were both rejected and deleting the NAS cascaded the
 * tunnel away.
 */
describe('TunnelService — WireGuard management tunnels', () => {
  const SERVER_PUB = 'kJ8FQ1n6Rr0YQ0i0oq6y7lVYQq9pQe6BvJ0Kx8Zt1Xo=';

  function realKey() {
    const { publicKey } = generateKeyPairSync('x25519');
    return publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  }

  function makeService(
    opts: {
      tunnels?: any[];
      existing?: any;
      wgFails?: boolean;
      noInterface?: boolean;
      env?: Record<string, string>;
      createFails?: number; // how many creates reject with P2002 first
    } = {},
  ) {
    const rows = opts.tunnels ?? [];
    let createAttempt = 0;

    const prisma: any = {
      nas: {
        findUnique: jest.fn().mockResolvedValue({ id: 1, shortname: 'booni', nasname: '10.0.0.1' }),
      },
      nasTunnel: {
        findMany: jest.fn().mockResolvedValue(rows),
        findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
        create: jest.fn(async ({ data }: any) => {
          if (createAttempt++ < (opts.createFails ?? 0)) {
            const e: any = new Error('Unique constraint failed');
            e.code = 'P2002';
            e.meta = { target: ['overlayIp'] };
            throw e;
          }
          return { id: 1, ...data };
        }),
        update: jest.fn(async ({ data }: any) => ({ id: 1, ...opts.existing, ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
    };

    const svc = new TunnelService(prisma);

    // Stub the ONE place that touches the outside world.
    const wgCalls: string[][] = [];
    (svc as any).wg = jest.fn(async (args: string[]) => {
      wgCalls.push(args);
      if (opts.wgFails) throw new Error('wg: command not found');
      if (args[1] === 'show' || args[0] === 'show') {
        if (args.includes('public-key')) return opts.noInterface ? '' : SERVER_PUB + '\n';
      }
      return '';
    });

    const env = { WG_ENDPOINT_HOST: 'panel.example.net', ...(opts.env ?? {}) };
    for (const [k, v] of Object.entries(env)) process.env[k] = v;

    return { svc, prisma, wgCalls };
  }

  afterEach(() => {
    for (const k of ['WG_ENDPOINT_HOST', 'WG_SUBNET', 'WG_INTERFACE', 'WG_KEEPALIVE']) {
      delete process.env[k];
    }
  });

  // ───────────────────────────────────────────────────────────────
  // 1 — key handling
  // ───────────────────────────────────────────────────────────────
  describe('key validation', () => {
    it('accepts every key it generates, across hundreds of them', () => {
      const { svc } = makeService();
      // The regression this guards: 32 bytes base64-encode so that the final
      // character is one of SIXTEEN, not thirteen. A narrower set rejects
      // roughly one valid key in five — which shows up as random provisioning
      // failures, the hardest kind to diagnose.
      for (let i = 0; i < 400; i++) {
        const { publicKey, privateKey } = svc.generateKeypair();
        expect(() => (svc as any).assertKey(publicKey, 'pub')).not.toThrow();
        expect(() => (svc as any).assertKey(privateKey, 'priv')).not.toThrow();
      }
    });

    it('derives the same public key WireGuard would', () => {
      const { svc } = makeService();
      const { privateKey, publicKey } = svc.generateKeypair();
      expect(svc.publicFromPrivate(privateKey)).toBe(publicKey);
    });

    it('refuses anything that is not a WireGuard key', () => {
      const { svc } = makeService();
      for (const bad of [
        '',
        'short',
        'A'.repeat(44), // right length, wrong final character
        '../../etc/passwd',
        `${realKey()}; rm -rf /`,
        `${realKey()}\nremove`,
      ]) {
        expect(() => (svc as any).assertKey(bad, 'key')).toThrow(BadRequestException);
      }
    });

    it('refuses a bogus overlay address', () => {
      const { svc } = makeService();
      for (const bad of ['10.0.0.999', '10.0.0', 'localhost', '10.0.0.1 -x', '']) {
        expect(() => (svc as any).assertIp(bad)).toThrow(BadRequestException);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 2 — address allocation
  // ───────────────────────────────────────────────────────────────
  describe('overlay address allocation', () => {
    it('starts at .2, leaving .1 for the panel itself', async () => {
      const { svc } = makeService();
      const cfg = await svc.provision(1);
      expect(cfg.overlayIp).toBe('10.66.0.2');
    });

    it('fills the lowest free address rather than always climbing', async () => {
      // A /24 has 253 usable hosts. Always taking max+1 would exhaust the
      // range after 253 LIFETIME provisions, even with three routers left.
      const { svc } = makeService({
        tunnels: [{ overlayIp: '10.66.0.2' }, { overlayIp: '10.66.0.4' }],
      });
      const cfg = await svc.provision(1);
      expect(cfg.overlayIp).toBe('10.66.0.3');
    });

    it('retries on a unique-constraint collision instead of colliding', async () => {
      // Two admins provisioning at once read the same free address; the loser
      // must take the next one, not share.
      const { svc, prisma } = makeService({ createFails: 2 });
      const cfg = await svc.provision(1);
      expect(prisma.nasTunnel.create).toHaveBeenCalledTimes(3);
      expect(cfg.overlayIp).toBe('10.66.0.2');
    });

    it('does NOT retry a failure that is not an address collision', async () => {
      // Spinning on a real error would bury it behind a misleading
      // "no addresses left".
      const { svc, prisma } = makeService();
      prisma.nasTunnel.create.mockRejectedValue(
        Object.assign(new Error('connection lost'), { code: 'P1001' }),
      );
      await expect(svc.provision(1)).rejects.toThrow('connection lost');
      expect(prisma.nasTunnel.create).toHaveBeenCalledTimes(1);
    });

    it('refuses a subnet too small to be usable', async () => {
      const { svc } = makeService({ env: { WG_SUBNET: '10.66.0.0/31' } });
      await expect(svc.provision(1)).rejects.toThrow(BadRequestException);
    });

    it('reports exhaustion clearly instead of handing out a broadcast address', async () => {
      const { svc } = makeService({
        env: { WG_SUBNET: '10.66.0.0/30' }, // .1 panel, .2 only usable host
        tunnels: [{ overlayIp: '10.66.0.2' }],
      });
      await expect(svc.provision(1)).rejects.toThrow(ConflictException);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 3 — the private key must not survive the response
  // ───────────────────────────────────────────────────────────────
  describe('key custody', () => {
    it('never writes the private key to the database', async () => {
      const { svc, prisma } = makeService();
      const cfg = await svc.provision(1);

      const written = JSON.stringify(prisma.nasTunnel.create.mock.calls[0][0].data);
      expect(written).not.toContain(cfg.privateKey);
      // Only the public half is stored.
      expect(prisma.nasTunnel.create.mock.calls[0][0].data.publicKey).toBe(
        svc.publicFromPrivate(cfg.privateKey),
      );
    });

    it('puts the private key in the config the operator pastes, and only there', async () => {
      const { svc } = makeService();
      const cfg = await svc.provision(1);
      expect(cfg.mikrotik).toContain(cfg.privateKey);
      expect(cfg.wgQuick).toContain(cfg.privateKey);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 4 — what we ask the kernel to do
  // ───────────────────────────────────────────────────────────────
  describe('peer application', () => {
    it('restricts the peer to its own /32 and nothing else', async () => {
      // Without this a compromised router could claim its neighbours' overlay
      // addresses and receive their management traffic.
      const { svc, wgCalls } = makeService();
      const cfg = await svc.provision(1);
      const set = wgCalls.find((a) => a[0] === 'set');
      expect(set).toBeTruthy();
      const allowed = set![set!.indexOf('allowed-ips') + 1];
      expect(allowed).toBe(`${cfg.overlayIp}/32`);
    });

    it('records the tunnel even when wg is missing, and says so', async () => {
      // Failing outright would leave the admin with no config and no idea what
      // the host was missing.
      const { svc, prisma } = makeService({ wgFails: true });
      const cfg = await svc.provision(1);
      expect(prisma.nasTunnel.create).toHaveBeenCalled();
      expect(cfg.applied).toBe(false);
      expect(cfg.warning).toMatch(/wireguard-tools|Reconcile/i);
      expect(cfg.privateKey).toBeTruthy();
    });

    it('warns when there is no endpoint for the router to dial', async () => {
      const { svc } = makeService({ env: { WG_ENDPOINT_HOST: '' } });
      const cfg = await svc.provision(1);
      expect(cfg.warning).toMatch(/WG_ENDPOINT_HOST/);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 5 — rotation and revocation
  // ───────────────────────────────────────────────────────────────
  describe('rotation', () => {
    const existing = {
      id: 1,
      nasId: 1,
      publicKey: 'OLDKEYOLDKEYOLDKEYOLDKEYOLDKEYOLDKEYOLDKEY0=',
      overlayIp: '10.66.0.7',
    };

    it('refuses to silently re-key a router that already has a tunnel', async () => {
      const { svc } = makeService({ existing });
      await expect(svc.provision(1)).rejects.toThrow(ConflictException);
    });

    it('keeps the overlay address across a rotation', async () => {
      // nasIp points here; moving it would turn a credential rotation into an
      // unexplained loss of reachability.
      const { svc } = makeService({ existing });
      const cfg = await svc.provision(1, { rotate: true });
      expect(cfg.overlayIp).toBe('10.66.0.7');
    });

    it('issues a different key and clears the old liveness', async () => {
      const { svc, prisma } = makeService({ existing });
      const cfg = await svc.provision(1, { rotate: true });
      const data = prisma.nasTunnel.update.mock.calls[0][0].data;
      expect(data.publicKey).not.toBe(existing.publicKey);
      // Otherwise the UI keeps reporting a healthy tunnel that no longer exists.
      expect(data.lastHandshake).toBeNull();
      expect(cfg.privateKey).toBeTruthy();
    });

    it('removes the old peer BEFORE adding the new one', async () => {
      // Overlapping would leave a key we have revoked on paper still working.
      const { svc, wgCalls } = makeService({ existing });
      await svc.provision(1, { rotate: true });
      const removeAt = wgCalls.findIndex((a) => a.includes('remove'));
      const addAt = wgCalls.findIndex((a) => a.includes('allowed-ips'));
      expect(removeAt).toBeGreaterThanOrEqual(0);
      expect(addAt).toBeGreaterThan(removeAt);
    });
  });

  describe('revocation', () => {
    const existing = {
      id: 1,
      nasId: 1,
      publicKey: 'OLDKEYOLDKEYOLDKEYOLDKEYOLDKEYOLDKEYOLDKEY0=',
      overlayIp: '10.66.0.7',
    };

    it('drops the kernel peer before deleting the row', async () => {
      // Row first, then a failure, would leave a working peer with nothing
      // left in the panel to revoke it by.
      const order: string[] = [];
      const { svc, prisma } = makeService({ existing });
      (svc as any).wg = jest.fn(async () => { order.push('wg'); return ''; });
      prisma.nasTunnel.delete.mockImplementation(async () => { order.push('db'); return {}; });

      const out = await svc.revoke(1);
      expect(out).toMatchObject({ revoked: true, overlayIp: '10.66.0.7' });
      expect(order).toEqual(['wg', 'db']);
    });

    it('is a no-op for a router that never had one', async () => {
      const { svc, prisma } = makeService({ existing: null });
      expect(await svc.revoke(1)).toEqual({ revoked: false });
      expect(prisma.nasTunnel.delete).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 6 — liveness, which is the only health signal WireGuard offers
  // ───────────────────────────────────────────────────────────────
  describe('status', () => {
    function withDump(dump: string, tunnels: any[]) {
      const { svc, prisma } = makeService({ tunnels });
      (svc as any).wg = jest.fn(async () => dump);
      return { svc, prisma };
    }

    it('counts a peer that handshook seconds ago as up', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { svc } = withDump(
        `iface\tline\n` + `KEY\t(none)\t1.2.3.4:51820\t10.66.0.2/32\t${now}\t100\t200\t25\n`,
        [{ id: 1, nasId: 1, publicKey: 'KEY' }],
      );
      expect(await svc.refreshStatus()).toEqual({ checked: 1, up: 1 });
    });

    it('counts a peer last seen ten minutes ago as down', async () => {
      // WireGuard re-handshakes about every two minutes, so a stale timestamp
      // is the ONLY evidence that a router has stopped talking.
      const old = Math.floor(Date.now() / 1000) - 600;
      const { svc } = withDump(
        `iface\tline\n` + `KEY\t(none)\t1.2.3.4:51820\t10.66.0.2/32\t${old}\t100\t200\t25\n`,
        [{ id: 1, nasId: 1, publicKey: 'KEY' }],
      );
      expect(await svc.refreshStatus()).toEqual({ checked: 1, up: 0 });
    });

    it('treats a peer that has never handshook as down, not as unknown', async () => {
      const { svc, prisma } = withDump(
        `iface\tline\n` + `KEY\t(none)\t(none)\t10.66.0.2/32\t0\t0\t0\t25\n`,
        [{ id: 1, nasId: 1, publicKey: 'KEY' }],
      );
      expect(await svc.refreshStatus()).toEqual({ checked: 1, up: 0 });
      expect(prisma.nasTunnel.update.mock.calls[0][0].data.lastHandshake).toBeNull();
    });

    it('reports nothing rather than crashing when the interface is absent', async () => {
      const { svc } = makeService({ wgFails: true, tunnels: [{ id: 1, publicKey: 'KEY' }] });
      expect(await svc.refreshStatus()).toEqual({ checked: 0, up: 0 });
    });
  });

  describe('reconcile', () => {
    it('re-applies every stored peer, because the kernel loses them on reboot', async () => {
      // Without this, every tunnel on the network dies the next time the panel
      // host restarts, silently and with no error anywhere.
      const keys = [realKey(), realKey(), realKey()];
      const { svc, wgCalls } = makeService({
        tunnels: keys.map((publicKey, i) => ({
          id: i + 1,
          nasId: i + 1,
          publicKey,
          overlayIp: `10.66.0.${i + 2}`,
        })),
      });
      const out = await svc.reconcile();
      expect(out).toMatchObject({ applied: 3, failed: 0 });
      expect(wgCalls.filter((a) => a[0] === 'set')).toHaveLength(3);
    });

    it('keeps going past one bad peer and names the router that failed', async () => {
      const { svc } = makeService({
        tunnels: [
          { id: 1, nasId: 11, publicKey: 'not-a-key', overlayIp: '10.66.0.2' },
          { id: 2, nasId: 12, publicKey: realKey(), overlayIp: '10.66.0.3' },
        ],
      });
      const out = await svc.reconcile();
      expect(out.applied).toBe(1);
      expect(out.failed).toBe(1);
      expect(out.errors[0]).toContain('#11');
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 7 — the config an engineer actually pastes
  // ───────────────────────────────────────────────────────────────
  describe('generated router config', () => {
    it('routes ONLY the panel through the tunnel, never the default route', async () => {
      // AllowedIPs of 0.0.0.0/0 would push the shop's entire internet through
      // the panel — an outage disguised as a configuration.
      const { svc } = makeService();
      const cfg = await svc.provision(1);
      expect(cfg.wgQuick).toContain('AllowedIPs = 10.66.0.1/32');
      expect(cfg.wgQuick).not.toContain('0.0.0.0/0');
      expect(cfg.mikrotik).toContain('allowed-address=10.66.0.1/32');
      expect(cfg.mikrotik).not.toContain('0.0.0.0/0');
    });

    it('sets a keepalive, without which CGNAT closes the mapping', async () => {
      const { svc } = makeService();
      const cfg = await svc.provision(1);
      expect(cfg.wgQuick).toMatch(/PersistentKeepalive = \d+/);
      expect(cfg.mikrotik).toMatch(/persistent-keepalive=\d+s/);
    });

    it('makes the interface name safe for a RouterOS command line', async () => {
      const { svc, prisma } = makeService();
      prisma.nas.findUnique.mockResolvedValue({
        id: 1,
        shortname: 'booni; /system reboot',
        nasname: '10.0.0.1',
      });
      const cfg = await svc.provision(1);
      expect(cfg.mikrotik).not.toContain('/system reboot');
      expect(cfg.mikrotik).toMatch(/name=wg-[A-Za-z0-9_-]+ /);
    });
  });
});
