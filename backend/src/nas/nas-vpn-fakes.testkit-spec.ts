/**
 * TEST KIT (simulations, not real equipment) for the NAS management VPN.
 * The file name ends in "spec.ts" so `nest build` excludes it, but it is not a
 * ".spec.ts" test file itself.
 *
 *   FakeRouter — RouterOS model: users/groups with the `sensitive` policy
 *                (hidden fields are OMITTED from print, as RouterOS does for
 *                API users without it), L2TP server, PPP secrets, firewall
 *                filter with ordered evaluation, fault injection, and an L2TP
 *                login simulation used to prove who can log in.
 *   FakeDb     — the subset of Prisma used by NasL2tpClientService, shared
 *                between several service instances to simulate PM2 workers.
 */

type Row = Record<string, any>;

export interface Fault {
  /** Matches the command word, e.g. '/interface/l2tp-server/server/set'. */
  cmd: string;
  /** Optional attribute that must be present, e.g. 'enabled'. */
  attr?: string;
  /** 'before': the router rejects (nothing applied). 'after': applied, then the API connection drops. */
  when: 'before' | 'after' | 'ignore';
  /** Fire on the n-th matching call (1-based). Default 1. */
  nth?: number;
}

export class FakeRouter {
  users: Row[] = [{ name: 'uplinko-api', group: 'uplinko' }];
  groups: Row[] = [
    { name: 'uplinko', policy: 'read,write,api,sensitive,!ftp' },
  ];
  server: Row = {
    enabled: 'false',
    'use-ipsec': 'no',
    'ipsec-secret': '',
    authentication: 'pap,chap,mschap1,mschap2',
    'default-profile': 'default-encryption',
  };
  secrets: Row[] = [];
  rules: Row[] = [];
  l2tpClients: Row[] = [];
  /** Make /interface/l2tp-client/print fail or return malformed rows. */
  l2tpClientsMode: 'ok' | 'error' | 'malformed' = 'ok';
  pppoeServers: Row[] = [
    {
      '.id': '*P1',
      'service-name': 'isp',
      interface: 'ether2',
      disabled: 'false',
    },
  ];
  log: string[][] = [];
  faults: Fault[] = [];
  /** Every call throws (router unreachable). */
  down = false;
  /** A new API connection succeeds again after a drop (router came back). */
  recoverOnReconnect = false;
  /** How a hidden (sensitive) field looks to an API user without the policy. */
  hiddenAs: 'omit' | 'empty' = 'omit';
  /** Router silently ignores place-before (rule appended at the end). */
  ignorePlaceBefore = false;
  connects = 0;
  /** After this many further calls, the router becomes unreachable. */
  downAfterCalls: number | null = null;
  private seq = 100;
  private hits = new Map<Fault, number>();

  get sensitive(): boolean {
    const u = this.users.find((x) => x.name === 'uplinko-api');
    const g = this.groups.find((x) => x.name === u?.group);
    return String(g?.policy ?? '')
      .split(',')
      .includes('sensitive');
  }

  connect = async <T>(
    fn: (c: { send(w: string[]): Promise<any[]> }) => Promise<T>,
  ): Promise<T> => {
    this.connects++;
    if (this.down && this.recoverOnReconnect) this.down = false;
    if (this.down)
      throw new Error('RouterOS 45.76.10.20: connection timed out');
    return fn({ send: (w) => this.send(w) });
  };

  /** RouterOS stores booleans and prints them as true/false whatever was written. */
  static normBool(attrs: Row): Row {
    const out = { ...attrs };
    for (const k of ['enabled', 'disabled'])
      if (k in out) out[k] = /^(yes|true)$/i.test(out[k]) ? 'true' : 'false';
    return out;
  }

  private parse(words: string[]) {
    const [cmd, ...rest] = words;
    const attrs: Row = {};
    const query: Row = {};
    for (const w of rest) {
      if (w.startsWith('=')) {
        const i = w.indexOf('=', 1);
        attrs[w.slice(1, i)] = w.slice(i + 1);
      } else if (w.startsWith('?')) {
        const i = w.indexOf('=');
        query[w.slice(1, i)] = w.slice(i + 1);
      }
    }
    return { cmd, attrs, query };
  }

  private hide(row: Row, keys: string[]) {
    const out = { ...row };
    if (!this.sensitive)
      for (const k of keys) {
        if (this.hiddenAs === 'omit') delete out[k];
        else if (k in out) out[k] = '';
      }
    return out;
  }

  async send(words: string[]): Promise<any[]> {
    if (this.down) throw new Error('RouterOS: connection closed by the router');
    if (this.downAfterCalls !== null) {
      if (this.downAfterCalls <= 0) {
        this.down = true;
        throw new Error('RouterOS: connection closed by the router');
      }
      this.downAfterCalls--;
    }
    const { cmd, attrs, query } = this.parse(words);
    const fault = this.faults.find(
      (f) => f.cmd === cmd && (!f.attr || f.attr in attrs),
    );
    let fireAfter = false;
    if (fault) {
      const n = (this.hits.get(fault) ?? 0) + 1;
      this.hits.set(fault, n);
      if (n === (fault.nth ?? 1)) {
        if (fault.when === 'before')
          throw new Error(
            `RouterOS error: !trap failure: injected before ${cmd}`,
          );
        if (fault.when === 'ignore') {
          this.log.push(words);
          return [];
        }
        fireAfter = true;
      }
    }
    this.log.push(words);
    const result = this.exec(cmd, attrs, query);
    if (fireAfter) {
      this.down = true;
      throw new Error('RouterOS: connection closed by the router');
    }
    return result;
  }

  private exec(cmd: string, attrs: Row, query: Row): any[] {
    const filt = (rows: Row[]) =>
      rows.filter((r) =>
        Object.entries(query).every(([k, v]) => String(r[k]) === v),
      );
    switch (cmd) {
      case '/user/print':
        return filt(this.users).map((r) => ({ ...r }));
      case '/user/group/print':
        return filt(this.groups).map((r) => ({ ...r }));
      case '/interface/l2tp-server/server/print':
        return [this.hide(this.server, ['ipsec-secret'])];
      case '/interface/l2tp-server/server/set':
        Object.assign(this.server, FakeRouter.normBool(attrs));
        return [];
      case '/ppp/secret/print':
        return filt(this.secrets).map((r) => this.hide(r, ['password']));
      case '/ppp/secret/add': {
        const id = `*${this.seq++}`;
        this.secrets.push({ '.id': id, ...attrs });
        return [{ ret: id }];
      }
      case '/ppp/secret/set': {
        const s = this.secrets.find((x) => x['.id'] === attrs['.id']);
        if (!s) throw new Error('no such item');
        Object.assign(s, attrs);
        return [];
      }
      case '/ppp/secret/remove':
        this.secrets = this.secrets.filter((x) => x['.id'] !== attrs['.id']);
        return [];
      case '/interface/l2tp-client/print':
        if (this.l2tpClientsMode === 'error')
          throw new Error('RouterOS error: !trap not enough permissions (9)');
        if (this.l2tpClientsMode === 'malformed') return [{ running: 'true' }];
        return this.l2tpClients.map((r) => this.hide(r, ['password']));
      case '/ip/firewall/filter/print':
        return this.rules.map((r) => ({ ...r }));
      case '/ip/firewall/filter/add': {
        const id = `*${this.seq++}`;
        const { 'place-before': before, ...rest } = attrs;
        const rule = { '.id': id, disabled: 'false', ...rest };
        const at =
          before && !this.ignorePlaceBefore
            ? this.rules.findIndex((r) => r['.id'] === before)
            : -1;
        if (at >= 0) this.rules.splice(at, 0, rule);
        else this.rules.push(rule);
        return [{ ret: id }];
      }
      case '/ip/firewall/filter/remove':
        this.rules = this.rules.filter((r) => r['.id'] !== attrs['.id']);
        return [];
      default:
        throw new Error(`unexpected RouterOS command ${cmd}`);
    }
  }

  /** Commands that changed something (excludes reads). */
  mutations() {
    return this.log.filter((w) => /\/(set|add|remove)$/.test(w[0]));
  }

  /** First-match evaluation of input rules for a UDP/1701 packet. */
  /**
   * First-match evaluation of the input chain for one packet, honouring
   * protocol, dst-port, src-address, ipsec-policy and connection-state
   * (a rule without a match field matches any value of it). Default accept.
   */
  packetAllowed(p: {
    protocol: 'udp' | 'ipsec-esp' | 'tcp';
    dstPort?: number;
    src: string;
    viaIpsec?: boolean;
    state: 'new' | 'established' | 'related';
  }): boolean {
    for (const r of this.rules) {
      if (r.chain !== 'input' || r.disabled === 'true') continue;
      if (r.protocol && r.protocol !== p.protocol) continue;
      if (
        r['dst-port'] &&
        !(
          p.dstPort !== undefined &&
          String(r['dst-port']).split(',').includes(String(p.dstPort))
        )
      )
        continue;
      if (r['src-address'] && r['src-address'] !== p.src) continue;
      if (r['ipsec-policy'] === 'in,ipsec' && !p.viaIpsec) continue;
      if (
        r['connection-state'] &&
        !String(r['connection-state']).split(',').includes(p.state)
      )
        continue;
      if (r['in-interface']) continue; // interface-bound admin rules are out of scope for this model
      return r.action !== 'drop';
    }
    return true;
  }

  private firewallAllows(srcIp: string, viaIpsec: boolean): boolean {
    return this.packetAllowed({
      protocol: 'udp',
      dstPort: 1701,
      src: srcIp,
      viaIpsec,
      state: 'new',
    });
  }

  /**
   * Would an L2TP login succeed? Models the order RouterOS applies: firewall,
   * then the L2TP server's IPsec requirement (PSK), then the PPP secret
   * (service l2tp or any).
   */
  canL2tpLogin(p: {
    srcIp: string;
    psk: string | null;
    user: string;
    password: string;
  }): boolean {
    if (!/^(yes|true)$/.test(this.server.enabled)) return false;
    const viaIpsec =
      p.psk !== null &&
      p.psk === this.server['ipsec-secret'] &&
      this.server['use-ipsec'] !== 'no';
    if (p.psk !== null && !viaIpsec) return false; // IKE fails with a wrong key
    if (this.server['use-ipsec'] === 'required' && !viaIpsec) return false;
    if (!this.firewallAllows(p.srcIp, viaIpsec)) return false;
    const s = this.secrets.find(
      (x) => x.name === p.user && x.disabled !== 'true',
    );
    return (
      !!s &&
      ['l2tp', 'any'].includes(s.service ?? 'any') &&
      s.password === p.password
    );
  }
}

/** In-memory subset of Prisma shared by several service instances. */
export class FakeDb {
  rows = new Map<number, Row>();
  nasRows: Row[] = [];
  failUpdateWhen: ((data: Row) => boolean) | null = null;

  private matches(r: Row, where: Row): boolean {
    for (const [k, v] of Object.entries(where ?? {})) {
      if (k === 'OR') {
        if (!(v as Row[]).some((c) => this.matches(r, c))) return false;
        continue;
      }
      if (v === null) {
        if (r[k] != null) return false;
        continue;
      }
      if (typeof v === 'object' && !(v instanceof Date)) {
        if ('not' in v && r[k] === v.not) return false;
        if ('lt' in v && !(r[k] != null && r[k] < v.lt)) return false;
        if ('gt' in v && !(r[k] != null && r[k] > v.gt)) return false;
        continue;
      }
      if (r[k] !== v) return false;
    }
    return true;
  }

  private unique(nasId: number, data: Row) {
    for (const col of ['mgmtPublicHost', 'localAddress', 'remoteAddress']) {
      if (data[col] == null) continue;
      for (const r of this.rows.values()) {
        if (r.nasId !== nasId && r[col] === data[col])
          throw Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
          });
      }
    }
  }

  private defaults(nasId: number): Row {
    return {
      nasId,
      clientState: 'disconnected',
      clientLockOwner: null,
      clientLockUntil: null,
      clientCancelRequested: false,
      mgmtApplyState: 'none',
      connectTimeoutSec: 30,
      retryCount: 1,
      retryDelaySec: 5,
    };
  }

  nas = {
    findUnique: async ({ where }: any) =>
      this.nasRows.find((n) => n.id === where.id) ?? null,
    findMany: async () => this.nasRows.map((n) => ({ ...n })),
  };

  nasL2tpConfig = {
    findUnique: async ({ where }: any) =>
      this.rows.has(where.nasId) ? { ...this.rows.get(where.nasId) } : null,
    findMany: async ({ where }: any = {}) =>
      [...this.rows.values()]
        .filter((r) => this.matches(r, where))
        .map((r) => ({ ...r })),
    upsert: async ({ where, create, update }: any) => {
      const existing = this.rows.get(where.nasId);
      const next = existing
        ? { ...existing, ...update }
        : { ...this.defaults(where.nasId), ...create };
      this.unique(where.nasId, next);
      this.rows.set(where.nasId, next);
      return { ...next };
    },
    update: async ({ where, data }: any) => {
      const r = this.rows.get(where.nasId);
      if (!r)
        throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      if (this.failUpdateWhen?.(data)) throw new Error('database unavailable');
      Object.assign(r, data);
      return { ...r };
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const r of this.rows.values())
        if (this.matches(r, where)) {
          Object.assign(r, data);
          count++;
        }
      return { count };
    },
  };

  $transaction = async (fn: (tx: any) => Promise<any>) => fn(this);
  $executeRaw = async () => 0;
}

export function fakeSecrets() {
  return {
    encryptValue: (v: string) => `enc:${Buffer.from(v).toString('base64')}`,
    decryptValue: (v: string) =>
      v?.startsWith('enc:')
        ? Buffer.from(v.slice(4), 'base64').toString()
        : null,
  };
}

/** Realistic host inventory (`ip -j -4 addr/route` of the audit VM). */
export const HOST_INVENTORY = {
  addresses: ['127.0.0.1', '192.168.1.167'],
  networks: [{ net: 0xc0a80000, bits: 23, text: '192.168.0.0/23' }],
  gateways: ['192.168.1.1'],
};

/**
 * One simulated Linux host shared by several "workers": the REAL
 * L2tpClientDialer host-lock code runs against an in-memory filesystem, and
 * each worker gets its own process id so a crash can be simulated by marking
 * that pid dead.
 */
export class SharedHost {
  files = new Map<string, string>();
  dirs = new Set<string>();
  dead = new Set<number>();
}

const {
  L2tpClientDialer: RealDialer,
} = require('./l2tp-client-dialer.service');

export function hostLocks(shared: SharedHost, pid: number) {
  const d = new RealDialer();
  d.sleep = async () => undefined;
  d.isAlive = (p: number) => !shared.dead.has(p);
  d.files = {
    writeSecret: async (f: string, data: string) => {
      shared.files.set(f, data);
    },
    read: async (f: string) => shared.files.get(f) ?? null,
    remove: async (f: string) => {
      shared.files.delete(f);
    },
    lockCreate: async (dir: string, owner: string) => {
      if (shared.dirs.has(dir)) return 'exists';
      shared.dirs.add(dir);
      shared.files.set(`${dir}/owner.json`, owner);
      return 'ok';
    },
    lockRemove: async (dir: string) => {
      shared.dirs.delete(dir);
      shared.files.delete(`${dir}/owner.json`);
    },
  };
  return {
    acquireHostLock: (nasId: number, owner: { token: string; pid: number }) =>
      d.acquireHostLock(nasId, { ...owner, pid }),
    releaseHostLock: (nasId: number, owner: { token: string; pid: number }) =>
      d.releaseHostLock(nasId, { ...owner, pid }),
  };
}
