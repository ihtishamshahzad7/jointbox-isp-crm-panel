/**
 * Address policy — UNIT tests (pure functions; inventory JSON is realistic
 * iproute2 `ip -j` output). No host or network is touched.
 */
import {
  checkAddressing,
  loadPolicy,
  parseInventory,
  PolicyConfig,
  OtherClaims,
} from './l2tp-address-policy';

const ADDR_JSON = JSON.stringify([
  {
    ifindex: 1,
    ifname: 'lo',
    flags: ['LOOPBACK', 'UP'],
    addr_info: [
      {
        family: 'inet',
        local: '127.0.0.1',
        prefixlen: 8,
        scope: 'host',
        label: 'lo',
      },
    ],
  },
  {
    ifindex: 2,
    ifname: 'ens160',
    flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'],
    addr_info: [
      {
        family: 'inet',
        local: '192.168.1.167',
        prefixlen: 23,
        broadcast: '192.168.1.255',
        scope: 'global',
        dynamic: true,
        label: 'ens160',
      },
    ],
  },
  {
    ifindex: 9,
    ifname: 'ulnas3',
    flags: ['POINTOPOINT', 'UP'],
    addr_info: [
      {
        family: 'inet',
        local: '10.255.3.2',
        address: '10.255.3.1',
        prefixlen: 32,
        scope: 'global',
        label: 'ulnas3',
      },
    ],
  },
  {
    ifindex: 10,
    ifname: 'wg0',
    addr_info: [{ family: 'inet', local: '10.66.0.1', prefixlen: 24 }],
  },
]);
const ROUTE_JSON = JSON.stringify([
  {
    dst: 'default',
    gateway: '192.168.1.1',
    dev: 'ens160',
    protocol: 'dhcp',
    prefsrc: '192.168.1.167',
    metric: 100,
    flags: [],
  },
  {
    dst: '10.255.3.1',
    dev: 'ulnas3',
    protocol: 'kernel',
    scope: 'link',
    prefsrc: '10.255.3.2',
    flags: [],
  },
  {
    dst: '10.66.0.0/24',
    dev: 'wg0',
    protocol: 'kernel',
    scope: 'link',
    prefsrc: '10.66.0.1',
    flags: [],
  },
  {
    dst: '192.168.0.0/23',
    dev: 'ens160',
    protocol: 'kernel',
    scope: 'link',
    prefsrc: '192.168.1.167',
    flags: [],
  },
]);

const policy = loadPolicy({
  L2TP_PROTECTED_CIDRS: '10.255.200.0/24, 203.0.113.50',
}) as PolicyConfig;
const host = parseInventory(ADDR_JSON, ROUTE_JSON)!;
const none: OtherClaims = { tunnelAddresses: [], endpoints: [], nasIps: [] };
const ok = {
  endpoint: '45.76.10.20',
  localAddress: '10.255.7.2',
  remoteAddress: '10.255.7.1',
};
const check = (over: object, others = none, inv: any = host, pol = policy) =>
  checkAddressing({ ...ok, ...over }, pol, inv, others);

describe('L2TP management address policy (unit)', () => {
  it("parses the host inventory and ignores Uplinko's own ulnas* tunnels", () => {
    expect(host.addresses).toEqual(
      expect.arrayContaining(['192.168.1.167', '10.66.0.1']),
    );
    expect(host.addresses).not.toContain('10.255.3.2');
    expect(host.gateways).toEqual(['192.168.1.1']);
    expect(host.networks.map((n) => n.text)).toEqual(
      expect.arrayContaining(['192.168.0.0/23', '10.66.0.0/24']),
    );
    expect(host.networks.map((n) => n.text)).not.toContain('10.255.3.1/32');
  });

  it('accepts addresses inside the management pool with a public endpoint', () => {
    expect(check({})).toEqual([]);
  });

  describe('audit examples are rejected', () => {
    it.each([
      [
        '8.8.8.8 as NAS tunnel address',
        { remoteAddress: '8.8.8.8' },
        /management pool/,
      ],
      [
        '8.8.8.8 as Uplinko tunnel address',
        { localAddress: '8.8.8.8' },
        /management pool/,
      ],
      [
        '192.168.1.1 (host gateway) as tunnel address',
        { remoteAddress: '192.168.1.1' },
        /management pool/,
      ],
      [
        'private NAS endpoint 10.0.0.5',
        { endpoint: '10.0.0.5' },
        /public IPv4/,
      ],
      [
        'host gateway as endpoint',
        { endpoint: '192.168.1.1' },
        /public IPv4|this server|gateway/,
      ],
      [
        'host interface address as endpoint',
        { endpoint: '192.168.1.167' },
        /public IPv4|this server/,
      ],
      [
        'documentation range endpoint',
        { endpoint: '203.0.113.10' },
        /reserved/,
      ],
      ['CGNAT endpoint', { endpoint: '100.64.1.1' }, /reserved/],
      ['loopback endpoint', { endpoint: '127.0.0.1' }, /reserved/],
      ['multicast endpoint', { endpoint: '224.0.0.5' }, /reserved/],
      ['hostname endpoint', { endpoint: 'nas.example.com' }, /IPv4/],
      [
        'pool network address',
        { remoteAddress: '10.255.0.0' },
        /network or broadcast/,
      ],
      [
        'pool broadcast address',
        { remoteAddress: '10.255.255.255' },
        /network or broadcast/,
      ],
      [
        'protected infrastructure range',
        { remoteAddress: '10.255.200.9' },
        /protected/,
      ],
      [
        'protected infrastructure endpoint (licence server)',
        { endpoint: '203.0.113.50' },
        /protected|reserved/,
      ],
      ['equal tunnel addresses', { localAddress: '10.255.7.1' }, /must differ/],
      ['endpoint inside the pool', { endpoint: '10.255.9.9' }, /pool|public/],
    ])('%s', (_label, over, msg) => {
      const errs = check(over);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs.join(' ')).toMatch(msg);
    });
  });

  it('rejects overlap with another NAS tunnel (any tenant) — local or remote side', () => {
    const others: OtherClaims = {
      tunnelAddresses: ['10.255.7.1', '10.255.8.2'],
      endpoints: [],
      nasIps: [],
    };
    expect(check({}, others).join(' ')).toMatch(/another NAS tunnel/);
    expect(
      check(
        { localAddress: '10.255.8.2', remoteAddress: '10.255.8.9' },
        others,
      ).join(' '),
    ).toMatch(/another NAS tunnel/);
  });

  it('rejects a duplicate endpoint (two PSK identities for one address)', () => {
    expect(
      check({}, { ...none, endpoints: ['45.76.10.20'] }).join(' '),
    ).toMatch(/Another NAS already uses/);
  });

  it('rejects a tunnel address equal to an existing NAS address', () => {
    expect(check({}, { ...none, nasIps: ['10.255.7.1'] }).join(' ')).toMatch(
      /existing NAS/,
    );
  });

  it('fails closed without a host inventory', () => {
    expect(check({}, none, null).join(' ')).toMatch(
      /inventory could not be read/,
    );
  });

  it('fails closed when the pool overlaps a host network', () => {
    const pol = loadPolicy({
      L2TP_MGMT_POOL: '192.168.0.0/16',
    }) as PolicyConfig;
    expect(
      check(
        { localAddress: '192.168.50.2', remoteAddress: '192.168.50.1' },
        none,
        host,
        pol,
      ).join(' '),
    ).toMatch(/overlaps a network on this server/);
  });

  it('refuses a public or malformed pool and malformed protected entries', () => {
    expect(loadPolicy({ L2TP_MGMT_POOL: '8.8.0.0/16' } as any)).toHaveProperty(
      'error',
    );
    expect(loadPolicy({ L2TP_MGMT_POOL: 'banana' } as any)).toHaveProperty(
      'error',
    );
    expect(
      loadPolicy({ L2TP_PROTECTED_CIDRS: '1.2.3.4/99' } as any),
    ).toHaveProperty('error');
  });

  it('private endpoints only when the platform enables them', () => {
    const priv = loadPolicy({
      L2TP_ALLOW_PRIVATE_ENDPOINTS: 'true',
    }) as PolicyConfig;
    expect(check({ endpoint: '172.20.0.5' }, none, host, priv)).toEqual([]);
    expect(
      check({ endpoint: '192.168.1.1' }, none, host, priv).join(' '),
    ).toMatch(/this server or its gateway/);
  });

  it('unparseable inventory output is null (fail closed)', () => {
    expect(parseInventory('not json', ROUTE_JSON)).toBeNull();
    expect(parseInventory('{}', ROUTE_JSON)).toBeNull();
  });
});
