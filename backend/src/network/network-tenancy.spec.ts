import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NetworkController } from './network.controller';
import { ScopeService } from '../common/scope.service';

/**
 * NETWORK TENANCY — POST /network/duplicate-sessions/sweep and
 * GET /network/nas/:id/test-coa.
 *
 *   • The sweep cuts EVERY company's duplicate logins and returns their
 *     usernames: platform owner only (it also runs on its own every 2 min).
 *   • test-coa signs a packet with the router's shared secret and fires it from
 *     this server, so the caller must be able to see that router (404 if not).
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ISP_A = { sub: 10, role: 'ADMIN' }; // owns NAS 100
const ISP_B = { sub: 20, role: 'ADMIN' };

function make() {
  const real = new ScopeService({} as any);
  const scope: any = {
    isAdmin: (r?: string) => r === 'SUPER_ADMIN',
    isPlatformOwner: (a: any) => real.isPlatformOwner(a),
    assertPlatformOwner: (a: any) => real.assertPlatformOwner(a),
    assertNas: jest.fn(async (a: any, id: number) => {
      if (a?.role === 'SUPER_ADMIN') return;
      if (!(id === 100 && a?.sub === 10)) throw new NotFoundException(`NAS ${id} not found`);
    }),
  };
  const coa: any = {
    disconnectDuplicateSessions: jest.fn().mockResolvedValue({ offenders: 1, sessionsCut: 2, users: ['x'] }),
    testCoa: jest.fn().mockResolvedValue({ reachable: true, message: 'ok' }),
  };
  const network: any = { liveSessions: jest.fn().mockResolvedValue([]) };
  const ctl = new NetworkController(network, coa, scope, {} as any);
  return { ctl, coa, network, scope };
}

describe('Network tenancy', () => {
  it('a company admin cannot run the installation-wide duplicate sweep', async () => {
    const { ctl, coa } = make();
    await expect(ctl.sweepDuplicates({ user: ISP_A })).rejects.toThrow(ForbiddenException);
    expect(coa.disconnectDuplicateSessions).not.toHaveBeenCalled();
  });

  it('the platform owner can', async () => {
    const { ctl, coa } = make();
    await expect(ctl.sweepDuplicates({ user: OWNER })).resolves.toMatchObject({ offenders: 1 });
    expect(coa.disconnectDuplicateSessions).toHaveBeenCalled();
  });

  it('test-coa on another company\'s router is NotFound and sends nothing', async () => {
    const { ctl, coa } = make();
    await expect(ctl.testCoa('100', { user: ISP_B })).rejects.toThrow(NotFoundException);
    expect(coa.testCoa).not.toHaveBeenCalled();
  });

  it('test-coa passes for the owning company and the platform owner', async () => {
    const { ctl, coa, scope } = make();
    await expect(ctl.testCoa('100', { user: ISP_A })).resolves.toMatchObject({ reachable: true });
    await expect(ctl.testCoa('100', { user: OWNER })).resolves.toMatchObject({ reachable: true });
    expect(scope.assertNas).toHaveBeenCalledWith(ISP_A, 100);
    expect(coa.testCoa).toHaveBeenCalledTimes(2);
  });

  it('the live list hands the caller to the scoped service', async () => {
    const { ctl, network } = make();
    await ctl.live({ nasIp: '10.0.0.1' }, { user: ISP_A });
    expect(network.liveSessions).toHaveBeenCalledWith('10.0.0.1', ISP_A, { nasIp: '10.0.0.1' });
  });
});
