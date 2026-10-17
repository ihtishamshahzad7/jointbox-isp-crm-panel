import { maskRecipient } from './notifications.service';

/** Simulated-delivery logs used to print the full number and message body — welcome SMS carry PPPoE passwords. */
describe('notification logs do not leak recipients or bodies', () => {
  it('masks phone numbers and emails', () => {
    expect(maskRecipient('+923001234567')).toBe('+92•••••4567');
    expect(maskRecipient('ali.khan@example.pk')).toBe('a•••@example.pk');
    expect(maskRecipient('123')).toBe('••••');
    expect(maskRecipient('')).toBe('••••');
  });
});
