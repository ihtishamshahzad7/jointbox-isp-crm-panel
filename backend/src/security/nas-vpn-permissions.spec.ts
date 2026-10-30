import { permissionForRoute } from './route-permissions';

describe('NAS VPN route permissions', () => {
  it('gates neighbor discovery as an authorized telemetry action', () => {
    expect(
      permissionForRoute('POST', '/nas/42/vpn/discover-neighbors'),
    ).toBe('telemetry.write');
  });
});
