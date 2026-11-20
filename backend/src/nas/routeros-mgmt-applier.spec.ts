/**
 * RouterOsMgmtApplier — SIMULATION tests against FakeRouter (no real MikroTik).
 * They prove the applier's decisions: secret preservation, snapshot-before-
 * mutation, verified restore after a failure at EVERY mutation, stale-rollback
 * refusal and the service=any protection. They do not prove RouterOS accepts
 * these exact API words — that needs real hardware.
 */
import { FakeRouter } from './nas-vpn-fakes.testkit-spec';
import {
  ApplyInput,
  MGMT_MARKER,
  RouterOsMgmtApplier,
  Snapshot,
  guardComment,
} from './routeros-mgmt-applier';

const PSK = 'Uplinko-Psk-2026';
const PASS = 'Uplinko-Ppp-2026';
const HOST_IP = '198.199.0.10';

function input(over: Partial<ApplyInput> = {}): {
  input: ApplyInput;
  persisted: Snapshot[];
} {
  const persisted: Snapshot[] = [];
  return {
    persisted,
    input: {
      nasId: 7,
      apiUser: 'uplinko-api',
      psk: PSK,
      pppUser: 'uplinko-mgmt',
      pppPassword: PASS,
      profile: 'default',
      nasTunnelIp: '10.255.7.1',
      hostTunnelIp: '10.255.7.2',
      hostPublicIp: HOST_IP,
      confirmServerChange: false,
      existingSnapshot: null,
      persistSnapshot: async (s) => {
        persisted.push(JSON.parse(JSON.stringify(s)));
      },
      ...over,
    },
  };
}

function freshRouter() {
  const r = new FakeRouter();
  r.server = {
    enabled: 'false',
    'use-ipsec': 'no',
    'ipsec-secret': '',
    authentication: 'pap,chap',
    'default-profile': 'default-encryption',
  };
  r.secrets = [
    {
      '.id': '*1',
      name: 'cust-any',
      password: 'cust-pass-1',
      service: 'any',
      profile: 'default',
    },
    {
      '.id': '*2',
      name: 'cust-pppoe',
      password: 'cust-pass-2',
      service: 'pppoe',
      profile: 'default',
    },
  ];
  r.rules = [
    {
      '.id': '*A',
      chain: 'input',
      action: 'accept',
      'connection-state': 'established,related',
      disabled: 'false',
      comment: 'admin: established',
    },
    {
      '.id': '*B',
      chain: 'input',
      action: 'drop',
      'in-interface': 'ether1',
      disabled: 'false',
      comment: 'admin: drop wan',
    },
  ];
  return r;
}

const state = (r: FakeRouter) =>
  JSON.parse(
    JSON.stringify({
      server: r.server,
      secrets: r.secrets,
      rules: r.rules,
      pppoe: r.pppoeServers,
    }),
  );

describe('RouterOsMgmtApplier (simulation)', () => {
  describe('CRITICAL: existing IPsec secrets are never lost', () => {
    it('audit scenario: API user without "sensitive", running server with a real key → refused before any change', async () => {
      const r = freshRouter();
      r.groups[0].policy = 'read,write,api';
      r.server = {
        enabled: 'true',
        'use-ipsec': 'yes',
        'ipsec-secret': 'Customers-Key-99',
        authentication: 'mschap2',
      };
      const before = state(r);
      const res = await new RouterOsMgmtApplier(r.connect).apply(
        input({ confirmServerChange: true }).input,
      );
      expect(res).toMatchObject({
        ok: false,
        stage: 'refused',
        code: 'sensitive_policy_missing',
      });
      expect(r.mutations()).toHaveLength(0);
      expect(state(r)).toEqual(before);
      expect(r.server['ipsec-secret']).toBe('Customers-Key-99');
      expect(JSON.stringify(res)).not.toMatch(/restored/i);
      expect(JSON.stringify(res)).not.toContain('Customers-Key-99');
    });

    it('a hidden secret shown as an EMPTY value is not mistaken for an empty key', async () => {
      const r = freshRouter();
      r.groups[0].policy = 'read,write,api';
      r.hiddenAs = 'empty';
      r.server = {
        enabled: 'true',
        'use-ipsec': 'yes',
        'ipsec-secret': 'Customers-Key-99',
        authentication: 'mschap2',
      };
      const res = await new RouterOsMgmtApplier(r.connect).apply(
        input({ confirmServerChange: true }).input,
      );
      expect(res).toMatchObject({
        ok: false,
        code: 'sensitive_policy_missing',
      });
      expect(r.server['ipsec-secret']).toBe('Customers-Key-99');
      expect(r.mutations()).toHaveLength(0);
    });

    it('policy granted but the field is still missing (ambiguous) → refused before any change', async () => {
      const r = freshRouter();
      delete r.server['ipsec-secret'];
      const res = await new RouterOsMgmtApplier(r.connect).apply(input().input);
      expect(res).toMatchObject({ ok: false, code: 'secret_unreadable' });
      expect(r.mutations()).toHaveLength(0);
    });

    it('an existing key on a disabled server is preserved in the snapshot and restored exactly', async () => {
      const r = freshRouter();
      r.server['ipsec-secret'] = 'Old-Key-1';
      const before = state(r);
      const a = new RouterOsMgmtApplier(r.connect);
      const { input: inp, persisted } = input();
      const res = await a.apply(inp);
      expect(res.ok).toBe(true);
      expect(persisted[0].server.ipsecSecret).toBe('Old-Key-1');
      if (!res.ok) return;
      const rep = await a.restore(7, res.snapshot, res.desired, {
        requireNoForeignChange: true,
      });
      expect(rep.outcome).toBe('restored');
      expect(state(r)).toEqual(before);
    });

    it("explicit replacement: a running server's different key needs confirmation; the old key is kept for rollback", async () => {
      const r = freshRouter();
      r.server = {
        enabled: 'true',
        'use-ipsec': 'required',
        'ipsec-secret': 'Customers-Key-99',
        authentication: 'mschap2',
      };
      const before = state(r);
      const a = new RouterOsMgmtApplier(r.connect);
      const refused = await a.apply(input().input);
      expect(refused).toMatchObject({ ok: false, code: 'confirm_required' });
      expect(r.mutations()).toHaveLength(0);
      const res = await a.apply(input({ confirmServerChange: true }).input);
      expect(res.ok).toBe(true);
      expect(r.server['ipsec-secret']).toBe(PSK);
      if (!res.ok) return;
      expect(res.snapshot.server.ipsecSecret).toBe('Customers-Key-99');
      expect(
        (
          await a.restore(7, res.snapshot, res.desired, {
            requireNoForeignChange: true,
          })
        ).outcome,
      ).toBe('restored');
      expect(state(r)).toEqual(before);
    });

    it('failed read-back (router ignores the key change) → restored to the original and reported as a failure', async () => {
      const r = freshRouter();
      r.server['ipsec-secret'] = 'Old-Key-1';
      r.faults.push({
        cmd: '/interface/l2tp-server/server/set',
        attr: 'ipsec-secret',
        when: 'ignore',
      });
      const before = state(r);
      const res = await new RouterOsMgmtApplier(r.connect).apply(input().input);
      expect(res).toMatchObject({
        ok: false,
        stage: 'failed',
        code: 'verify_failed',
      });
      if (res.ok || res.stage !== 'failed') return;
      expect(res.restore.outcome).toBe('restored');
      expect(state(r)).toEqual(before);
    });

    it('rollback when the router cannot be reached is reported as failed, never restored', async () => {
      const r = freshRouter();
      const a = new RouterOsMgmtApplier(r.connect);
      const res = await a.apply(input().input);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      r.down = true;
      const rep = await a.restore(7, res.snapshot, res.desired, {
        requireNoForeignChange: true,
      });
      expect(rep.outcome).toBe('failed');
      expect(rep.detail).toMatch(/manual intervention/i);
    });

    it('rollback when the key becomes unreadable later refuses to claim success', async () => {
      const r = freshRouter();
      const a = new RouterOsMgmtApplier(r.connect);
      const res = await a.apply(input().input);
      if (!res.ok) throw new Error('apply failed');
      r.groups[0].policy = 'read,write,api';
      const before = state(r);
      const rep = await a.restore(7, res.snapshot, res.desired, {
        requireNoForeignChange: true,
      });
      expect(rep.outcome).toBe('failed');
      expect(state(r)).toEqual(before);
    });
  });

  describe('HIGH: failure-safe apply — a fault after EVERY mutation', () => {
    // Mutation order on a disabled server: 4 firewall adds, ipsec set, authentication set, secret add, enable.
    const steps: [string, string | undefined, number][] = [
      ['/ip/firewall/filter/add', undefined, 1],
      ['/ip/firewall/filter/add', undefined, 2],
      ['/ip/firewall/filter/add', undefined, 3],
      ['/ip/firewall/filter/add', undefined, 4],
      ['/interface/l2tp-server/server/set', 'ipsec-secret', 1],
      ['/interface/l2tp-server/server/set', 'authentication', 1],
      ['/ppp/secret/add', undefined, 1],
      ['/interface/l2tp-server/server/set', 'enabled', 1],
    ];

    it.each(steps)(
      'API drops right AFTER %s %s #%d, router reachable again → restored and verified',
      async (cmd, attr, nth) => {
        const r = freshRouter();
        r.server['ipsec-secret'] = 'Old-Key-1';
        r.recoverOnReconnect = true;
        r.faults.push({ cmd, attr, nth, when: 'after' });
        const before = state(r);
        const res = await new RouterOsMgmtApplier(r.connect).apply(
          input().input,
        );
        expect(res).toMatchObject({ ok: false, stage: 'failed' });
        if (res.ok || res.stage !== 'failed') return;
        expect(res.restore.outcome).toBe('restored');
        expect(state(r)).toEqual(before);
      },
    );

    it.each(steps)(
      'router REJECTS %s %s #%d → earlier changes restored and verified',
      async (cmd, attr, nth) => {
        const r = freshRouter();
        r.faults.push({ cmd, attr, nth, when: 'before' });
        const before = state(r);
        const res = await new RouterOsMgmtApplier(r.connect).apply(
          input().input,
        );
        expect(res.ok).toBe(false);
        if (!res.ok && res.stage === 'failed')
          expect(res.restore.outcome).toBe('restored');
        expect(state(r)).toEqual(before);
      },
    );

    it.each(steps)(
      'API drops after %s %s #%d and the router stays unreachable → reported NOT restored',
      async (cmd, attr, nth) => {
        const r = freshRouter();
        r.faults.push({ cmd, attr, nth, when: 'after' });
        const res = await new RouterOsMgmtApplier(r.connect).apply(
          input().input,
        );
        expect(res).toMatchObject({ ok: false, stage: 'failed' });
        if (res.ok || res.stage !== 'failed') return;
        expect(res.restore.outcome).toBe('failed');
        expect(res.restore.detail).toMatch(/manual intervention/i);
      },
    );

    it('API error during the final read-back → restored', async () => {
      const r = freshRouter();
      r.recoverOnReconnect = true;
      r.faults.push({ cmd: '/ppp/secret/print', nth: 2, when: 'after' }); // 1st = preflight, 2nd = verify
      const before = state(r);
      const res = await new RouterOsMgmtApplier(r.connect).apply(input().input);
      expect(res).toMatchObject({ ok: false, stage: 'failed' });
      if (res.ok || res.stage !== 'failed') return;
      expect(res.restore.outcome).toBe('restored');
      expect(state(r)).toEqual(before);
    });

    it('snapshot persistence failure → nothing on the router changes', async () => {
      const r = freshRouter();
      const res = await new RouterOsMgmtApplier(r.connect).apply(
        input({
          persistSnapshot: async () => {
            throw new Error('db down');
          },
        }).input,
      );
      expect(res).toMatchObject({
        ok: false,
        stage: 'refused',
        code: 'snapshot_persist_failed',
      });
      expect(r.mutations()).toHaveLength(0);
    });

    it('the snapshot is persisted BEFORE the first mutation', async () => {
      const r = freshRouter();
      let mutationsAtPersist = -1;
      const res = await new RouterOsMgmtApplier(r.connect).apply(
        input({
          persistSnapshot: async () => {
            mutationsAtPersist = r.mutations().length;
          },
        }).input,
      );
      expect(res.ok).toBe(true);
      expect(mutationsAtPersist).toBe(0);
    });

    it('rollback is idempotent: a second rollback changes nothing and still verifies', async () => {
      const r = freshRouter();
      const a = new RouterOsMgmtApplier(r.connect);
      const res = await a.apply(input().input);
      if (!res.ok) throw new Error('apply failed');
      expect(
        (
          await a.restore(7, res.snapshot, res.desired, {
            requireNoForeignChange: true,
          })
        ).outcome,
      ).toBe('restored');
      const n = r.mutations().length;
      expect(
        (
          await a.restore(7, res.snapshot, res.desired, {
            requireNoForeignChange: true,
          })
        ).outcome,
      ).toBe('restored');
      expect(r.mutations()).toHaveLength(n);
    });
  });

  describe('MEDIUM D: stale rollback snapshot', () => {
    it.each([
      [
        'ipsec key rotated by an admin',
        (r: FakeRouter) => {
          r.server['ipsec-secret'] = 'Admin-New-Key';
        },
      ],
      [
        'L2TP authentication methods changed by an admin',
        (r: FakeRouter) => {
          r.server.authentication = 'chap';
        },
      ],
      [
        'Uplinko PPP secret edited',
        (r: FakeRouter) => {
          r.secrets.find((s) => s.comment === MGMT_MARKER)!.profile = 'vip';
        },
      ],
      [
        'guard rule edited',
        (r: FakeRouter) => {
          r.rules.find((x) => x.comment === guardComment(7, 4))!.action =
            'accept';
        },
      ],
    ])(
      '%s since apply → automatic rollback refused, nothing changed',
      async (_label, change) => {
        const r = freshRouter();
        const a = new RouterOsMgmtApplier(r.connect);
        const res = await a.apply(input().input);
        if (!res.ok) throw new Error('apply failed');
        change(r);
        const before = state(r);
        const n = r.mutations().length;
        const rep = await a.restore(7, res.snapshot, res.desired, {
          requireNoForeignChange: true,
        });
        expect(rep.outcome).toBe('failed');
        expect(rep.detail).toMatch(/manual intervention/i);
        expect(r.mutations()).toHaveLength(n);
        expect(state(r)).toEqual(before);
      },
    );
  });

  describe('HIGH: customer PPP accounts cannot use the management L2TP service', () => {
    it('only the Uplinko account, from the Uplinko IP, with the PSK, can log in over L2TP', async () => {
      const r = freshRouter();
      const res = await new RouterOsMgmtApplier(r.connect).apply(input().input);
      expect(res.ok).toBe(true);
      expect(
        r.canL2tpLogin({
          srcIp: HOST_IP,
          psk: PSK,
          user: 'uplinko-mgmt',
          password: PASS,
        }),
      ).toBe(true);
      // service=any customer, from the internet, no PSK / with the PSK / from Uplinko's own IP without PSK:
      expect(
        r.canL2tpLogin({
          srcIp: '8.8.4.4',
          psk: null,
          user: 'cust-any',
          password: 'cust-pass-1',
        }),
      ).toBe(false);
      expect(
        r.canL2tpLogin({
          srcIp: '8.8.4.4',
          psk: PSK,
          user: 'cust-any',
          password: 'cust-pass-1',
        }),
      ).toBe(false);
      expect(
        r.canL2tpLogin({
          srcIp: HOST_IP,
          psk: null,
          user: 'cust-any',
          password: 'cust-pass-1',
        }),
      ).toBe(false);
    });

    it('customer secrets, PPPoE server and admin firewall rules are untouched', async () => {
      const r = freshRouter();
      const before = state(r);
      await new RouterOsMgmtApplier(r.connect).apply(input().input);
      expect(r.secrets.filter((s) => s.comment !== MGMT_MARKER)).toEqual(
        before.secrets,
      );
      expect(r.pppoeServers).toEqual(before.pppoe);
      expect(
        r.rules.filter((x) => !String(x.comment).startsWith(MGMT_MARKER)),
      ).toEqual(before.rules);
      for (const w of r.mutations()) {
        expect(w.join(' ')).not.toMatch(/cust-|pppoe/);
        expect(w.filter((x) => x.startsWith('=.id='))).not.toEqual(
          expect.arrayContaining(['=.id=*1', '=.id=*2', '=.id=*A', '=.id=*B']),
        );
      }
    });

    it('firewall guard: placed first, verified, not duplicated on re-apply, removed by rollback', async () => {
      const r = freshRouter();
      const a = new RouterOsMgmtApplier(r.connect);
      const res = await a.apply(input().input);
      if (!res.ok) throw new Error('apply failed');
      expect(r.rules.slice(0, 4).map((x) => x.comment)).toEqual(
        [1, 2, 3, 4].map((k) => guardComment(7, k)),
      );
      expect(r.rules[3]).toMatchObject({
        protocol: 'udp',
        'dst-port': '1701',
        action: 'drop',
      });
      const n = r.mutations().length;
      const again = await a.apply(
        input({ existingSnapshot: res.snapshot }).input,
      );
      expect(again.ok).toBe(true);
      expect(
        r.mutations().filter((w) => w[0].startsWith('/ip/firewall')).length,
      ).toBe(
        r
          .mutations()
          .slice(0, n)
          .filter((w) => w[0].startsWith('/ip/firewall')).length,
      );
      expect(
        r.rules.filter((x) => String(x.comment).startsWith(MGMT_MARKER)),
      ).toHaveLength(4);
      expect(
        (
          await a.restore(7, res.snapshot, res.desired, {
            requireNoForeignChange: true,
          })
        ).outcome,
      ).toBe('restored');
      expect(
        r.rules.filter((x) => String(x.comment).startsWith(MGMT_MARKER)),
      ).toHaveLength(0);
    });

    it('firewall cannot be read → refused before any change', async () => {
      const r = freshRouter();
      r.faults.push({ cmd: '/ip/firewall/filter/print', when: 'before' });
      const res = await new RouterOsMgmtApplier(r.connect).apply(input().input);
      expect(res).toMatchObject({
        ok: false,
        stage: 'refused',
        code: 'firewall_unavailable',
      });
      expect(r.mutations()).toHaveLength(0);
    });

    it('guard cannot be verified in place (router ignores ordering) → apply fails and is restored', async () => {
      const r = freshRouter();
      r.ignorePlaceBefore = true;
      const before = state(r);
      const res = await new RouterOsMgmtApplier(r.connect).apply(input().input);
      expect(res).toMatchObject({
        ok: false,
        stage: 'failed',
        code: 'verify_failed',
      });
      if (!res.ok && res.stage === 'failed')
        expect(res.restore.outcome).toBe('restored');
      expect(state(r)).toEqual(before);
    });

    it('a running server used by others needs explicit confirmation (it will become Uplinko-only)', async () => {
      const r = freshRouter();
      r.server = {
        enabled: 'true',
        'use-ipsec': 'no',
        'ipsec-secret': '',
        authentication: 'mschap2',
      };
      const res = await new RouterOsMgmtApplier(r.connect).apply(input().input);
      expect(res).toMatchObject({ ok: false, code: 'confirm_required' });
      if (!res.ok && res.stage === 'refused')
        expect(res.message).toMatch(/mandatory|only Uplinko/);
      expect(r.mutations()).toHaveLength(0);
    });

    it('an existing customer secret with the Uplinko username is never taken over', async () => {
      const r = freshRouter();
      r.secrets.push({
        '.id': '*9',
        name: 'uplinko-mgmt',
        password: 'x',
        service: 'l2tp',
        comment: 'customer',
      });
      const res = await new RouterOsMgmtApplier(r.connect).apply(input().input);
      expect(res).toMatchObject({ ok: false, code: 'secret_conflict' });
      expect(r.mutations()).toHaveLength(0);
    });
  });

  it('never puts a secret into an error message or report', async () => {
    const r = freshRouter();
    r.server['ipsec-secret'] = 'Old-Key-1';
    r.faults.push({ cmd: '/ppp/secret/add', when: 'after' });
    const res = await new RouterOsMgmtApplier(r.connect).apply(input().input);
    const json = JSON.stringify(res);
    for (const s of [PSK, PASS, 'Old-Key-1']) expect(json).not.toContain(s);
  });
});
