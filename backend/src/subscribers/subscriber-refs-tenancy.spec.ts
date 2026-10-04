import * as fs from 'fs';
import * as path from 'path';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SubscribersService } from './subscribers.service';
import { ScopeService } from '../common/scope.service';

/**
 * A customer write may only point at the caller's OWN owner, salesperson,
 * package, area and router. Found on a running panel: company B could create a
 * customer on company A's package, or plant one under A's dealer — which then
 * appeared in A's lists and books.
 *
 *   company A: 10 (ADMIN) → 11 franchise → 12 dealer · package 5 · area 50
 *   company B: 20 (ADMIN) · package 6 · area 60
 */
const COMPANY: Record<number, number> = { 10: 10, 11: 10, 12: 10, 20: 20 };
const TREE: Record<number, number[]> = { 10: [10, 11, 12], 11: [11, 12], 12: [12], 20: [20] };
const PKG_OWNER: Record<number, number> = { 5: 10, 6: 20 };
const AREA_OWNER: Record<number, number> = { 50: 10, 60: 20 };

function make() {
  const prisma: any = {
    area: { findUnique: jest.fn(async ({ where }: any) => (AREA_OWNER[where.id] ? { ownerId: AREA_OWNER[where.id] } : null)) },
    nas: { findFirst: jest.fn(async () => ({ id: 1 })) },
  };
  const scope = new ScopeService(prisma);
  jest.spyOn(scope, 'rootId').mockImplementation(async (a: any) => Number(a.sub));
  jest.spyOn(scope, 'descendantIds').mockImplementation(async (id: number) => TREE[id] ?? [id]);
  jest.spyOn(scope, 'companyRootId').mockImplementation(async (id: number) => COMPANY[id] ?? null);
  jest.spyOn(scope, 'assertPackage').mockImplementation(async (a: any, id: number) => {
    if (COMPANY[PKG_OWNER[id]] !== COMPANY[Number(a.sub)]) throw new NotFoundException(`Package ${id} not found`);
  });
  const svc = new SubscribersService(
    prisma, {} as any, {} as any, {} as any, {} as any, {} as any, scope, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any,
    { assertCanAddNas: async () => undefined, assertCanAddSubscriber: async () => undefined } as any,
  );
  return { svc };
}

const A = { sub: 10, role: 'ADMIN' } as any;
const B = { sub: 20, role: 'ADMIN' } as any;
const A_DEALER = { sub: 12, role: 'SUB_RESELLER' } as any;

describe('customer writes stay inside the company', () => {
  it("another company cannot point at A's dealer, package or area", async () => {
    const { svc } = make();
    await expect(svc.assertRefsInScope(B, { userId: 12 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.assertRefsInScope(B, { salespersonId: 11 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.assertRefsInScope(B, { packageId: 5 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.assertRefsInScope(B, { areaId: 50 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the company uses its own; a dealer may use its upline\x27s area', async () => {
    const { svc } = make();
    await expect(svc.assertRefsInScope(A, { userId: 12, salespersonId: 11, packageId: 5, areaId: 50 })).resolves.toBeUndefined();
    await expect(svc.assertRefsInScope(A_DEALER, { areaId: 50 })).resolves.toBeUndefined();
    await expect(svc.assertRefsInScope(A_DEALER, { userId: 11 })).rejects.toBeInstanceOf(ForbiddenException); // its own parent
  });

  it('create, edit, import and activation all run the checks', () => {
    const src = fs.readFileSync(path.join(__dirname, 'subscribers.service.ts'), 'utf8');
    expect(src).toMatch(/await this\.assertRefsInScope\(actor, data\);\s*\/\*\*\s*\*\s*WHO OWNS THIS CUSTOMER/);
    expect(src).toMatch(/await this\.assertRefsInScope\(actor, \{ \.\.\.data, userId: undefined \}\)/);
    expect(src).toMatch(/username\(s\) are already in use on this server/);
    const ctl = fs.readFileSync(path.join(__dirname, 'subscribers.controller.ts'), 'utf8');
    expect(ctl).toMatch(/activateRenewal[\s\S]{0,400}assertSubscriber\(req\.user, Number\(body\?\.subscriberId\)\)/);
  });
});
