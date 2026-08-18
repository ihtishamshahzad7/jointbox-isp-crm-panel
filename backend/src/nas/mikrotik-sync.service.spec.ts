import { MikrotikSyncService } from './mikrotik-sync.service';

jest.mock('./mikrotik.client', () => ({
  withMikrotik: jest.fn(),
}));

import { withMikrotik } from './mikrotik.client';
const mockWithMikrotik = withMikrotik as jest.MockedFunction<typeof withMikrotik>;

/**
 * disconnectPppoeUser() semantics (Bug 1 root cause #2).
 *
 * The OLD implementation returned `true` whenever the API call did not throw —
 * even when /ppp/active/print matched ZERO sessions. A name mismatch or an
 * already-dead session looked identical to a successful kill, so the panel
 * reported "disconnected" while the customer stayed online.
 *
 * The contract now: `found` = an active session existed for this username at
 * all; `removed` = the API actually removed it. Callers must treat
 * {found:true, removed:false} as failure — never as success.
 */
describe('MikrotikSyncService.disconnectPppoeUser', () => {
  const svc = new MikrotikSyncService();
  const client: any = { send: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    client.send.mockReset();
    mockWithMikrotik.mockImplementation(async (_cfg: any, fn: (c: any) => Promise<any>) => fn(client));
  });

  it('no active session → {found:false, removed:false} — the caller must NOT report success', async () => {
    client.send.mockResolvedValue([]);

    const r = await svc.disconnectPppoeUser('192.168.88.17', 8728, 'admin', 'pw', 'z');

    expect(r).toEqual({ found: false, removed: false, sessionIds: [] });
    // Only the print ran — no remove was attempted (there was nothing to remove).
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0][0]).toEqual(['/ppp/active/print', '?name=z']);
  });

  it('one active session removed → {found:true, removed:true} with the .id', async () => {
    client.send
      .mockResolvedValueOnce([{ '.id': '*1A', name: 'z' }])
      .mockResolvedValueOnce({}); // remove

    const r = await svc.disconnectPppoeUser('192.168.88.17', 8728, 'admin', 'pw', 'z');

    expect(r).toEqual({ found: true, removed: true, sessionIds: ['*1A'] });
    expect(client.send.mock.calls[1][0]).toEqual(['/ppp/active/remove', '=.id=*1A']);
  });

  it('multiple sessions: ALL are removed, every .id reported', async () => {
    client.send
      .mockResolvedValueOnce([{ '.id': '*1A', name: 'z' }, { '.id': '*1B', name: 'z' }])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const r = await svc.disconnectPppoeUser('192.168.88.17', 8728, 'admin', 'pw', 'z');

    expect(r).toEqual({ found: true, removed: true, sessionIds: ['*1A', '*1B'] });
    expect(client.send.mock.calls[1][0]).toEqual(['/ppp/active/remove', '=.id=*1A']);
    expect(client.send.mock.calls[2][0]).toEqual(['/ppp/active/remove', '=.id=*1B']);
  });

  it('one of two removes fails → {found:true, removed:false} — a PARTIAL kill is not success', async () => {
    client.send
      .mockResolvedValueOnce([{ '.id': '*1A', name: 'z' }, { '.id': '*1B', name: 'z' }])
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('internal error'));

    const r = await svc.disconnectPppoeUser('192.168.88.17', 8728, 'admin', 'pw', 'z');

    expect(r.found).toBe(true);
    expect(r.removed).toBe(false); // the caller must keep the session marked online
    expect(r.sessionIds).toEqual(['*1A']);
  });

  it('connection failure propagates as an error (not a fake success)', async () => {
    mockWithMikrotik.mockRejectedValueOnce(new Error('connection refused'));

    await expect(
      svc.disconnectPppoeUser('192.168.88.17', 8728, 'admin', 'pw', 'z'),
    ).rejects.toThrow('connection refused');
  });
});
