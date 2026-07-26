import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RadiusSyncService } from '../nas/radius-sync.service';
import { JobsService } from '../jobs/jobs.service';
import { AccountingService } from '../accounting/accounting.service';

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
  ) {}

  /** Expose the full reconcile as a background job the ISP can run on demand. */
  onModuleInit() {
    this.jobs.register('integrity.reconcile', async (payload, update) => {
      await update(0, 3);
      const trialBalance = await this.accounting.getTrialBalance();
      await update(1, 3);
      const wallets = await this.reconcileWallets();
      await update(2, 3);
      const radius = await this.reconcileRadiusState(payload?.apply !== false);
      await update(3, 3);
      return { trialBalance, wallets, radius };
    });
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

  /** Nightly at 03:20 — off-peak. */
  @Cron('20 3 * * *')
  async nightly() {
    try { await this.reconcileWallets(); } catch (e: any) { this.logger.warn(`Wallet reconcile failed: ${e?.message || e}`); }
    try { await this.reconcileRadiusState(true); } catch (e: any) { this.logger.warn(`RADIUS reconcile failed: ${e?.message || e}`); }
  }
}
