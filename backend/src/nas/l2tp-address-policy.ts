/**
 * NAS management-VPN ADDRESS POLICY (server-side only).
 *
 * Who may decide which addresses the Uplinko host routes into a tunnel is a
 * PLATFORM decision, never a company admin's: every accepted tunnel address
 * becomes a /32 route on the shared host (pppd runs as root). This module is
 * pure (no I/O) so it can be tested exhaustively; the host inventory it checks
 * against is read by the dialer (`ip -j …`) and passed in.
 *
 * Configuration (environment of the backend process — platform owner only):
 *   L2TP_MGMT_POOL                 CIDR reserved for tunnel addresses.
 *                                  Default 10.255.0.0/16.
 *   L2TP_PROTECTED_CIDRS           Extra comma-separated CIDRs/IPs that must
 *                                  never be a tunnel address or a NAS endpoint
 *                                  (licence server, monitoring, DNS …).
 *   L2TP_ALLOW_PRIVATE_ENDPOINTS   "true" only for a deliberate private/NAT
 *                                  deployment where NAS endpoints are RFC1918
 *                                  addresses reachable without the internet.
 */

export interface Cidr {
  net: number;
  bits: number;
  text: string;
}

export interface HostInventory {
  /** Addresses on host interfaces (excluding Uplinko's own ulnas* tunnels). */
  addresses: string[];
  /** Directly connected / routed networks in the main table (excluding ulnas* routes). */
  networks: Cidr[];
  /** Default gateway addresses. */
  gateways: string[];
}

export interface PolicyConfig {
  pool: Cidr;
  protected: Cidr[];
  allowPrivateEndpoints: boolean;
}

export interface OtherClaims {
  /** Every tunnel address (local or remote) already claimed by ANOTHER NAS. */
  tunnelAddresses: string[];
  /** Management endpoints of other NAS (one PSK identity per address). */
  endpoints: string[];
  /** Management IPs / names of every NAS the app knows (any tenant). */
  nasIps: string[];
}

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpv4(v: unknown): v is string {
  return typeof v === 'string' && IPV4.test(v);
}

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

export function parseCidr(text: string): Cidr | null {
  const t = String(text || '').trim();
  const [ip, b] = t.includes('/') ? t.split('/') : [t, '32'];
  const bits = Number(b);
  if (!isIpv4(ip) || !Number.isInteger(bits) || bits < 0 || bits > 32)
    return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (ipToInt(ip) & mask) >>> 0, bits, text: `${ip}/${bits}` };
}

function mask(bits: number): number {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

export function inCidr(ip: string, c: Cidr): boolean {
  return (ipToInt(ip) & mask(c.bits)) >>> 0 === c.net;
}

export function cidrsOverlap(a: Cidr, b: Cidr): boolean {
  const bits = Math.min(a.bits, b.bits);
  return (a.net & mask(bits)) >>> 0 === (b.net & mask(bits)) >>> 0;
}

/** IANA special-purpose IPv4 blocks that are never a public NAS endpoint. */
const NEVER_ENDPOINT = [
  '0.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
].map((c) => parseCidr(c)!);
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map((c) =>
  parseCidr(c)!,
);

export function loadPolicy(
  env: NodeJS.ProcessEnv = process.env,
): PolicyConfig | { error: string } {
  const pool = parseCidr(env.L2TP_MGMT_POOL || '10.255.0.0/16');
  if (!pool) return { error: 'L2TP_MGMT_POOL is not a valid IPv4 CIDR.' };
  if (pool.bits < 8 || pool.bits > 29)
    return { error: 'L2TP_MGMT_POOL must be between /8 and /29.' };
  if (!PRIVATE.some((p) => cidrsOverlap(p, pool) && pool.bits >= p.bits)) {
    return {
      error: 'L2TP_MGMT_POOL must lie inside private address space (RFC 1918).',
    };
  }
  const prot: Cidr[] = [];
  for (const part of String(env.L2TP_PROTECTED_CIDRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const c = parseCidr(part);
    if (!c)
      return {
        error: `L2TP_PROTECTED_CIDRS entry "${part}" is not a valid IPv4 address or CIDR.`,
      };
    prot.push(c);
  }
  return {
    pool,
    protected: prot,
    allowPrivateEndpoints: env.L2TP_ALLOW_PRIVATE_ENDPOINTS === 'true',
  };
}

/**
 * Check one NAS's management addressing. Returns the list of violations
 * (empty = allowed). Fails closed: a missing inventory is itself a violation.
 */
export function checkAddressing(
  input: {
    endpoint?: string | null;
    localAddress?: string | null;
    remoteAddress?: string | null;
  },
  policy: PolicyConfig,
  host: HostInventory | null,
  others: OtherClaims,
): string[] {
  const errs: string[] = [];
  if (!host)
    return [
      'The server network inventory could not be read, so the addresses cannot be checked safely.',
    ];

  // The pool itself must not collide with anything the host already uses.
  if (
    host.networks.some((n) => cidrsOverlap(n, policy.pool)) ||
    host.addresses.some((a) => inCidr(a, policy.pool))
  ) {
    errs.push(
      `The management pool ${policy.pool.text} overlaps a network on this server. The platform owner must change L2TP_MGMT_POOL.`,
    );
    return errs;
  }

  const poolNet = policy.pool.net;
  const poolBcast = (poolNet | (~mask(policy.pool.bits) >>> 0)) >>> 0;

  const tunnel = (label: string, ip?: string | null) => {
    if (ip == null || ip === '') return;
    if (!isIpv4(ip)) {
      errs.push(`${label} must be an IPv4 address.`);
      return;
    }
    if (!inCidr(ip, policy.pool)) {
      errs.push(
        `${label} must be inside the management pool ${policy.pool.text}.`,
      );
      return;
    }
    const n = ipToInt(ip);
    if (n === poolNet || n === poolBcast)
      errs.push(`${label} cannot be the pool's network or broadcast address.`);
    if (policy.protected.some((c) => inCidr(ip, c)))
      errs.push(`${label} is a protected infrastructure address.`);
    if (
      host.addresses.includes(ip) ||
      host.gateways.includes(ip) ||
      host.networks.some((c) => inCidr(ip, c))
    ) {
      errs.push(`${label} is already used on this server.`);
    }
    if (others.tunnelAddresses.includes(ip))
      errs.push(`${label} is already used by another NAS tunnel.`);
    if (others.nasIps.includes(ip))
      errs.push(`${label} is the address of an existing NAS.`);
  };
  tunnel('Uplinko tunnel address', input.localAddress);
  tunnel('NAS tunnel address', input.remoteAddress);
  if (
    input.localAddress &&
    input.remoteAddress &&
    input.localAddress === input.remoteAddress
  ) {
    errs.push('Uplinko and NAS tunnel addresses must differ.');
  }

  const ep = input.endpoint;
  if (ep != null && ep !== '') {
    if (!isIpv4(ep))
      errs.push('NAS public address must be an IPv4 address (no hostnames).');
    else {
      if (NEVER_ENDPOINT.some((c) => inCidr(ep, c)))
        errs.push('NAS public address is a reserved/special-purpose address.');
      if (!policy.allowPrivateEndpoints && PRIVATE.some((c) => inCidr(ep, c))) {
        errs.push(
          'NAS public address must be a public IPv4 address (private endpoints are not enabled on this server).',
        );
      }
      if (inCidr(ep, policy.pool))
        errs.push('NAS public address cannot be inside the management pool.');
      if (policy.protected.some((c) => inCidr(ep, c)))
        errs.push('NAS public address is a protected infrastructure address.');
      if (host.addresses.includes(ep) || host.gateways.includes(ep))
        errs.push('NAS public address belongs to this server or its gateway.');
      if (
        !policy.allowPrivateEndpoints &&
        host.networks.some((c) => c.bits > 0 && inCidr(ep, c))
      ) {
        errs.push(
          'NAS public address is on a network directly connected to this server.',
        );
      }
      if (others.endpoints.includes(ep))
        errs.push(
          'Another NAS already uses this public address for its management VPN.',
        );
      if ([input.localAddress, input.remoteAddress].includes(ep))
        errs.push('Tunnel addresses must differ from the NAS public address.');
    }
  }
  return [...new Set(errs)];
}

/**
 * Parse `ip -j -4 addr show` and `ip -j -4 route show table main` (iproute2
 * JSON output). Uplinko's own ulnas* interfaces are excluded — they are
 * checked against the database claims instead. Returns null when either
 * document is not the expected JSON (fail closed).
 */
export function parseInventory(
  addrJson: string,
  routeJson: string,
): HostInventory | null {
  let addrs: any, routes: any;
  try {
    addrs = JSON.parse(addrJson);
    routes = JSON.parse(routeJson);
  } catch {
    return null;
  }
  if (!Array.isArray(addrs) || !Array.isArray(routes)) return null;
  const own = (dev: unknown) =>
    typeof dev === 'string' && /^ulnas\d+$/.test(dev);
  const addresses: string[] = [];
  const networks: Cidr[] = [];
  for (const link of addrs) {
    if (own(link?.ifname)) continue;
    for (const a of Array.isArray(link?.addr_info) ? link.addr_info : []) {
      if (a?.family !== 'inet' || !isIpv4(a?.local)) continue;
      addresses.push(a.local);
      const c = parseCidr(`${a.local}/${a.prefixlen ?? 32}`);
      if (c && c.bits < 32 && a.local !== '127.0.0.1') networks.push(c);
    }
  }
  const gateways: string[] = [];
  for (const r of routes) {
    if (own(r?.dev)) continue;
    if (isIpv4(r?.gateway)) gateways.push(r.gateway);
    if (typeof r?.dst === 'string' && r.dst !== 'default') {
      const c = parseCidr(r.dst);
      if (c) networks.push(c);
    }
  }
  return {
    addresses: [...new Set(addresses)],
    networks,
    gateways: [...new Set(gateways)],
  };
}
