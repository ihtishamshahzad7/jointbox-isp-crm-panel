import { randomBytes } from 'crypto';

/**
 * A payment number that cannot collide. `paymentNo` is UNIQUE, and the old
 * `PAY-${Date.now()}` made any two payments recorded in the same millisecond
 * (a gateway callback beside a cashier, a bulk renewal) fail with a unique
 * violation — the second customer's payment was lost with a 500.
 */
export function newPaymentNo(prefix = 'PAY'): string {
  return `${prefix}-${Date.now()}-${randomBytes(6).toString('hex').toUpperCase()}`;
}
