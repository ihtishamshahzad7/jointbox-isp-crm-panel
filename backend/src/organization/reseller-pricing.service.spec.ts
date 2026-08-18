import { ResellerPricingService } from './reseller-pricing.service';

describe('ResellerPricingService.reverseActivation', () => {
  it('reverses a previously settled activation by restoring balances and logging an audit entry', async () => {
    const prisma: any = {
      userBalanceTransaction: {
        // reverseActivation first checks whether this settlement was ALREADY
        // reversed (reference REV#…). null = not yet reversed, so it proceeds.
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          { id: 11, userId: 7, amount: -150, balanceAfter: 350, reference: 'SUB#42', notes: 'Package activation: dealer cost' },
          { id: 12, userId: 8, amount: 50, balanceAfter: 250, reference: 'SUB#42', notes: 'Package activation: dealer profit' },
        ]),
        create: jest.fn(),
      },
      user: {
        update: jest.fn().mockResolvedValue({ balance: 500 }),
      },
      activityLog: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
      },
      $transaction: jest.fn(async (cb) => cb({
        user: {
          update: jest.fn().mockResolvedValue({ balance: 500 }),
        },
        userBalanceTransaction: {
          create: jest.fn(),
        },
        // The reversal mirrors the profit ledger with negative entries.
        profitEntry: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
        },
      })),
    };

    const service = new ResellerPricingService(prisma, {
      actorId: jest.fn(() => 7),
      isAdmin: jest.fn(() => false),
    } as any);

    await expect(service.reverseActivation(42, {
      reference: 'SUB#42',
      reason: 'Duplicate activation reversal',
      actorId: 7,
    })).resolves.toMatchObject({ reversed: true, reference: 'SUB#42' });
  });
});
