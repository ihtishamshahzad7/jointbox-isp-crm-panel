import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../common/secrets.service';
import { NasL2tpConfigService } from './nas-l2tp-config.service';
import { withMikrotik } from './mikrotik.client';
import { decField } from './nas-credentials';
import {
  DialStatus,
  L2TP_LIMITS,
  HostLockOwner,
  L2tpClientDialer,
  isSafePppUser,
  isSafeSecret,
} from './l2tp-client-dialer.service';
import {
  HostInventory,
  checkAddressing,
  isIpv4,
  loadPolicy,
  OtherClaims,
  PolicyConfig,
} from './l2tp-address-policy';
import {
  classifyRouter,
  Desired,
  MGMT_MARKER as ROS_MARKER,
  RosConnect,
  RouterOsMgmtApplier,
  Snapshot,
  validSnapshot,
} from './routeros-mgmt-applier';

/**
 * NAS MANAGEMENT VPN — Uplinko host = L2TP/IPsec CLIENT → MikroTik NAS = SERVER.
 * Not a subscriber VPN; never touches FreeRADIUS, WireGuard or SSTP.
 *
 * Phase 1.1 guarantees (see UPLINKO-VPN-PHASE1-1-REMEDIATION-REPORT.md):
 *   • addresses: every endpoint/tunnel address passes the server-side address
 *     policy (management pool, host inventory, other NAS, protected ranges)
 *     before it is stored, dialed or written to a router — fail closed;
 *   • router: apply goes through RouterOsMgmtApplier (secret preservation,
 *     persisted snapshot before mutation, verified restore, firewall guard);
 *   • host: one operation per NAS at a time under a renewable lease with an
 *     owner token; connect/reconnect run in the background and return an
 *     operation id; disconnect never releases another operation's lease;
 *   • state: "connected" only from the dialer's live checks (including ESP).
 */

export const MGMT_MARKER = ROS_MARKER;
const LEASE_TTL_MS = 45_000;
const LEASE_RENEW_MS = 15_000;
const ADDRESS_LOCK_KEY = 727_011; // pg_advisory_xact_lock key for address claims
const ADDRESS_TX_RETRIES = 3;
const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface ClientSaveInput {
  publicHost?: string | null;
  pppUsername?: string | null;
  pppPassword?: string | null;
  ipsecPsk?: string | null;
  pppProfile?: string | null;
  localAddress?: string | null;
  remoteAddress?: string | null;
  connectTimeoutSec?: number;
  retryCount?: number;
  retryDelaySec?: number;
}

interface Lease {
  nasId: number;
  token: string;
  kind: string;
  lost: boolean;
  cancel: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

@Injectable()
export class NasL2tpClientService implements OnModuleDestroy {
  private readonly logger = new Logger(NasL2tpClientService.name);
  /** Background operations running in THIS process (for tests and shutdown). */
  private readonly running = new Map<number, Promise<unknown>>();
  private readonly leases = new Set<Lease>();
  /** Overridable for tests: how the RouterOS session is opened. */
  rosConnect: (nasId: number) => Promise<RosConnect> = async (nasId) => {
    const api = await this.nasApi(nasId);
    return (fn) => withMikrotik(api, fn as any) as any;
  };
  /** Overridable for tests. */
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly config: NasL2tpConfigService,
    private readonly dialer: L2tpClientDialer,
  ) {}

  onModuleDestroy() {
    for (const l of this.leases) if (l.timer) clearInterval(l.timer);
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private uid(actor: any): number | null {
    const n = Number(actor?.sub ?? actor?.id);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  private dec(v?: string | null): string | null {
    return v ? (this.secrets.decryptValue(v) ?? null) : null;
  }
  private async row(nasId: number) {
    return this.prisma.nasL2tpConfig.findUnique({
      where: { nasId },
    }) as Promise<any>;
  }
  private policy(): PolicyConfig {
    const p = loadPolicy(this.env);
    if ('error' in p)
      throw new BadRequestException(
        `Management VPN address policy is misconfigured on this server: ${p.error}`,
      );
    return p;
  }

  /** Masked view — the only shape this service returns for the configuration. */
  private view(nasId: number, row: any) {
    return {
      nasId,
      direction:
        'Uplinko server → NAS public IP (Uplinko is the L2TP/IPsec client)',
      publicHost: row?.mgmtPublicHost ?? null,
      pppUsername: row?.pppUsername ?? null,
      pppProfile: row?.pppProfile ?? null,
      hasPppPassword: !!row?.pppPasswordEnc,
      hasIpsecPsk: !!row?.mgmtIpsecPskEnc,
      localAddress: row?.localAddress ?? null,
      remoteAddress: row?.remoteAddress ?? null,
      interface: this.dialer.ifName(nasId),
      connectTimeoutSec: row?.connectTimeoutSec ?? 30,
      retryCount: row?.retryCount ?? 1,
      retryDelaySec: row?.retryDelaySec ?? 5,
      clientState: row?.clientState ?? 'disconnected',
      operation:
        row?.clientOpId && this.busy(row)
          ? {
              id: row.clientOpId,
              kind: row.clientOpKind,
              startedAt: row.clientOpStartedAt,
              cancelRequested: !!row.clientCancelRequested,
            }
          : null,
      lastDialAt: row?.lastDialAt ?? null,
      lastConnectedAt: row?.lastConnectedAt ?? null,
      lastDisconnectedAt: row?.lastDisconnectedAt ?? null,
      lastClientErrorCode: row?.lastClientErrorCode ?? null,
      lastClientError: row?.lastClientError ?? null,
      nasApplyState: this.applyStateOf(row),
      nasApplyDetail: row?.mgmtApplyDetail ?? null,
      nasAppliedAt: row?.nasAppliedAt ?? null,
      rollbackAvailable: !!row?.mgmtSnapshotEnc,
      tunnelUsedForRouterAccess: false,
    };
  }

  /**
   * An apply whose lease expired without finishing is not "applying" any
   * more — it is an interrupted operation that needs recovery.
   */
  private applyStateOf(row: any): string {
    const s = row?.mgmtApplyState ?? 'none';
    return s === 'applying' && !this.busy(row) ? 'recovery_required' : s;
  }

  /** Every claim of OTHER NAS plus every NAS address the app knows. */
  private async otherClaims(db: any, nasId: number): Promise<OtherClaims> {
    const rows = (await db.nasL2tpConfig.findMany({
      where: { nasId: { not: nasId } },
      select: { localAddress: true, remoteAddress: true, mgmtPublicHost: true },
    })) as any[];
    const nas = (await db.nas.findMany({
      select: { nasIp: true, nasname: true },
    })) as any[];
    const strip = (v: unknown) => String(v ?? '').replace(/\/\d+$/, '');
    return {
      tunnelAddresses: rows
        .flatMap((r) => [r.localAddress, r.remoteAddress])
        .filter(Boolean),
      endpoints: rows.map((r) => r.mgmtPublicHost).filter(Boolean),
      nasIps: nas
        .flatMap((n) => [strip(n.nasIp), strip(n.nasname)])
        .filter(isIpv4),
    };
  }

  /** Throws 400 with every violation, or returns when the addressing is allowed. */
  private async assertAddressing(
    db: any,
    nasId: number,
    a: {
      endpoint?: string | null;
      localAddress?: string | null;
      remoteAddress?: string | null;
    },
    inventoryIn?: HostInventory | null,
  ) {
    const policy = this.policy();
    const inventory =
      inventoryIn !== undefined
        ? inventoryIn
        : await this.dialer.inventory().catch(() => null);
    const errs = checkAddressing(
      a,
      policy,
      inventory,
      await this.otherClaims(db, nasId),
    );
    if (errs.length) throw new BadRequestException(errs.join(' '));
  }

  // ── lease (one operation per NAS across all PM2 workers) ─────────────────
  private async acquire(
    nasId: number,
    kind: string,
    extra: Record<string, unknown> = {},
  ): Promise<Lease | null> {
    const now = new Date();
    const token = randomUUID();
    const res = (await this.prisma.nasL2tpConfig.updateMany({
      where: {
        nasId,
        OR: [{ clientLockUntil: null }, { clientLockUntil: { lt: now } }],
      },
      data: {
        clientLockOwner: token,
        clientLockUntil: new Date(now.getTime() + LEASE_TTL_MS),
        clientOpId: token,
        clientOpKind: kind,
        clientOpStartedAt: now,
        clientCancelRequested: false,
        ...extra,
      },
    })) as any;
    if (res.count !== 1) return null;
    const lease: Lease = {
      nasId,
      token,
      kind,
      lost: false,
      cancel: false,
      timer: null,
    };
    lease.timer = setInterval(() => void this.renew(lease), LEASE_RENEW_MS);
    (lease.timer as any).unref?.();
    this.leases.add(lease);
    return lease;
  }

  /** Extend the lease while we still own it; pick up cancel requests. */
  async renew(lease: Lease): Promise<void> {
    try {
      const res = (await this.prisma.nasL2tpConfig.updateMany({
        where: { nasId: lease.nasId, clientLockOwner: lease.token },
        data: { clientLockUntil: new Date(Date.now() + LEASE_TTL_MS) },
      })) as any;
      if (res.count !== 1) {
        lease.lost = true;
        return;
      }
      const r = await this.row(lease.nasId);
      if (r?.clientCancelRequested) lease.cancel = true;
    } catch {
      lease.lost = true; // cannot prove we still own it → stop
    }
  }

  /** Release ONLY if we still own it. Never clears another operation's lease. */
  private async release(lease: Lease, data: Record<string, unknown>) {
    if (lease.timer) clearInterval(lease.timer);
    this.leases.delete(lease);
    await this.prisma.nasL2tpConfig.updateMany({
      where: { nasId: lease.nasId, clientLockOwner: lease.token },
      data: {
        ...data,
        clientLockOwner: null,
        clientLockUntil: null,
        clientOpId: null,
        clientOpKind: null,
        clientOpStartedAt: null,
        clientCancelRequested: false,
      },
    });
  }

  private busy(row: any) {
    return !!row?.clientLockUntil && new Date(row.clientLockUntil) > new Date();
  }

  /**
   * Address claims: one transaction at a time, pinned to READ COMMITTED.
   * The advisory lock serialises claimers; READ COMMITTED makes every
   * statement after the lock see what the previous holder committed (under
   * REPEATABLE READ / SERIALIZABLE the snapshot could predate it). Write
   * conflicts / serialization failures (P2034) are retried, bounded.
   */
  private async withAddressLock<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= ADDRESS_TX_RETRIES; attempt++) {
      try {
        return await (this.prisma as any).$transaction(
          async (tx: any) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADDRESS_LOCK_KEY})`;
            return fn(tx);
          },
          { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 15_000 },
        );
      } catch (e: any) {
        lastErr = e;
        if (e?.code !== 'P2034' || attempt === ADDRESS_TX_RETRIES) throw e;
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
    throw lastErr;
  }

  // ── view / save ──────────────────────────────────────────────────────────
  async getView(nasId: number, actor: any) {
    await this.config.assertNasAccess(nasId, actor);
    return this.view(nasId, await this.row(nasId));
  }

  async save(nasId: number, actor: any, body: ClientSaveInput) {
    await this.config.assertNasAccess(nasId, actor);
    const input = body && typeof body === 'object' ? body : {};
    const current = await this.row(nasId);
    if (
      current &&
      (['connecting', 'connected', 'disconnecting'].includes(
        current.clientState,
      ) ||
        this.busy(current))
    ) {
      throw new ConflictException(
        'Disconnect the management VPN (and wait for any running operation) before changing its settings.',
      );
    }
    const data: Record<string, unknown> = { updatedById: this.uid(actor) };
    const str = (v: unknown) =>
      typeof v === 'string' ? v.trim() : v == null ? null : null;
    const ipField = (key: keyof ClientSaveInput, col: string) => {
      if (input[key] === undefined) return;
      const v = str(input[key]);
      if (v === null || v === '') {
        data[col] = null;
        return;
      }
      if (!isIpv4(v))
        throw new BadRequestException(`${key} must be an IPv4 address.`);
      data[col] = v;
    };
    ipField('publicHost', 'mgmtPublicHost');
    ipField('localAddress', 'localAddress');
    ipField('remoteAddress', 'remoteAddress');
    if (input.pppUsername !== undefined) {
      const v = str(input.pppUsername);
      if (v && !isSafePppUser(v))
        throw new BadRequestException(
          'PPP username must be 3–64 characters: letters, digits, . _ @ -',
        );
      data.pppUsername = v || null;
    }
    if (input.pppProfile !== undefined) {
      const v = str(input.pppProfile);
      if (v && !PROFILE_RE.test(v))
        throw new BadRequestException('PPP profile name is invalid.');
      data.pppProfile = v || null;
    }
    for (const [key, col, label] of [
      ['pppPassword', 'pppPasswordEnc', 'PPP password'],
      ['ipsecPsk', 'mgmtIpsecPskEnc', 'IPsec pre-shared key'],
    ] as const) {
      if (input[key] === undefined) continue;
      const v = input[key];
      if (v === null || v === '') {
        data[col] = null;
        continue;
      }
      if (!isSafeSecret(v))
        throw new BadRequestException(
          `${label} must be 8–128 printable characters without spaces, quotes or backslashes.`,
        );
      data[col] = this.secrets.encryptValue(v);
    }
    const intIn = (key: keyof ClientSaveInput, lo: number, hi: number) => {
      if (input[key] === undefined) return;
      const n = Number(input[key]);
      if (!Number.isInteger(n) || n < lo || n > hi)
        throw new BadRequestException(
          `${key} must be a whole number from ${lo} to ${hi}.`,
        );
      data[key] = n;
    };
    intIn(
      'connectTimeoutSec',
      L2TP_LIMITS.MIN_TIMEOUT_SEC,
      L2TP_LIMITS.MAX_TIMEOUT_SEC,
    );
    intIn('retryCount', 0, L2TP_LIMITS.MAX_RETRIES);
    intIn('retryDelaySec', 1, L2TP_LIMITS.MAX_RETRY_DELAY_SEC);

    const pick = (col: string) =>
      (data[col] !== undefined ? data[col] : current?.[col]) as string | null;
    // Host I/O happens BEFORE the transaction: nothing slow runs while the
    // global address lock is held.
    const inventory = await this.dialer.inventory().catch(() => null);
    try {
      const saved = await this.withAddressLock(async (tx: any) => {
        await this.assertAddressing(
          tx,
          nasId,
          {
            endpoint: pick('mgmtPublicHost'),
            localAddress: pick('localAddress'),
            remoteAddress: pick('remoteAddress'),
          },
          inventory,
        );
        return tx.nasL2tpConfig.upsert({
          where: { nasId },
          create: { nasId, ...data, createdById: this.uid(actor) },
          update: data,
        });
      });
      return this.view(nasId, saved);
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException(
          'That address is already used by another NAS management VPN on this server.',
        );
      throw e;
    }
  }

  // ── RouterOS side ────────────────────────────────────────────────────────
  private async nasApi(nasId: number) {
    const nas = (await this.prisma.nas.findUnique({
      where: { id: nasId },
      select: {
        nasIp: true,
        apiPort: true,
        apiUsername: true,
        apiPassword: true,
      },
    })) as any;
    if (!nas) throw new NotFoundException(`NAS ${nasId} not found`);
    if (!nas.apiUsername || !nas.apiPassword)
      throw new BadRequestException(
        'Set this NAS RouterOS API username and password first.',
      );
    if (!nas.nasIp)
      throw new BadRequestException('Set this NAS IP address first.');
    return {
      host: String(nas.nasIp).replace(/\/\d+$/, ''),
      port: Number(nas.apiPort) || 8728,
      username: String(nas.apiUsername),
      password: decField(this.secrets, nas.apiPassword),
      timeout: 12_000,
    };
  }

  private hostPublicIp(policy: PolicyConfig): string {
    const ip = String(this.env.UPLINKO_PUBLIC_IP || '').trim();
    const errs = checkAddressing(
      { endpoint: ip },
      policy,
      { addresses: [], networks: [], gateways: [] },
      { tunnelAddresses: [], endpoints: [], nasIps: [] },
    );
    if (!isIpv4(ip) || errs.length) {
      throw new BadRequestException(
        "UPLINKO_PUBLIC_IP (this server's public IPv4 as routers see it) must be configured by the platform owner before the NAS firewall guard can be installed. Nothing was changed.",
      );
    }
    return ip;
  }

  private async applyInputs(nasId: number) {
    const row = await this.row(nasId);
    const psk = this.dec(row?.mgmtIpsecPskEnc);
    const pass = this.dec(row?.pppPasswordEnc);
    const missing = [
      !row?.mgmtPublicHost && 'NAS public address',
      !row?.pppUsername && 'PPP username',
      !pass && 'PPP password',
      !psk && 'IPsec pre-shared key',
      !row?.localAddress && 'Uplinko tunnel address',
      !row?.remoteAddress && 'NAS tunnel address',
    ].filter(Boolean);
    if (missing.length)
      throw new BadRequestException(`Set these first: ${missing.join(', ')}.`);
    if (
      !isSafePppUser(row.pppUsername) ||
      !isSafeSecret(pass) ||
      !isSafeSecret(psk)
    ) {
      throw new BadRequestException(
        'Saved management-VPN settings are invalid. Save them again.',
      );
    }
    const profile = row.pppProfile || 'default';
    if (!PROFILE_RE.test(profile))
      throw new BadRequestException('PPP profile name is invalid.');
    await this.assertAddressing(this.prisma, nasId, {
      endpoint: row.mgmtPublicHost,
      localAddress: row.localAddress,
      remoteAddress: row.remoteAddress,
    });
    const nas = (await this.prisma.nas.findUnique({
      where: { id: nasId },
      select: { apiUsername: true },
    })) as any;
    if (!nas?.apiUsername)
      throw new BadRequestException(
        'Set this NAS RouterOS API username and password first.',
      );
    return {
      row,
      psk: psk,
      pass: pass,
      profile,
      apiUser: String(nas.apiUsername),
    };
  }

  private refusalStatus(code: string) {
    return ['secret_conflict', 'confirm_required'].includes(code)
      ? ConflictException
      : BadRequestException;
  }

  async previewNas(nasId: number, actor: any) {
    await this.config.assertNasAccess(nasId, actor);
    const { row, psk, apiUser } = await this.applyInputs(nasId);
    const hostPublicIp = this.hostPublicIp(this.policy());
    const applier = new RouterOsMgmtApplier(await this.rosConnect(nasId));
    try {
      const plan = await applier.inspect({
        nasId,
        apiUser,
        psk,
        pppUser: row.pppUsername,
        hostPublicIp,
      });
      return { nasId, executed: false, ...plan };
    } catch (e: any) {
      if (e?.code && typeof e.code === 'string' && e.message)
        throw new (this.refusalStatus(e.code))(e.message);
      throw new BadRequestException(
        'Could not read the NAS over the RouterOS API.',
      );
    }
  }

  /** States in which a new apply must not run until recovery has been done. */
  private static readonly NEEDS_RECOVERY = new Set([
    'applying',
    'recovery_required',
    'apply_failed_unrestored',
    'rollback_failed',
  ]);

  private hostOwner(lease: Lease): HostLockOwner {
    return { token: lease.token, pid: process.pid };
  }

  /**
   * Owner-guarded write: only the current lease holder may change the row.
   * Throws when ownership was lost, so a stale worker stops immediately.
   */
  private async ownedUpdate(lease: Lease, data: Record<string, unknown>) {
    const res = (await this.prisma.nasL2tpConfig.updateMany({
      where: { nasId: lease.nasId, clientLockOwner: lease.token },
      data,
    })) as any;
    if (res.count !== 1) {
      lease.lost = true;
      throw new Error('operation lease lost');
    }
  }

  /** Take the per-NAS host lock for a lease, or release the lease and refuse. */
  private async holdHost(lease: Lease) {
    if (await this.dialer.acquireHostLock(lease.nasId, this.hostOwner(lease)))
      return;
    await this.release(lease, {});
    throw new ConflictException(
      'Another process on this server is still working on this NAS (an earlier operation has not finished). Try again shortly.',
    );
  }

  private readJson<T>(enc?: string | null): T | null {
    try {
      return JSON.parse(this.dec(enc) ?? 'null') as T;
    } catch {
      return null;
    }
  }

  async applyNas(
    nasId: number,
    actor: any,
    body: { confirmServerChange?: boolean } = {},
  ) {
    await this.config.assertNasAccess(nasId, actor);
    const inputs = await this.applyInputs(nasId);
    const hostPublicIp = this.hostPublicIp(this.policy());
    const lease = await this.acquire(nasId, 'nas-apply');
    if (!lease)
      throw new ConflictException('Another operation for this NAS is running.');
    // An earlier interrupted or unrestored apply: never mutate again blindly.
    if (NasL2tpClientService.NEEDS_RECOVERY.has(inputs.row.mgmtApplyState)) {
      await this.release(lease, {
        mgmtApplyState:
          inputs.row.mgmtApplyState === 'applying'
            ? 'recovery_required'
            : inputs.row.mgmtApplyState,
      });
      throw new ConflictException(
        'The previous router change did not finish cleanly. Run recovery (POST /nas/:id/l2tp-client/nas/recover) before applying again.',
      );
    }
    let existingSnapshot: Snapshot | null = null;
    if (inputs.row.mgmtSnapshotEnc) {
      existingSnapshot = this.readJson<Snapshot>(inputs.row.mgmtSnapshotEnc);
      if (!validSnapshot(existingSnapshot, nasId)) {
        await this.release(lease, {});
        throw new BadRequestException(
          'The stored rollback point is unreadable. Manual intervention required before applying again.',
        );
      }
    }
    const prevDesiredEnc = inputs.row.mgmtDesiredEnc ?? null;
    const prevState = inputs.row.mgmtApplyState ?? 'none';
    await this.holdHost(lease);
    try {
      const applier = new RouterOsMgmtApplier(await this.rosConnect(nasId));
      const result = await applier.apply({
        nasId,
        apiUser: inputs.apiUser,
        psk: inputs.psk,
        pppUser: inputs.row.pppUsername,
        pppPassword: inputs.pass,
        profile: inputs.profile,
        nasTunnelIp: inputs.row.remoteAddress,
        hostTunnelIp: inputs.row.localAddress,
        hostPublicIp,
        confirmServerChange: body?.confirmServerChange === true,
        existingSnapshot,
        // Snapshot AND intended result are on record before the first change,
        // so an interruption can always be classified later.
        persistSnapshot: async (s, desired) => {
          if (lease.lost) throw new Error('lease lost');
          await this.ownedUpdate(lease, {
            mgmtSnapshotEnc: this.secrets.encryptValue(JSON.stringify(s)),
            mgmtDesiredEnc: this.secrets.encryptValue(JSON.stringify(desired)),
            mgmtApplyState: 'applying',
            mgmtApplyDetail: null,
            updatedById: this.uid(actor),
          });
        },
        onStep: async (step) => {
          await this.ownedUpdate(lease, {
            mgmtApplyDetail: `last step: ${step}`.slice(0, 500),
          });
        },
      });

      if (result.ok) {
        await this.release(lease, {
          mgmtApplyState: 'applied',
          mgmtApplyDetail: null,
          nasAppliedAt: new Date(),
          mgmtDesiredEnc: this.secrets.encryptValue(
            JSON.stringify(result.desired),
          ),
        });
        this.logger.log(
          `NAS ${nasId}: management VPN applied on the router (${result.changed.length} change(s))`,
        );
        return {
          nasId,
          applied: true,
          confirmedByNas: true,
          changed: result.changed,
        };
      }
      if (result.stage === 'refused') {
        // Nothing changed on the router: put the record back as it was.
        await this.release(
          lease,
          existingSnapshot
            ? { mgmtDesiredEnc: prevDesiredEnc, mgmtApplyState: prevState }
            : {
                mgmtSnapshotEnc: null,
                mgmtDesiredEnc: null,
                mgmtApplyState: prevState,
              },
        );
        throw new (this.refusalStatus(result.code))(result.message);
      }
      const restoredOk = result.restore.outcome === 'restored';
      await this.release(lease, {
        mgmtApplyState: restoredOk
          ? existingSnapshot
            ? prevState
            : 'apply_failed_restored'
          : 'apply_failed_unrestored',
        mgmtApplyDetail:
          `${result.message} Restore: ${result.restore.outcome}${result.restore.notRestored.length ? ` (not restored: ${result.restore.notRestored.join(', ')})` : ''}`.slice(
            0,
            500,
          ),
        // Restored to the pre-call state: the previous intended result is current again.
        ...(restoredOk
          ? existingSnapshot
            ? { mgmtDesiredEnc: prevDesiredEnc }
            : { mgmtSnapshotEnc: null, mgmtDesiredEnc: null }
          : {}),
      });
      this.logger.warn(
        `NAS ${nasId}: management VPN apply failed at "${result.failedStep}"; restore ${result.restore.outcome}`,
      );
      throw new BadRequestException({
        message: restoredOk
          ? `${result.message} The NAS was restored to its previous settings (verified by read-back).`
          : `${result.message} The NAS could NOT be fully restored — manual intervention required.`,
        applyOutcome: restoredOk
          ? 'apply_failed_restored'
          : result.restore.outcome === 'partial'
            ? 'apply_failed_partially_restored'
            : 'apply_failed_not_restored',
        failedStep: result.failedStep,
        restored: result.restore.restored,
        notRestored: result.restore.notRestored,
      });
    } finally {
      await this.dialer
        .releaseHostLock(nasId, this.hostOwner(lease))
        .catch(() => undefined);
      if (this.leases.has(lease))
        await this.release(lease, {}).catch(() => undefined);
    }
  }

  async rollbackNas(nasId: number, actor: any) {
    await this.config.assertNasAccess(nasId, actor);
    const row = await this.row(nasId);
    const snap = this.readJson<Snapshot>(row?.mgmtSnapshotEnc);
    const desired = this.readJson<Desired>(row?.mgmtDesiredEnc);
    if (!row || !validSnapshot(snap, nasId))
      throw new BadRequestException(
        'Nothing to roll back: there is no valid rollback point for this NAS.',
      );
    if (!desired) {
      throw new ConflictException(
        'What Uplinko applied is not on record, so later changes on the NAS cannot be ruled out. Automatic rollback refused — manual intervention required.',
      );
    }
    const lease = await this.acquire(nasId, 'nas-rollback');
    if (!lease)
      throw new ConflictException('Another operation for this NAS is running.');
    await this.holdHost(lease);
    try {
      // The tunnel depends on what is being removed.
      await this.dialer.hangup(nasId).catch(() => undefined);
      const applier = new RouterOsMgmtApplier(await this.rosConnect(nasId));
      const report = await applier.restore(nasId, snap, desired, {
        requireNoForeignChange: true,
      });
      if (lease.lost) {
        throw new ConflictException(
          'This operation lost its lock while running; its result was not recorded. Check the router and run recovery.',
        );
      }
      if (report.outcome === 'restored') {
        await this.release(lease, {
          mgmtSnapshotEnc: null,
          mgmtDesiredEnc: null,
          nasAppliedAt: null,
          mgmtApplyState: 'none',
          mgmtApplyDetail: null,
          clientState: 'disconnected',
          tunnelInterface: null,
          lastDisconnectedAt: new Date(),
        });
        return { nasId, rolledBack: true, confirmedByNas: true };
      }
      await this.release(lease, {
        mgmtApplyState: 'rollback_failed',
        mgmtApplyDetail: report.detail.slice(0, 500),
        clientState: 'disconnected',
        tunnelInterface: null,
      });
      throw new ConflictException({
        message: report.detail,
        rollbackOutcome: report.outcome,
        restored: report.restored,
        notRestored: report.notRestored,
      });
    } finally {
      await this.dialer
        .releaseHostLock(nasId, this.hostOwner(lease))
        .catch(() => undefined);
      if (this.leases.has(lease))
        await this.release(lease, {}).catch(() => undefined);
    }
  }

  /**
   * Recovery after an interrupted/unrestored apply. Read-only on the router:
   * classifies its current state against the recorded snapshot and intended
   * result, and records the outcome. Never mutates the router itself.
   */
  async recoverNas(nasId: number, actor: any) {
    await this.config.assertNasAccess(nasId, actor);
    const row = await this.row(nasId);
    const snap = this.readJson<Snapshot>(row?.mgmtSnapshotEnc);
    const desired = this.readJson<Desired>(row?.mgmtDesiredEnc);
    if (!row || !validSnapshot(snap, nasId) || !desired) {
      if (row && NasL2tpClientService.NEEDS_RECOVERY.has(row.mgmtApplyState)) {
        await this.prisma.nasL2tpConfig.updateMany({
          where: {
            nasId,
            OR: [
              { clientLockUntil: null },
              { clientLockUntil: { lt: new Date() } },
            ],
          },
          data: {
            mgmtApplyState: 'recovery_required',
            mgmtApplyDetail:
              'Recovery data is missing or unreadable. Manual intervention required.',
          },
        });
      }
      throw new ConflictException(
        'There is no readable recovery record for this NAS. Manual intervention required.',
      );
    }
    const lease = await this.acquire(nasId, 'nas-recover');
    if (!lease)
      throw new ConflictException('Another operation for this NAS is running.');
    await this.holdHost(lease);
    try {
      const { state, items } = await classifyRouter(
        await this.rosConnect(nasId),
        nasId,
        snap,
        desired,
      );
      const next: Record<string, unknown> =
        state === 'at_desired'
          ? {
              mgmtApplyState: 'applied',
              mgmtApplyDetail:
                'Recovered: the router has the full Uplinko configuration (verified by read-back).',
              nasAppliedAt: row.nasAppliedAt ?? new Date(),
            }
          : state === 'at_snapshot'
            ? {
                mgmtApplyState: 'none',
                mgmtApplyDetail:
                  'Recovered: the router is unchanged (verified by read-back).',
                mgmtSnapshotEnc: null,
                mgmtDesiredEnc: null,
              }
            : state === 'mixed'
              ? {
                  mgmtApplyState: 'recovery_required',
                  mgmtApplyDetail:
                    "Partially applied. Every changed item is Uplinko's own, so rollback is safe.",
                }
              : {
                  mgmtApplyState: 'recovery_required',
                  mgmtApplyDetail:
                    state === 'unreadable'
                      ? 'The router could not be read reliably. Manual intervention required.'
                      : "The router has settings that match neither the original nor Uplinko's. Manual intervention required.",
                };
      if (lease.lost)
        throw new ConflictException(
          'This operation lost its lock while running; nothing was recorded.',
        );
      await this.release(lease, next);
      return {
        nasId,
        routerState: state,
        items,
        nasApplyState: next.mgmtApplyState,
        rollbackSafe: state === 'mixed' || state === 'at_desired',
      };
    } finally {
      await this.dialer
        .releaseHostLock(nasId, this.hostOwner(lease))
        .catch(() => undefined);
      if (this.leases.has(lease))
        await this.release(lease, {}).catch(() => undefined);
    }
  }

  // ── host tunnel lifecycle (background operations) ───────────────────────
  private publicStatus(nasId: number, st: DialStatus) {
    return {
      nasId,
      state: st.state,
      connected: st.state === 'connected',
      interface: st.interface ?? null,
      localAddress: st.localAddress ?? null,
      remoteAddress: st.remoteAddress ?? null,
      ipsec: st.ipsec ?? null,
      l2tp: st.l2tp ?? null,
      detail: st.detail ?? null,
      errorCode: st.errorCode ?? null,
      error: st.error ?? null,
      attempts: st.attempts ?? null,
    };
  }

  private resultData(st: DialStatus) {
    const now = new Date();
    return {
      clientState:
        st.state === 'connected'
          ? 'connected'
          : st.errorCode === 'cancelled'
            ? 'disconnected'
            : st.state === 'error'
              ? 'error'
              : 'disconnected',
      tunnelInterface: st.state === 'connected' ? (st.interface ?? null) : null,
      lastClientErrorCode:
        st.state === 'connected' ? null : (st.errorCode ?? null),
      lastClientError:
        st.state === 'connected'
          ? null
          : ((st.error ?? null)?.slice(0, 500) ?? null),
      ...(st.state === 'connected'
        ? { lastConnectedAt: now }
        : { lastDisconnectedAt: now }),
    };
  }

  private async dialInputs(nasId: number) {
    const row = await this.row(nasId);
    const psk = this.dec(row?.mgmtIpsecPskEnc);
    const pass = this.dec(row?.pppPasswordEnc);
    if (
      !row?.mgmtPublicHost ||
      !row?.pppUsername ||
      !pass ||
      !psk ||
      !row?.localAddress ||
      !row?.remoteAddress
    ) {
      throw new BadRequestException(
        'Save the NAS public address, PPP username/password, IPsec key and both tunnel addresses first.',
      );
    }
    await this.assertAddressing(this.prisma, nasId, {
      endpoint: row.mgmtPublicHost,
      localAddress: row.localAddress,
      remoteAddress: row.remoteAddress,
    });
    return {
      nasId,
      server: row.mgmtPublicHost as string,
      ipsecPsk: psk,
      pppUsername: row.pppUsername as string,
      pppPassword: pass,
      localAddress: row.localAddress as string,
      remoteAddress: row.remoteAddress as string,
      timeoutSec: row.connectTimeoutSec ?? 30,
      retryCount: row.retryCount ?? 1,
      retryDelaySec: row.retryDelaySec ?? 5,
    };
  }

  private startBackground(lease: Lease, work: () => Promise<DialStatus>) {
    const p = (async () => {
      let st: DialStatus;
      const owner = this.hostOwner(lease);
      const gotHost = await this.dialer
        .acquireHostLock(lease.nasId, owner)
        .catch(() => false);
      try {
        st = gotHost
          ? await work()
          : {
              state: 'error',
              errorCode: 'host_error',
              error:
                'Another process on this server is still working on this NAS (an earlier operation has not finished).',
            };
      } catch {
        st = {
          state: 'error',
          errorCode: 'host_error',
          error: 'The server could not run the VPN client tooling.',
        };
      }
      if (gotHost)
        await this.dialer
          .releaseHostLock(lease.nasId, owner)
          .catch(() => undefined);
      if (lease.lost) {
        // Someone else owns the NAS now; do not overwrite their state.
        this.logger.warn(
          `NAS ${lease.nasId}: ${lease.kind} finished after its lease was lost; result discarded`,
        );
        return st;
      }
      await this.release(lease, this.resultData(st)).catch(() => undefined);
      this.logger.log(
        `NAS ${lease.nasId}: management VPN ${lease.kind} → ${st.state}${st.errorCode ? ` (${st.errorCode})` : ''}`,
      );
      return st;
    })();
    this.running.set(lease.nasId, p);
    void p.finally(() => {
      if (this.running.get(lease.nasId) === p) this.running.delete(lease.nasId);
    });
  }

  /** Test/shutdown helper: resolves when this process's background op for the NAS ends. */
  async waitForOperation(nasId: number): Promise<unknown> {
    return this.running.get(nasId);
  }

  async connect(nasId: number, actor: any) {
    await this.config.assertNasAccess(nasId, actor);
    const params = await this.dialInputs(nasId);
    const lease = await this.acquire(nasId, 'connect', {
      clientState: 'connecting',
      lastDialAt: new Date(),
      lastClientError: null,
      lastClientErrorCode: null,
    });
    if (!lease)
      throw new ConflictException('Another operation for this NAS is running.');
    this.startBackground(lease, () =>
      this.dialer.dial(params, {
        shouldCancel: () => lease.cancel || lease.lost,
      }),
    );
    return {
      nasId,
      accepted: true,
      operationId: lease.token,
      state: 'connecting',
      statusUrl: `/nas/${nasId}/l2tp-client/status`,
    };
  }

  async reconnect(nasId: number, actor: any) {
    await this.config.assertNasAccess(nasId, actor);
    const params = await this.dialInputs(nasId);
    const lease = await this.acquire(nasId, 'reconnect', {
      clientState: 'connecting',
      lastDialAt: new Date(),
      lastClientError: null,
      lastClientErrorCode: null,
    });
    if (!lease)
      throw new ConflictException('Another operation for this NAS is running.');
    this.startBackground(lease, async () => {
      await this.dialer.hangup(nasId);
      return this.dialer.dial(params, {
        shouldCancel: () => lease.cancel || lease.lost,
      });
    });
    return {
      nasId,
      accepted: true,
      operationId: lease.token,
      state: 'connecting',
      statusUrl: `/nas/${nasId}/l2tp-client/status`,
    };
  }

  /** Ask a running operation to stop. Never touches the lease itself. */
  async cancel(nasId: number, actor: any) {
    await this.config.assertNasAccess(nasId, actor);
    const res = (await this.prisma.nasL2tpConfig.updateMany({
      where: { nasId, clientLockUntil: { gt: new Date() } },
      data: { clientCancelRequested: true },
    })) as any;
    for (const l of this.leases) if (l.nasId === nasId) l.cancel = true; // same process: immediately
    return { nasId, cancelRequested: res.count === 1 };
  }

  async disconnect(nasId: number, actor: any) {
    await this.config.assertNasAccess(nasId, actor);
    const lease = await this.acquire(nasId, 'disconnect', {
      clientState: 'disconnecting',
    });
    if (!lease) {
      // A connect is running: ask it to stop (it tears down its own tunnel).
      const c = await this.cancel(nasId, actor);
      return { nasId, state: 'cancelling', cancelRequested: c.cancelRequested };
    }
    await this.holdHost(lease);
    let st: DialStatus;
    try {
      st = await this.dialer.hangup(nasId);
      await this.dialer.releaseHostLock(nasId, this.hostOwner(lease));
    } catch {
      await this.dialer
        .releaseHostLock(nasId, this.hostOwner(lease))
        .catch(() => undefined);
      st = {
        state: 'error',
        errorCode: 'host_error',
        error: 'The tunnel could not be stopped.',
      };
    }
    await this.release(lease, {
      ...this.resultData(st),
      clientState: st.state === 'error' ? 'error' : 'disconnected',
    });
    return this.publicStatus(nasId, st);
  }

  /** Live host status; the stored state is corrected from it when no operation runs. */
  async status(nasId: number, actor: any) {
    await this.config.assertNasAccess(nasId, actor);
    const row = await this.row(nasId);
    const tooling = await this.dialer.tooling();
    const busy = this.busy(row);
    const st = await this.dialer.status(nasId, {
      localAddress: row?.localAddress,
      remoteAddress: row?.remoteAddress,
      server: row?.mgmtPublicHost,
    });
    if (row && !busy) {
      const wasUp = row.clientState === 'connected';
      const d = this.resultData(st);
      await this.prisma.nasL2tpConfig.updateMany({
        where: {
          nasId,
          OR: [
            { clientLockUntil: null },
            { clientLockUntil: { lt: new Date() } },
          ],
        },
        data: {
          clientState:
            st.state === 'connected'
              ? 'connected'
              : st.state === 'error'
                ? 'error'
                : 'disconnected',
          tunnelInterface: d.tunnelInterface,
          lastClientErrorCode: d.lastClientErrorCode,
          lastClientError: d.lastClientError,
          ...(st.state === 'connected'
            ? { lastConnectedAt: new Date() }
            : wasUp
              ? { lastDisconnectedAt: new Date() }
              : {}),
          // A crashed worker's operation is over: clear it (lease already expired).
          clientLockOwner: null,
          clientLockUntil: null,
          clientOpId: null,
          clientOpKind: null,
          clientOpStartedAt: null,
          clientCancelRequested: false,
          ...(row.mgmtApplyState === 'applying'
            ? {
                mgmtApplyState: 'recovery_required',
                mgmtApplyDetail:
                  'An apply was interrupted (its worker stopped). Run recovery.',
              }
            : {}),
        },
      });
    }
    const shown: DialStatus =
      busy && st.state !== 'connected'
        ? {
            ...st,
            state:
              row?.clientState === 'disconnecting'
                ? 'disconnected'
                : 'connecting',
          }
        : st;
    return {
      ...this.publicStatus(nasId, shown),
      operation: busy
        ? {
            id: row.clientOpId,
            kind: row.clientOpKind,
            startedAt: row.clientOpStartedAt,
            cancelRequested: !!row.clientCancelRequested,
          }
        : null,
      nasApplyState: this.applyStateOf(row),
      tooling: { ok: tooling.ok, detail: tooling.detail },
      tunnelUsedForRouterAccess: false,
    };
  }

  /** Remove this NAS's host tunnel and files, verified. */
  async purgeHost(nasId: number, actor: any) {
    await this.config.assertNasAccess(nasId, actor);
    return this.purgeInternal(nasId);
  }

  private async purgeInternal(nasId: number) {
    const lease = await this.acquire(nasId, 'purge');
    const row = await this.row(nasId);
    if (!lease && row) {
      await this.prisma.nasL2tpConfig.updateMany({
        where: { nasId },
        data: { clientCancelRequested: true },
      });
      throw new ConflictException(
        'An operation for this NAS is running; it has been asked to stop. Retry in a moment.',
      );
    }
    const owner: HostLockOwner = {
      token: lease?.token ?? randomUUID(),
      pid: process.pid,
    };
    if (!(await this.dialer.acquireHostLock(nasId, owner))) {
      if (lease) await this.release(lease, {});
      throw new ConflictException(
        'Another process on this server is still working on this NAS. Retry in a moment; nothing was removed.',
      );
    }
    let res: { clean: boolean; remaining: string[] };
    try {
      res = await this.dialer.purge(nasId);
    } finally {
      await this.dialer.releaseHostLock(nasId, owner).catch(() => undefined);
    }
    if (lease)
      await this.release(lease, {
        clientState: res.clean ? 'disconnected' : 'error',
        tunnelInterface: null,
        lastDisconnectedAt: new Date(),
        ...(res.clean
          ? {}
          : {
              lastClientErrorCode: 'host_error',
              lastClientError:
                `Cleanup incomplete: ${res.remaining.join(', ')}`.slice(0, 500),
            }),
      });
    if (!res.clean)
      throw new ConflictException(
        `The server could not remove everything for this NAS: ${res.remaining.join(', ')}. Retry; nothing was deleted.`,
      );
    return { nasId, removedFromHost: true };
  }

  /**
   * Called by NasService.remove (owner already verified). Stops and removes
   * ONLY this NAS's host tunnel and files; throws (blocking the deletion) when
   * that cannot be verified. Router-side settings are not touched here.
   */
  async cleanupForNasDeletion(
    nasId: number,
  ): Promise<{ hadConfig: boolean; routerSideApplied: boolean }> {
    const row = await this.row(nasId);
    if (row && this.busy(row)) {
      await this.prisma.nasL2tpConfig.updateMany({
        where: { nasId },
        data: { clientCancelRequested: true },
      });
      throw new ConflictException(
        'A management-VPN operation for this NAS is running. It has been asked to stop; delete again in a moment.',
      );
    }
    const owner: HostLockOwner = { token: randomUUID(), pid: process.pid };
    if (!(await this.dialer.acquireHostLock(nasId, owner).catch(() => false))) {
      throw new ConflictException(
        'Another process on this server is still working on this NAS. Delete again in a moment; the NAS was not deleted.',
      );
    }
    const files = await this.dialer
      .purge(nasId)
      .catch(() => ({ clean: false, remaining: ['host tooling unavailable'] }))
      .finally(() =>
        this.dialer.releaseHostLock(nasId, owner).catch(() => undefined),
      );
    if (!row && files.clean)
      return { hadConfig: false, routerSideApplied: false };
    if (!files.clean)
      throw new ConflictException(
        `The management VPN for this NAS could not be removed from the server (${files.remaining.join(', ')}). The NAS was not deleted.`,
      );
    return { hadConfig: !!row, routerSideApplied: !!row?.nasAppliedAt };
  }
}

/** Keys that must never appear in any response. */
export const NEVER_RETURNED = [
  'mgmtIpsecPskEnc',
  'pppPasswordEnc',
  'mgmtSnapshotEnc',
  'mgmtDesiredEnc',
  'ipsecPsk',
  'pppPassword',
];
