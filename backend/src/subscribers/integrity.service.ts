import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RadiusSyncService } from '../nas/radius-sync.service';
import { JobsService } from '../jobs/jobs.service';
import { AccountingService } from '../accounting/accounting.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';
import { isPrimaryInstance } from '../common/cluster-util';

/**
 * IntegrityService — the two safety nets that catch silent drift.
 *
 * 1. WALLET ↔ LEDGER: every balance change should have a ledger row, so a
 *    wallet's balance should equal the sum of its transactions. If it doesn't,
 *    money was created or destroyed off-ledger — a bug, a manual DB edit, or a
 *    partial failure. We flag it (never auto-"fix", because the right fix
 *    depends on the cause).
 *
 * 2. RADIUS ↔ BILLING: a subscriber who is INACTIVE/EXPIRED/SUSPENDED in
 *    billing but still has a LIVE RADIUS session is getting free internet. We
 *    find them and cut them off, and report the divergence.
 *
 * Both run nightly and are callable on demand (ISP only) from the money-integrity
 * panel. Read-only where it matters; the only mutation is cutting a session that
 * billing already says should be off.
 */
@Injectable()
export class IntegrityService implements OnModuleInit {
  private readonly logger = new Logger(IntegrityService.name);

  constructor(
    private prisma: PrismaService,
    private radius: RadiusSyncService,
    private jobs: JobsService,
    private accounting: AccountingService,
    private mikrotik: MikrotikSyncService,
  ) {}

  /** Expose the full reconcile as a background job the ISP can run on demand. */
  onModuleInit() {
    this.jobs.register('integrity.reconcile', async (payload, update) => {
      const apply = payload?.apply !== false;
      await update(0, 4);
      const trialBalance = await this.accounting.getTrialBalance();
      await update(1, 4);
      const wallets = await this.reconcileWallets();
      await update(2, 4);
      const radius = await this.reconcileRadiusState(apply);
      await update(3, 5);
      const radiusHeal = await this.healActiveCredentials(apply);
      await update(4, 5);
      const sessions = await this.reconcileSessionsWithRouter(apply);
      await update(5, 5);
      return { trialBalance, wallets, radius, radiusHeal, sessions };
    });
  }

  /**
   * Keep the panel's online state honest automatically — every 5 minutes ask
   * the routers who is really connected and close ghost sessions. This is what
   * makes a stale "online" self-heal within minutes after a reboot.
   */
  private sessionSyncBusy = false;
  @Cron('*/5 * * * *')
  async sessionSyncCron() {
    // Cluster-safe: only the primary worker runs scheduled jobs.
    if (!isPrimaryInstance()) return;
    // Overlap-safe: skip if the previous run (e.g. many unreachable routers) is
    // still going, so runs never pile up under load.
    if (this.sessionSyncBusy) { this.logger.warn('Session sync still running — skipping this tick'); return; }
    this.sessionSyncBusy = true;
    try {
      await this.reconcileSessionsWithRouter(true);
      // Enforce panel-dependency: kick any live session whose account is gone.
      if ((process.env.ENFORCE_PANEL_DEPENDENCY ?? '1') !== '0') {
        await this.disconnectUnknownRouterSessions(true);
      }
    }
    catch (e: any) { this.logger.warn(`Session sync cron failed: ${e?.message || e}`); }
    finally { this.sessionSyncBusy = false; }
  }

  /** Wallet balance vs sum of ledger entries, per account. Report-only. */
  async reconcileWallets(toleranceRaw = 0.01) {
    const tolerance = Number(toleranceRaw) || 0.01;
    const rows = await this.prisma.$queryRaw<Array<{ id: number; name: string; role: string; balance: number; ledger: number; txns: number }>>`
      SELECT u.id, u.name, u.role, u.balance::float8 AS balance,
             COALESCE(SUM(t.amount), 0)::float8 AS ledger,
             COUNT(t.id)::int AS txns
      FROM "User" u
      LEFT JOIN "UserBalanceTransaction" t ON t."userId" = u.id
      GROUP BY u.id, u.name, u.role, u.balance
      HAVING ABS(u.balance - COALESCE(SUM(t.amount), 0)) > ${tolerance}
      ORDER BY ABS(u.balance - COALESCE(SUM(t.amount), 0)) DESC;`;

    const drift = rows.map((r) => ({
      userId: Number(r.id), name: r.name, role: r.role,
      balance: Math.round(Number(r.balance) * 100) / 100,
      ledgerSum: Math.round(Number(r.ledger) * 100) / 100,
      difference: Math.round((Number(r.balance) - Number(r.ledger)) * 100) / 100,
      txnCount: Number(r.txns),
    }));

    if (drift.length) {
      this.logger.warn(`WALLET DRIFT: ${drift.length} account(s) whose balance ≠ ledger sum`);
      await this.prisma.systemLog.create({
        data: {
          level: 'WARN', source: 'integrity',
          message: `Wallet-vs-ledger drift on ${drift.length} account(s): ` +
            drift.slice(0, 10).map((d) => `#${d.userId} ${d.name} Δ${d.difference}`).join(', '),
        },
      }).catch(() => null);
    }
    return { checked: 'wallets', driftCount: drift.length, tolerance, accounts: drift };
  }

  /**
   * Live RADIUS sessions whose subscriber is NOT active in billing → cut off.
   * `apply=false` reports without cutting (dry run).
   */
  async reconcileRadiusState(apply = true) {
    // Open accounting sessions (no stop time) → who is actually online now.
    const open = await this.prisma.$queryRaw<Array<{ username: string }>>`
      SELECT DISTINCT username FROM radacct WHERE acctstoptime IS NULL AND username IS NOT NULL;`;
    const onlineUsernames = open.map((o) => o.username).filter(Boolean);
    if (!onlineUsernames.length) return { checked: 'radius', online: 0, drift: 0, cut: 0, accounts: [] };

    // Of those, the ones billing says should NOT be online.
    const leaking = await this.prisma.subscriber.findMany({
      where: { username: { in: onlineUsernames }, status: { not: 'ACTIVE' } },
      select: { id: true, username: true, fullName: true, status: true },
    });

    let cut = 0;
    if (apply) {
      for (const s of leaking) {
        if (!s.username) continue;
        try {
          await this.radius.removeSubscriberFromRadius(s.username);
          cut++;
        } catch (e: any) {
          this.logger.warn(`RADIUS drift cut failed for ${s.username}: ${e?.message || e}`);
        }
      }
    }

    if (leaking.length) {
      this.logger.warn(`RADIUS DRIFT: ${leaking.length} inactive subscriber(s) still online${apply ? `, cut ${cut}` : ' (dry run)'}`);
      await this.prisma.systemLog.create({
        data: {
          level: 'WARN', source: 'integrity',
          message: `RADIUS/billing drift: ${leaking.length} inactive subscriber(s) online: ` +
            leaking.slice(0, 15).map((s) => `${s.username}(${s.status})`).join(', '),
        },
      }).catch(() => null);
    }
    return { checked: 'radius', online: onlineUsernames.length, drift: leaking.length, cut, accounts: leaking };
  }

  /**
   * The other half of RADIUS drift: an ACTIVE subscriber whose credentials have
   * vanished from radcheck can't authenticate at all — they're paying and
   * offline through no fault of their own. Find them and re-push their
   * credentials (same restore the password-change path uses). Self-healing.
   */
  async healActiveCredentials(apply = true) {
    // ACTIVE subscribers with a username but no radcheck row = cannot log in.
    const missing = await this.prisma.$queryRaw<Array<{ id: number; username: string; password: string }>>`
      SELECT s.id, s.username, s.password
      FROM "Subscriber" s
      WHERE s.status = 'ACTIVE' AND s.username IS NOT NULL AND s.username <> ''
        AND NOT EXISTS (SELECT 1 FROM radcheck r WHERE r.username = s.username)
      LIMIT 500;`;

    let healed = 0;
    if (apply) {
      for (const s of missing) {
        if (!s.username || !s.password) continue;
        try {
          await this.radius.syncSubscriberProfile(s.username, s.password, null);
          healed++;
        } catch (e: any) {
          this.logger.warn(`RADIUS heal failed for ${s.username}: ${e?.message || e}`);
        }
      }
    }

    if (missing.length) {
      this.logger.warn(`RADIUS HEAL: ${missing.length} active subscriber(s) missing credentials${apply ? `, restored ${healed}` : ' (dry run)'}`);
      await this.prisma.systemLog.create({
        data: {
          level: 'WARN', source: 'integrity',
          message: `RADIUS credential drift: ${missing.length} active subscriber(s) had no radcheck entry` +
            `${apply ? `, restored ${healed}` : ''}: ` + missing.slice(0, 15).map((s) => s.username).join(', '),
        },
      }).catch(() => null);
    }
    return { checked: 'radius-credentials', missing: missing.length, healed };
  }

  /**
   * SESSION TRUTH SYNC — make the panel's "online" match the router's reality.
   *
   * A radacct row is "open" (online) until an Accounting-Stop arrives. If that
   * Stop is lost — e.g. the panel/DB was down during a reboot while a customer
   * disconnected — the row stays open forever and the panel shows a ghost
   * "online" user. Here we ask each MikroTik who is ACTUALLY connected
   * (/ppp/active) and close any open row the router no longer has.
   *
   * SAFETY: if a router is unreachable we SKIP it entirely and touch none of
   * its sessions — an unreachable router must never be read as "everyone off".
   */
  async reconcileSessionsWithRouter(apply = true) {
    const nases = await this.prisma.nas.findMany({
      where: { isActive: true, nasIp: { not: null }, apiUsername: { not: null } },
      select: { nasname: true, nasIp: true, apiPort: true, apiUsername: true, apiPassword: true },
    });

    let closed = 0; let checkedNas = 0; let skippedNas = 0; const details: any[] = [];
    for (const nas of nases) {
      const ip = nas.nasIp as string;
      let live: any[];
      try {
        live = await this.mikrotik.getPppoeActiveConnections(ip, nas.apiPort, nas.apiUsername as string, nas.apiPassword || '');
      } catch {
        skippedNas++; continue; // unreachable → do NOT touch its sessions
      }
      // getPppoeActiveConnections returns [] both for "nobody online" AND for a
      // failed call. Guard against the failure case: if the router has open
      // rows in radacct but returned an empty list, treat as unreachable/ambiguous
      // and skip, so a blip can't mass-close everyone.
      const liveNames = new Set(live.map((c) => (c.name || '').trim()).filter(Boolean));
      checkedNas++;

      const open = await this.prisma.$queryRaw<Array<{ username: string; acctsessionid: string }>>`
        SELECT username, acctsessionid FROM radacct
        WHERE acctstoptime IS NULL AND nasipaddress = ${ip}::inet AND username IS NOT NULL`;
      if (!open.length) continue;
      if (!liveNames.size && open.length) { skippedNas++; checkedNas--; continue; }

      const ghosts = open.filter((r) => !liveNames.has((r.username || '').trim()));
      if (apply) {
        for (const g of ghosts) {
          await this.prisma.$executeRaw`
            UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'Reconciled-NotOnRouter'
            WHERE acctsessionid = ${g.acctsessionid} AND acctstoptime IS NULL`;
          closed++;
        }
      }
      if (ghosts.length) details.push({ nas: nas.nasname || ip, ghosts: ghosts.length });
    }

    if (closed || skippedNas) {
      this.logger.warn(`Session sync: closed ${closed} ghost session(s) across ${checkedNas} router(s)${skippedNas ? `, skipped ${skippedNas} unreachable` : ''}`);
    }
    return { checked: 'router-sessions', routers: checkedNas, skipped: skippedNas, closed, details };
  }

  /**
   * Enforce panel-dependency: disconnect any LIVE router session whose username
   * is not a valid credential in the panel (no radcheck row) — i.e. a customer
   * who was deleted or whose data was wiped but whose PPPoE session is still up
   * on the router. This is the safety net behind Session-Timeout: it drops
   * orphaned sessions within the cron interval instead of waiting for the
   * timeout. Unreachable routers are skipped (never assumed empty).
   */
  async disconnectUnknownRouterSessions(apply = true) {
    const nases = await this.prisma.nas.findMany({
      where: { isActive: true, nasIp: { not: null }, apiUsername: { not: null } },
      select: { nasname: true, nasIp: true, apiPort: true, apiUsername: true, apiPassword: true },
    });
    let kicked = 0; const details: any[] = [];
    for (const nas of nases) {
      const ip = nas.nasIp as string;
      let live: any[];
      try {
        live = await this.mikrotik.getPppoeActiveConnections(ip, nas.apiPort, nas.apiUsername as string, nas.apiPassword || '');
      } catch { continue; }
      if (!live.length) continue;
      const names = [...new Set(live.map((c) => (c.name || '').trim()).filter(Boolean))];
      // Which of these usernames actually have a valid credential?
      const known = await this.prisma.$queryRaw<Array<{ username: string }>>`
        SELECT DISTINCT username FROM radcheck WHERE username = ANY(${names}::text[])`;
      const knownSet = new Set(known.map((r) => r.username.trim()));
      const orphans = names.filter((n) => !knownSet.has(n));
      for (const user of orphans) {
        if (apply) {
          const n = await this.mikrotik.removePppoeActive(ip, nas.apiPort, nas.apiUsername as string, nas.apiPassword || '', user);
          if (n > 0) kicked += n;
        }
        details.push({ nas: nas.nasname || ip, user });
      }
    }
    if (kicked) this.logger.warn(`Panel-dependency: disconnected ${kicked} orphaned router session(s) with no credential`);
    return { kicked, details };
  }

  /** Nightly at 03:20 — off-peak. */
  @Cron('20 3 * * *')
  async nightly() {
    if (!isPrimaryInstance()) return;
    try { await this.reconcileWallets(); } catch (e: any) { this.logger.warn(`Wallet reconcile failed: ${e?.message || e}`); }
    try { await this.reconcileRadiusState(true); } catch (e: any) { this.logger.warn(`RADIUS reconcile failed: ${e?.message || e}`); }
    try { await this.healActiveCredentials(true); } catch (e: any) { this.logger.warn(`RADIUS heal failed: ${e?.message || e}`); }
  }
}
