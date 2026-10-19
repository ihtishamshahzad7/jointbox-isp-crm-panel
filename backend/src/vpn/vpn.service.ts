import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * PANEL VPN SERVERS — how a remote MikroTik behind CGNAT reaches this panel so
 * its PPPoE users authenticate here over the tunnel, and the panel can run
 * RADIUS / CoA / API toward the router.
 *
 * Three server types, all MikroTik-native: WireGuard, OpenVPN, L2TP/IPsec.
 * Several can run at once, and many routers can connect to each.
 *
 * SETUP MODEL (chosen with the operator): the panel does not try to create
 * interfaces or run daemons itself — the backend is an unprivileged service and
 * a VPN server needs root. Instead the panel GENERATES, per VPN type:
 *   • a one-time install script the operator runs once on the panel host
 *     (with sudo) to bring the server up and keep it up across reboots, and
 *   • the exact MikroTik client config to paste on each router.
 * The panel then reports status by probing the host (ports / `wg show`).
 *
 * SAFETY: every value that reaches a generated command or config is validated
 * against a strict pattern first. Nothing is shelled out with string
 * interpolation from user input.
 */

const HOST = /^[A-Za-z0-9.-]{1,253}$/; // hostname or IPv4, for the endpoint
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

export type VpnType = 'wireguard' | 'openvpn' | 'l2tp';

export interface VpnConfig {
  endpointHost: string;
  wireguard: { port: number; subnet: string };
  openvpn: { port: number; proto: 'udp' | 'tcp'; subnet: string };
  l2tp: { subnet: string };
}

const DEFAULTS: VpnConfig = {
  endpointHost: '',
  wireguard: { port: 51820, subnet: '10.66.0.0/24' },
  openvpn: { port: 1194, proto: 'udp', subnet: '10.67.0.0/24' },
  l2tp: { subnet: '10.68.0.0/24' },
};

@Injectable()
export class VpnService {
  private readonly logger = new Logger(VpnService.name);

  private get configPath(): string {
    return process.env.JBX_VPN_CONFIG || path.join(process.cwd(), 'vpn-servers.json');
  }

  // ── stored, editable config (no DB migration needed) ──────────────────
  getConfig(): VpnConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return {
        endpointHost: typeof raw.endpointHost === 'string' ? raw.endpointHost : '',
        wireguard: { ...DEFAULTS.wireguard, ...(raw.wireguard || {}) },
        openvpn: { ...DEFAULTS.openvpn, ...(raw.openvpn || {}) },
        l2tp: { ...DEFAULTS.l2tp, ...(raw.l2tp || {}) },
      };
    } catch {
      // Fall back to env for the endpoint so an existing WG_ENDPOINT_HOST keeps working.
      return { ...DEFAULTS, endpointHost: process.env.WG_ENDPOINT_HOST || '' };
    }
  }

  private save(cfg: VpnConfig): void {
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }

  private port(n: unknown, what: string): number {
    const p = Number(n);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new BadRequestException(`${what} must be a port between 1 and 65535.`);
    }
    return p;
  }

  private cidr(v: unknown, what: string): string {
    const s = String(v || '');
    const m = CIDR.exec(s);
    if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) < 16 || Number(m[5]) > 30) {
      throw new BadRequestException(`${what} must be a CIDR between /16 and /30, e.g. 10.66.0.0/24.`);
    }
    return s;
  }

  /** Update endpoint host and per-type settings from the GUI. */
  setConfig(body: Record<string, unknown>): VpnConfig {
    const cfg = this.getConfig();
    if (body.endpointHost !== undefined) {
      const h = String(body.endpointHost || '').trim();
      if (h && !HOST.test(h)) {
        throw new BadRequestException('Endpoint host must be a hostname or IP, e.g. vpn.yourdomain.com.');
      }
      cfg.endpointHost = h;
    }
    const wg = body.wireguard as Record<string, unknown> | undefined;
    if (wg) {
      if (wg.port !== undefined) cfg.wireguard.port = this.port(wg.port, 'WireGuard port');
      if (wg.subnet !== undefined) cfg.wireguard.subnet = this.cidr(wg.subnet, 'WireGuard subnet');
    }
    const ov = body.openvpn as Record<string, unknown> | undefined;
    if (ov) {
      if (ov.port !== undefined) cfg.openvpn.port = this.port(ov.port, 'OpenVPN port');
      if (ov.proto !== undefined) cfg.openvpn.proto = ov.proto === 'tcp' ? 'tcp' : 'udp';
      if (ov.subnet !== undefined) cfg.openvpn.subnet = this.cidr(ov.subnet, 'OpenVPN subnet');
    }
    const l2 = body.l2tp as Record<string, unknown> | undefined;
    if (l2 && l2.subnet !== undefined) cfg.l2tp.subnet = this.cidr(l2.subnet, 'L2TP subnet');
    this.save(cfg);
    this.logger.log('VPN server config updated');
    return cfg;
  }

  // ── host probes (best effort; never throw) ────────────────────────────
  private run(cmd: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, out) =>
        resolve(err ? null : out || ''),
      );
    });
  }

  private firstHostIp(subnet: string): string {
    // 10.66.0.0/24 → 10.66.0.1 (the panel's own overlay address).
    const [net] = subnet.split('/');
    const o = net.split('.');
    o[3] = '1';
    return o.join('.');
  }

  private async wgPublicKey(): Promise<string | null> {
    const iface = process.env.WG_INTERFACE || 'wg0';
    const out = await this.run('wg', ['show', iface, 'public-key']);
    const k = out?.trim();
    return k && WG_KEY.test(k) ? k : null;
  }

  private async portListening(port: number, proto: 'tcp' | 'udp'): Promise<boolean> {
    // `ss -H -lun`/`-ltn` lists listening sockets; grep the port. Best effort.
    const flag = proto === 'udp' ? '-lun' : '-ltn';
    const out = await this.run('ss', ['-H', flag]);
    if (out == null) return false;
    return new RegExp(`[:.]${port}\\b`).test(out);
  }

  /** Full status + ready-to-use scripts/configs for all three VPN types. */
  async overview() {
    const cfg = this.getConfig();
    const host = cfg.endpointHost;
    const [wgKey, ovUp, l2Up] = await Promise.all([
      this.wgPublicKey(),
      this.portListening(cfg.openvpn.port, cfg.openvpn.proto),
      this.portListening(500, 'udp'),
    ]);

    return {
      endpointHost: host,
      endpointSet: !!host,
      servers: [
        {
          type: 'wireguard' as VpnType,
          name: 'WireGuard',
          blurb: 'Fast, modern, lowest overhead. Best default for CGNAT routers.',
          running: !!wgKey,
          listenPort: cfg.wireguard.port,
          subnet: cfg.wireguard.subnet,
          serverIp: this.firstHostIp(cfg.wireguard.subnet),
          publicKey: wgKey,
          ready: !!wgKey && !!host,
          install: this.wireguardInstall(cfg),
          mikrotik: this.wireguardMikrotik(cfg, wgKey),
        },
        {
          type: 'openvpn' as VpnType,
          name: 'OpenVPN',
          blurb: 'Widely compatible, works over TCP/UDP through most firewalls.',
          running: ovUp,
          listenPort: cfg.openvpn.port,
          proto: cfg.openvpn.proto,
          subnet: cfg.openvpn.subnet,
          serverIp: this.firstHostIp(cfg.openvpn.subnet),
          ready: ovUp && !!host,
          install: this.openvpnInstall(cfg),
          mikrotik: this.openvpnMikrotik(cfg),
        },
        {
          type: 'l2tp' as VpnType,
          name: 'L2TP / IPsec',
          blurb: 'Native and easy on MikroTik. Uses a shared secret plus a login.',
          running: l2Up,
          subnet: cfg.l2tp.subnet,
          serverIp: this.firstHostIp(cfg.l2tp.subnet),
          ready: l2Up && !!host,
          install: this.l2tpInstall(cfg),
          mikrotik: this.l2tpMikrotik(cfg),
        },
      ],
    };
  }

  // ── install scripts (run once on the panel host, with sudo) ───────────
  private header(title: string): string {
    return [
      '#!/usr/bin/env bash',
      `# Jointbox — ${title}. Run once on the PANEL host as root.`,
      'set -euo pipefail',
      '[ "$(id -u)" = "0" ] || { echo "Run with sudo."; exit 1; }',
      '',
    ].join('\n');
  }

  private wireguardInstall(cfg: VpnConfig): string {
    const iface = process.env.WG_INTERFACE || 'wg0';
    const ip = this.firstHostIp(cfg.wireguard.subnet);
    const mask = cfg.wireguard.subnet.split('/')[1];
    return (
      this.header('WireGuard panel server') +
      [
        'apt-get update -y && apt-get install -y wireguard-tools',
        'install -d -m 0700 /etc/wireguard',
        `CONF=/etc/wireguard/${iface}.conf`,
        'if [ ! -f "$CONF" ]; then',
        '  umask 077',
        '  KEY=$(wg genkey)',
        '  cat > "$CONF" <<EOF',
        '[Interface]',
        'PrivateKey = ${KEY}',
        `Address = ${ip}/${mask}`,
        `ListenPort = ${cfg.wireguard.port}`,
        'EOF',
        'fi',
        `systemctl enable --now wg-quick@${iface}`,
        `ufw allow ${cfg.wireguard.port}/udp 2>/dev/null || true`,
        `echo; echo "WireGuard up. Public key:"; wg show ${iface} public-key`,
        'echo "Now click Re-check in the panel, then Reconcile to push router peers."',
      ].join('\n') +
      '\n'
    );
  }

  private wireguardMikrotik(cfg: VpnConfig, serverKey: string | null): string {
    const host = cfg.endpointHost || '<panel-host>';
    const key = serverKey || '<panel-public-key>';
    return [
      '# On the router: Jointbox issues the client keys per NAS from the',
      '# router’s Tunnel tab. This is the server endpoint it will dial:',
      `#   endpoint ${host}:${cfg.wireguard.port}`,
      `#   panel public key ${key}`,
      '# Use the per-router config on each NAS’s "Tunnel" tab to paste the',
      '# full /interface/wireguard block (it contains that router’s own key).',
    ].join('\n');
  }

  private openvpnInstall(cfg: VpnConfig): string {
    const ip = this.firstHostIp(cfg.openvpn.subnet);
    const net = cfg.openvpn.subnet.split('/')[0];
    return (
      this.header('OpenVPN panel server') +
      [
        'apt-get update -y && apt-get install -y openvpn easy-rsa',
        'MK=/etc/openvpn/jointbox',
        'install -d -m 0700 "$MK"',
        'if [ ! -f "$MK/ca.crt" ]; then',
        '  make-cadir "$MK/easyrsa"; cd "$MK/easyrsa"',
        '  ./easyrsa init-pki',
        '  EASYRSA_BATCH=1 ./easyrsa build-ca nopass',
        '  EASYRSA_BATCH=1 ./easyrsa build-server-full server nopass',
        '  ./easyrsa gen-dh',
        '  cp pki/ca.crt pki/issued/server.crt pki/private/server.key pki/dh.pem "$MK/"',
        'fi',
        'cat > /etc/openvpn/server/jointbox.conf <<EOF',
        `port ${cfg.openvpn.port}`,
        `proto ${cfg.openvpn.proto}`,
        'dev tun',
        'ca /etc/openvpn/jointbox/ca.crt',
        'cert /etc/openvpn/jointbox/server.crt',
        'key /etc/openvpn/jointbox/server.key',
        'dh /etc/openvpn/jointbox/dh.pem',
        `server ${net} ${this.maskFor(cfg.openvpn.subnet)}`,
        'topology subnet',
        'keepalive 10 60',
        'persist-key',
        'persist-tun',
        'EOF',
        'systemctl enable --now openvpn-server@jointbox',
        `ufw allow ${cfg.openvpn.port}/${cfg.openvpn.proto} 2>/dev/null || true`,
        `echo "OpenVPN up on ${ip}. Create a client cert per router:"`,
        'echo "  cd /etc/openvpn/jointbox/easyrsa && EASYRSA_BATCH=1 ./easyrsa build-client-full <routername> nopass"',
        'echo "Then export its .ovpn and paste into the router (see the panel)."',
      ].join('\n') +
      '\n'
    );
  }

  private openvpnMikrotik(cfg: VpnConfig): string {
    const host = cfg.endpointHost || '<panel-host>';
    return [
      '# RouterOS 7 — OpenVPN client to the panel.',
      '# First import the router’s client cert + key (from the panel host:',
      '#   /etc/openvpn/jointbox/easyrsa/pki/issued/<routername>.crt and the key)',
      '/certificate',
      '# import file-name=<routername>.crt ; import file-name=<routername>.key',
      '/interface/ovpn-client',
      `add name=jointbox-ovpn connect-to=${host} port=${cfg.openvpn.port} \\`,
      `    mode=ip protocol=${cfg.openvpn.proto} user=<routername> \\`,
      '    certificate=<routername>.crt_0 add-default-route=no \\',
      '    comment="Jointbox management tunnel"',
    ].join('\n');
  }

  private l2tpInstall(cfg: VpnConfig): string {
    const ip = this.firstHostIp(cfg.l2tp.subnet);
    const base = cfg.l2tp.subnet.split('/')[0].split('.').slice(0, 3).join('.');
    return (
      this.header('L2TP/IPsec panel server') +
      [
        'apt-get update -y && apt-get install -y strongswan xl2tpd',
        '# Shared secret for IPsec — change this and use the same on every router:',
        'PSK=$(head -c 18 /dev/urandom | base64)',
        'cat > /etc/ipsec.secrets <<EOF',
        ': PSK "${PSK}"',
        'EOF',
        'cat > /etc/xl2tpd/xl2tpd.conf <<EOF',
        '[global]',
        '[lns default]',
        `ip range = ${base}.10-${base}.240`,
        `local ip = ${ip}`,
        'require chap = yes',
        'refuse pap = yes',
        'ppp debug = no',
        'pppoptfile = /etc/ppp/options.xl2tpd',
        'length bit = yes',
        'EOF',
        'systemctl enable --now strongswan-starter xl2tpd',
        'ufw allow 500,4500/udp 2>/dev/null || true; ufw allow 1701/udp 2>/dev/null || true',
        'echo; echo "L2TP/IPsec up. Shared secret (use on every router):"; echo "$PSK"',
        'echo "Add a login per router in /etc/ppp/chap-secrets:  <routername> * <password> *"',
      ].join('\n') +
      '\n'
    );
  }

  private l2tpMikrotik(cfg: VpnConfig): string {
    const host = cfg.endpointHost || '<panel-host>';
    return [
      '# RouterOS 7 — L2TP/IPsec client to the panel.',
      '/interface/l2tp-client',
      `add name=jointbox-l2tp connect-to=${host} user=<routername> password=<password> \\`,
      '    use-ipsec=yes ipsec-secret=<shared-secret> add-default-route=no \\',
      '    comment="Jointbox management tunnel"',
    ].join('\n');
  }

  private maskFor(cidr: string): string {
    const bits = Number(cidr.split('/')[1]);
    const m = [0, 0, 0, 0];
    for (let i = 0; i < 32; i++) if (i < bits) m[Math.floor(i / 8)] |= 1 << (7 - (i % 8));
    return m.join('.');
  }

  // ── per-router client config, for any vendor ──────────────────────────
  /**
   * The config a SPECIFIC router pastes to join a VPN, rendered for its
   * vendor. "All vendors" means we emit the right syntax for each platform —
   * the operator still applies it on the device (we never push blindly to
   * third-party gear). WireGuard is the fast, low-overhead default.
   */
  clientConfig(type: VpnType, vendor: string, name: string, overlayIp: string): string {
    const nm = /^[A-Za-z0-9_-]{1,32}$/.test(name) ? name : 'router';
    const ip = this.assertIpStr(overlayIp);
    const cfg = this.getConfig();
    const host = cfg.endpointHost || '<panel-host>';
    const v = (vendor || 'mikrotik').toLowerCase();

    if (type === 'wireguard') return this.wgClient(v, nm, ip, host, cfg);
    if (type === 'openvpn') return this.ovpnClient(v, nm, host, cfg);
    return this.l2tpClient(v, nm, host);
  }

  private assertIpStr(ip: string): string {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
    if (!m || m.slice(1).some((o) => Number(o) > 255)) {
      throw new BadRequestException(`"${ip}" is not a valid overlay IP.`);
    }
    return ip;
  }

  private wgClient(vendor: string, nm: string, ip: string, host: string, cfg: VpnConfig): string {
    const port = cfg.wireguard.port;
    const mask = cfg.wireguard.subnet.split('/')[1];
    const panelIp = this.firstHostIp(cfg.wireguard.subnet);
    switch (vendor) {
      case 'cisco':
        return [
          `! Cisco IOS-XE WireGuard — ${nm}`,
          'crypto wireguard',
          ` private-key generate`,
          `interface wireguard1`,
          ` ip address ${ip} 255.255.255.255`,
          ` peer panel`,
          `  public-key <panel-public-key>`,
          `  endpoint ${host} ${port}`,
          `  allowed-ips ${panelIp}/32`,
          `  persistent-keepalive 25`,
        ].join('\n');
      case 'juniper':
        return [
          `# Juniper (set syntax) — ${nm}`,
          `set interfaces wg0 unit 0 family inet address ${ip}/${mask}`,
          `set security wireguard interface wg0 peer panel endpoint ${host}:${port}`,
          `set security wireguard interface wg0 peer panel allowed-ips ${panelIp}/32`,
          `set security wireguard interface wg0 peer panel public-key <panel-public-key>`,
        ].join('\n');
      case 'linux':
        return [
          `# wg-quick — /etc/wireguard/jointbox.conf on ${nm}`,
          '[Interface]',
          'PrivateKey = <this-router-private-key>',
          `Address = ${ip}/${mask}`,
          '[Peer]',
          'PublicKey = <panel-public-key>',
          `Endpoint = ${host}:${port}`,
          `AllowedIPs = ${panelIp}/32`,
          'PersistentKeepalive = 25',
        ].join('\n');
      default: // mikrotik
        return [
          `# RouterOS 7 — ${nm}. Keys are issued per-router on its Tunnel tab;`,
          `# this is the panel endpoint it dials:`,
          '/interface/wireguard add name=jointbox listen-port=13231',
          `/ip/address add address=${ip}/32 interface=jointbox`,
          '/interface/wireguard/peers add interface=jointbox \\',
          `    public-key="<panel-public-key>" endpoint-address=${host} endpoint-port=${port} \\`,
          `    allowed-address=${panelIp}/32 persistent-keepalive=25s`,
        ].join('\n');
    }
  }

  private ovpnClient(vendor: string, nm: string, host: string, cfg: VpnConfig): string {
    const port = cfg.openvpn.port;
    const proto = cfg.openvpn.proto;
    switch (vendor) {
      case 'cisco':
        return [
          `! Cisco OpenVPN is non-native; use a standard .ovpn on an attached host, or:`,
          `! crypto / AnyConnect is the Cisco path. Recommended: use WireGuard or L2TP on Cisco.`,
        ].join('\n');
      case 'linux':
      case 'generic':
        return [
          `# ${nm}.ovpn (OpenVPN client, any OS)`,
          'client',
          'dev tun',
          `proto ${proto}`,
          `remote ${host} ${port}`,
          'resolv-retry infinite',
          'nobind',
          'persist-key',
          'persist-tun',
          'remote-cert-tls server',
          '<ca>  # paste ca.crt from the panel host',
          '<cert># paste this router’s client cert',
          '<key> # paste this router’s client key',
        ].join('\n');
      default: // mikrotik
        return [
          `# RouterOS 7 — OpenVPN client ${nm}. Import this router’s cert+key first.`,
          '/interface/ovpn-client',
          `add name=jointbox-ovpn connect-to=${host} port=${port} protocol=${proto} \\`,
          `    mode=ip user=${nm} certificate=${nm}.crt_0 add-default-route=no \\`,
          '    comment="Jointbox management tunnel"',
        ].join('\n');
    }
  }

  private l2tpClient(vendor: string, nm: string, host: string): string {
    switch (vendor) {
      case 'cisco':
        return [
          `! Cisco IOS — L2TP/IPsec to the panel (${nm})`,
          'crypto isakmp policy 10',
          ' encr aes',
          ' authentication pre-share',
          ' group 2',
          `crypto isakmp key <shared-secret> address ${host}`,
          '! then an l2tp pseudowire / virtual-ppp to ' + host,
        ].join('\n');
      case 'juniper':
        return [
          `# Juniper — L2TP/IPsec to ${host} (${nm})`,
          `set services l2tp ... remote ${host}  # with IKE pre-shared-key <shared-secret>`,
        ].join('\n');
      case 'linux':
        return [
          `# Linux (NetworkManager/xl2tpd) — ${nm}`,
          `# server = ${host}, IPsec PSK = <shared-secret>, user = ${nm}, CHAP password = <password>`,
        ].join('\n');
      default: // mikrotik
        return [
          `# RouterOS 7 — L2TP/IPsec client ${nm}`,
          '/interface/l2tp-client',
          `add name=jointbox-l2tp connect-to=${host} user=${nm} password=<password> \\`,
          '    use-ipsec=yes ipsec-secret=<shared-secret> add-default-route=no \\',
          '    comment="Jointbox management tunnel"',
        ].join('\n');
    }
  }

  /** The script for one VPN type, for a Download/Copy button. */
  async install(type: VpnType): Promise<{ script: string; mikrotik: string }> {
    const o = await this.overview();
    const s = o.servers.find((x) => x.type === type);
    if (!s) throw new BadRequestException('Unknown VPN type.');
    return { script: s.install, mikrotik: s.mikrotik };
  }
}
