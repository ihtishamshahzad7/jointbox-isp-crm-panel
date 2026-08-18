import { RadiusSyncService } from './radius-sync.service';

/**
 * RADIUS ATTRIBUTE PRIORITY (Bug 2 root cause — the reply the NAS actually
 * acts on).
 *
 * syncSubscriberProfile() must implement exactly one of:
 *
 *   STATIC IP  → Framed-IP-Address := <static>  (+ /32 netmask), NO Framed-Pool
 *   NO static  → Framed-Pool := <pool>,          NO Framed-IP-Address
 *
 * Sending both is the classic breakage: depending on the NAS one wins silently
 * (MikroTik's order makes Framed-IP-Address win in some builds and the pool in
 * others), so the operator can never tell which address the customer really
 * gets. The tests below pin the priority AND the exclusivity.
 */
describe('RadiusSyncService.syncSubscriberProfile — addressing attributes', () => {
  const pkgWithPool: any = {
    downloadSpeed: 4,
    uploadSpeed: 4,
    pool: { name: 'pool-4mb' },
  };
  const pkgNoPool: any = { downloadSpeed: 4, uploadSpeed: 4, pool: null };

  function makeService() {
    const pg: any = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const svc = new RadiusSyncService({} as any);
    (svc as any).connected = true;
    (svc as any).pgClient = pg;
    return { pg, svc };
  }

  function inserts(pg: any): Array<{ sql: string; params: any[] }> {
    return pg.query.mock.calls
      .filter((c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT'))
      .map((c: any[]) => ({ sql: c[0], params: c[1] }));
  }

  function attrValues(pg: any, attribute: string): string[] {
    return inserts(pg)
      .filter((i) => i.sql.includes('radreply') && i.params[1] === attribute)
      .map((i) => i.params[3]);
  }

  it('STATIC IP: Framed-IP-Address is written, Framed-Pool is NOT', async () => {
    const { pg, svc } = makeService();
    await svc.syncSubscriberProfile('z', 'pw', pkgWithPool, {
      serviceType: 'PPPOE',
      staticIp: '192.168.88.151',
    });

    expect(attrValues(pg, 'Framed-IP-Address')).toEqual(['192.168.88.151']);
    expect(attrValues(pg, 'Framed-IP-Netmask')).toEqual(['255.255.255.255']);
    expect(attrValues(pg, 'Framed-Pool')).toEqual([]);
  });

  it('DYNAMIC (no static): Framed-Pool is written, Framed-IP-Address is NOT', async () => {
    const { pg, svc } = makeService();
    await svc.syncSubscriberProfile('z', 'pw', pkgWithPool, {
      serviceType: 'PPPOE',
      staticIp: null,
    });

    expect(attrValues(pg, 'Framed-Pool')).toEqual(['pool-4mb']);
    expect(attrValues(pg, 'Framed-IP-Address')).toEqual([]);
  });

  it('a static IP wins over the package pool even when the package HAS a pool', async () => {
    const { pg, svc } = makeService();
    await svc.syncSubscriberProfile('z', 'pw', pkgWithPool, {
      serviceType: 'PPPOE',
      staticIp: '192.168.88.151',
    });

    const framed = attrValues(pg, 'Framed-IP-Address');
    const pool = attrValues(pg, 'Framed-Pool');
    expect(framed).toEqual(['192.168.88.151']);
    expect(pool).toEqual([]); // the pool must NOT also be requested
  });

  it('policy-attribute packages still write addressing with the same exclusivity', async () => {
    const { pg, svc } = makeService();
    const pkgWithPolicy = {
      ...pkgWithPool,
      policyAttributes: [{ attribute: 'Mikrotik-Rate-Limit', op: ':=', value: '10M/10M' }],
    };
    await svc.syncSubscriberProfile('z', 'pw', pkgWithPolicy, {
      serviceType: 'PPPOE',
      staticIp: '192.168.88.151',
    });

    expect(attrValues(pg, 'Mikrotik-Rate-Limit')).toEqual(['10M/10M']);
    expect(attrValues(pg, 'Framed-IP-Address')).toEqual(['192.168.88.151']);
    expect(attrValues(pg, 'Framed-Pool')).toEqual([]);
  });

  it('no package and no static → no addressing attributes at all (nothing invented)', async () => {
    const { pg, svc } = makeService();
    await svc.syncSubscriberProfile('z', 'pw', null, { serviceType: 'PPPOE' });

    expect(attrValues(pg, 'Framed-IP-Address')).toEqual([]);
    expect(attrValues(pg, 'Framed-Pool')).toEqual([]);
  });
});
