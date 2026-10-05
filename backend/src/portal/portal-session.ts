import { createHash } from 'crypto';

/**
 * A portal session is tied to the password it was opened with: the token
 * carries a short fingerprint of it (`pv`), and the guard compares it with
 * the current password on every request. Changing the password — by the
 * customer or by staff — ends every older portal session. (Before, a 30-day
 * portal token stayed valid after the password was changed.)
 *
 * The fingerprint is a truncated SHA-256 salted with the JWT secret, so the
 * token never carries anything that helps recover the password.
 */
export function portalPasswordVersion(password: string | null | undefined): string {
  const salt = process.env.JWT_SECRET || 'portal';
  return createHash('sha256').update(`${salt}:${password ?? ''}`).digest('hex').slice(0, 16);
}
