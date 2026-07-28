import { ConflictException } from '@nestjs/common';
import { SubscribersService } from './subscribers.service';

describe('SubscribersService.activateRenewal', () => {
  let service: SubscribersService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      subscriber: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      package: { findUnique: jest.fn() },
      serviceSettings: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
      payment: { create: jest.fn() },
      invoice: { create: jest.fn() },
      activityLog: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
      },
      userBalanceTransaction: { findFirst: jest.fn() },
      $transaction: jest.fn(),
    };

    service = new SubscribersService(
      prisma,
      { syncSubscriberProfile: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('blocks a second activation when the subscriber is already active', async () => {
    prisma.subscriber.findUnique.mockResolvedValue({
      id: 42,
      status: 'ACTIVE',
      username: 'demo',
      fullName: 'Demo User',
    });

    await expect(service.activateRenewal({ subscriberId: 42, packageId: 1, actorId: 7 })).rejects.toThrow(ConflictException);
  });
});
