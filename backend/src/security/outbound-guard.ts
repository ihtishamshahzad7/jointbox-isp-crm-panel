import * as dns from 'dns';
import * as net from 'net';
import { BadRequestException } from '@nestjs/common';

/**
 * THE ONE PLACE AN OUTBOUND DESTINATION IS APPROVED.
 *
 * ── The problem ──────────────────────────────────────────────────────────
 * This application dials out from a dozen places: webhooks, Discord and
 * WhatsApp alert channels, the SMS gateway, ping and traceroute, TCP and HTTP
 * service checks, DNS lookups, SNMP polling, RouterOS API sessions, RADIUS
 * CoA, and syslog forwarding. In several of them the destination comes from a
 * user — a webhook URL from a request body, a monitor host from a form, a
 * syslog forward target from a settings page.
 *
 * A server that will fetch a URL you give it is a server that will read
 * anything it can reach and you cannot. On this box that includes Redis on
 * 127.0.0.1:6379, PostgreSQL on 5432, the FreeRADIUS status port, the
 * backend's own /events stream, every router on 192.168.88.0/24 — and, if
 * this is ever hosted on a cloud VM, 169.254.169.254, which hands out IAM
 * credentials to anything that asks.
 *
 * ── Why one blanket denylist would break this product ────────────────────
 * This is an ISP CRM. Its entire job is to monitor 192.168.88.20, poll SNMP
 * on 10.x routers and send CoA packets to RFC1918 NAS devices. A guard that
 * refused private addresses everywhere would refuse the application's core
 * function, get switched off within a week, and leave the webhooks exposed.
 *
 * So the guard takes a PROFILE. The distinction that matters is not
 * public-versus-private; it is "infrastructure this operator owns and has
 * deliberately configured" versus "a URL someone typed".
 *
 *   EXTERNAL         — webhooks, alert channels, SMS, payment callbacks.
 *                      Public internet only. Everything internal is refused.
 *
 *   OPERATOR_NETWORK — monitors, NAS, SNMP, CoA, syslog forwarding.
 *                      RFC1918 and CGNAT are allowed, because that is where
 *                      the routers live. Loopback, link-local, metadata,
 *                      multicast and broadcast are STILL refused: pointing a
 *                      "monitor" at 127.0.0.1:6379 or 169.254.169.254 is an
 *                      attack whatever the profile, and no router lives there.
 *
 * ── Why not a regex on the hostname ──────────────────────────────────────
 * Because every one of these reaches 127.0.0.1 and none of them looks like
 * it:
 *
 *     http://127.1/                 (Linux short form)
 *     http://2130706433/            (decimal)
 *     http://0x7f.0x0.0x0.0x1/      (hex)
 *     http://0177.0.0.1/            (octal)
 *     http://[::1]/                 (IPv6 loopback)
 *     http://[::ffff:127.0.0.1]/    (IPv4-mapped IPv6)
 *     http://localtest.me/          (public DNS name resolving to 127.0.0.1)
 *
 * A blocklist of strings loses this game permanently. The only thing that
 * works is to RESOLVE the name and judge the resolved ADDRESS, which is what
 * `assertDestination` does. `net.isIP` and a real parser do the deciding, not
 * a pattern.
 */

export type OutboundProfile = 'EXTERNAL' | 'OPERATOR_NETWORK';

export class SsrfBlocked extends BadRequestException {
  constructor(
    readonly host: string,
    readonly address: string,
    readonly why: string,
  ) {
    super(`Refusing to connect to ${host} (${address}): ${why}`);
  }
}

/** Where a rejected address falls. Kept as a reason string for the log. */
type Verdict = { allowed: boolean; why: string };

// ───────────────────────────────────────────────────────────────────────────
// Address classification
// ───────────────────────────────────────────────────────────────────────────

/** Parse a dotted-quad into its four octets, or null if it is not one. */
function v4Octets(addr: string): number[] | null {
  if (net.isIPv4(addr) !== true) return null;
  return addr.split('.').map((o) => Number(o));
}

/**
 * Normalise an IPv4-mapped or IPv4-compatible IPv6 address down to its IPv4
 * form, so `::ffff:127.0.0.1` is judged as `127.0.0.1` rather than sailing
 * past the v4 rules because it is technically a v6 address.
 */
export function unmapV6(addr: string): string {
  const lower = addr.toLowerCase().replace(/^\[|\]$/g, '');
  const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (m && net.isIPv4(m[1])) return m[1];
  // ::ffff:7f00:1 — the same thing written in hex groups.
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return lower;
}

/**
 * Judge one RESOLVED address against a profile.
 *
 * Exported so it can be tested directly against the whole table of evasions
 * without needing DNS.
 */
export function classify(rawAddr: string, profile: OutboundProfile): Verdict {
  const addr = unmapV6(rawAddr);

  const v4 = v4Octets(addr);
  if (v4) {
    const [a, b] = v4;

    // Always refused, in EVERY profile. No router, webhook or monitor target
    // legitimately lives at any of these, and each is a documented pivot.
    if (a === 127) return { allowed: false, why: 'loopback (127.0.0.0/8)' };
    if (a === 0) return { allowed: false, why: '"this host" (0.0.0.0/8)' };
    if (a === 169 && b === 254) {
      // 169.254.169.254 is the cloud metadata service on AWS, GCP, Azure,
      // DigitalOcean and Hetzner. It answers plain HTTP with no credential
      // and hands out IAM role keys. The whole /16 goes.
      return { allowed: false, why: 'link-local / cloud metadata (169.254.0.0/16)' };
    }
    if (a >= 224 && a <= 239) return { allowed: false, why: 'multicast (224.0.0.0/4)' };
    if (a >= 240) return { allowed: false, why: 'reserved / broadcast (240.0.0.0/4)' };

    // Private and carrier-grade NAT: the operator's own network.
    const isPrivate =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
      (a === 192 && b === 0) || // 192.0.0.0/24 IETF protocol assignments
      (a === 198 && (b === 18 || b === 19)); // benchmarking 198.18.0.0/15

    if (isPrivate) {
      return profile === 'OPERATOR_NETWORK'
        ? { allowed: true, why: 'operator network' }
        : { allowed: false, why: 'private address (RFC1918 / CGNAT)' };
    }
    return { allowed: true, why: 'public' };
  }

  if (net.isIPv6(addr)) {
    const a = addr.toLowerCase();
    if (a === '::1' || a === '::') return { allowed: false, why: 'IPv6 loopback / unspecified' };
    if (/^fe[89ab]/.test(a)) return { allowed: false, why: 'IPv6 link-local (fe80::/10)' };
    if (a.startsWith('ff')) return { allowed: false, why: 'IPv6 multicast (ff00::/8)' };
    // fc00::/7 — unique local addresses, the IPv6 equivalent of RFC1918.
    if (a.startsWith('fc') || a.startsWith('fd')) {
      return profile === 'OPERATOR_NETWORK'
        ? { allowed: true, why: 'operator network (IPv6 ULA)' }
        : { allowed: false, why: 'IPv6 unique-local (fc00::/7)' };
    }
    return { allowed: true, why: 'public' };
  }

  // Not an IP at all. Callers must resolve first; reaching here means a
  // hostname slipped through, and guessing is not an option.
  return { allowed: false, why: 'not a resolvable IP address' };
}

// ───────────────────────────────────────────────────────────────────────────
// Hostname handling
// ───────────────────────────────────────────────────────────────────────────

/**
 * Alternate integer notations, resolved to a dotted quad BEFORE anything
 * looks at them.
 *
 * `http://2130706433/` is 127.0.0.1 and every HTTP client in Node accepts it.
 * So does `0x7f000001` and `017700000001`. Node's own `net.isIP` says false
 * for all three, which means a guard that trusts `isIP` to mean "not an
 * address" waves them straight through — and this is precisely the bypass a
 * regex-based check cannot see.
 */
export function normaliseNumericHost(host: string): string {
  const h = host.trim().toLowerCase();

  // Fully numeric: decimal, hex or octal 32-bit value.
  //
  // ORDER MATTERS, and the first version of this got it wrong — a test
  // caught it. `017700000001` is 127.0.0.1 written in octal, and it also
  // matches /^\d+$/. Checked as decimal first it becomes 17,700,000,001,
  // which overflows 32 bits, so the normaliser gave up and returned the
  // string unchanged — and the guard then saw a hostname rather than
  // loopback. A LEADING ZERO MEANS OCTAL, exactly as inet_aton reads it,
  // so octal and hex are tested before plain decimal.
  let n: number | null = null;
  if (/^0x[0-9a-f]+$/.test(h)) n = parseInt(h.slice(2), 16);
  else if (/^0[0-7]+$/.test(h)) n = parseInt(h.slice(1), 8);
  else if (/^\d+$/.test(h)) n = Number(h);

  if (n !== null && Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
  }

  const parts = h.split('.');

  // Dotted, but with hex or octal octets: 0x7f.0x0.0x0.0x1 / 0177.0.0.1
  if (parts.length === 4 && parts.every((p) => /^(0x[0-9a-f]+|0[0-7]*|\d+)$/.test(p))) {
    const octets = parts.map((p) => {
      if (p.startsWith('0x')) return parseInt(p.slice(2), 16);
      if (/^0[0-7]+$/.test(p)) return parseInt(p.slice(1), 8);
      return Number(p);
    });
    if (octets.every((o) => Number.isFinite(o) && o >= 0 && o <= 255)) return octets.join('.');
  }

  // Linux short forms: 127.1 is 127.0.0.1; 10.0.1 is 10.0.0.1. The LAST part
  // fills the remaining low octets, which is what inet_aton actually does.
  if ((parts.length === 2 || parts.length === 3) && parts.every((p) => /^\d+$/.test(p))) {
    const nums = parts.map(Number);
    const head = nums.slice(0, -1);
    const tail = nums[nums.length - 1];
    if (head.every((o) => o >= 0 && o <= 255) && tail >= 0 && tail <= 0xffffffff) {
      const fill = 4 - head.length;
      const low: number[] = [];
      for (let i = fill - 1; i >= 0; i--) low.push((tail >>> (i * 8)) & 0xff);
      return [...head, ...low].join('.');
    }
  }

  return h;
}

/** Resolve a hostname to EVERY address it has. */
async function resolveAll(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  try {
    const results = await dns.promises.lookup(host, { all: true, verbatim: true });
    return results.map((r) => r.address);
  } catch (e: any) {
    throw new SsrfBlocked(host, '-', `DNS lookup failed (${e?.code || e?.message || 'unknown'})`);
  }
}

/**
 * APPROVE A DESTINATION, OR THROW.
 *
 * Returns the resolved addresses, so a caller that wants to defeat DNS
 * rebinding can connect to the address it was given rather than re-resolving
 * the name.
 *
 * EVERY resolved address must pass. A name with an A record for a public IP
 * and a second A record for 127.0.0.1 is refused — that is the cheap form of
 * rebinding, and accepting "at least one is fine" would allow it outright.
 */
export async function assertDestination(
  hostOrUrl: string,
  profile: OutboundProfile,
): Promise<{ host: string; addresses: string[] }> {
  const raw = String(hostOrUrl || '').trim();
  if (!raw) throw new SsrfBlocked('(empty)', '-', 'no destination given');

  let host = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new SsrfBlocked(raw, '-', 'not a valid URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      // file://, gopher://, ftp:// and dict:// are classic SSRF escalations:
      // they read local files or speak to non-HTTP services.
      throw new SsrfBlocked(raw, '-', `scheme ${u.protocol} is not allowed`);
    }
    host = u.hostname;
  }

  host = normaliseNumericHost(host.replace(/^\[|\]$/g, ''));

  const addresses = await resolveAll(host);
  if (addresses.length === 0) throw new SsrfBlocked(host, '-', 'resolved to no addresses');

  for (const addr of addresses) {
    const verdict = classify(addr, profile);
    if (!verdict.allowed) throw new SsrfBlocked(host, addr, verdict.why);
  }
  return { host, addresses };
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP
// ───────────────────────────────────────────────────────────────────────────

const MAX_REDIRECTS = 3;

/**
 * `fetch`, with every hop validated.
 *
 * ── Why redirects need their own handling ────────────────────────────────
 * Validating the URL and then handing it to `fetch` is not a control. The
 * attacker's server answers `302 Location: http://169.254.169.254/latest/
 * meta-data/iam/security-credentials/`, and `fetch` follows it without asking
 * anyone. The first URL passed; the request that actually went out did not.
 *
 * So redirects are followed manually, and EVERY hop goes back through
 * `assertDestination`. `redirect: 'manual'` is the part that makes this work.
 *
 * ── The rebinding window ─────────────────────────────────────────────────
 * There is still a gap between our DNS lookup and the one the HTTP stack
 * does: a name with a one-second TTL can answer publicly for us and
 * 127.0.0.1 for the connection that follows. Closing that properly needs a
 * custom agent that pins the socket to the address we validated. It is
 * deliberately NOT done here, because Node's undici does not expose that
 * cleanly and a half-working pin is worse than an honest gap.
 *
 * What IS done: every resolved address must pass, which defeats the common
 * multi-A-record variant, and the gap is written down rather than papered
 * over. Treat rebinding as UNPROVEN-mitigated, not closed.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  profile: OutboundProfile = 'EXTERNAL',
): Promise<Response> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertDestination(current, profile);

    const res = await fetch(current, { ...init, redirect: 'manual' });

    const location = res.headers.get('location');
    const isRedirect = res.status >= 300 && res.status < 400 && location;
    if (!isRedirect) return res;

    // Relative redirects are resolved against the current URL, then validated
    // like any other destination.
    current = new URL(location!, current).toString();
  }

  throw new SsrfBlocked(url, '-', `more than ${MAX_REDIRECTS} redirects`);
}
