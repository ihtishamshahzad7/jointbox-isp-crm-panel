import * as fs from 'fs';
import * as path from 'path';
import { ForbiddenException } from '@nestjs/common';
import { ServiceSettingsService } from './service-settings.service';

/**
 * Found on a running panel: the subscriber screen saves ONE toggle
 * ({ allowMultipleSessions }) through upsert, and every field it did not send
 * was written as null/0/false — the customer's expiry date and duration were
 * wiped, and the toggle itself was never stored. The same route let a dealer
 * set expiry to 2035 without paying.
 */
function make() {
  const prisma: any = {
    serviceSettings: {
      findUnique: jest.fn(async () => ({ id: 1, subscriberId: 3 })),
      update: jest.fn(async ({ data }: any) => data),
      create: jest.fn(async ({ data }: any) => data),
    },
  };
  const subs: any = { syncToRadius: jest.fn(async () => undefined) };
  return { prisma, svc: new ServiceSettingsService(prisma, subs) };
}

describe('service settings writes', () => {
  it('saves only what was sent', async () => {
    const { svc, prisma } = make();
    await svc.upsert(3, { allowMultipleSessions: true }, { role: 'RESELLER' });
    expect(prisma.serviceSettings.update.mock.calls[0][0].data).toEqual({ allowMultipleSessions: true });
  });

  it('expiry, term, price and addressing are for the company account only', async () => {
    const { svc, prisma } = make();
    for (const body of [{ expiryDate: '2035-01-01' }, { duration: 3650 }, { customPrice: 1 }, { ipAddress: '1.2.3.4' }, { quotaUsed: 0 }]) {
      await expect(svc.upsert(3, body, { role: 'SUB_RESELLER' })).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(prisma.serviceSettings.update).not.toHaveBeenCalled();
    await svc.upsert(3, { expiryDate: '2027-01-01' }, { role: 'ADMIN' });
    expect(prisma.serviceSettings.update.mock.calls[0][0].data.expiryDate).toBeInstanceOf(Date);
  });

  it('the fibre screen and bulk edit follow the same rules', () => {
    const fiber = fs.readFileSync(path.join(__dirname, '..', 'fiber', 'fiber.service.ts'), 'utf8');
    expect(fiber).toMatch(/create: \{ subscriberId, \.\.\.clean \}/);
    const subs = fs.readFileSync(path.join(__dirname, '..', 'subscribers', 'subscribers.service.ts'), 'utf8');
    expect(subs).toMatch(/isBlocked: payload\.profileStatus \? payload\.profileStatus === 'SUSPENDED' : undefined/);
    expect(subs).toMatch(/Package, expiry, data and discounts change through Activate\/Renew/);
  });
});
