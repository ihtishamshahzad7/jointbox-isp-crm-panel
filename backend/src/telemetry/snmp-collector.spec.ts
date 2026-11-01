/**
 * Stage 2 — DeviceHealthService.collectOne: classification, no-fabrication,
 * counter handling and SNMPv3 session construction.
 *
 * net-snmp is replaced with a fake session so these run without a device. The
 * key guarantees: a failed probe writes NO metrics (unreachable data is never
 * recorded as zero), errors are classified without leaking the credential, and
 * SNMPv3 builds an authPriv USM session.
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { DeviceHealthService } from './device-health.service';
import { IF, IF_HC } from './oids';

const originalSnmpAllowedCidrs = process.env.SNMP_ALLOWED_CIDRS;
beforeAll(() => {
  process.env.SNMP_ALLOWED_CIDRS = '10.0.0.0/8';
});
afterAll(() => {
  if (originalSnmpAllowedCidrs === undefined) delete process.env.SNMP_ALLOWED_CIDRS;
  else process.env.SNMP_ALLOWED_CIDRS = originalSnmpAllowedCidrs;
});

function makePrisma() {
  const writes = { device: 0, iface: 0, interfaces: [] as any[] };
  const prisma: any = {
    deviceMetric: { createMany: async () => { writes.device++; return { count: 1 }; } },
    interfaceMetric: { createMany: async ({ data }: any) => { writes.iface++; writes.interfaces.push(...data); return { count: data.length }; } },
  };
  return { prisma, writes };
}
const secrets = { decryptValue: (v: string) => v, encryptValue: (v: string) => v } as any;

/** A fake net-snmp whose session behaviour is scripted per test. */
function fakeSnmp(session: any) {
  const created: any = { v3: null, v2: null };
  return {
    Version1: 0, Version2c: 1, Version3: 3,
    SecurityLevel: { noAuthNoPriv: 1, authNoPriv: 2, authPriv: 3 },
    AuthProtocols: { md5: 'md5', sha: 'sha' },
    PrivProtocols: { des: 'des', aes: 'aes' },
    isVarbindError: () => false,
    createSession: (host: string, community: string, opts: any) => { created.v2 = { host, community, opts }; return session; },
    createV3Session: (host: string, user: any, opts: any) => { created.v3 = { host, user, opts }; return session; },
    _created: created,
  };
}

function svc(prisma: any, snmp: any) {
  const s: any = new DeviceHealthService(prisma, secrets);
  s.snmp = snmp; // override the require('net-snmp') from the constructor
  return s;
}

describe('DeviceHealthService.collectOne (Stage 2 collector)', () => {
  it('classifies a timeout and writes NO metrics (no fabricated zeros)', async () => {
    const { prisma, writes } = makePrisma();
    const session = { get: (_o: any, cb: any) => cb(Object.assign(new Error('Request timed out'), { name: 'RequestTimedOutError' })), close: () => {} };
    const snmp = fakeSnmp(session);
    const r = await svc(prisma, snmp).collectOne({ id: 1, nasname: 'n1', nasIp: '10.0.0.1', snmpVersion: 'V2C', snmpCommunity: 'public' });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('timeout');
    expect(r.message).not.toContain('public'); // never leaks the community
    expect(writes.device).toBe(0);
    expect(writes.iface).toBe(0);
  });

  it('classifies an SNMPv3 authentication failure', async () => {
    const { prisma } = makePrisma();
    const session = { get: (_o: any, cb: any) => cb(new Error('Authentication failure')), close: () => {} };
    const r = await svc(prisma, fakeSnmp(session)).collectOne({
      id: 1, nasname: 'n1', nasIp: '10.0.0.1', snmpVersion: 'V3',
      snmpV3User: 'u', snmpV3SecLevel: 'authPriv', snmpV3AuthProto: 'SHA', snmpV3AuthPass: 'secretpass', snmpV3PrivProto: 'AES', snmpV3PrivPass: 'privpass',
    });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('auth_error');
    expect(r.message).not.toMatch(/secretpass|privpass/); // no credential in the message
  });

  it('builds an SNMPv3 authPriv USM session from the stored fields', async () => {
    const { prisma } = makePrisma();
    const session = { get: (_o: any, cb: any) => cb(new Error('timeout')), close: () => {} };
    const snmp = fakeSnmp(session);
    await svc(prisma, snmp).collectOne({
      id: 1, nasname: 'n1', nasIp: '10.0.0.1', snmpVersion: 'V3',
      snmpV3User: 'netops', snmpV3SecLevel: 'authPriv', snmpV3AuthProto: 'SHA', snmpV3AuthPass: 'a', snmpV3PrivProto: 'AES', snmpV3PrivPass: 'p',
    });
    expect(snmp._created.v3).toBeTruthy();
    expect(snmp._created.v2).toBeNull(); // never silently used a community session
    expect(snmp._created.v3.user).toMatchObject({ name: 'netops', level: 3, authProtocol: 'sha', privProtocol: 'aes' });
  });

  it('rejects unknown SNMP versions and missing v2c communities without a fallback session', async () => {
    const { prisma } = makePrisma();
    const snmp = fakeSnmp({});
    const service = svc(prisma, snmp);
    const unknownVersion = await service.collectOne({
      id: 1, nasname: 'n1', nasIp: '10.0.0.1', snmpVersion: 'V9', snmpCommunity: 'secret',
    });
    const missingCommunity = await service.collectOne({
      id: 2, nasname: 'n2', nasIp: '10.0.0.2', snmpVersion: 'V2C',
    });
    expect(unknownVersion).toMatchObject({ ok: false, kind: 'config_error' });
    expect(missingCommunity).toMatchObject({ ok: false, kind: 'config_error' });
    expect(snmp._created.v2).toBeNull();
    expect(snmp._created.v3).toBeNull();
  });

  it('redacts SNMP session-construction errors from the test API', async () => {
    const { prisma } = makePrisma();
    prisma.nas = {
      findUnique: async () => ({
        id: 1, nasname: 'n1', nasIp: '10.0.0.1', snmpPort: 161,
        snmpVersion: 'V3', snmpV3User: 'netops', snmpV3SecLevel: 'authPriv',
        snmpV3AuthProto: 'SHA', snmpV3AuthPass: 'auth-secret',
        snmpV3PrivProto: 'AES', snmpV3PrivPass: 'privacy-secret',
      }),
    };
    const snmp = fakeSnmp({});
    snmp.createV3Session = () => { throw new Error('failed with auth-secret and privacy-secret'); };
    const result = await svc(prisma, snmp as any).testSnmp(1);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/auth-secret|privacy-secret/);
  });

  it('succeeds on a good probe, returns identity, and records metrics', async () => {
    const { prisma, writes } = makePrisma();
    const session = {
      get: (oids: string[], cb: any) => cb(null, oids.map((o) => ({
        oid: o,
        value: o === IF.sysUpTime ? 123456 : o === IF.sysDescr ? 'RouterOS 7.x' : 0,
      }))),
      // no interfaces in this fake walk → first poll records health/snmpMs only
      subtree: (_oid: string, _m: number, _perVb: any, done: any) => done(),
      close: () => {},
    };
    const r = await svc(prisma, fakeSnmp(session)).collectOne({ id: 1, nasname: 'n1', nasIp: '10.0.0.1', snmpVersion: 'V2C', snmpCommunity: 'public', deviceType: 'MIKROTIK' });
    expect(r.ok).toBe(true);
    expect(r.sysDescr).toMatch(/RouterOS/);
    expect(r.uptimeSec).toBe(Math.round(123456 / 100));
    expect(writes.device).toBe(1); // snmpMs (+health) persisted
  });

  it('rate(): a 64-bit counter decrease is a reset → 0, not a negative spike', () => {
    const { prisma } = makePrisma();
    const s: any = svc(prisma, fakeSnmp({}));
    expect(s.rate(1000n, 500n, true, 10)).toBe(0);           // 64-bit reset → 0
    expect(s.rate(100n, 900n, true, 8)).toBe((800 * 8) / 8); // normal delta
    // 32-bit wrap: prev near max, cur small → wrap math, not 0
    const wrap = s.rate((2n ** 32n) - 100n, 100n, false, 1);
    expect(wrap).toBe(200 * 8);
  });

  it('resets the counter baseline when an interface name changes at the same index', async () => {
    const { prisma, writes } = makePrisma();
    let interfaceName = 'ether1';
    let counter = 1000;
    const session = {
      get: (oids: string[], cb: any) => cb(null, oids.map((oid) => ({
        oid,
        value: oid === IF.sysUpTime ? 100000 : oid === IF.sysDescr ? 'RouterOS' : 0,
      }))),
      subtree: (oid: string, _max: number, perVb: any, done: any) => {
        let value: any = 0;
        if (oid === IF.operStatus) value = 1;
        if (oid === IF_HC.name) value = interfaceName;
        if (oid === IF_HC.inOctets) value = counter;
        if (oid === IF_HC.outOctets) value = counter * 2;
        if (oid === IF_HC.speed) value = 1000;
        perVb([{ oid: `${oid}.1`, value }]);
        done();
      },
      close: () => {},
    };
    const service = svc(prisma, fakeSnmp(session));
    const nas = { id: 1, nasname: 'n1', nasIp: '10.0.0.1', snmpVersion: 'V2C', snmpCommunity: 'public', deviceType: 'MIKROTIK' };

    await service.collectOne(nas);
    interfaceName = 'ether2';
    counter += 1000;
    await service.collectOne(nas);
    expect(writes.interfaces).toHaveLength(0);

    counter += 1000;
    await service.collectOne(nas);
    expect(writes.interfaces).toHaveLength(1);
    expect(writes.interfaces[0].name).toBe('ether2');
  });

  it('no IP configured is a config_error, not a crash', async () => {
    const { prisma } = makePrisma();
    const r = await svc(prisma, fakeSnmp({})).collectOne({ id: 1, nasname: 'n1', nasIp: '', snmpVersion: 'V2C' });
    expect(r).toMatchObject({ ok: false, kind: 'config_error' });
  });
});
