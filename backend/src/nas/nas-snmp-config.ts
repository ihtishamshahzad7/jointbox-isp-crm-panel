import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BlockList, isIP } from 'node:net';

/**
 * Per-NAS SNMP configuration helpers (Stage 2).
 *
 * Kept out of nas.service so the validation — the part that enforces "never a
 * silent downgrade to a weaker SNMPv3 level or to v2c" — can be unit-tested on
 * its own, without constructing the whole NAS service graph.
 */

/**
 * Accept the SNMP version in either the UI form ("1" / "2c" / "3") or the DB
 * enum ("V1" / "V2C" / "V3") and always return the enum Prisma expects.
 * Reject unknown values rather than silently weakening the configured version.
 */
export function normalizeSnmpVersion(v: any): 'V1' | 'V2C' | 'V3' {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === '1' || s === 'V1') return 'V1';
  if (s === '3' || s === 'V3') return 'V3';
  if (s === '2' || s === '2C' || s === 'V2C') return 'V2C';
  throw new BadRequestException('Unsupported SNMP version.');
}

export function assertValidSnmpPort(port: unknown): asserts port is number {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BadRequestException('SNMP port must be an integer between 1 and 65535.');
  }
}

/**
 * SNMP is an outbound network capability. Permit requests only to literal NAS
 * IPs explicitly covered by an operator-controlled CIDR allowlist.
 */
export function assertSnmpTargetAllowed(
  host: string,
  port: unknown,
  allowedCidrs = process.env.SNMP_ALLOWED_CIDRS,
): void {
  assertValidSnmpPort(port);
  const address = host.trim();
  const family = isIP(address);
  if (!family) throw new BadRequestException('SNMP target must be a valid IP address.');

  const cidrs = (allowedCidrs ?? '').split(',').map((cidr) => cidr.trim()).filter(Boolean);
  if (!cidrs.length) {
    throw new ForbiddenException('SNMP polling requires an operator-configured SNMP_ALLOWED_CIDRS allowlist.');
  }

  const targets = new BlockList();
  for (const cidr of cidrs) {
    const [network, prefixText, ...extra] = cidr.split('/');
    const networkFamily = isIP(network);
    if (!networkFamily || extra.length || (prefixText !== undefined && !/^\d+$/.test(prefixText))) {
      throw new BadRequestException('SNMP_ALLOWED_CIDRS contains an invalid CIDR entry.');
    }

    const prefix = prefixText === undefined ? (networkFamily === 4 ? 32 : 128) : Number(prefixText);
    const maxPrefix = networkFamily === 4 ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new BadRequestException('SNMP_ALLOWED_CIDRS contains an invalid CIDR prefix.');
    }
    if (networkFamily === family) {
      targets.addSubnet(network, prefix, family === 4 ? 'ipv4' : 'ipv6');
    }
  }

  if (!targets.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new ForbiddenException('SNMP target is outside the configured SNMP_ALLOWED_CIDRS ranges.');
  }
}

/** Clamp a numeric config value into a safe range, falling back to a default. */
export function clampInt(v: any, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * Normalise monitoredPorts to a JSON string array (or null = monitor all).
 * Accepts an array or a comma/space separated string from the form.
 */
export function normalizeMonitoredPorts(v: string | string[] | null | undefined): string | null {
  if (v == null) return null;
  let arr: string[];
  if (Array.isArray(v)) arr = v;
  else {
    const s = String(v).trim();
    if (!s) return null;
    try { const p = JSON.parse(s); arr = Array.isArray(p) ? p : String(s).split(/[,\s]+/); }
    catch { arr = s.split(/[,\s]+/); }
  }
  const clean = arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 256);
  return clean.length ? JSON.stringify(clean) : null;
}

/**
 * Validate the RESULTING SNMP configuration (existing row merged with the
 * pending update). Enforces that an SNMPv3 security level has the credentials it
 * requires — never a silent downgrade to a weaker level or to v2c.
 */
export function assertSnmpConfigValid(existing: any, update: Record<string, any>): void {
  const pick = (k: string) => (k in update ? update[k] : existing?.[k]);
  const version = pick('snmpVersion');
  if (version !== 'V3') return; // v1/v2c community is validated by masking only

  const user = (pick('snmpV3User') || '').toString().trim();
  if (!user) throw new BadRequestException('SNMPv3 requires a username.');

  const level = (pick('snmpV3SecLevel') || '').toString().trim();
  if (!['noAuthNoPriv', 'authNoPriv', 'authPriv'].includes(level)) {
    throw new BadRequestException('Choose an SNMPv3 security level (authPriv is recommended).');
  }
  const authPresent = 'snmpV3AuthPass' in update ? !!update.snmpV3AuthPass : !!existing?.snmpV3AuthPass;
  const privPresent = 'snmpV3PrivPass' in update ? !!update.snmpV3PrivPass : !!existing?.snmpV3PrivPass;
  const authProto = (pick('snmpV3AuthProto') || '').toString().toUpperCase();
  const privProto = (pick('snmpV3PrivProto') || '').toString().toUpperCase();

  if (level === 'authNoPriv' || level === 'authPriv') {
    if (!['MD5', 'SHA'].includes(authProto)) throw new BadRequestException('Select an SNMPv3 authentication protocol (SHA recommended).');
    if (!authPresent) throw new BadRequestException('SNMPv3 authentication requires an authentication passphrase.');
  }
  if (level === 'authPriv') {
    if (!['DES', 'AES'].includes(privProto)) throw new BadRequestException('Select an SNMPv3 privacy protocol (AES recommended).');
    if (!privPresent) throw new BadRequestException('SNMPv3 authPriv requires a privacy passphrase.');
  }
}
