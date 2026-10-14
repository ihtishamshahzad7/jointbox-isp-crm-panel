jest.mock('./radius-coa', () => {
  const actual =
    jest.requireActual<typeof import('./radius-coa')>('./radius-coa');
  return { ...actual, sendCoa: jest.fn() };
});

import { CoaService, COA_TENANCY_REFUSED } from './coa.service';
import { sendCoa } from './radius-coa';
import { PrismaService } from '../prisma/prisma.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';
import { SecretsService } from '../common/secrets.service';

/**
 * RADIUS tenancy for CoA / disconnect: a request about a subscriber goes only
 * to a router the tenancy policy would let that subscriber log in on — the
 * same database decision FreeRADIUS uses (jointbox_radius_tenancy, kind 'coa').
 */
describe('CoA tenancy guard', () => {
  const send = sendCoa as jest.Mock;

  function make(decision: string | Error) {
    const queryRaw = jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('jointbox_radius_tenancy')) {
        if (decision instanceof Error) return Promise.reject(decision);
        return Promise.resolve([{ r: decision }]);
      }
      // live session / open sessions for the user
      return Promise.resolve([
        {
          acctsessionid: 'S1',
          nasipaddress: '192.0.2.3',
          framedipaddress: '100.64.0.9',
          callingstationid: 'AA',
        },
      ]);
    });
    const prisma = {
      $queryRaw: queryRaw,
      subscriber: {
        findUnique: jest.fn().mockResolvedValue({
          id: 7,
          username: 'alice',
          nasId: 24,
          nas: {
            nasIp: '192.0.2.3',
            nasIdentifier: null,
            radiusSecretEnc: null,
            secret: 'router-b-secret',
            incomingPort: 3799,
            apiPort: 8728,
            apiUsername: 'api',
            apiPassword: 'x',
          },
        }),
      },
      nas: {
        findFirst: jest.fn().mockResolvedValue({
          secret: 'router-b-secret',
          radiusSecretEnc: null,
          incomingPort: 3799,
          nasIdentifier: null,
          apiPort: 8728,
          apiUsername: 'api',
          apiPassword: 'x',
          nasIp: '192.0.2.3',
        }),
      },
      systemLog: { create: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };
    const mikrotik = {
      disconnectPppoeUser: jest.fn(),
      isSessionActive: jest.fn(),
    };
    const secrets = { decryptValue: jest.fn() };
    return {
      svc: new CoaService(
        prisma as unknown as PrismaService,
        mikrotik as unknown as MikrotikSyncService,
        secrets as unknown as SecretsService,
      ),
      prisma,
      mikrotik,
      queryRaw,
    };
  }

  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({ ok: true, type: 'ack', message: 'ACK' });
  });

  it.each([
    ['allow', true],
    ['monitor:cross-company', true],
    ['reject:cross-company', false],
    ['reject:nas-no-owner', false],
    ['', false],
  ])('decision %p → sent: %p', async (decision, sent) => {
    const { svc } = make(decision);
    expect(await svc.tenancyAllows('alice', '192.0.2.3')).toBe(sent);
  });

  it('fails closed when the check cannot run (migration missing / database error)', async () => {
    const { svc } = make(
      Object.assign(new Error('function does not exist'), { code: 'P2010' }),
    );
    expect(await svc.tenancyAllows('alice', '192.0.2.3')).toBe(false);
  });

  it('asks nothing and sends nothing without a username or router address', async () => {
    const { svc, queryRaw } = make('allow');
    expect(await svc.tenancyAllows('', '192.0.2.3')).toBe(false);
    expect(await svc.tenancyAllows('alice', null)).toBe(false);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('passes the username and router address as bound parameters, kind coa', async () => {
    const { svc, queryRaw } = make('allow');
    await svc.tenancyAllows("o'brien", '192.0.2.3');
    const [strings, ...values] = queryRaw.mock.calls[0];
    expect(strings.join('?')).toContain("jointbox_radius_tenancy('coa', ?, ?)");
    expect(values).toEqual(["o'brien", '192.0.2.3']);
  });

  it('disconnectSubscriber: refused → no Disconnect-Request, no router API call', async () => {
    const { svc, mikrotik } = make('reject:cross-company');
    const r = await svc.disconnectSubscriber(7);
    expect(r).toEqual({ success: false, message: COA_TENANCY_REFUSED });
    expect(send).not.toHaveBeenCalled();
    expect(mikrotik.disconnectPppoeUser).not.toHaveBeenCalled();
  });

  it('disconnectSubscriber: allowed → the Disconnect-Request is sent', async () => {
    const { svc } = make('allow');
    const r = await svc.disconnectSubscriber(7);
    expect(r.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('changeBandwidth: refused → rate saved for the next login, but no live CoA', async () => {
    const { svc, prisma } = make('reject:cross-company');
    const r = await svc.changeBandwidth(7, 10, 5);
    expect(r).toMatchObject({ success: true, live: false });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2); // radcheck: delete + insert
    expect(send).not.toHaveBeenCalled();
  });

  it('disconnectByUsername: refused → nothing sent', async () => {
    const { svc } = make('reject:cross-company');
    const r = await svc.disconnectByUsername('alice');
    expect(r).toEqual({
      ok: false,
      method: 'none',
      message: COA_TENANCY_REFUSED,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('cutAllSessions: a session on a refused router gets neither CoA nor the API fallback', async () => {
    const { svc, mikrotik } = make('reject:cross-company');
    const r = await svc.cutAllSessions('alice');
    expect(send).not.toHaveBeenCalled();
    expect(mikrotik.disconnectPppoeUser).not.toHaveBeenCalled();
    expect(r.sessionsCut).toBe(0);
  });
});
