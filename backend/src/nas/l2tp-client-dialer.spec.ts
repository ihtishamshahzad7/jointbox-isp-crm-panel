/**
 * L2tpClientDialer — MOCKED host tests.
 *
 * A fake host (strongSwan SAs, xl2tpd LACs, ppp interfaces, routes, pppd logs)
 * answers the dialer's commands. Nothing here touches a real strongSwan,
 * xl2tpd, pppd or MikroTik: these tests prove the dialer's decisions and
 * command/argument handling, NOT interoperability with a real NAS.
 */
import {
  L2tpClientDialer,
  DialParams,
  classifyIpsec,
  classifyPppLog,
  parseSwanctlSas,
} from './l2tp-client-dialer.service';

type Fail =
  | 'psk'
  | 'proposal'
  | 'unreachable'
  | 'pppauth'
  | 'neverUp'
  | 'wrongAddr'
  | 'defaultRoute'
  | 'routeElsewhere'
  | 'noTools'
  // ESP / CHILD_SA failure modes (encryption proof)
  | 'noChild'
  | 'unrelatedChild'
  | 'wrongPeer'
  | 'wrongTs'
  | 'noXfrm'
  | 'childRekeying'
  | 'nullCipher'
  | 'truncated';

class FakeHost {
  sas = new Set<string>();
  servers = new Map<string, string>();
  locks = new Set<string>();

  /**
   * `swanctl --list-sas --ike <name>` in the strongSwan 5.9 layout
   * (src/swanctl/commands/list_sas.c), with per-NAS failure modes.
   */
  listSas(name: string): string {
    const f = this.fail.get(this.nasOf(name));
    const server = f === 'wrongPeer' ? '45.76.99.99' : this.servers.get(name);
    const ike = [
      `${name}: #3, ESTABLISHED, IKEv1, 4f6a2c1d9e8b7a65_i* 1b2c3d4e5f6a7b8c_r`,
      `  local  '192.168.1.167' @ 192.168.1.167[4500]`,
      `  remote '${server}' @ ${server}[4500]`,
      '  AES_CBC-256/HMAC_SHA1_96/PRF_HMAC_SHA1/MODP_2048',
      '  established 42s ago, rekeying in 13811s',
    ];
    if (f === 'truncated') return ike.slice(0, 2).join('\n') + '\n';
    if (f === 'noChild') return ike.join('\n') + '\n';
    const childName = f === 'unrelatedChild' ? 'other-tunnel' : name;
    const state = f === 'childRekeying' ? 'REKEYING' : 'INSTALLED';
    const cipher =
      f === 'nullCipher' ? 'NULL/HMAC_SHA1_96' : 'AES_CBC-256/HMAC_SHA1_96';
    const port = f === 'wrongTs' ? 'domain' : 'l2f';
    return [
      ...ike,
      `  ${childName}: #4, reqid 1, ${state}, TRANSPORT-in-UDP, ESP:${cipher}`,
      '    installed 42s ago, rekeying in 3244s, expires in 3918s',
      '    in  c3b2a1f0 (-|0x00000000),    840 bytes,    10 packets,     1s ago',
      '    out 0a1b2c3d (-|0x00000000),    912 bytes,    11 packets,     1s ago',
      `    local  192.168.1.167/32[udp/${port}]`,
      `    remote ${server}/32[udp/${port}]`,
      '',
    ].join('\n');
  }
  lacs = new Set<string>();
  links = new Map<string, { local: string; peer: string }>();
  files = new Map<string, string>();
  calls: { cmd: string; args: string[] }[] = [];
  defaultRoute =
    'default via 192.168.1.1 dev ens160 proto dhcp src 192.168.1.167 metric 100';
  fail = new Map<number, Fail>(); // per NAS id
  lacParams = new Map<string, Record<string, string>>();

  nasOf(name: string) {
    return Number(name.replace(/^uplinko-nas-/, ''));
  }

  run = async (cmd: string, args: string[]) => {
    this.calls.push({ cmd, args });
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const bad = (stderr = '') => ({ code: 1, stdout: '', stderr });
    if (cmd === 'which')
      return [...this.fail.values()].includes('noTools') &&
        args[0] === 'xl2tpd-control'
        ? bad()
        : ok(`/usr/sbin/${args[0]}`);
    if (cmd === 'test') return ok();
    if (cmd === 'swanctl') {
      if (args[0] === '--load-all') return ok('loaded');
      if (args[0] === '--initiate') {
        const name = args[args.indexOf('--child') + 1];
        const f = this.fail.get(this.nasOf(name));
        if (f === 'psk')
          return bad('received AUTHENTICATION_FAILED notify error');
        if (f === 'proposal')
          return bad('received NO_PROPOSAL_CHOSEN notify error');
        if (f === 'unreachable') return bad('giving up after 5 retransmits');
        this.sas.add(name);
        const conf = this.files.get(`/s/${name}.conf`) ?? '';
        this.servers.set(
          name,
          conf.match(/remote_addrs = ([0-9.]+)/)?.[1] ?? '',
        );
        return ok('initiate completed successfully');
      }
      if (args[0] === '--terminate') {
        this.sas.delete(args[args.indexOf('--ike') + 1]);
        return ok();
      }
      if (args[0] === '--list-sas') {
        const name = args[args.indexOf('--ike') + 1];
        return ok(this.sas.has(name) ? this.listSas(name) : '');
      }
    }
    if (cmd === 'xl2tpd-control') {
      const [, , verb, name, ...rest] = args;
      if (verb === 'add-lac') {
        this.lacs.add(name);
        this.lacParams.set(
          name,
          Object.fromEntries(
            rest.map((kv) => kv.split('=') as [string, string]),
          ),
        );
        return ok('00 OK');
      }
      if (verb === 'remove-lac') {
        this.lacs.delete(name);
        return ok('00 OK');
      }
      if (verb === 'disconnect-lac') {
        this.links.delete(`ulnas${this.nasOf(name)}`);
        return ok('00 OK');
      }
      if (verb === 'connect-lac') {
        const id = this.nasOf(name);
        const f = this.fail.get(id);
        const ppp = this.files.get(`/u/${name}.ppp`) ?? '';
        if (f === 'pppauth') {
          this.files.set(`/u/${name}.log`, 'MS-CHAP authentication failed\n');
          return ok('00 OK');
        }
        if (f === 'neverUp') return ok('00 OK');
        const [local, peer] = (
          ppp.match(/^(\d+\.\d+\.\d+\.\d+):(\d+\.\d+\.\d+\.\d+)$/m) ?? []
        ).slice(1);
        this.links.set(
          `ulnas${id}`,
          f === 'wrongAddr' ? { local: '10.9.9.9', peer } : { local, peer },
        );
        if (f === 'defaultRoute')
          this.defaultRoute = `default dev ulnas${id} scope link`;
        return ok('00 OK');
      }
    }
    if (cmd === 'ip' && args[0] === 'xfrm') {
      const dst = args[args.indexOf('dst') + 1];
      const entry = [...this.sas]
        .map((n) => [n, this.servers.get(n)] as const)
        .find(([, s]) => s === dst);
      if (!entry || this.fail.get(this.nasOf(entry[0])) === 'noXfrm')
        return ok('');
      return ok(
        `src 192.168.1.167 dst ${dst}\n\tproto esp spi 0xc8a1b2c3 reqid 1 mode transport\n\treplay-window 0 \n\tauth-trunc hmac(sha1) 0x… 96\n\tenc cbc(aes) 0x…\n\tencap type espinudp sport 4500 dport 4500 addr 0.0.0.0\n`,
      );
    }
    if (cmd === 'ip') {
      if (args.join(' ') === '-4 route show default')
        return ok(this.defaultRoute + '\n');
      if (args[0] === '-o' && args[1] === 'link') {
        const dev = args[4];
        return this.links.has(dev)
          ? ok(
              `9: ${dev}: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1400 qdisc fq_codel state UNKNOWN`,
            )
          : bad('Device does not exist');
      }
      if (args[0] === '-o' && args[1] === '-4') {
        const l = this.links.get(args[5]);
        return l
          ? ok(
              `9: ${args[5]}    inet ${l.local} peer ${l.peer}/32 scope global ${args[5]}`,
            )
          : ok('');
      }
      if (args[1] === 'route' && args[2] === 'get') {
        const peer = args[3];
        const hit = [...this.links.entries()].find(([, v]) => v.peer === peer);
        const routedElsewhere =
          hit && this.fail.get(Number(hit[0].slice(5))) === 'routeElsewhere';
        return ok(
          hit && !routedElsewhere
            ? `${peer} dev ${hit[0]} src ${hit[1].local} uid 0`
            : `${peer} via 192.168.1.1 dev ens160 src 192.168.1.167`,
        );
      }
    }
    return bad(`unexpected ${cmd} ${args.join(' ')}`);
  };
}

function setup() {
  process.env.L2TP_SWANCTL_CONF_DIR = '/s';
  process.env.L2TP_CLIENT_DIR = '/u';
  const host = new FakeHost();
  const d = new L2tpClientDialer();
  d.run = host.run;
  d.sleep = async () => undefined;
  d.files = {
    writeSecret: async (f, data) => {
      host.files.set(f, data);
    },
    read: async (f) => host.files.get(f) ?? null,
    remove: async (f) => {
      host.files.delete(f);
    },
    lockCreate: async (dir, owner) => {
      if (host.locks.has(dir)) return 'exists';
      host.locks.add(dir);
      host.files.set(`${dir}/owner.json`, owner);
      return 'ok';
    },
    lockRemove: async (dir) => {
      host.locks.delete(dir);
      host.files.delete(`${dir}/owner.json`);
    },
  };
  return { d, host };
}

const P = (over: Partial<DialParams> = {}): DialParams => ({
  nasId: 7,
  server: '203.0.113.10',
  ipsecPsk: 'Psk-Secret-123',
  pppUsername: 'uplinko-mgmt',
  pppPassword: 'Ppp-Pass-456',
  localAddress: '10.255.7.2',
  remoteAddress: '10.255.7.1',
  timeoutSec: 10,
  retryCount: 0,
  retryDelaySec: 1,
  ...over,
});

describe('L2tpClientDialer (mocked host)', () => {
  describe('validation', () => {
    it.each([
      [{ server: 'nas.example.com' }, /routable IPv4/],
      [{ server: '127.0.0.1' }, /routable IPv4/],
      [{ server: '1.2.3.4; reboot' }, /routable IPv4/],
      [{ ipsecPsk: 'short' }, /pre-shared key/],
      [{ ipsecPsk: 'has"quote123' }, /pre-shared key/],
      [{ pppPassword: 'line\nbreak123' }, /PPP password/],
      [{ pppUsername: 'bad user' }, /PPP username/],
      [{ localAddress: '10.255.7.1' }, /must differ/],
      [{ remoteAddress: '203.0.113.10' }, /differ from the NAS public/],
    ])(
      'rejects %p before any file write or tunnel command',
      async (over, msg) => {
        const { d, host } = setup();
        const r = await d.dial(P(over));
        expect(r.state).toBe('error');
        expect(r.errorCode).toBe('invalid_config');
        expect(r.error).toMatch(msg);
        expect(host.files.size).toBe(0);
        expect(
          host.calls.filter(
            (c) => c.cmd === 'swanctl' || c.cmd === 'xl2tpd-control',
          ),
        ).toHaveLength(0);
      },
    );
  });

  describe('generated config', () => {
    it('binds the PSK to this NAS only and never writes it in plaintext', () => {
      const { d } = setup();
      const swan = d.renderSwan(P());
      expect(swan).toContain('remote_addrs = 203.0.113.10');
      expect(swan).toContain('id-1 = 203.0.113.10');
      expect(swan).toContain(
        `secret = 0s${Buffer.from('Psk-Secret-123').toString('base64')}`,
      );
      expect(swan).not.toContain('Psk-Secret-123');
      expect(swan).toMatch(/mode = transport/);
      expect(swan).toMatch(/udp\/1701/);
    });

    it('pppd options never take the default route or DNS, and use a per-NAS interface', () => {
      const { d } = setup();
      const ppp = d.renderPpp(P());
      expect(ppp).toMatch(/^nodefaultroute$/m);
      expect(ppp).not.toMatch(
        /^(defaultroute|replacedefaultroute|usepeerdns)$/m,
      );
      expect(ppp).toMatch(/^ifname ulnas7$/m);
      expect(ppp).toMatch(/^10\.255\.7\.2:10\.255\.7\.1$/m);
      // The client authenticates to the NAS; it must not demand the NAS authenticate to it.
      expect(ppp).toMatch(/^noauth$/m);
      expect(ppp).not.toMatch(/^require-/m);
    });
  });

  describe('lifecycle', () => {
    it('reports connected only after IPsec, interface, addresses, route and default route all check out', async () => {
      const { d, host } = setup();
      const r = await d.dial(P());
      expect(r).toMatchObject({
        state: 'connected',
        interface: 'ulnas7',
        localAddress: '10.255.7.2',
        remoteAddress: '10.255.7.1',
        ipsec: 'established',
        l2tp: 'up',
      });
      const verbs = host.calls
        .filter((c) => c.cmd === 'xl2tpd-control')
        .map((c) => c.args[2]);
      expect(verbs).toEqual(expect.arrayContaining(['add-lac', 'connect-lac']));
      expect(host.lacParams.get('uplinko-nas-7')).toMatchObject({
        lns: '203.0.113.10',
        pppoptfile: '/u/uplinko-nas-7.ppp',
      });
      expect(
        host.calls.some(
          (c) =>
            c.cmd === 'swanctl' &&
            c.args.includes('--initiate') &&
            c.args.includes('uplinko-nas-7'),
        ),
      ).toBe(true);
    });

    it('every command is argv-only (no shell) and carries no secret', async () => {
      const { d, host } = setup();
      await d.dial(P());
      for (const c of host.calls) {
        expect(['which', 'test', 'swanctl', 'xl2tpd-control', 'ip']).toContain(
          c.cmd,
        );
        expect(c.args.join(' ')).not.toMatch(/Psk-Secret-123|Ppp-Pass-456/);
      }
    });

    it('disconnect tears down only this NAS and status then says disconnected', async () => {
      const { d, host } = setup();
      await d.dial(P());
      await d.dial(
        P({
          nasId: 8,
          server: '203.0.113.20',
          localAddress: '10.255.8.2',
          remoteAddress: '10.255.8.1',
        }),
      );
      host.calls = [];
      await d.hangup(7);
      expect(host.calls.every((c) => !c.args.join(' ').includes('nas-8'))).toBe(
        true,
      );
      expect((await d.status(7)).state).toBe('disconnected');
      expect(
        (
          await d.status(8, {
            localAddress: '10.255.8.2',
            remoteAddress: '10.255.8.1',
            server: '203.0.113.20',
          })
        ).state,
      ).toBe('connected');
    });

    it('reconnect after a drop brings the tunnel back', async () => {
      const { d, host } = setup();
      await d.dial(P());
      host.sas.clear();
      host.links.clear(); // NAS rebooted
      expect((await d.status(7)).state).toBe('disconnected');
      expect((await d.dial(P())).state).toBe('connected');
    });

    it('missing host tooling is an error, never a dial', async () => {
      const { d, host } = setup();
      host.fail.set(7, 'noTools');
      const r = await d.dial(P());
      expect(r).toMatchObject({ state: 'error', errorCode: 'tooling_missing' });
      expect(host.calls.some((c) => c.cmd === 'swanctl')).toBe(false);
    });
  });

  describe('failures', () => {
    it.each([
      ['psk', 'ipsec_auth_failed'],
      ['proposal', 'ipsec_proposal_mismatch'],
      ['pppauth', 'ppp_auth_failed'],
      ['wrongAddr', 'address_mismatch'],
      ['defaultRoute', 'route_violation'],
      ['routeElsewhere', 'route_violation'],
    ])('%s → %s, torn down, not retried', async (fail, code) => {
      const { d, host } = setup();
      host.fail.set(7, fail as Fail);
      const r = await d.dial(P({ retryCount: 3 }));
      expect(r.state).toBe('error');
      expect(r.errorCode).toBe(code);
      expect(r.attempts).toBe(1);
      expect(host.sas.has('uplinko-nas-7')).toBe(false);
      expect(host.links.has('ulnas7')).toBe(false);
      expect(host.lacs.has('uplinko-nas-7')).toBe(false);
    });

    it('unreachable NAS is retried up to the limit, then reported with a clear code', async () => {
      const { d, host } = setup();
      host.fail.set(7, 'unreachable');
      const r = await d.dial(P({ retryCount: 2 }));
      expect(r).toMatchObject({
        state: 'error',
        errorCode: 'nas_unreachable',
        attempts: 3,
      });
      expect(
        host.calls.filter((c) => c.args.includes('--initiate')),
      ).toHaveLength(3);
    });

    it('timeout: IPsec up but PPP never comes up → error timeout, cleaned up', async () => {
      const { d, host } = setup();
      host.fail.set(7, 'neverUp');
      const realNow = Date.now;
      let t = realNow();
      jest.spyOn(Date, 'now').mockImplementation(() => (t += 3000));
      try {
        const r = await d.dial(P({ timeoutSec: 10 }));
        expect(r).toMatchObject({ state: 'error', errorCode: 'timeout' });
        expect(host.sas.size).toBe(0);
      } finally {
        (Date.now as jest.Mock).mockRestore();
      }
    });

    it('one NAS failing does not disturb another NAS tunnel', async () => {
      const { d, host } = setup();
      await d.dial(
        P({
          nasId: 8,
          server: '203.0.113.20',
          localAddress: '10.255.8.2',
          remoteAddress: '10.255.8.1',
        }),
      );
      host.fail.set(7, 'psk');
      expect((await d.dial(P())).state).toBe('error');
      expect(host.sas.has('uplinko-nas-8')).toBe(true);
      expect(host.links.has('ulnas8')).toBe(true);
    });
  });

  describe('status never invents a connection', () => {
    it('config files alone are not "connected"', async () => {
      const { d, host } = setup();
      host.files.set('/s/uplinko-nas-7.conf', 'x');
      expect((await d.status(7)).state).toBe('disconnected');
    });
    it('an IPsec SA without the PPP interface is "connecting", not connected', async () => {
      const { d, host } = setup();
      host.sas.add('uplinko-nas-7');
      expect((await d.status(7)).state).toBe('connecting');
    });
  });

  describe('error classification', () => {
    it('maps strongSwan and pppd output', () => {
      expect(classifyIpsec('INVALID_HASH_V1 payload').code).toBe(
        'ipsec_auth_failed',
      );
      expect(classifyIpsec('peer not responding').code).toBe('nas_unreachable');
      expect(classifyIpsec('something else').code).toBe('ipsec_failed');
      expect(classifyPppLog('CHAP authentication failed')?.code).toBe(
        'ppp_auth_failed',
      );
      expect(classifyPppLog('LCP: timeout sending Config-Requests')?.code).toBe(
        'l2tp_failed',
      );
      expect(classifyPppLog('')).toBeNull();
    });
  });

  describe('HIGH: Connected requires the ESP SA that encrypts L2TP (realistic swanctl output)', () => {
    it.each([
      ['IKE SA but no CHILD_SA (L2TP would run in clear)', 'noChild'],
      ['only an unrelated CHILD_SA', 'unrelatedChild'],
      ['IKE SA to a different peer', 'wrongPeer'],
      ['CHILD_SA selectors not L2TP', 'wrongTs'],
      ['CHILD_SA without kernel ESP state', 'noXfrm'],
      ['CHILD_SA not INSTALLED (stale/rekeying)', 'childRekeying'],
      ['NULL encryption', 'nullCipher'],
      ['truncated/incomplete status output', 'truncated'],
    ])('%s → never connected; dial torn down', async (_label, fail) => {
      const { d, host } = setup();
      host.fail.set(7, fail as Fail);
      const r = await d.dial(P({ retryCount: 2 }));
      expect(r.state).not.toBe('connected');
      expect(r.errorCode).toBe('encryption_unverified');
      expect(r.attempts).toBe(1);
      expect(host.links.has('ulnas7')).toBe(false);
      expect(host.sas.has('uplinko-nas-7')).toBe(false);
    });

    it('status without the NAS public address cannot prove encryption → not connected', async () => {
      const { d } = setup();
      await d.dial(P());
      const st = await d.status(7, {
        localAddress: '10.255.7.2',
        remoteAddress: '10.255.7.1',
      });
      expect(st.state).toBe('error');
      expect(st.errorCode).toBe('encryption_unverified');
    });

    it('the expected ESP transport SA to this NAS → connected, with the cipher named', async () => {
      const { d } = setup();
      const r = await d.dial(P());
      expect(r.state).toBe('connected');
      expect(r.detail).toMatch(
        /ESP AES_CBC-256 transport SA to 203\.0\.113\.10/,
      );
    });

    it('parseSwanctlSas reads IKE peer, CHILD_SA state/mode/cipher and selectors', () => {
      const { host } = setup();
      host.servers.set('uplinko-nas-7', '203.0.113.10');
      const sa = parseSwanctlSas(
        host.listSas('uplinko-nas-7'),
        'uplinko-nas-7',
      );
      expect(sa.ike).toEqual({
        state: 'ESTABLISHED',
        remoteHost: '203.0.113.10',
      });
      expect(sa.children[0]).toMatchObject({
        name: 'uplinko-nas-7',
        state: 'INSTALLED',
        mode: 'TRANSPORT-in-UDP',
        protocol: 'ESP',
        cipher: 'AES_CBC-256',
        localTs: ['192.168.1.167/32[udp/l2f]'],
        remoteTs: ['203.0.113.10/32[udp/l2f]'],
      });
    });
  });

  describe('cancellation and cleanup', () => {
    it('a cancelled dial stops, tears down and reports cancelled (not connected)', async () => {
      const { d, host } = setup();
      host.fail.set(7, 'neverUp');
      let polls = 0;
      const r = await d.dial(P({ timeoutSec: 60 }), {
        shouldCancel: () => ++polls > 3,
      });
      expect(r).toMatchObject({
        state: 'disconnected',
        errorCode: 'cancelled',
      });
      expect(host.sas.has('uplinko-nas-7')).toBe(false);
    });

    it('purge removes only this NAS and verifies nothing is left', async () => {
      const { d, host } = setup();
      await d.dial(P());
      await d.dial(
        P({
          nasId: 8,
          server: '203.0.113.20',
          localAddress: '10.255.8.2',
          remoteAddress: '10.255.8.1',
        }),
      );
      const res = await d.purge(7);
      expect(res).toEqual({ clean: true, remaining: [] });
      expect([...host.files.keys()].some((f) => f.includes('nas-7'))).toBe(
        false,
      );
      expect(host.sas.has('uplinko-nas-8')).toBe(true);
      expect(host.links.has('ulnas8')).toBe(true);
    });

    it('purge reports what could not be removed', async () => {
      const { d, host } = setup();
      await d.dial(P());
      const realRun = host.run;
      d.run = async (cmd, args) =>
        cmd === 'xl2tpd-control' ||
        (cmd === 'swanctl' && args[0] === '--terminate')
          ? { code: 1, stdout: '', stderr: 'fail' }
          : realRun(cmd, args);
      const res = await d.purge(7);
      expect(res.clean).toBe(false);
      expect(res.remaining.join(' ')).toMatch(/IPsec SA|interface ulnas7/);
    });

    it('inventory fails closed when ip -j output is unusable', async () => {
      const { d } = setup();
      d.run = async () => ({ code: 0, stdout: 'garbage', stderr: '' });
      expect(await d.inventory()).toBeNull();
      d.run = async () => ({ code: 1, stdout: '', stderr: 'ip: not found' });
      expect(await d.inventory()).toBeNull();
    });
  });
});
