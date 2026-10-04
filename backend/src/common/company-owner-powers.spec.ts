import * as fs from 'fs';
import * as path from 'path';
import { ScopeService } from './scope.service';

/**
 * The platform account runs no business, so "the ISP owner may…" powers must
 * belong to the ISP COMPANY's own account (ADMIN). Gated on isAdmin() they
 * were usable by nobody: a company could not add a router, top up its
 * franchise, read its own ledger, run its billing or delete its own customer.
 * Visibility (seeing across companies) stays isAdmin() = platform only.
 */
const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('company owner powers', () => {
  const s = new ScopeService({} as any);

  it('isOwner = the company account or the platform; isAdmin = the platform only', () => {
    expect(s.isOwner('ADMIN')).toBe(true);
    expect(s.isOwner('SUPER_ADMIN')).toBe(true);
    for (const r of ['RESELLER', 'SUB_RESELLER', 'RETAILER', 'SALES', 'AUDITOR', undefined]) expect(s.isOwner(r)).toBe(false);
    expect(s.isAdmin('ADMIN')).toBe(false);
  });

  it.each([
    ['nas/nas.service.ts', /if \(!actor \|\| this\.scope\.isOwner\(actor\.role\)\) return; \/\/ the ISP company/],
    ['accounting/accounting.service.ts', /!this\.scope\.isOwner\(actor\.role\) && actor\.role !== 'AUDITOR'/],
    ['organization/organization.service.ts', /funderIsSource = !funder \|\| this\.scope\.isOwner\(funder\.role\)/],
    ['organization/organization.service.ts', /const isSource = this\.scope\.isOwner\(actor\?\.role\)/],
    ['billing/billing.controller.ts', /isOwner\(actor\?\.role\)/],
    ['setup/setup.service.ts', /const isIsp = this\.scope\.isOwner\(actor\?\.role\)/],
    ['ip-pool/prefix-allocation.service.ts', /!this\.scope\.isOwner\(actor\.role\)/],
  ])('%s gives the company its owner power', (file, re) => {
    expect(read(file)).toMatch(re);
  });

  it('a company runs billing for its own customers only', () => {
    const svc = read('billing/billing.service.ts');
    expect(svc).toMatch(/\.\.\.owners,\s*status: 'ACTIVE',\s*packageId/);
    expect(svc).toMatch(/billingRun\.create\(\{ data: \{ type: 'SUSPENSION', dryRun, companyId \} \}\)/);
  });
});
