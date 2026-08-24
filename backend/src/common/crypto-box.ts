import * as crypto from 'crypto';

/**
 * AES-256-GCM helpers, extracted from SecretsService so that plain modules
 * (which cannot receive a Nest injectable) can decrypt stored credentials.
 *
 * The key derivation and the payload format are IDENTICAL to what
 * SecretsService has always used — `iv:tag:ciphertext`, each base64, key =
 * sha256(SECRETS_KEY || JWT_SECRET || fallback). That is not a coincidence to
 * preserve casually: every already-encrypted SNMP community and app secret in
 * the database was written with this exact scheme, and changing any part of it
 * makes those rows undecryptable.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  const material =
    process.env.SECRETS_KEY || process.env.JWT_SECRET || 'jointbox-fallback-key';
  return crypto.createHash('sha256').update(material).digest(); // 32 bytes
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload: string): string | null {
  try {
    const [ivB, tagB, dataB] = payload.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // wrong key, tampered value, or simply not an encrypted payload
  }
}

/**
 * Does this value have the *shape* of one of our payloads?
 *
 * Checked before attempting decryption so that a real password which merely
 * contains colons is never mistaken for ciphertext. The IV and tag lengths are
 * fixed by the algorithm, so they are a strong discriminator: a human-chosen
 * password is vanishingly unlikely to decode to exactly 12 and 16 bytes.
 */
export function looksEncrypted(v: string): boolean {
  const parts = v.split(':');
  if (parts.length !== 3) return false;
  try {
    return (
      Buffer.from(parts[0], 'base64').length === IV_BYTES &&
      Buffer.from(parts[1], 'base64').length === TAG_BYTES &&
      parts[2].length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Decrypt if it is ciphertext, otherwise hand back what you gave us.
 *
 * This is what makes encryption deployable without a migration window: rows
 * written before encryption was switched on are plaintext, and they keep
 * working untouched while new writes are encrypted. Nothing breaks on the
 * deploy, and the database converges as routers are edited (or when the
 * backfill script is run).
 */
export function maybeDecrypt(v: string | null | undefined): string {
  if (!v) return '';
  if (!looksEncrypted(v)) return v;
  const out = decryptSecret(v);
  return out ?? v;
}
