import { permissionForRoute } from './route-permissions';

describe('HR leave route permissions', () => {
  it('maps self-service and approval routes to separate grants', () => {
    expect(permissionForRoute('GET', '/hr/leave/access')).toBe('hr.leave.read');
    expect(permissionForRoute('GET', '/hr/leave/requests/mine')).toBe(
      'hr.leave.read',
    );
    expect(permissionForRoute('POST', '/hr/leave/requests')).toBe(
      'hr.leave.write',
    );
    expect(permissionForRoute('POST', '/hr/leave/requests/31/approve')).toBe(
      'hr.leave.approve',
    );
    expect(permissionForRoute('POST', '/hr/leave/requests/31/reject')).toBe(
      'hr.leave.approve',
    );
    expect(permissionForRoute('PATCH', '/hr/leave/requests/31/cancel')).toBe(
      'hr.leave.write',
    );
  });

  it('protects leave policy and balance administration separately', () => {
    expect(permissionForRoute('GET', '/hr/leave/types')).toBe('hr.leave.read');
    expect(permissionForRoute('POST', '/hr/leave/types')).toBe(
      'hr.leave.manage_types',
    );
    expect(permissionForRoute('PATCH', '/hr/leave/types/4')).toBe(
      'hr.leave.manage_types',
    );
    expect(permissionForRoute('GET', '/hr/leave/balances')).toBe(
      'hr.leave.read',
    );
    expect(permissionForRoute('POST', '/hr/leave/balances/allocate')).toBe(
      'hr.leave.manage_balances',
    );
    expect(permissionForRoute('PATCH', '/hr/leave/balances/7/adjust')).toBe(
      'hr.leave.manage_balances',
    );
  });
});
