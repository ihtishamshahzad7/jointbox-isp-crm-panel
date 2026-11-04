import { permissionForRoute } from './route-permissions';

describe('HR attendance route permissions', () => {
  it('uses the specific read, self-service write, and correction grants', () => {
    expect(permissionForRoute('GET', '/hr/attendance')).toBe(
      'hr.attendance.read',
    );
    expect(permissionForRoute('GET', '/hr/attendance/employees/12')).toBe(
      'hr.attendance.read',
    );
    expect(permissionForRoute('GET', '/hr/attendance/45/history')).toBe(
      'hr.attendance.read',
    );
    expect(
      permissionForRoute('POST', '/hr/attendance/employees/12/check-in'),
    ).toBe('hr.attendance.write');
    expect(
      permissionForRoute('POST', '/hr/attendance/employees/12/check-out'),
    ).toBe('hr.attendance.write');
    expect(permissionForRoute('PATCH', '/hr/attendance/45/correction')).toBe(
      'hr.attendance.correct',
    );
  });
});
