import { newPaymentNo } from './payment-number';

/** paymentNo is UNIQUE; `PAY-${Date.now()}` collided for two payments in one millisecond. */
describe('payment numbers', () => {
  it('stay unique when thousands are minted in the same millisecond', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000);
    const seen = new Set(Array.from({ length: 5000 }, () => newPaymentNo()));
    now.mockRestore();
    expect(seen.size).toBe(5000);
  });

  it('keep the PAY- prefix existing reports search for', () => {
    expect(newPaymentNo()).toMatch(/^PAY-\d{13}-[0-9A-F]{12}$/);
  });
});
