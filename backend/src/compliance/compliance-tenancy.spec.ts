import { ComplianceController } from './compliance.controller';
import { KycService } from './kyc.service';

/**
 * COMPLIANCE TENANCY — GET /compliance/kyc/validate/:cnic.
 *
 * Deliberately tenant-free: it is a pure format check. This pins that it
 * never touches the database or the scope service, so it cannot reveal
 * whether a CNIC exists in another company's subscriber base.
 */
const untouchable = (name: string) =>
  new Proxy({}, { get: (_t, prop) => { throw new Error(`${name}.${String(prop)} must not be used`); } });

const ISP_A = { sub: 10, role: 'ADMIN' };

describe('Compliance tenancy', () => {
  const kyc = new KycService(untouchable('prisma') as any, untouchable('scope') as any);
  const ctl = new ComplianceController(kyc, untouchable('fup') as any);

  it('validate/:cnic is a pure format check (no DB, no scope)', () => {
    expect(ctl.validateCnic('35201-1234567-1', { user: ISP_A })).toEqual({
      valid: true, formatted: '35201-1234567-1',
    });
    expect(ctl.validateCnic('123', { user: ISP_A })).toMatchObject({ valid: false });
  });
});
