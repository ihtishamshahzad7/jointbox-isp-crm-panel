import { ForbiddenException } from '@nestjs/common';
import { PaymentGatewaysService } from './payment-gateways.service';
import { PaymentGatewaysController } from './payment-gateways.controller';
import { ScopeService } from '../common/scope.service';

/**
 * Tenancy of payment gateways.
 *
 * A PaymentGateway row has no owner: it (and its provider secretConfig)
 * collects money for every company on the installation, and its transaction
 * log spans all of them. The admin surface is therefore platform-owner only.
 * The portal surface stays public by design.
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const COMPANY_A = { sub: 10, role: 'ADMIN' };

function makePrisma() {
  return {
    paymentGateway: {
      findMany: jest.fn().mockResolvedValue([{ id: 1, publicConfig: {} }]),
      findUnique: jest.fn().mockResolvedValue({ id: 1, isActive: true, secretConfig: { apiKey: 'sk_live' } }),
      create: jest.fn().mockResolvedValue({ id: 2 }),
      update: jest.fn().mockResolvedValue({ id: 1 }),
      delete: jest.fn().mockResolvedValue({ id: 1 }),
    },
    paymentTransaction: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  } as any;
}

function make() {
  const prisma = makePrisma();
  const svc = new PaymentGatewaysService(prisma, {} as any, new ScopeService({} as any));
  return { prisma, svc, ctl: new PaymentGatewaysController(svc) };
}

describe('payment gateways: admin surface is platform-owner only', () => {
  const routes: Array<[string, (c: PaymentGatewaysController, r: any) => any]> = [
    ['GET admin', (c, r) => c.adminList({}, r)],
    ['GET admin/:id', (c, r) => c.adminGet('1', r)],
    ['PATCH admin/:id/toggle', (c, r) => c.adminToggle('1', r)],
    ['GET admin/:id/transactions', (c, r) => c.adminTransactions('1', {}, r)],
    ['POST admin', (c, r) => c.adminCreate({ name: 'x', provider: 'STRIPE' }, r)],
    ['PUT admin/:id', (c, r) => c.adminUpdate('1', { secretConfig: { apiKey: 'attacker' } }, r)],
    ['DELETE admin/:id', (c, r) => c.adminRemove('1', r)],
  ];

  it.each(routes)('refuses a company ADMIN: %s', async (_name, call) => {
    const { prisma, ctl } = make();
    await expect(call(ctl, { user: COMPANY_A })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.paymentGateway.findMany).not.toHaveBeenCalled();
    expect(prisma.paymentGateway.findUnique).not.toHaveBeenCalled();
    expect(prisma.paymentGateway.create).not.toHaveBeenCalled();
    expect(prisma.paymentGateway.update).not.toHaveBeenCalled();
    expect(prisma.paymentGateway.delete).not.toHaveBeenCalled();
    expect(prisma.paymentTransaction.findMany).not.toHaveBeenCalled();
  });

  it.each(routes)('lets the platform owner through: %s', async (_name, call) => {
    const { ctl } = make();
    await expect(call(ctl, { user: OWNER })).resolves.toBeDefined();
  });

  it('gives the platform owner the unfiltered gateway list', async () => {
    const { prisma, ctl } = make();
    await ctl.adminList({}, { user: OWNER });
    expect(prisma.paymentGateway.findMany.mock.calls[0][0].where).toEqual({});
  });

  it('leaves the public portal list public', async () => {
    const { prisma, ctl } = make();
    await expect(ctl.publicList()).resolves.toEqual([{ id: 1, publicConfig: {} }]);
    expect(prisma.paymentGateway.findMany.mock.calls[0][0].select).not.toHaveProperty('secretConfig');
  });
});
