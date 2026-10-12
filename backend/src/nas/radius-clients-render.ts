/**
 * FreeRADIUS client file — pure rendering, shared by the backend
 * (RadiusClientVaultService) and the server-side cutover script
 * (scripts/radius-clients.js, which loads the compiled copy of this file).
 *
 * No Nest, no Prisma, no I/O: given the NAS rows and a way to decrypt, it
 * returns the exact file FreeRADIUS will read, plus what was left out and why.
 */
import { isIP } from 'net';

/** The one file the application owns under the FreeRADIUS config dir. */
export const VAULT_FILE_NAME = 'jointbox-nas.conf';

/**
 * The include line, by exact file name. FreeRADIUS 3 does NOT expand
 * wildcards in $INCLUDE: "$INCLUDE clients.d/*.conf" (what earlier installers
 * wrote) is read as a literal file name and stops the server from starting.
 */
export const VAULT_INCLUDE_LINE = `$INCLUDE clients.d/${VAULT_FILE_NAME}`;

/** The broken wildcard form earlier installers appended to clients.conf. */
export const BROKEN_WILDCARD_INCLUDE =
  /^[ \t]*\$INCLUDE[ \t]+clients\.d\/\*\.conf[ \t]*$/m;

export interface VaultNasRow {
  id: number;
  nasIp: string | null;
  nasname?: string | null;
  shortname?: string | null;
  isActive: boolean;
  /** Legacy plaintext (servers not yet switched to the vault file). */
  secret?: string | null;
  /** AES-256-GCM payload (common/crypto-box). */
  radiusSecretEnc?: string | null;
}

export interface RenderResult {
  content: string;
  clients: Array<{ id: number; ip: string }>;
  skipped: Array<{ id: number; ip: string | null; reason: string }>;
  /** Active routers whose stored secret could not be decrypted (wrong SECRETS_KEY?). */
  undecryptable: number[];
}

/**
 * A FreeRADIUS single-quoted string. Single quotes because double-quoted
 * strings are expanded ("${...}", "%{...}"), which a secret must never be.
 * Backslash and quote are escaped.
 */
export function confQuote(v: string): string {
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** What a RADIUS shared secret may contain: printable ASCII, 1–60 chars. */
export function secretProblem(
  secret: string | null | undefined,
): string | null {
  const s = String(secret ?? '');
  if (!s) return 'The RADIUS secret is empty.';
  if (s !== s.trim())
    return 'The RADIUS secret has spaces at the start or end — routers treat those as part of it.';
  if (s.length > 60) return 'The RADIUS secret is longer than 60 characters.';
  if (!/^[\x20-\x7E]+$/.test(s))
    return 'The RADIUS secret may only use letters, digits and ordinary symbols (no accents, emoji or control characters).';
  return null;
}

/**
 * Why an address cannot be a router's RADIUS client address (null = usable).
 * Checked when a router is saved, so a bad address is refused with a reason
 * instead of the router silently missing from FreeRADIUS's list.
 */
export function nasIpProblem(ip: string | null | undefined): string | null {
  const v = String(ip ?? '').trim();
  if (isIP(v) !== 4) {
    return `"${v}" is not a valid IPv4 address. Enter the router's IP as seen by the RADIUS server (e.g. 192.168.1.127) — no name, no placeholder, no subnet mask, no leading zeros.`;
  }
  const first = Number(v.split('.')[0]);
  if (first === 0 || v === '255.255.255.255')
    return `${v} is not a usable router address.`;
  if (first === 127) {
    return `${v} is this server itself (loopback). Enter the address the router's RADIUS requests come FROM.`;
  }
  if (first >= 224)
    return `${v} is a multicast or reserved address, not a router.`;
  return null;
}

/** A display name that cannot break out of its quoted string. */
export function safeShortname(
  v: string | null | undefined,
  fallback: string,
): string {
  const s = String(v ?? '')
    .replace(/[^A-Za-z0-9 ._:@-]/g, '_')
    .trim()
    .slice(0, 32);
  return s || fallback;
}

/** Normalise an address the way FreeRADIUS compares clients (no /32, lower-case v6). */
export function normaliseIp(v: string | null | undefined): string | null {
  const raw = String(v ?? '').trim();
  const m = raw.match(/^(.+?)(?:\/(\d+))?$/);
  if (!m) return null;
  const ip = m[1].toLowerCase();
  const kind = isIP(ip);
  if (!kind) return null;
  const bits = m[2] != null ? Number(m[2]) : kind === 4 ? 32 : 128;
  if ((kind === 4 && bits !== 32) || (kind === 6 && bits !== 128)) return null; // a range, not one router
  return ip;
}

/**
 * Host addresses already defined by clients in clients.conf (localhost, …).
 * A second client for the same address stops FreeRADIUS from starting, so the
 * generated file must skip them.
 */
export function staticClientIps(
  clientsConf: string | null | undefined,
): Set<string> {
  const out = new Set<string>();
  const text = String(clientsConf ?? '')
    .split('\n')
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n');
  const re = /^\s*(?:ipaddr|ipv4addr|ipv6addr)\s*=\s*["']?([^"'\s]+)["']?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ip = normaliseIp(m[1]);
    if (ip) out.add(ip);
  }
  return out;
}

/**
 * Which source FreeRADIUS takes router (client) secrets from:
 *   'file' — clients.conf includes the generated file and the sql module does
 *            not read clients: the vault is the only source; plaintext in the
 *            database is no longer needed.
 *   'sql'  — anything else (an older server, or FreeRADIUS on another host):
 *            the plaintext `nas.secret` column is still what FreeRADIUS reads,
 *            so it must be kept.
 */
export function detectClientMode(
  clientsConf: string | null | undefined,
  sqlModule: string | null | undefined,
): 'file' | 'sql' {
  const text = String(clientsConf ?? '');
  const includes = text.split('\n').some((l) => {
    const t = l.replace(/#.*$/, '').trim();
    return (
      t === VAULT_INCLUDE_LINE ||
      t === '$INCLUDE clients.d/' ||
      t === '$INCLUDE clients.d'
    );
  });
  const readsSqlClients = /^\s*read_clients\s*=\s*(yes|true)\b/m.test(
    String(sqlModule ?? ''),
  );
  return includes && !readsSqlClients ? 'file' : 'sql';
}

/**
 * Build the client file. Only active routers with a valid single address and
 * a usable secret are written; everything else is listed in `skipped`.
 */
export function renderClients(
  rows: VaultNasRow[],
  opts: {
    decrypt: (payload: string) => string | null;
    reservedIps?: Set<string>;
  },
): RenderResult {
  const clients: RenderResult['clients'] = [];
  const skipped: RenderResult['skipped'] = [];
  const undecryptable: number[] = [];
  const seen = new Map<string, number>();
  const blocks: string[] = [];
  const reserved = opts.reservedIps ?? new Set<string>();

  const sorted = [...rows].sort((a, b) => a.id - b.id);
  for (const row of sorted) {
    if (!row.isActive) continue;
    const ip = normaliseIp(row.nasIp);
    if (!ip) {
      skipped.push({
        id: row.id,
        ip: row.nasIp ?? null,
        reason: 'not a single IP address',
      });
      continue;
    }
    let secret: string | null = null;
    if (row.radiusSecretEnc) {
      secret = opts.decrypt(row.radiusSecretEnc);
      if (secret == null) {
        undecryptable.push(row.id);
        skipped.push({
          id: row.id,
          ip,
          reason: 'stored secret cannot be decrypted (SECRETS_KEY changed?)',
        });
        continue;
      }
    } else if (row.secret) {
      secret = row.secret;
    }
    const problem = secretProblem(secret);
    if (problem) {
      skipped.push({
        id: row.id,
        ip,
        reason: secret
          ? 'secret has characters FreeRADIUS cannot take'
          : 'no RADIUS secret set',
      });
      continue;
    }
    if (reserved.has(ip)) {
      skipped.push({
        id: row.id,
        ip,
        reason: 'address already defined in clients.conf',
      });
      continue;
    }
    if (seen.has(ip)) {
      skipped.push({
        id: row.id,
        ip,
        reason: `same address as router #${seen.get(ip)}`,
      });
      continue;
    }
    seen.set(ip, row.id);
    clients.push({ id: row.id, ip });
    blocks.push(
      [
        `client jointbox-nas-${row.id} {`,
        `\tipaddr = ${ip}`,
        `\tsecret = ${confQuote(secret as string)}`,
        `\tshortname = ${confQuote(safeShortname(row.shortname || row.nasname, `nas-${row.id}`))}`,
        '\tnas_type = other',
        '\tproto = udp',
        '}',
      ].join('\n'),
    );
  }

  const content =
    [
      '# Managed by Jointbox — rewritten whenever a router is added, changed, enabled or removed.',
      '# Do not edit by hand. Shared secrets come from the encrypted vault in the database.',
      `# Routers: ${clients.length}`,
      '',
      ...blocks.map((b) => `${b}\n`),
    ]
      .join('\n')
      .replace(/\n+$/, '') + '\n';

  return { content, clients, skipped, undecryptable };
}
