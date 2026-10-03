import { ForbiddenException } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { ScopeService } from '../common/scope.service';

/**
 * MONITORING TENANCY — POST /monitoring/diagnostics/*.
 *
 * Each diagnostic makes THIS SERVER send traffic (ICMP, TCP, DNS, HTTP) to a
 * target the caller names, and the outbound guard allows RFC1918 on purpose.
 * On a shared installation that reaches every company's LAN, so the tools are
 * the platform owner's alone. A company admin is refused before anything is
 * sent.
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ISP_A = { sub: 10, role: 'ADMIN' };

function make() {
  const real = new ScopeService({} as any);
  const scope: any = {
    isPlatformOwner: (a: any) => real.isPlatformOwner(a),
    assertPlatformOwner: (a: any) => real.assertPlatformOwner(a),
  };
  const diag: any = {
    ping: jest.fn().mockResolvedValue('ping'),
    traceroute: jest.fn().mockResolvedValue('trace'),
    tcpPort: jest.fn().mockResolvedValue('tcp'),
    tcpTrace: jest.fn().mockResolvedValue('tcptrace'),
    dnsLookup: jest.fn().mockResolvedValue('dns'),
    httpCheck: jest.fn().mockResolvedValue('http'),
  };
  const monitoring: any = { list: jest.fn().mockResolvedValue([]) };
  return { diag, monitoring, ctl: new MonitoringController(monitoring, diag, scope) };
}

const routes: Array<[string, string, any]> = [
  ['dPing', 'ping', { host: '192.168.1.1', count: 2 }],
  ['dTrace', 'traceroute', { host: '192.168.1.1' }],
  ['dTcp', 'tcpPort', { host: '192.168.1.1', port: 22 }],
  ['dTcpTrace', 'tcpTrace', { host: '192.168.1.1', port: 22 }],
  ['dDns', 'dnsLookup', { name: 'example.com' }],
  ['dHttp', 'httpCheck', { url: 'http://192.168.1.1/' }],
];

describe('Monitoring tenancy — server-side probes', () => {
  it.each(routes)('%s: a company admin is refused and nothing is sent', (route, method, body) => {
    const { ctl, diag } = make();
    expect(() => (ctl as any)[route](body, { user: ISP_A })).toThrow(ForbiddenException);
    expect(diag[method]).not.toHaveBeenCalled();
  });

  it.each(routes)('%s: the platform owner runs it', async (route, method, body) => {
    const { ctl, diag } = make();
    await expect((ctl as any)[route](body, { user: OWNER })).resolves.toBeDefined();
    expect(diag[method]).toHaveBeenCalledTimes(1);
  });

  it('the target list still hands the caller to the scoped service', async () => {
    const { ctl, monitoring } = make();
    await ctl.list({ user: ISP_A });
    expect(monitoring.list).toHaveBeenCalledWith(ISP_A);
  });
});
