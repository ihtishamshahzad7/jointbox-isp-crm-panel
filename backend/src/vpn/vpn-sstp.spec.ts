import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VpnService } from './vpn.service';

/**
 * SSTP protocol support + config-generation sanity. VpnService has no
 * constructor deps, so it is unit-testable directly. These do NOT prove a live
 * SSTP server works — they prove the panel generates correct, secret-free
 * config and keeps the four overlay subnets distinct.
 */
describe('VpnService — SSTP', () => {
  let dir: string;
  let svc: VpnService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbx-sstp-'));
    process.env.JBX_VPN_CONFIG = path.join(dir, 'vpn-servers.json');
    svc = new VpnService();
  });
  afterEach(() => {
    delete process.env.JBX_VPN_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips SSTP config (port + subnet)', () => {
    const cfg = svc.setConfig({
      endpointHost: 'vpn.example.com',
      sstp: { port: 8443, subnet: '10.79.0.0/24' },
    });
    expect(cfg.sstp.port).toBe(8443);
    expect(cfg.sstp.subnet).toBe('10.79.0.0/24');
    expect(svc.getConfig().sstp.port).toBe(8443);
  });

  it('generates a MikroTik SSTP client config with no secret leakage', () => {
    svc.setConfig({ endpointHost: 'vpn.example.com' });
    const out = svc.clientConfig('sstp', 'mikrotik', 'router1', '10.69.0.9');
    expect(out).toContain('/interface/sstp-client');
    expect(out).toContain('vpn.example.com');
    expect(out).toContain('password=<password>'); // placeholder, never a real secret
    expect(out).toContain('verify-server-certificate=yes');
    expect(out).not.toContain('verify-server-certificate=no');
  });

  it('requires L2TP/IPsec and keeps the shared secret placeholder explicit', () => {
    const out = svc.clientConfig('l2tp', 'mikrotik', 'router1', '10.68.0.9');
    expect(out).toContain('use-ipsec=yes');
    expect(out).toContain('ipsec-secret=<shared-secret>');
    expect(out).toContain('user=router1');
    expect(out).not.toContain('use-ipsec=no');
  });

  it('masks L2TP/IPsec secrets and rejects incomplete config', () => {
    const good = svc.validateL2tpConfig({
      configurationName: 'uplinko-branch-01',
      nasName: 'Branch NAS',
      publicHost: 'vpn.example.com',
      routerManagementIp: '10.10.0.42',
      l2tpEnabled: true,
      ipsecEnabled: true,
      ipsecPsk: 'super-secret-psk',
      radiusServer: 'radius.example.com',
      radiusSourceIp: '203.0.113.10',
      radiusSharedSecret: 'shared-secret',
      pppProfile: 'uplinko-vpn',
      clientPool: 'uplinko-pool',
    });

    expect(good.valid).toBe(true);
    expect(good.masked.ipsecPsk).toBe('********');
    expect(good.masked.radiusSharedSecret).toBe('********');
    expect(good.preview).toContain('secret=<masked>');
    expect(good.preview).not.toContain('super-secret-psk');
    expect(good.preview).not.toContain('shared-secret');

    const bad = svc.validateL2tpConfig({
      routerManagementIp: 'bad-ip',
      l2tpEnabled: false,
      ipsecEnabled: false,
    });

    expect(bad.valid).toBe(false);
    expect(bad.errors).toContain('Public VPN hostname or IP is required.');
    expect(bad.errors).toContain(
      'At least one of L2TP or IPsec must be enabled.',
    );
  });

  it('rejects RouterOS preview values that could inject additional commands', () => {
    const result = svc.validateL2tpConfig({
      publicHost: 'vpn.example.com',
      routerManagementIp: '10.10.0.42',
      l2tpEnabled: true,
      ipsecEnabled: true,
      ipsecPsk: 'psk',
      radiusServer: 'radius.example.com',
      radiusSharedSecret: 'secret',
      pppProfile: 'safe\n/system reboot',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'PPP profile may contain only letters, numbers, dots, underscores, and hyphens.',
    );
    expect(result.preview).not.toContain('/system reboot');
  });

  it('emits a non-MikroTik note for a vendor without native SSTP', () => {
    const out = svc.clientConfig('sstp', 'cisco', 'r1', '10.69.0.9');
    expect(out.toLowerCase()).toContain('not native');
  });

  it('defaults keep all four overlay subnets distinct', () => {
    const c = svc.getConfig();
    const nets = [
      c.wireguard.subnet,
      c.openvpn.subnet,
      c.l2tp.subnet,
      c.sstp.subnet,
    ];
    expect(new Set(nets).size).toBe(4);
  });

  it('does not share the DEFAULTS object across instances (no poisoning)', () => {
    svc.setConfig({ sstp: { port: 9443 } });
    const fresh = new VpnService();
    // A new instance with no file sees the real default, not 9443.
    delete process.env.JBX_VPN_CONFIG;
    expect(fresh.getConfig().sstp.port).toBe(443);
    process.env.JBX_VPN_CONFIG = path.join(dir, 'vpn-servers.json');
  });
});
