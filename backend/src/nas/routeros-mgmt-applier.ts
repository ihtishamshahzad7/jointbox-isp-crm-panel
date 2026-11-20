/**
 * RouterOS side of the NAS management VPN — failure-safe apply and verified
 * rollback. No I/O of its own: it drives a RouterOS API session supplied by
 * the caller (`connect`) and persists through a caller-supplied callback, so
 * every failure point can be injected in tests.
 *
 * What it manages on the NAS (and nothing else):
 *   1. /interface l2tp-server server: enabled, use-ipsec, ipsec-secret,
 *      authentication (mschap2 added, other methods kept).
 *   2. ONE /ppp secret, comment `uplinko-mgmt-vpn`, service=l2tp.
 *   3. Four /ip firewall filter input rules, comment `uplinko-mgmt-vpn guard
 *      nas=<id> …`, placed at the top:
 *        accept UDP 500,4500 from the Uplinko public IP     (IKE / NAT-T)
 *        accept ipsec-esp from the Uplinko public IP        (ESP)
 *        accept UDP 1701 from the Uplinko public IP, ipsec-policy=in,ipsec
 *        drop   UDP 1701 from anywhere else
 *      Together with use-ipsec=required and a PSK only Uplinko holds, no
 *      customer PPP secret (service=any or service=l2tp) can log in over this
 *      L2TP server. PPPoE, RADIUS and other IPsec peers are untouched: only
 *      UDP 1701 is dropped, and IKE/ESP from other sources is not filtered.
 *
 * Safety rules
 *   • Secrets are three-state: known-empty, known-value, UNKNOWN. UNKNOWN is
 *     never treated as empty. The API user must hold the `sensitive` policy
 *     and every secret field must be present in the read, or nothing is
 *     changed.
 *   • The rollback snapshot (every field this code may change) is captured,
 *     validated and PERSISTED before the first mutation.
 *   • Any failure after the first mutation restores the snapshot on a fresh
 *     API session and verifies by read-back. The outcome is reported as
 *     restored / partial / failed — never "restored" without verification.
 *   • Rollback refuses when a managed item has a value that is neither the
 *     snapshot nor what Uplinko applied (an administrator changed it since).
 */

export interface RosSession {
  send(words: string[]): Promise<any[]>;
}
export type RosConnect = <T>(fn: (c: RosSession) => Promise<T>) => Promise<T>;

export const MGMT_MARKER = 'uplinko-mgmt-vpn';
export const guardComment = (nasId: number, k: number) =>
  `${MGMT_MARKER} guard nas=${nasId} rule=${k}`;

/** A value read from the router: known (possibly empty) or unknown. */
export type Known<T> = { known: true; value: T } | { known: false };

export interface ServerState {
  enabled: boolean;
  useIpsec: string;
  ipsecSecret: string;
  authentication: string[];
}

export interface SecretState {
  id: string;
  name: string;
  password: string;
  service: string;
  profile: string;
  localAddress: string;
  remoteAddress: string;
  comment: string;
}

export interface RuleSpec {
  k: number;
  chain: string;
  protocol: string;
  'dst-port'?: string;
  'src-address'?: string;
  'ipsec-policy'?: string;
  'connection-state'?: string;
  action: string;
}

export interface Snapshot {
  version: 1;
  nasId: number;
  takenAt: string;
  server: ServerState;
  /** The Uplinko-marked secret as it was before (null = none existed). */
  secret: Omit<SecretState, 'id'> | null;
  /** Whether Uplinko's firewall guard was already in place at that moment. */
  guardInstalled: boolean;
}

export interface Desired {
  server: ServerState;
  secret: Omit<SecretState, 'id'>;
  rules: RuleSpec[];
}

export type RestoreOutcome = 'restored' | 'partial' | 'failed';

export interface ApplyInput {
  nasId: number;
  apiUser: string;
  psk: string;
  pppUser: string;
  pppPassword: string;
  profile: string;
  /** NAS side of the tunnel (secret local-address). */
  nasTunnelIp: string;
  /** Uplinko side of the tunnel (secret remote-address). */
  hostTunnelIp: string;
  /** Uplinko's public egress IPv4 as the NAS sees it. */
  hostPublicIp: string;
  confirmServerChange: boolean;
  /** Snapshot from an earlier apply: re-apply keeps the ORIGINAL rollback point. */
  existingSnapshot: Snapshot | null;
  /** Persist the snapshot before any mutation. Throwing aborts the apply. */
  persistSnapshot: (s: Snapshot, desired: Desired) => Promise<void>;
  /** Progress note after each mutation (non-secret step names). */
  onStep?: (step: string) => Promise<void> | void;
}

export type ApplyResult =
  | { ok: true; snapshot: Snapshot; desired: Desired; changed: string[] }
  | { ok: false; stage: 'refused'; code: RefusalCode; message: string }
  | {
      ok: false;
      stage: 'failed';
      code: 'mutation_failed' | 'verify_failed';
      message: string;
      failedStep: string;
      changed: string[];
      restore: RestoreReport;
    };

export type RefusalCode =
  | 'sensitive_policy_missing'
  | 'secret_unreadable'
  | 'state_ambiguous'
  | 'secret_conflict'
  | 'confirm_required'
  | 'firewall_unavailable'
  | 'l2tp_clients_present'
  | 'l2tp_clients_unreadable'
  | 'snapshot_persist_failed'
  | 'snapshot_mismatch'
  | 'read_failed';

export interface RestoreReport {
  outcome: RestoreOutcome;
  restored: string[];
  notRestored: string[];
  detail: string;
}

export class RouterOsRefusal extends Error {
  constructor(
    public readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

const has = (o: any, k: string) =>
  o != null && Object.prototype.hasOwnProperty.call(o, k);
const bool = (v: unknown) => /^(yes|true)$/i.test(String(v ?? ''));

// ── reading ────────────────────────────────────────────────────────────────

/** True only when the API user's group positively grants `sensitive`. */
export async function hasSensitivePolicy(
  c: RosSession,
  apiUser: string,
): Promise<boolean> {
  const users = await c.send(['/user/print', `?name=${apiUser}`]);
  const group = users?.[0]?.group;
  if (!group) return false;
  const groups = await c.send(['/user/group/print', `?name=${group}`]);
  const policy = String(groups?.[0]?.policy ?? '');
  return policy
    .split(',')
    .map((p) => p.trim())
    .includes('sensitive');
}

export async function readServer(
  c: RosSession,
): Promise<{ state: Omit<ServerState, 'ipsecSecret'>; secret: Known<string> }> {
  const rows = await c.send(['/interface/l2tp-server/server/print']);
  const s = rows?.[0];
  if (
    !s ||
    !has(s, 'enabled') ||
    !has(s, 'use-ipsec') ||
    !has(s, 'authentication')
  ) {
    throw new RouterOsRefusal(
      'state_ambiguous',
      'The NAS returned an incomplete L2TP server configuration.',
    );
  }
  return {
    state: {
      enabled: bool(s.enabled),
      useIpsec: String(s['use-ipsec']).toLowerCase(),
      authentication: String(s.authentication)
        .split(',')
        .map((x: string) => x.trim())
        .filter(Boolean),
    },
    // Absent field = the router withheld it (no `sensitive` policy). That is UNKNOWN, not empty.
    secret: has(s, 'ipsec-secret')
      ? { known: true, value: String(s['ipsec-secret']) }
      : { known: false },
  };
}

export async function readSecret(
  c: RosSession,
  name: string,
): Promise<
  (Omit<SecretState, 'password'> & { password: Known<string> }) | null
> {
  const rows = await c.send(['/ppp/secret/print', `?name=${name}`]);
  if (!rows?.length) return null;
  if (rows.length > 1)
    throw new RouterOsRefusal(
      'state_ambiguous',
      `The NAS has ${rows.length} PPP secrets named "${name}".`,
    );
  const s = rows[0];
  return {
    id: String(s['.id'] ?? ''),
    name: String(s.name ?? ''),
    service: String(s.service ?? ''),
    profile: String(s.profile ?? ''),
    localAddress: String(s['local-address'] ?? ''),
    remoteAddress: String(s['remote-address'] ?? ''),
    comment: String(s.comment ?? ''),
    password: has(s, 'password')
      ? { known: true, value: String(s.password) }
      : { known: false },
  };
}

/** `/interface l2tp-client print` — every configured client, enabled or not. */
export async function readL2tpClients(
  c: RosSession,
): Promise<{ name: string; disabled: boolean; running: boolean }[]> {
  let rows: any;
  try {
    rows = await c.send(['/interface/l2tp-client/print']);
  } catch {
    rows = undefined;
  }
  if (
    !Array.isArray(rows) ||
    rows.some((r) => !r || typeof r !== 'object' || !has(r, 'name'))
  ) {
    throw new RouterOsRefusal(
      'l2tp_clients_unreadable',
      'The NAS list of L2TP client interfaces could not be read reliably, so Uplinko cannot rule out disrupting them. Nothing was changed.',
    );
  }
  return rows.map((r: any) => ({
    name: String(r.name),
    disabled: bool(r.disabled),
    running: bool(r.running),
  }));
}

export async function readRules(c: RosSession): Promise<any[]> {
  const rows = await c.send(['/ip/firewall/filter/print']);
  if (!Array.isArray(rows))
    throw new RouterOsRefusal(
      'firewall_unavailable',
      'The NAS firewall filter list could not be read.',
    );
  return rows;
}

export function guardRules(hostPublicIp: string): RuleSpec[] {
  return [
    {
      k: 1,
      chain: 'input',
      protocol: 'udp',
      'dst-port': '500,4500',
      'src-address': hostPublicIp,
      action: 'accept',
    },
    {
      k: 2,
      chain: 'input',
      protocol: 'ipsec-esp',
      'src-address': hostPublicIp,
      action: 'accept',
    },
    {
      k: 3,
      chain: 'input',
      protocol: 'udp',
      'dst-port': '1701',
      'src-address': hostPublicIp,
      'ipsec-policy': 'in,ipsec',
      action: 'accept',
    },
    {
      // Only NEW inbound L2TP sessions are dropped. Established/related
      // packets — e.g. replies to the router's OWN outgoing L2TP clients —
      // are not matched and continue to the administrator's rules.
      k: 4,
      chain: 'input',
      protocol: 'udp',
      'dst-port': '1701',
      'connection-state': 'new',
      action: 'drop',
    },
  ];
}

const RULE_KEYS = [
  'chain',
  'protocol',
  'dst-port',
  'src-address',
  'ipsec-policy',
  'connection-state',
  'action',
] as const;

function ruleMatches(row: any, spec: RuleSpec, nasId: number): boolean {
  if (row?.comment !== guardComment(nasId, spec.k)) return false;
  if (bool(row?.disabled)) return false;
  return RULE_KEYS.every(
    (k) => String(row?.[k] ?? '') === String((spec as any)[k] ?? ''),
  );
}

const ourRules = (rows: any[], nasId: number) =>
  rows.filter(
    (r) =>
      typeof r?.comment === 'string' &&
      r.comment.startsWith(`${MGMT_MARKER} guard nas=${nasId} `),
  );

/** Our guard rules exist exactly once each, match, are enabled, and are the first input rules. */
export function rulesInPlace(
  rows: any[],
  nasId: number,
  specs: RuleSpec[],
): boolean {
  const input = rows.filter((r) => r?.chain === 'input');
  if (input.length < specs.length) return false;
  if (ourRules(rows, nasId).length !== specs.length) return false;
  return specs.every((spec, i) => ruleMatches(input[i], spec, nasId));
}

// ── apply ──────────────────────────────────────────────────────────────────

export class RouterOsMgmtApplier {
  constructor(private readonly connect: RosConnect) {}

  /** Read-only plan. Throws RouterOsRefusal for anything apply would refuse. */
  async inspect(
    input: Pick<
      ApplyInput,
      'nasId' | 'apiUser' | 'psk' | 'pppUser' | 'hostPublicIp'
    >,
  ) {
    return this.connect(async (c) => {
      const pre = await this.preflight(c, input as ApplyInput);
      return pre.plan;
    });
  }

  private async preflight(c: RosSession, input: ApplyInput) {
    if (!(await hasSensitivePolicy(c, input.apiUser).catch(() => false))) {
      throw new RouterOsRefusal(
        'sensitive_policy_missing',
        'The RouterOS API user needs the "sensitive" policy so Uplinko can read and preserve the existing IPsec secret. Nothing was changed.',
      );
    }
    // Existing outbound L2TP clients on the router: never touched, and their
    // presence stops the apply (fail closed if the list cannot be read).
    const clients = await readL2tpClients(c);
    if (clients.length) {
      throw new RouterOsRefusal(
        'l2tp_clients_present',
        `The NAS has ${clients.length} L2TP client interface(s) (${clients
          .map(
            (x) =>
              `${x.name}${x.disabled ? ' (disabled)' : x.running ? ' (running)' : ''}`,
          )
          .join(
            ', ',
          )}). Uplinko will not change the L2TP/IPsec configuration of a router that also dials out over L2TP. Nothing was changed.`,
      );
    }
    const server = await readServer(c);
    if (!server.secret.known) {
      throw new RouterOsRefusal(
        'secret_unreadable',
        'The NAS did not return its current L2TP IPsec secret, so it cannot be preserved. Nothing was changed.',
      );
    }
    const secret = await readSecret(c, input.pppUser);
    if (secret && secret.comment !== MGMT_MARKER) {
      throw new RouterOsRefusal(
        'secret_conflict',
        `A PPP secret named "${input.pppUser}" exists on the NAS and is not managed by Uplinko.`,
      );
    }
    if (secret && !secret.password.known) {
      throw new RouterOsRefusal(
        'secret_unreadable',
        'The NAS did not return the password of the existing Uplinko PPP secret, so it cannot be preserved.',
      );
    }
    let rules: any[];
    try {
      rules = await readRules(c);
    } catch {
      throw new RouterOsRefusal(
        'firewall_unavailable',
        'The NAS firewall could not be read, so the management service cannot be restricted. Nothing was changed.',
      );
    }
    const current: ServerState = {
      ...server.state,
      ipsecSecret: server.secret.value,
    };
    const keyDiffers = current.ipsecSecret !== input.psk;
    const changes: string[] = [];
    if (current.useIpsec !== 'required')
      changes.push('require IPsec for L2TP (use-ipsec=required)');
    if (keyDiffers)
      changes.push('set the L2TP IPsec secret to the saved pre-shared key');
    if (!current.authentication.includes('mschap2'))
      changes.push('allow MS-CHAPv2');
    if (!current.enabled) changes.push('enable the L2TP server');
    if (!rulesInPlace(rules, input.nasId, guardRules(input.hostPublicIp)))
      changes.push(
        'install the Uplinko firewall guard (L2TP only from Uplinko over IPsec)',
      );
    changes.push(
      secret
        ? 'update the Uplinko PPP secret'
        : 'create the Uplinko PPP secret (service=l2tp)',
    );
    // A running server with other clients: replacing its key or forcing IPsec cuts them off.
    const confirmReasons: string[] = [];
    if (current.enabled && current.ipsecSecret !== '' && keyDiffers)
      confirmReasons.push(
        "replaces the IPsec secret used by the NAS's other L2TP clients",
      );
    if (current.enabled && current.useIpsec !== 'required')
      confirmReasons.push(
        'makes IPsec mandatory for every L2TP client of this NAS',
      );
    if (current.enabled)
      confirmReasons.push(
        "only Uplinko will be able to use this NAS's L2TP server afterwards (firewall guard)",
      );
    return {
      current,
      secret,
      rules,
      plan: {
        changes,
        requiresConfirmation:
          current.enabled &&
          (keyDiffers ||
            current.useIpsec !== 'required' ||
            !rulesInPlace(rules, input.nasId, guardRules(input.hostPublicIp))),
        confirmReasons,
      },
    };
  }

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const changed: string[] = [];
    let mutating = false;
    /** Router state right before THIS call — what a failed call restores. */
    let callState: Snapshot | null = null;
    let snapshot: Snapshot | null = null;
    let desired: Desired | null = null;
    let failedStep = 'connect';
    try {
      return await this.connect(async (c) => {
        failedStep = 'read';
        const pre = await this.preflight(c, input);
        if (pre.plan.requiresConfirmation && !input.confirmServerChange) {
          throw new RouterOsRefusal(
            'confirm_required',
            `Confirmation required: this ${pre.plan.confirmReasons.join('; ')}.`,
          );
        }

        callState = {
          version: 1,
          nasId: input.nasId,
          takenAt: new Date().toISOString(),
          server: pre.current,
          secret: pre.secret
            ? {
                name: pre.secret.name,
                password: (pre.secret.password as any).value,
                service: pre.secret.service,
                profile: pre.secret.profile,
                localAddress: pre.secret.localAddress,
                remoteAddress: pre.secret.remoteAddress,
                comment: pre.secret.comment,
              }
            : null,
          guardInstalled: rulesInPlace(
            pre.rules,
            input.nasId,
            guardRules(input.hostPublicIp),
          ),
        };
        // Long-term rollback point: keep the ORIGINAL from an earlier apply.
        snapshot = input.existingSnapshot ?? callState;
        if (!validSnapshot(snapshot, input.nasId)) {
          throw new RouterOsRefusal(
            'snapshot_mismatch',
            'The stored rollback point is invalid for this NAS. Nothing was changed.',
          );
        }
        desired = {
          server: {
            enabled: true,
            useIpsec: 'required',
            ipsecSecret: input.psk,
            authentication: pre.current.authentication.includes('mschap2')
              ? pre.current.authentication
              : [...pre.current.authentication, 'mschap2'],
          },
          secret: {
            name: input.pppUser,
            password: input.pppPassword,
            service: 'l2tp',
            profile: input.profile,
            localAddress: input.nasTunnelIp,
            remoteAddress: input.hostTunnelIp,
            comment: MGMT_MARKER,
          },
          rules: guardRules(input.hostPublicIp),
        };
        failedStep = 'persist-snapshot';
        try {
          await input.persistSnapshot(snapshot, desired);
        } catch {
          throw new RouterOsRefusal(
            'snapshot_persist_failed',
            'The rollback point could not be saved, so the NAS was not changed.',
          );
        }

        const step = async (name: string, fn: () => Promise<unknown>) => {
          failedStep = name;
          // From here on the router MAY have changed — even if the call throws
          // (an API disconnect right after the router applied it).
          mutating = true;
          await fn();
          changed.push(name);
          await input.onStep?.(name);
        };

        // 1. Firewall guard FIRST — the L2TP server is never reachable unguarded.
        if (!rulesInPlace(pre.rules, input.nasId, desired.rules)) {
          for (const r of ourRules(pre.rules, input.nasId)) {
            await step(`firewall-remove-stale ${r.comment}`, () =>
              c.send(['/ip/firewall/filter/remove', `=.id=${r['.id']}`]),
            );
          }
          // Insert in reverse at the very top so the final order is rule 1..4.
          for (const spec of [...desired.rules].reverse()) {
            const rows = await readRules(c);
            const first = rows[0]?.['.id'];
            const words = [
              '/ip/firewall/filter/add',
              ...RULE_KEYS.filter((k) => (spec as any)[k] !== undefined).map(
                (k) => `=${k}=${(spec as any)[k]}`,
              ),
              `=comment=${guardComment(input.nasId, spec.k)}`,
              ...(first ? [`=place-before=${first}`] : []),
            ];
            await step(`firewall-add rule=${spec.k}`, () => c.send(words));
          }
        }
        // 2. Secure the server before enabling it.
        const s = desired.server;
        if (
          pre.current.ipsecSecret !== s.ipsecSecret ||
          pre.current.useIpsec !== s.useIpsec
        ) {
          await step('server-ipsec', () =>
            c.send([
              '/interface/l2tp-server/server/set',
              `=use-ipsec=${s.useIpsec}`,
              `=ipsec-secret=${s.ipsecSecret}`,
            ]),
          );
        }
        if (
          pre.current.authentication.join(',') !== s.authentication.join(',')
        ) {
          await step('server-authentication', () =>
            c.send([
              '/interface/l2tp-server/server/set',
              `=authentication=${s.authentication.join(',')}`,
            ]),
          );
        }
        // 3. The PPP secret.
        const d = desired.secret;
        const attrs = [
          `=password=${d.password}`,
          `=service=${d.service}`,
          `=profile=${d.profile}`,
          `=local-address=${d.localAddress}`,
          `=remote-address=${d.remoteAddress}`,
          `=comment=${d.comment}`,
        ];
        if (pre.secret)
          await step('ppp-secret-update', () =>
            c.send(['/ppp/secret/set', `=.id=${pre.secret!.id}`, ...attrs]),
          );
        else
          await step('ppp-secret-create', () =>
            c.send(['/ppp/secret/add', `=name=${d.name}`, ...attrs]),
          );
        // 4. Enable last, once everything protecting it is in place.
        if (!pre.current.enabled)
          await step('server-enable', () =>
            c.send(['/interface/l2tp-server/server/set', '=enabled=yes']),
          );

        failedStep = 'verify';
        const v = await verifyDesired(c, input.nasId, desired);
        if (!v.ok)
          throw Object.assign(
            new Error(`read-back mismatch: ${v.mismatch.join(', ')}`),
            { verify: true },
          );
        return {
          ok: true as const,
          snapshot: snapshot,
          desired: desired,
          changed,
        };
      });
    } catch (e: any) {
      if (e instanceof RouterOsRefusal)
        return {
          ok: false,
          stage: 'refused',
          code: e.code,
          message: e.message,
        };
      if (!mutating) {
        // Nothing was changed on the router.
        return {
          ok: false,
          stage: 'refused',
          code: 'read_failed',
          message:
            'The NAS could not be read or configured; nothing was changed.',
        };
      }
      const restore =
        callState && desired
          ? await this.restore(input.nasId, callState, desired, {
              requireNoForeignChange: false,
            })
          : {
              outcome: 'failed' as const,
              restored: [],
              notRestored: changed,
              detail: 'No rollback point was available.',
            };
      return {
        ok: false,
        stage: 'failed',
        code: e?.verify ? 'verify_failed' : 'mutation_failed',
        message: e?.verify
          ? 'The NAS did not confirm the applied settings.'
          : `The NAS stopped responding or refused a change during "${failedStep}".`,
        failedStep,
        changed,
        restore,
      };
    }
  }

  // ── restore / rollback ───────────────────────────────────────────────────

  /**
   * Bring every managed item back to the snapshot on a FRESH session and
   * verify. With requireNoForeignChange, refuse (change nothing) if any item
   * holds a value that is neither the snapshot nor what Uplinko applied.
   */
  async restore(
    nasId: number,
    snap: Snapshot,
    desired: Desired,
    opts: { requireNoForeignChange: boolean },
  ): Promise<RestoreReport> {
    const restored: string[] = [];
    const notRestored: string[] = [];
    try {
      return await this.connect(async (c) => {
        const server = await readServer(c);
        if (!server.secret.known) {
          return {
            outcome: 'failed' as const,
            restored,
            notRestored: ['server'],
            detail:
              'The NAS does not return its IPsec secret now, so the restore cannot be verified. Manual intervention required.',
          };
        }
        const cur: ServerState = {
          ...server.state,
          ipsecSecret: server.secret.value,
        };
        const secret = await readSecret(c, desired.secret.name);
        const rules = await readRules(c);

        if (opts.requireNoForeignChange) {
          const foreign: string[] = [];
          const eitherOf = (a: unknown, b: unknown, x: unknown) =>
            JSON.stringify(x) === JSON.stringify(a) ||
            JSON.stringify(x) === JSON.stringify(b);
          if (
            !eitherOf(snap.server.enabled, desired.server.enabled, cur.enabled)
          )
            foreign.push('server enabled');
          if (
            !eitherOf(
              snap.server.useIpsec,
              desired.server.useIpsec,
              cur.useIpsec,
            )
          )
            foreign.push('server use-ipsec');
          if (
            !eitherOf(
              snap.server.ipsecSecret,
              desired.server.ipsecSecret,
              cur.ipsecSecret,
            )
          )
            foreign.push('server ipsec-secret');
          if (
            !eitherOf(
              snap.server.authentication,
              desired.server.authentication,
              cur.authentication,
            )
          )
            foreign.push('server authentication');
          if (secret && secret.comment !== MGMT_MARKER)
            foreign.push('ppp secret (no longer Uplinko-managed)');
          if (secret && secret.comment === MGMT_MARKER) {
            const now = {
              service: secret.service,
              profile: secret.profile,
              localAddress: secret.localAddress,
              remoteAddress: secret.remoteAddress,
            };
            const want = {
              service: desired.secret.service,
              profile: desired.secret.profile,
              localAddress: desired.secret.localAddress,
              remoteAddress: desired.secret.remoteAddress,
            };
            const was = snap.secret
              ? {
                  service: snap.secret.service,
                  profile: snap.secret.profile,
                  localAddress: snap.secret.localAddress,
                  remoteAddress: snap.secret.remoteAddress,
                }
              : null;
            if (!eitherOf(want, was, now)) foreign.push('ppp secret');
          }
          for (const r of ourRules(rules, nasId)) {
            const spec = desired.rules.find(
              (x) => r.comment === guardComment(nasId, x.k),
            );
            if (!spec || !ruleMatches(r, spec, nasId))
              foreign.push(`firewall ${r.comment}`);
          }
          if (foreign.length) {
            return {
              outcome: 'failed' as const,
              restored,
              notRestored: foreign,
              detail: `Changed on the NAS since Uplinko applied it: ${foreign.join(', ')}. Automatic rollback refused — manual intervention required.`,
            };
          }
        }

        const attempt = async (item: string, fn: () => Promise<unknown>) => {
          try {
            await fn();
            restored.push(item);
          } catch {
            notRestored.push(item);
          }
        };
        // Reverse order of apply: disable first so nothing is exposed meanwhile.
        if (cur.enabled !== snap.server.enabled)
          await attempt('server-enable', () =>
            c.send([
              '/interface/l2tp-server/server/set',
              `=enabled=${snap.server.enabled ? 'yes' : 'no'}`,
            ]),
          );
        if (secret && secret.comment === MGMT_MARKER) {
          if (snap.secret) {
            await attempt('ppp-secret', () =>
              c.send([
                '/ppp/secret/set',
                `=.id=${secret.id}`,
                `=password=${snap.secret!.password}`,
                `=service=${snap.secret!.service}`,
                `=profile=${snap.secret!.profile}`,
                `=local-address=${snap.secret!.localAddress}`,
                `=remote-address=${snap.secret!.remoteAddress}`,
                `=comment=${snap.secret!.comment}`,
              ]),
            );
          } else {
            await attempt('ppp-secret', () =>
              c.send(['/ppp/secret/remove', `=.id=${secret.id}`]),
            );
          }
        }
        if (
          cur.authentication.join(',') !== snap.server.authentication.join(',')
        ) {
          await attempt('server-authentication', () =>
            c.send([
              '/interface/l2tp-server/server/set',
              `=authentication=${snap.server.authentication.join(',')}`,
            ]),
          );
        }
        if (
          cur.useIpsec !== snap.server.useIpsec ||
          cur.ipsecSecret !== snap.server.ipsecSecret
        ) {
          await attempt('server-ipsec', () =>
            c.send([
              '/interface/l2tp-server/server/set',
              `=use-ipsec=${snap.server.useIpsec}`,
              `=ipsec-secret=${snap.server.ipsecSecret}`,
            ]),
          );
        }
        // The guard is removed only if it was not there before; when it was,
        // it stays (an enabled server must never be left unguarded).
        if (!snap.guardInstalled) {
          for (const r of ourRules(rules, nasId)) {
            await attempt(`firewall ${r.comment}`, () =>
              c.send(['/ip/firewall/filter/remove', `=.id=${r['.id']}`]),
            );
          }
        }

        // Verify by read-back — the only basis for "restored".
        const after = await readServer(c);
        const afterSecret = await readSecret(c, desired.secret.name);
        const afterRules = await readRules(c);
        const bad: string[] = [];
        if (!after.secret.known) bad.push('server ipsec-secret (unreadable)');
        else {
          if (after.secret.value !== snap.server.ipsecSecret)
            bad.push('server ipsec-secret');
        }
        if (after.state.enabled !== snap.server.enabled)
          bad.push('server enabled');
        if (after.state.useIpsec !== snap.server.useIpsec)
          bad.push('server use-ipsec');
        if (
          after.state.authentication.join(',') !==
          snap.server.authentication.join(',')
        )
          bad.push('server authentication');
        if (snap.secret) {
          if (
            !afterSecret ||
            afterSecret.service !== snap.secret.service ||
            afterSecret.profile !== snap.secret.profile ||
            afterSecret.localAddress !== snap.secret.localAddress ||
            afterSecret.remoteAddress !== snap.secret.remoteAddress
          )
            bad.push('ppp secret');
        } else if (afterSecret && afterSecret.comment === MGMT_MARKER)
          bad.push('ppp secret');
        if (
          snap.guardInstalled
            ? !rulesInPlace(afterRules, nasId, desired.rules)
            : ourRules(afterRules, nasId).length > 0
        )
          bad.push('firewall guard');
        if (!bad.length)
          return {
            outcome: 'restored' as const,
            restored,
            notRestored: [],
            detail:
              'The NAS was restored to its previous settings and verified by read-back.',
          };
        return {
          outcome: (restored.length ? 'partial' : 'failed') as RestoreOutcome,
          restored,
          notRestored: [...new Set([...notRestored, ...bad])],
          detail: `Not restored (verified by read-back): ${[...new Set(bad)].join(', ')}. Manual intervention required.`,
        };
      });
    } catch {
      return {
        outcome: restored.length ? 'partial' : 'failed',
        restored,
        notRestored: notRestored.length ? notRestored : ['all managed items'],
        detail:
          'The NAS could not be reached to restore or verify its settings. Manual intervention required.',
      };
    }
  }
}

export type RecoveryState =
  'at_snapshot' | 'at_desired' | 'mixed' | 'foreign' | 'unreadable';

/**
 * After an interrupted apply: where is the router now? Read-only.
 *   at_snapshot — every managed item still equals the pre-apply snapshot
 *   at_desired  — every managed item equals what Uplinko set (apply completed)
 *   mixed       — each item equals one of the two (rollback is safe)
 *   foreign     — some item matches neither (manual intervention)
 *   unreadable  — the router could not be read reliably
 */
export async function classifyRouter(
  connect: RosConnect,
  nasId: number,
  snap: Snapshot,
  desired: Desired,
): Promise<{
  state: RecoveryState;
  items: Record<
    string,
    'snapshot' | 'desired' | 'both' | 'foreign' | 'desired-partial'
  >;
}> {
  try {
    return await connect(async (c) => {
      const server = await readServer(c);
      if (!server.secret.known)
        return { state: 'unreadable' as const, items: {} };
      const secret = await readSecret(c, desired.secret.name);
      const rules = await readRules(c);
      const items: Record<
        string,
        'snapshot' | 'desired' | 'both' | 'foreign' | 'desired-partial'
      > = {};
      const cmp = (key: string, cur: unknown, s: unknown, d: unknown) => {
        const a = JSON.stringify(cur) === JSON.stringify(s);
        const b = JSON.stringify(cur) === JSON.stringify(d);
        items[key] =
          a && b ? 'both' : a ? 'snapshot' : b ? 'desired' : 'foreign';
      };
      cmp(
        'server enabled',
        server.state.enabled,
        snap.server.enabled,
        desired.server.enabled,
      );
      cmp(
        'server use-ipsec',
        server.state.useIpsec,
        snap.server.useIpsec,
        desired.server.useIpsec,
      );
      cmp(
        'server ipsec-secret',
        server.secret.value,
        snap.server.ipsecSecret,
        desired.server.ipsecSecret,
      );
      cmp(
        'server authentication',
        server.state.authentication,
        snap.server.authentication,
        desired.server.authentication,
      );
      const view = (s: any) =>
        s
          ? {
              service: s.service,
              profile: s.profile,
              localAddress: s.localAddress,
              remoteAddress: s.remoteAddress,
              comment: s.comment,
            }
          : null;
      const curSecret =
        secret && secret.comment === MGMT_MARKER
          ? view(secret)
          : secret
            ? { foreign: true }
            : null;
      cmp('ppp secret', curSecret, view(snap.secret), view(desired.secret));
      const ours = ourRules(rules, nasId);
      const allOursMatch = ours.every((r) => {
        const spec = desired.rules.find(
          (x) => r.comment === guardComment(nasId, x.k),
        );
        return !!spec && ruleMatches(r, spec, nasId);
      });
      const guardNow =
        ours.length === 0
          ? 'absent'
          : rulesInPlace(rules, nasId, desired.rules)
            ? 'present'
            : allOursMatch
              ? 'partial'
              : 'other';
      // Some of Uplinko's own guard rules (apply stopped half-way): Uplinko-owned, not foreign.
      if (guardNow === 'partial') items['firewall guard'] = 'desired-partial';
      else
        cmp(
          'firewall guard',
          guardNow,
          snap.guardInstalled ? 'present' : 'absent',
          'present',
        );
      const vals = Object.values(items);
      const state: RecoveryState = vals.includes('foreign')
        ? 'foreign'
        : vals.every((v) => v === 'snapshot' || v === 'both')
          ? 'at_snapshot'
          : vals.every((v) => v === 'desired' || v === 'both')
            ? 'at_desired'
            : 'mixed';
      return { state, items };
    });
  } catch {
    return { state: 'unreadable', items: {} };
  }
}

export async function verifyDesired(
  c: RosSession,
  nasId: number,
  d: Desired,
): Promise<{ ok: boolean; mismatch: string[] }> {
  const m: string[] = [];
  const server = await readServer(c);
  if (!server.secret.known) m.push('ipsec-secret unreadable');
  else if (server.secret.value !== d.server.ipsecSecret) m.push('ipsec-secret');
  if (server.state.enabled !== d.server.enabled) m.push('enabled');
  if (server.state.useIpsec !== d.server.useIpsec) m.push('use-ipsec');
  if (
    !d.server.authentication.every((a) =>
      server.state.authentication.includes(a),
    )
  )
    m.push('authentication');
  const s = await readSecret(c, d.secret.name);
  if (!s) m.push('ppp secret missing');
  else {
    if (s.comment !== MGMT_MARKER) m.push('ppp secret marker');
    if (s.service !== d.secret.service) m.push('ppp secret service');
    if (s.profile !== d.secret.profile) m.push('ppp secret profile');
    if (s.localAddress !== d.secret.localAddress)
      m.push('ppp secret local-address');
    if (s.remoteAddress !== d.secret.remoteAddress)
      m.push('ppp secret remote-address');
    if (!s.password.known || s.password.value !== d.secret.password)
      m.push('ppp secret password');
  }
  if (!rulesInPlace(await readRules(c), nasId, d.rules))
    m.push('firewall guard');
  return { ok: m.length === 0, mismatch: m };
}

export function validSnapshot(s: any, nasId: number): s is Snapshot {
  return (
    !!s &&
    s.version === 1 &&
    s.nasId === nasId &&
    s.server &&
    typeof s.server.enabled === 'boolean' &&
    typeof s.server.useIpsec === 'string' &&
    typeof s.server.ipsecSecret === 'string' &&
    Array.isArray(s.server.authentication) &&
    typeof s.guardInstalled === 'boolean' &&
    (s.secret === null ||
      (typeof s.secret?.password === 'string' &&
        typeof s.secret?.name === 'string'))
  );
}
