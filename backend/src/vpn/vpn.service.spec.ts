import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { VpnService } from './vpn.service';
import { VpnMonitorService } from './vpn-monitor.service';

/**
 * Unit tests for the VPN hardening: config validation + atomic persistence,
 * the WireGuard dump parser, the truthful health state machine, and the
 * honest-verify contract (an inconclusive ICMP must never fail verification).
 * These are the pieces that must be right for the status the GUI shows to be
 * trustworthy. They do NOT prove a live VPN works — that needs the lab.
 */
describe('VpnService', () => {
  let dir: string;
  let svc: VpnService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbx-vpn-'));
    process.env.JBX_VPN_CONFIG = path.join(dir, 'vpn-servers.json');
    process.env.JBX_VPN_STATE = path.join(dir, 'vpn-state.json');
    svc = new VpnService();
  });

  afterEach(() => {
    delete process.env.JBX_VPN_CONFIG;
    delete process.env.JBX_VPN_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('config persistence', () => {
    it('round-trips a valid config and writes 0600', async () => {
      await svc.setConfig({ endpointHost: 'vpn.example.com', wireguard: { port: 51999, subnet: '10.90.0.0/24' } });
      const cfg = svc.getConfig();
      expect(cfg.endpointHost).toBe('vpn.example.com');
      expect(cfg.wireguard.port).toBe(51999);
      expect(cfg.wireguard.subnet).toBe('10.90.0.0/24');
      const mode = fs.statSync(process.env.JBX_VPN_CONFIG!).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('rejects a bad endpoint host, port, and subnet on write', async () => {
      await expect(svc.setConfig({ endpointHost: 'bad host!!' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.setConfig({ wireguard: { port: 70000 } })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.setConfig({ l2tp: { subnet: '10.0.0.0/8' } })).rejects.toBeInstanceOf(BadRequestException); // /8 < /16
    });

    it('repairs a corrupt file by falling back to defaults, not crashing', () => {
      fs.writeFileSync(process.env.JBX_VPN_CONFIG!, '{ not valid json ');
      const cfg = svc.getConfig();
      expect(cfg.wireguard.port).toBe(51820); // default
    });

    it('keeps a rolling .bak of the previous good file', async () => {
      await svc.setConfig({ endpointHost: 'first.example.com' });
      await svc.setConfig({ endpointHost: 'second.example.com' });
      const bak = JSON.parse(fs.readFileSync(`${process.env.JBX_VPN_CONFIG}.bak`, 'utf8'));
      expect(bak.endpointHost).toBe('first.example.com');
    });

    it('serialises concurrent writes without corrupting the file', async () => {
      await Promise.all([
        svc.setConfig({ wireguard: { port: 51001 } }),
        svc.setConfig({ openvpn: { port: 51002 } }),
        svc.setConfig({ l2tp: { subnet: '10.70.0.0/24' } }),
      ]);
      const cfg = svc.getConfig(); // must parse cleanly
      expect(cfg.l2tp.subnet).toBe('10.70.0.0/24');
    });

    it('persists observed health separately from desired config', async () => {
      await svc.setConfig({ endpointHost: 'vpn.example.com' });
      stub(svc, { which: true, wgPublicKey: null });
      await svc.overview();
      const state = svc.getState();
      expect(state.health.wireguard).toBeDefined();
      // Desired config file must NOT contain health.
      const raw = JSON.parse(fs.readFileSync(process.env.JBX_VPN_CONFIG!, 'utf8'));
      expect(raw.health).toBeUndefined();
    });
  });

  describe('overlay subnet conflict detection', () => {
    it('rejects overlapping VPN overlays', async () => {
      // OpenVPN set to overlap WireGuard's 10.66.0.0/24.
      await expect(
        svc.setConfig({ openvpn: { subnet: '10.66.0.0/25' } }),
      ).rejects.toThrow(/overlap/i);
    });
    it('accepts three disjoint overlays', async () => {
      await expect(
        svc.setConfig({ wireguard: { subnet: '10.80.0.0/24' }, openvpn: { subnet: '10.81.0.0/24' }, l2tp: { subnet: '10.82.0.0/24' } }),
      ).resolves.toBeDefined();
    });
    it('detects overlap regardless of prefix length (supernet vs subnet)', () => {
      expect((svc as any).cidrsOverlap('10.66.0.0/16', '10.66.5.0/24')).toBe(true);
      expect((svc as any).cidrsOverlap('10.66.0.0/24', '10.67.0.0/24')).toBe(false);
    });
  });

  describe('OpenVPN session parsing', () => {
    it('counts CLIENT_LIST rows from the status file (no secrets)', async () => {
      (svc as any).runFull = async (cmd: string) =>
        cmd === 'cat'
          ? { code: 0, out: 'TITLE,x\nCLIENT_LIST,r1,1.2.3.4\nCLIENT_LIST,r2,1.2.3.5\nROUTING_TABLE,x', err: '', ran: true }
          : { code: 1, out: '', err: '', ran: true };
      expect(await (svc as any).ovpnSessions()).toBe(2);
    });
    it('returns null when the status file is absent (not zero)', async () => {
      (svc as any).runFull = async () => ({ code: 1, out: '', err: '', ran: true });
      expect(await (svc as any).ovpnSessions()).toBeNull();
    });
  });

  describe('privileged service action (Phase 2)', () => {
    afterEach(() => delete process.env.JBX_VPN_PRIVILEGED);

    it('is disabled by default (operator-run model retained)', async () => {
      const r = await svc.serviceAction('wireguard', 'restart');
      expect(r.enabled).toBe(false);
    });

    it('rejects an injected operation even when enabled', async () => {
      process.env.JBX_VPN_PRIVILEGED = '1';
      await expect(svc.serviceAction('wireguard', 'restart; rm -rf /' as any)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.serviceAction('wireguard', '../../bin/sh' as any)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an invalid VPN type (no path/arg smuggling)', async () => {
      process.env.JBX_VPN_PRIVILEGED = '1';
      await expect(svc.serviceAction('wireguard; id' as any, 'status')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('passes only fixed argv to the helper when enabled', async () => {
      process.env.JBX_VPN_PRIVILEGED = '1';
      let seen: { cmd: string; args: string[] } | null = null;
      (svc as any).runFull = async (cmd: string, args: string[]) => {
        seen = { cmd, args };
        return { code: 0, out: 'active', err: '', ran: true };
      };
      const r = await svc.serviceAction('openvpn', 'status');
      expect(r.enabled).toBe(true);
      expect(seen!.cmd).toBe('sudo');
      expect(seen!.args).toEqual(['-n', expect.any(String), 'status', 'openvpn']);
    });
  });

  describe('generated installers', () => {
    const { execFileSync } = require('child_process');
    const types = ['wireguard', 'openvpn', 'l2tp'] as const;
    it.each(types)('emits syntactically valid bash for %s', async (type) => {
      const { script } = await svc.install(type);
      const file = path.join(dir, `${type}-install.sh`);
      fs.writeFileSync(file, script);
      // bash -n parses without executing — catches broken heredocs/functions.
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    });
    it('backs up and self-tests in every installer', async () => {
      for (const type of types) {
        const { script } = await svc.install(type);
        expect(script).toContain('backup_file');
        expect(script).toContain('SELF-TEST FAILED');
        expect(script).toContain('enable_forwarding');
      }
    });
  });

  describe('client config validation', () => {
    it('rejects a non-IP overlay address', () => {
      expect(() => svc.clientConfig('wireguard', 'mikrotik', 'r1', 'not-an-ip')).toThrow(BadRequestException);
    });
    it('sanitises a bad router name and emits vendor-specific syntax', () => {
      const out = svc.clientConfig('wireguard', 'cisco', 'bad name;rm', '10.66.0.9');
      expect(out).toContain('10.66.0.9');
      expect(out).toContain('crypto wireguard');
      expect(out).not.toContain('rm'); // name was sanitised to "router"
    });
    it('never leaks a real secret — placeholders only in client configs', () => {
      const l2 = svc.clientConfig('l2tp', 'mikrotik', 'r1', '10.68.0.9');
      expect(l2).toContain('<shared-secret>');
      expect(l2).toContain('<password>');
    });
  });

  describe('WireGuard dump parsing', () => {
    it('counts connected peers by handshake freshness', async () => {
      const now = Math.floor(Date.now() / 1000);
      const dump = [
        'PRIVKEYREDACTED\tPUBKEY\t51820\toff',
        `peerA\t(none)\t1.2.3.4:5\t10.66.0.2/32\t${now - 10}\t100\t200\toff`, // fresh
        `peerB\t(none)\t1.2.3.5:5\t10.66.0.3/32\t${now - 9999}\t0\t0\toff`, // stale
        `peerC\t(none)\t(none)\t10.66.0.4/32\t0\t0\t0\toff`, // never
      ].join('\n');
      (svc as any).runFull = async (cmd: string, args: string[]) =>
        cmd === 'wg' && args[2] === 'dump' ? { code: 0, out: dump, err: '', ran: true } : { code: 1, out: '', err: '', ran: true };
      const parsed = await (svc as any).wgDump();
      expect(parsed.peers).toBe(3);
      expect(parsed.connected).toBe(1);
    });
  });

  describe('health state machine', () => {
    it('reports install_required when wg is absent', async () => {
      stub(svc, { which: false });
      const h = await svc.healthWireguard(svc.getConfig());
      expect(h.state).toBe('install_required');
    });

    it('reports offline when wg installed but interface down', async () => {
      stub(svc, { which: true, wgPublicKey: null });
      const h = await svc.healthWireguard(svc.getConfig());
      expect(h.state).toBe('offline');
    });

    it('reports degraded when peers exist but none handshake', async () => {
      stub(svc, { which: true, wgPublicKey: 'A'.repeat(42) + 'A=', ifaceHasIp: true, wgDump: { peers: 2, connected: 0, newestHandshakeSecs: 9999 } });
      const h = await svc.healthWireguard(svc.getConfig());
      expect(h.state).toBe('degraded');
    });

    it('reports online with a connected peer', async () => {
      stub(svc, { which: true, wgPublicKey: 'A'.repeat(42) + 'A=', ifaceHasIp: true, wgDump: { peers: 1, connected: 1, newestHandshakeSecs: 5 } });
      const h = await svc.healthWireguard(svc.getConfig());
      expect(h.state).toBe('online');
    });
  });

  describe('verify contract', () => {
    it('does not fail verification on an inconclusive (filtered) ICMP', async () => {
      stub(svc, { which: true, wgPublicKey: 'A'.repeat(42) + 'A=', ifaceHasIp: true, wgDump: { peers: 1, connected: 1, newestHandshakeSecs: 5 } });
      // ping ran but got no reply (code 1) → check ok must be null, verify still ok.
      (svc as any).runFull = async (cmd: string) =>
        cmd === 'ping' ? { code: 1, out: '', err: '', ran: true } : { code: 0, out: '', err: '', ran: true };
      (svc as any).portListening = async () => true; // radius present
      const v = await svc.verify('wireguard');
      const ping = v.checks.find((c) => c.name.includes('reachable'));
      expect(ping?.ok).toBeNull();
      expect(v.ok).toBe(true);
    });
  });
});

describe('VpnMonitorService', () => {
  it('ranks error worst and online best', () => {
    const m = new VpnMonitorService({} as any, {} as any);
    const rank = (s: any) => (m as any).rank(s);
    expect(rank('error')).toBeGreaterThan(rank('offline'));
    expect(rank('offline')).toBeGreaterThan(rank('degraded'));
    expect(rank('degraded')).toBeGreaterThan(rank('online'));
  });

  function harness(states: string[]) {
    let i = 0;
    const emitted: any[] = [];
    const vpn = {
      getConfig: () => ({ endpointHost: 'vpn.example.com', wireguard: {}, openvpn: {}, l2tp: {} }),
      health: async (type: string) => ({ state: type === 'wireguard' ? states[Math.min(i, states.length - 1)] : 'unconfigured', summary: 's' }),
    };
    const events = { broadcast: (event: string, payload: any) => emitted.push(payload) };
    const m = new VpnMonitorService(vpn as any, events as any);
    return { m, emitted, step: async () => { await m.sweep(); i++; }, setIdx: (n: number) => { i = n; } };
  }

  it('primes silently, emits on transition, and de-duplicates a stable state', async () => {
    const h = harness(['online', 'online', 'offline', 'offline']);
    await h.step(); // observe online (prime) → no emit
    await h.step(); // online again → no emit
    expect(h.emitted.length).toBe(0);
    await h.step(); // online → offline → emit
    expect(h.emitted.length).toBe(1);
    expect(h.emitted[0]).toMatchObject({ from: 'online', to: 'offline', worsened: true });
    await h.step(); // offline stable → no emit
    expect(h.emitted.length).toBe(1);
  });

  it('does not lose a transition that happened during the cooldown window', async () => {
    // online (prime) → offline (emit) → online (suppressed by cooldown) →
    // online stable. The suppressed online must still be announced because we
    // compare against the last ANNOUNCED state, not the last observation.
    const h = harness(['online', 'offline', 'online', 'online']);
    await h.step(); // prime online
    await h.step(); // → offline, emit (cooldown starts)
    expect(h.emitted.length).toBe(1);
    await h.step(); // → online, within cooldown → suppressed, last stays 'offline'
    expect(h.emitted.length).toBe(1);
    // Fast-forward past the cooldown and observe the still-current 'online'.
    (h.m as any).lastNotifiedAt.wireguard = 0;
    await h.step(); // online vs last-announced offline → emit recovery
    expect(h.emitted.length).toBe(2);
    expect(h.emitted[1]).toMatchObject({ from: 'offline', to: 'online' });
  });
});

/** Stub the private host-probe methods so health logic is tested in isolation. */
function stub(svc: VpnService, over: Record<string, unknown>) {
  const s = svc as any;
  if ('which' in over) s.which = async () => over.which;
  if ('wgPublicKey' in over) s.wgPublicKey = async () => over.wgPublicKey;
  if ('ifaceHasIp' in over) s.ifaceHasIp = async () => over.ifaceHasIp;
  if ('wgDump' in over) s.wgDump = async () => over.wgDump;
}
