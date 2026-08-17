import { SecretsService } from '../common/secrets.service';

/**
 * NAS credential handling — one place, so encryption and masking can never
 * drift between the poller, the API and the UI.
 *
 * WHAT IS ENCRYPTED, AND WHAT DELIBERATELY IS NOT
 *
 *   • snmpCommunity, snmpV3AuthPass, snmpV3PrivPass  → encrypted at rest.
 *     Only our own pollers read them, so encryption is contained and safe.
 *
 *   • RADIUS `secret`  → NOT encrypted, on purpose. FreeRADIUS is configured
 *     with `read_clients = yes` and reads this column straight out of the
 *     database to authenticate every router. Encrypting it would silently break
 *     RADIUS for the whole network. It is still MASKED in API responses so it
 *     never reaches the browser.
 *
 *   • apiPassword  → not yet encrypted: ten services read it (CoA, sync, IP
 *     pools, static IP, integrity checks…). It is masked in responses now, and
 *     encryption is a separate, deliberate step rather than a risky drive-by.
 *
 * Values already stored in plaintext keep working: decrypt() returns the input
 * unchanged when it is not an encrypted payload, so no data migration is needed.
 */

/** Fields that must never be returned to the browser in plaintext. */
export const SECRET_FIELDS = [
  'secret', 'apiPassword', 'snmpCommunity', 'snmpV3AuthPass', 'snmpV3PrivPass',
] as const;

const MASK = '••••••••';

/** Encrypt a credential for storage (no-op for empty values). */
export function encField(secrets: SecretsService, v?: string | null): string | null | undefined {
  if (v === undefined) return undefined;      // "not supplied" → leave column alone
  if (v === null || v === '') return v;
  return secrets.encryptValue(v);
}

/** Decrypt a stored credential; plaintext legacy values pass straight through. */
export function decField(secrets: SecretsService, v?: string | null): string {
  if (!v) return '';
  const out = secrets.decryptValue(v);
  return out ?? v;
}

/**
 * Strip credentials from anything sent to the browser. Returns a `hasX` flag per
 * field so the UI can show "configured / not set" and a Change button without
 * ever receiving the value.
 */
export function sanitizeNas<T extends Record<string, any>>(nas: T): T {
  if (!nas || typeof nas !== 'object') return nas;
  const out: any = { ...nas };
  for (const f of SECRET_FIELDS) {
    if (f in out) {
      const had = !!out[f];
      out[f] = had ? MASK : '';
      out[`has${f.charAt(0).toUpperCase()}${f.slice(1)}`] = had;
    }
  }
  return out as T;
}

export function sanitizeNasList<T extends Record<string, any>>(rows: T[]): T[] {
  return Array.isArray(rows) ? rows.map((r) => sanitizeNas(r)) : rows;
}

/**
 * A value coming from the UI that equals the mask means "unchanged" — the form
 * round-trips what we sent it, and saving must not overwrite the real secret
 * with bullet characters.
 */
export function isMask(v: any): boolean {
  return typeof v === 'string' && (v === MASK || /^[•*]{4,}$/.test(v.trim()));
}
