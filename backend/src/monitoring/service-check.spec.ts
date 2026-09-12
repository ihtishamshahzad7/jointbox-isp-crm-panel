import { BadRequestException } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';

/**
 * "SOMETIMES DEVICE UP BUT SERVICE DOWN."
 *
 * That sentence is the whole requirement. ICMP answers a question nobody is
 * paying for — is the box powered and routable — while the thing a customer
 * actually experiences is whether the service on it responds. A web server can
 * ping perfectly while its application returns 500, and a ping-only monitor
 * reports that outage as green.
 *
 * So a monitor now names its own check, and these tests pin the part that makes
 * it worth having: a reachable host serving errors must read as DOWN.
 */
describe('monitoring: service-level checks', () => {
  const make = (diag: any) =>
    new MonitoringService({} as any, {} as any, { broadcast: jest.fn() } as any, diag);

  const probe = (svc: any, t: any) => (svc as any).probe(t);

  // ── the requirement ──────────────────────────────────────────────────────
  it('THE POINT: a host that answers but serves 500 is DOWN', async () => {
    const diag = {
      httpCheck: jest.fn(async () => ({ status: 500, responseMs: 42 })),
      tcpPort: jest.fn(),
    };
    const r = await probe(make(diag), { host: 'panel.example', checkType: 'HTTPS', port: 443, path: '/' });
    expect(r.up).toBe(false);
    // The reason has to survive to the alert: "HTTP 500" and "connection
    // refused" send an engineer to entirely different places.
    expect(r.detail).toMatch(/500/);
    expect(diag.tcpPort).not.toHaveBeenCalled(); // a real request, not a handshake
  });

  it.each([
    [200, true], [204, true], [301, true], [302, true], [399, true],
    [400, false], [401, false], [404, false], [500, false], [502, false], [503, false],
  ])('HTTP %i → up=%s', async (status, up) => {
    const diag = { httpCheck: jest.fn(async () => ({ status, responseMs: 10 })), tcpPort: jest.fn() };
    expect((await probe(make(diag), { host: 'h', checkType: 'HTTP', port: 80 })).up).toBe(up);
  });

  it('a refused connection is down, not a crash', async () => {
    const diag = { httpCheck: jest.fn(async () => { throw new Error('ECONNREFUSED'); }), tcpPort: jest.fn() };
    const r = await probe(make(diag), { host: 'h', checkType: 'HTTPS', port: 443 });
    expect(r.up).toBe(false);
    expect(r.detail).toMatch(/ECONNREFUSED/);
  });

  it('builds the URL without a redundant :80 / :443', async () => {
    const diag = { httpCheck: jest.fn(async () => ({ status: 200 })), tcpPort: jest.fn() };
    const svc = make(diag);
    await probe(svc, { host: 'a.example', checkType: 'HTTPS', port: 443, path: '/' });
    await probe(svc, { host: 'b.example', checkType: 'HTTP', port: 8080, path: '/health' });
    expect(diag.httpCheck).toHaveBeenNthCalledWith(1, 'https://a.example/');
    expect(diag.httpCheck).toHaveBeenNthCalledWith(2, 'http://b.example:8080/health');
  });

  it('a path without a leading slash still produces a valid URL', async () => {
    const diag = { httpCheck: jest.fn(async () => ({ status: 200 })), tcpPort: jest.fn() };
    await probe(make(diag), { host: 'h', checkType: 'HTTP', port: 80, path: 'status' });
    expect(diag.httpCheck).toHaveBeenCalledWith('http://h/status');
  });

  // ── TCP: SSH / Telnet / anything ─────────────────────────────────────────
  it('TCP is up when the port accepts, down when it does not', async () => {
    const open = { tcpPort: jest.fn(async () => ({ open: true, latencyMs: 7 })), httpCheck: jest.fn() };
    const shut = { tcpPort: jest.fn(async () => ({ open: false, error: 'Connection refused' })), httpCheck: jest.fn() };
    expect((await probe(make(open), { host: 'h', checkType: 'TCP', port: 22 })).up).toBe(true);
    const d = await probe(make(shut), { host: 'h', checkType: 'TCP', port: 23 });
    expect(d.up).toBe(false);
    expect(d.detail).toMatch(/refused/i);
  });

  it('loss is the binary it really is, never invented', async () => {
    // Every consumer already reads 100 as "no answer"; inventing a percentage
    // for a TCP check would put a fake number on the uptime graph.
    const diag = { tcpPort: jest.fn(async () => ({ open: false, error: 'x' })), httpCheck: jest.fn() };
    expect((await probe(make(diag), { host: 'h', checkType: 'TCP', port: 22 })).loss).toBe(100);
  });

  // ── ICMP stays exactly as it was ─────────────────────────────────────────
  it('an existing monitor with no checkType still pings', async () => {
    const diag = { tcpPort: jest.fn(), httpCheck: jest.fn() };
    const svc = make(diag);
    (svc as any).ping = jest.fn(async () => ({ up: true, ms: 1.2, loss: 0 }));
    const r = await probe(svc, { host: '10.254.1.10' });
    expect(r).toEqual({ up: true, ms: 1.2, loss: 0 });
    expect(diag.tcpPort).not.toHaveBeenCalled();
    expect(diag.httpCheck).not.toHaveBeenCalled();
  });

  // ── validation ───────────────────────────────────────────────────────────
  /**
   * An unknown type must be refused, not quietly downgraded. An operator who
   * typed "SNMP" and got a ping monitor would believe a service was watched
   * when it was not, and would discover the truth during an outage.
   */
  it.each(['SNMP', 'https ', 'PING', ''])('rejects the unknown check type %p', (t) => {
    expect(() => (MonitoringService as any).parseCheck({ checkType: t })).toThrow(BadRequestException);
  });

  it('defaults the port per scheme, so the operator need not know them', () => {
    const p = (o: any) => (MonitoringService as any).parseCheck(o);
    expect(p({ checkType: 'HTTPS' })).toEqual({ checkType: 'HTTPS', port: 443, path: '/' });
    expect(p({ checkType: 'HTTP' })).toEqual({ checkType: 'HTTP', port: 80, path: '/' });
    expect(p({ checkType: 'TCP' })).toEqual({ checkType: 'TCP', port: 22, path: null });
    expect(p({ checkType: 'ICMP' })).toEqual({ checkType: 'ICMP', port: null, path: null });
  });

  it.each([0, 65536, -1, 1.5, 'ssh'])('rejects the invalid port %p', (port) => {
    expect(() => (MonitoringService as any).parseCheck({ checkType: 'TCP', port })).toThrow(BadRequestException);
  });

  /**
   * THE SILENT-REGRESSION GUARD.
   *
   * The poller selects explicit columns. If someone adds a field to the model
   * and forgets it here, `checkType` arrives undefined and EVERY service
   * monitor quietly degrades to a ping — still green, still checking the wrong
   * thing, with nothing in the logs. That is the failure this feature exists to
   * prevent, so it gets its own test.
   */
  it('the poller selects the columns the check depends on', () => {
    const src = require('fs').readFileSync(__dirname + '/monitoring.service.ts', 'utf8');
    const poll = src.slice(src.indexOf('async poll()'), src.indexOf('async pruneSamples'));
    for (const field of ['checkType: true', 'port: true', 'path: true']) {
      expect(poll).toContain(field);
    }
  });
});
