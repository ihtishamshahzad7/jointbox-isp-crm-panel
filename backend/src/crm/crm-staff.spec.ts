import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CrmStaffService } from './crm-staff.service';

const OWNER = { sub: 10, role: 'ADMIN' } as any;
const STAFF = { sub: 12, role: 'SALES' } as any;

/** company 10 → people 11 (Asma), 12 (Bilal), 13 (Hina); profiles: 12 reports to 11. */
function make(o: { profiles?: Record<number, any>; counter?: number } = {}) {
  const profiles: Record<number, any> = o.profiles ?? { 12: { userId: 12, companyId: 10, reportsToUserId: 11, employeeCode: 'EMP-000001' } };
  const sql: string[] = [];
  const tx: any = {
    $executeRaw: jest.fn(async (strings: string[]) => { sql.push(strings.join('?')); return 1; }),
    $queryRaw: jest.fn(async () => [{ next: o.counter ?? 7 }]),
    crmDesignation: { findFirst: jest.fn(async ({ where }: any) => (where.id === 3 ? { id: 3, isActive: true } : where.id === 4 ? { id: 4, isActive: false } : null)) },
    crmEmployeeProfile: {
      findUnique: jest.fn(async ({ where }: any) => profiles[where.userId] ?? null),
      update: jest.fn(async ({ where, data }: any) => ({ ...profiles[where.userId], ...data })),
      create: jest.fn(async ({ data }: any) => data),
    },
  };
  const prisma: any = {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    user: { findMany: jest.fn(async () => [{ id: 11, name: 'Asma', role: 'SALES', isActive: true }, { id: 12, name: 'Bilal', role: 'SALES', isActive: true }, { id: 13, name: 'Hina', role: 'AUDITOR', isActive: true }]) },
    crmEmployeeProfile: { findMany: jest.fn(async () => Object.values(profiles)), findUnique: jest.fn(async ({ where }: any) => profiles[where.userId] ?? null) },
    crmDesignation: { findMany: jest.fn(async () => []) },
  };
  const scope: any = {
    actorId: (a: any) => a.sub,
    companyRootId: async () => 10,
    descendantIds: async () => [10, 11, 12, 13],
    isOwner: (r?: string) => r === 'ADMIN',
  };
  const perms: any = { canActivate: jest.fn(async () => true) };
  return { svc: new CrmStaffService(prisma, scope, perms), tx, sql };
}

describe('staff records', () => {
  it('first save issues the next employee code for the company, inside the locked transaction', async () => {
    const t = make({ counter: 7 });
    const r: any = await t.svc.save(OWNER, 13, { department: 'NOC', availability: 'ON_DUTY' });
    expect(t.sql[0]).toMatch(/pg_advisory_xact_lock/);
    expect(r).toMatchObject({ userId: 13, companyId: 10, employeeCode: 'EMP-000007', department: 'NOC', availability: 'ON_DUTY' });
  });
  it('an existing record keeps its code', async () => {
    const t = make();
    await t.svc.save(OWNER, 12, { department: 'Field' });
    expect(t.tx.$queryRaw).not.toHaveBeenCalled();
    expect(t.tx.crmEmployeeProfile.update.mock.calls[0][0].data).not.toHaveProperty('employeeCode');
  });
  it('refuses a reporting loop (11 → 12 when 12 already reports to 11) and self-reporting', async () => {
    const t = make();
    await expect(t.svc.save(OWNER, 11, { reportsToUserId: 12 })).rejects.toThrow('reporting loop');
    await expect(t.svc.save(OWNER, 11, { reportsToUserId: 11 })).rejects.toThrow('themselves');
    await t.svc.save(OWNER, 13, { reportsToUserId: 12 }); // 13 → 12 → 11 is fine
  });
  it('managers and people must be in the company; titles must be active to be newly given', async () => {
    const t = make();
    await expect(t.svc.save(OWNER, 99, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.svc.save(OWNER, 13, { reportsToUserId: 99 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(t.svc.save(OWNER, 13, { designationId: 4 })).rejects.toThrow('active designation');
    await expect(t.svc.save(OWNER, 13, { availability: 'SICK' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('only the company owner edits; roles/permissions are never written', async () => {
    const t = make();
    await expect(t.svc.save(STAFF, 13, { department: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await t.svc.save(OWNER, 13, { role: 'ADMIN', department: 'x' } as any);
    expect(t.tx.crmEmployeeProfile.create.mock.calls[0][0].data).not.toHaveProperty('role');
  });
  it('tree nests people under their manager', async () => {
    const roots: any[] = await make().svc.tree(OWNER);
    const asma = roots.find((r) => r.userId === 11);
    expect(asma.reports.map((r: any) => r.userId)).toEqual([12]);
    expect(roots.map((r) => r.userId).sort()).toEqual([11, 13]);
  });
});
