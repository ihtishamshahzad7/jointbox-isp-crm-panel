import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PlatformPlansService } from './platform-plans.service';

/**
 * Super Admin → per-company switch for the two separately sold products.
 */
const PLATFORM = { sub: 1, role: 'SUPER_ADMIN' } as never;
const COMPANY_ADMIN = { sub: 10, role: 'ADMIN' } as never;

function make(row: any = { features: ['billing', 'ai-assistant'], planId: 2 }) {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 10 ? { id: 10, name: 'Acme', role: 'ADMIN', parent: { role: 'SUPER_ADMIN' } } : where.id === 11 ? { id: 11, name: 'Dealer', role: 'DEALER', parent: { role: 'ADMIN' } } : null,
      ),
    },
    companyPlan: { findUnique: jest.fn(async () => row) },
    platformPlan: { findUnique: jest.fn(async () => ({ features: ['crm-advanced'] })) },
    $executeRaw: jest.fn(async () => 1),
    activityLog: { create: jest.fn(async () => ({})) },
  };
  return { prisma, svc: new PlatformPlansService(prisma) };
}

/** The SQL text and bound values of a tagged-template $executeRaw call. */
const sqlOf = (call: any[]) => ({ text: (call[0] as string[]).join('?'), values: call.slice(1) });

describe('company features (Super Admin)', () => {
  it('shows each gated feature: enabled for the company, and whether its plan includes it', async () => {
    const { svc } = make();
    const r = await svc.getCompanyFeatures(PLATFORM, 10);
    expect(r.features).toEqual([
      { key: 'ai-assistant', label: 'AI Assistant', enabled: true, fromPlan: false },
      { key: 'crm-advanced', label: 'Advanced CRM', enabled: false, fromPlan: true },
    ]);
  });

  it('only the platform account may read or change them', async () => {
    const { svc } = make();
    await expect(svc.getCompanyFeatures(COMPANY_ADMIN, 10)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setCompanyFeatures(COMPANY_ADMIN, 10, { 'ai-assistant': true })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('only for company accounts', async () => {
    const { svc } = make();
    await expect(svc.setCompanyFeatures(PLATFORM, 11, { 'ai-assistant': true })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects unknown or descriptive features and non-boolean values', async () => {
    const { svc, prisma } = make();
    await expect(svc.setCompanyFeatures(PLATFORM, 10, { billing: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setCompanyFeatures(PLATFORM, 10, { 'ai-assistant': 'yes' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setCompanyFeatures(PLATFORM, 10, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('changes the row in ONE atomic upsert (no read-modify-write), and audits it', async () => {
    const { svc, prisma } = make();
    await svc.setCompanyFeatures(PLATFORM, 10, { 'crm-advanced': true, 'ai-assistant': false });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const { text, values } = sqlOf(prisma.$executeRaw.mock.calls[0]);
    expect(text).toMatch(/INSERT INTO "company_plan"/);
    expect(text).toMatch(/ON CONFLICT \("companyId"\) DO UPDATE/);
    expect(text).toMatch(/unnest\("company_plan"\."features" \|\|/);
    expect(values).toEqual([10, ['crm-advanced'], 1, ['crm-advanced'], ['ai-assistant']]);
    expect(prisma.companyPlan.findUnique).toHaveBeenCalled(); // re-read for the response only
    expect(prisma.activityLog.create.mock.calls[0][0].data).toMatchObject({ action: 'COMPANY_FEATURES', entityId: 10 });
  });
});
