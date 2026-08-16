import { Body, Controller, Get, Post, UseGuards, Req, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { promises as fs } from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './security/permissions.guard';

const execAsync = promisify(exec);

async function runGitCommand(command: string, cwd = process.cwd()) {
  return execAsync(command, {
    cwd,
    env: process.env,
    maxBuffer: 50 * 1024 * 1024,
  });
}

const CHECKLIST_STATUS = ['yes', 'partial', 'no', 'unassessed'] as const;
type ChecklistStatus = (typeof CHECKLIST_STATUS)[number];

const assessmentFilePath = path.join(process.cwd(), 'data', 'reseller-capability-checklist.json');

async function readAssessmentStore(): Promise<Record<string, ChecklistStatus>> {
  try {
    await fs.mkdir(path.dirname(assessmentFilePath), { recursive: true });
    const raw = await fs.readFile(assessmentFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(([_, value]) => CHECKLIST_STATUS.includes(value as ChecklistStatus)),
    ) as Record<string, ChecklistStatus>;
  } catch {
    return {};
  }
}

async function writeAssessmentStore(store: Record<string, ChecklistStatus>) {
  await fs.mkdir(path.dirname(assessmentFilePath), { recursive: true });
  await fs.writeFile(assessmentFilePath, JSON.stringify(store, null, 2), 'utf8');
}

const resellerCapabilityChecklist = {
  generatedAt: new Date().toISOString(),
  sections: [
    {
      id: 'A',
      title: 'Hierarchy & role structure',
      questions: [
        'Can a franchise have unlimited levels of sub-dealers (dealer → sub-dealer → sub-sub-dealer)?',
        'Does each level see only their own child dealers/subscribers, never siblings or parents\' other branches?',
        'Can a subscriber be reassigned from one sub-dealer to another without losing billing history?',
        'Is it enforced at the database level that a subscriber belongs to exactly one dealer at a time?',
        'Can commission/profit % be set differently per hierarchy level and per dealer?',
        'Can a parent franchise directly manage a grandchild\'s subscriber without transferring ownership first?',
        'Is hierarchy depth actually unlimited, or hardcoded to N levels somewhere in the code?',
        'Can a dealer be promoted/demoted between levels without losing subscriber/transaction history?',
        'Do two franchises operating in the same area get subscriber ID collisions?',
        'When a dealer account is deleted, are its subscribers cascade-deleted, orphaned, or reassigned?',
        'Can a sub-dealer create their own sub-sub-dealer, or only the parent franchise can?',
        'Is there an approval step when a dealer adds a new child dealer?',
        'Can permissions differ between two dealers at the same hierarchy level (custom roles per dealer)?',
        'Can top-level admin view/manage any subscriber regardless of which dealer owns them?',
        'Does each hierarchy level get its own branded login/portal, or do they share one UI with role checks?',
      ],
    },
    {
      id: 'B',
      title: 'Subscriber activation',
      questions: [
        'Does "activate" check current status before proceeding, or does it always execute?',
        'If a subscriber is already active and activation is triggered again, is it blocked or does it silently double-charge?',
        'Is there a unique constraint preventing two activation records for the same billing cycle?',
        'Does mass/bulk activation auto-skip subscribers that are already active?',
        'Can an activation be undone within a defined time window?',
        'Is wallet/balance deduction on activation synchronous, or async with a delay?',
        'If wallet deduction fails mid-process, does activation still go through (bug) or roll back cleanly?',
        'Is activation wrapped in a single DB transaction (subscriber status + wallet debit + RADIUS write all succeed or all fail together)?',
        'Does every activation log who performed it (which dealer/sub-dealer, timestamp, IP)?',
        'Does activation write to RADIUS in the same transaction, or is there a sync delay/failure risk?',
        'If RADIUS activation succeeds but billing fails (or vice versa), is there a reconciliation job that catches the mismatch?',
        'Does double-clicking "Activate" in the UI fire duplicate API calls (missing debounce)?',
        'Does the activation API endpoint accept/require an idempotency key?',
        'Can a subscriber be activated on a package that\'s been discontinued/archived?',
        'Does the system block activation if the acting dealer\'s wallet balance is insufficient?',
        'Can activation be back-dated, and does billing calculate correctly if it is?',
        'Does reactivating an expired subscriber use the current package price or the price at original signup?',
        'Are "activation" and "renewal" the same code path, or distinct flows with different rules?',
        'Can two staff/dealers activate the same subscriber at the same moment (race condition)?',
        'Is there a full activation/deactivation history timeline visible per subscriber?',
      ],
    },
    {
      id: 'C',
      title: 'Double-action & reversal',
      questions: [
        'Does the hierarchy permission model even allow a franchise to directly activate a grandchild sub-dealer\'s subscriber, or should that be blocked entirely?',
        'Does the system detect a subscriber was already activated this cycle before applying a second charge?',
        'Is a "this subscriber is already active — duplicate action?" warning shown before confirming a second activation?',
        'Can support/admin locate the exact duplicate transaction (ID, timestamp, amount, actor) to reverse it?',
        'Does a reversal request require approval from the parent franchise, or can any admin process it unilaterally?',
        'When reversed, is the amount credited back to the level that was actually charged (the sub-dealer), not the top franchise?',
        'Does reversal auto-correct the subscriber\'s service status/expiry date, or only the ledger?',
        'Does reversal create a new credit-note/reversal entry, or does it edit the original transaction record (bad practice)?',
        'Can a reversal be partial (reverse only the duplicate charge, keep the legitimate one)?',
        'Is there a visible audit trail: original charge → dispute raised → reversal approved → balance restored?',
        'After reversal, is there anything preventing the exact same double-activation from recurring?',
        'If the double-activation also affected the RADIUS session/expiry, does reversal fix that too, or only the billing side?',
        'Can a dealer view a real-time log of duplicate/failed/reversed transactions scoped to their own child dealers?',
        'Is there a time cutoff after which a duplicate charge can no longer be auto-reversed and needs manual admin override?',
        'Does reversing an activation also reverse any commission already paid up the chain to parent resellers for that transaction?',
        'If the sub-dealer already spent/withdrew the (wrongly charged) balance, how does the system handle a negative balance after reversal?',
        'Can the reversal action itself be logged and require its own approval trail (reversal of a reversal)?',
        'Does the subscriber receive any notification that their activation was reversed, or does it happen silently?',
        'Is there a reason code field required when processing a reversal (dealer error, system bug, customer dispute)?',
        'Can a franchise see a consolidated view of all reversal requests across their entire dealer tree?',
        'Does the system distinguish between "reverse because duplicate" vs "refund because customer cancelled" — different accounting treatment?',
        'If the subscriber\'s package price changed between the two duplicate activations, does reversal use the correct historical price?',
        'Is there a dedicated "Disputes/Reversals" module, or is this handled ad hoc through manual ledger edits (risky)?',
      ],
    },
    {
      id: 'D',
      title: 'Wallet & balance across hierarchy',
      questions: [
        'Does each dealer/sub-dealer have their own independent wallet, or a shared pool with the parent?',
        'When a parent tops up a child dealer\'s wallet, is it a transfer (parent debited, child credited) or just child credited from nowhere?',
        'Can a sub-dealer\'s wallet go negative, and if so, is that allowed/blocked/flagged?',
        'Is there a credit limit settable per dealer independent of their actual wallet balance?',
        'Does the system prevent a dealer from spending more than their available balance in a race condition (two simultaneous activations)?',
        'Can wallet balance be viewed in real time by the dealer, or is there a reporting delay?',
        'Is there a minimum balance alert/notification per dealer?',
        'Can a parent franchise claw back balance from a child dealer\'s wallet directly?',
        'Does every wallet balance change have a corresponding ledger entry (no silent balance edits)?',
        'Is wallet currency consistent across the hierarchy, or can child dealers operate in different currencies than the parent?',
        'If a sub-dealer is deactivated/suspended, what happens to their remaining wallet balance?',
        'Can wallet top-ups be reversed if done in error?',
        'Is there a distinction between "wallet balance" and "commission earned but not yet paid out"?',
        'Does the system handle wallet balance correctly if a dealer is moved to a different parent mid-cycle?',
        'Can two operations debit the same wallet simultaneously without a lock, causing balance drift?',
        'Is there a scheduled reconciliation job comparing wallet balance vs sum of ledger entries (catches drift bugs)?',
        'Can a dealer see a breakdown of why their balance changed (which subscriber, which action) or just a running total?',
        'Does bulk/mass activation debit the wallet per-subscriber or as one batch — and does a partial failure leave a partial debit?',
        'Is wallet debit amount locked to the package price at time of transaction, immune to later price changes?',
        'Can a franchise set per-sub-dealer spending limits (e.g., max activations per day)?',
      ],
    },
    {
      id: 'E',
      title: 'Payments, refunds & credit notes',
      questions: [
        'Is every refund tied to a specific original transaction, or can refunds be issued freestanding?',
        'Does a refund automatically reverse the associated commission paid up the chain?',
        'Can refunds be partial?',
        'Is there an approval workflow for refunds above a certain amount?',
        'Does the system support refunding to the original payment method vs wallet credit — and track which was used?',
        'Are credit notes generated as proper accounting documents (with their own ID, PDF, audit trail)?',
        'Can a subscriber dispute a charge directly through the client portal, or only through their dealer?',
        'Does a dispute automatically pause auto-suspension while under review?',
        'Is there a distinct log for "payment gateway reversed this on their end" vs "we manually reversed it internally" — these can get out of sync?',
        'If a payment gateway webhook for a refund arrives late/out of order, does the system handle it idempotently?',
        'Can double-payment (subscriber pays twice by mistake) be detected and refunded automatically?',
        'Does refund processing correctly handle tax/fee components (refund the fee too, or just the base amount)?',
        'Is there a report showing all pending refund/reversal requests older than X days?',
        'Can a sub-dealer initiate a refund without franchise approval, or is it always escalated?',
        'Does the system prevent refunding an already-refunded transaction (double-refund bug)?',
      ],
    },
    {
      id: 'F',
      title: 'Package migration & renewal',
      questions: [
        'When a subscriber migrates packages mid-cycle, is the price difference pro-rated correctly?',
        'Does package migration correctly update the RADIUS profile/bandwidth in sync with the billing change?',
        'Can migration be reversed if done in error, restoring the original package and correct billing?',
        'Does auto-renewal respect the current package price or a price locked at signup?',
        'If a subscriber\'s package was discontinued, does auto-renewal fail gracefully or error out silently?',
        'Can a dealer downgrade a subscriber below what the subscriber has already paid for (and does that trigger a partial refund)?',
        'Is there a cooldown/limit on how many times a subscriber can migrate packages per cycle (abuse prevention)?',
        'Does mass package migration handle partial failures (some subscribers succeed, some fail) with a clear report?',
        'Is migration history (old package → new package, date, who did it) fully auditable?',
        'Does a failed auto-renewal correctly trigger suspension, or does the subscriber stay active unpaid?',
        'Can migration be scheduled for a future date, and does it execute reliably?',
        'Does the system prevent migrating a subscriber to a package outside their dealer\'s allowed package list?',
        'Is commission recalculated correctly when a subscriber migrates to a different-priced package?',
        'Can a sub-dealer migrate a subscriber without franchise visibility, or does it always surface upstream?',
        'If migration fails after RADIUS update but before billing update (or vice versa), is there a rollback?',
      ],
    },
    {
      id: 'G',
      title: 'Suspension, termination & reconnection',
      questions: [
        'Does non-payment auto-suspension actually trigger a RADIUS disconnect, or just a status flag in the DB?',
        'Is there a grace period before suspension, and is it configurable per dealer/package?',
        'Can a sub-dealer reconnect a suspended subscriber without franchise approval?',
        'Does reconnection correctly recalculate the new expiry date (not just flip status to active)?',
        'If a subscriber is suspended for non-payment, does paying immediately auto-reconnect, or does it require manual action?',
        'Does termination (permanent) differ from suspension (temporary) in the data model, or are they conflated?',
        'Can a terminated subscriber\'s data (usage history, invoices) still be queried after termination?',
        'Does suspending a subscriber stop future auto-invoice generation, or does it keep generating unpaid invoices?',
        'Is there a bulk suspend/reconnect action, and does it handle partial failures visibly?',
        'Does the system distinguish "suspended by dealer" vs "suspended by system for non-payment" vs "suspended by admin for abuse"?',
        'Can a franchise override and force-terminate any subscriber regardless of which sub-dealer owns them?',
        'Does reconnection after long suspension correctly re-check package validity (package may have changed/been discontinued)?',
        'Is there a maximum suspension duration after which the subscriber is auto-terminated?',
        'Does suspension status sync correctly if the subscriber has multiple services/lines?',
        'Can a subscriber see their own suspension reason in the self-service portal?',
      ],
    },
    {
      id: 'H',
      title: 'Ledger & accounting consistency',
      questions: [
        'Is there a single source-of-truth ledger, or do wallet balance, invoices, and reports each keep separate numbers that can drift?',
        'Can any transaction be edited directly, or is every correction done via a new offsetting entry (proper accounting practice)?',
        'Does the ledger show entries per hierarchy level (franchise sees consolidated, sub-dealer sees only their own)?',
        'Is there a daily/monthly closing process that locks past ledger entries from edits?',
        'Can two transactions have the same ID due to a race condition in ID generation?',
        'Does the system support an "opening balance" per dealer when they\'re first onboarded?',
        'Is commission distribution calculated and logged as its own ledger entries, separate from the subscriber charge?',
        'Can you trace any single rupee/dollar in a subscriber\'s payment through to which dealer\'s commission it contributed to?',
        'Does currency rounding (paise/cents) accumulate errors across thousands of transactions?',
        'Is there a reconciliation report comparing RADIUS accounting data against billed usage (for usage-based packages)?',
        'Can an admin export a full audit trail for a single subscriber across their entire lifetime?',
        'Does the ledger correctly handle tax calculation per region if dealers operate in different tax jurisdictions?',
        'Is there protection against backdating a ledger entry to a already-closed accounting period?',
        'Does deleting a dealer/subscriber leave their historical ledger entries intact (never hard-delete financial records)?',
        'Can the system detect and flag ledger entries that don\'t sum correctly against wallet balance (drift alert)?',
      ],
    },
    {
      id: 'I',
      title: 'Permission boundaries between levels',
      questions: [
        'Can a sub-dealer see the wallet balance or commission % of their parent franchise?',
        'Can a sub-dealer see other sub-dealers under the same parent (sibling visibility)?',
        'Is "view" access separated from "action" access at each level (can view ≠ can activate/reverse)?',
        'Can a franchise impersonate/log in as a sub-dealer to troubleshoot, and is that logged?',
        'Are API endpoints scoped server-side to the caller\'s hierarchy, or does the frontend just hide UI elements (insecure)?',
        'Can a sub-dealer escalate their own permissions by manipulating a request (IDOR risk on subscriber/dealer IDs)?',
        'Does role/permission change take effect immediately, or does the user need to re-login?',
        'Can a dealer be granted temporary elevated permissions (e.g., for a support case) with auto-expiry?',
        'Is there a distinct "read-only auditor" role for accounting review without transaction rights?',
        'Can two admins at the same level have different permission sets (not just role-based, but per-user overrides)?',
        'Does removing a dealer\'s permission immediately block in-flight actions, or only new ones?',
        'Can a sub-dealer\'s staff member (not the dealer owner) have restricted permissions within that dealer\'s account?',
        'Is 2FA enforceable per role (e.g., mandatory for franchise-level, optional for retailer-level)?',
        'Does the system log every permission change (who changed what, when)?',
        'Can a suspended dealer\'s account still process transactions until manually deactivated (window of risk)?',
      ],
    },
    {
      id: 'J',
      title: 'Concurrency / race conditions',
      questions: [
        'If two staff activate the same subscriber within the same second, does the system prevent double-billing?',
        'Are wallet debits protected by row-level locking or optimistic concurrency control?',
        'Can a bulk operation and an individual operation on the same subscriber run simultaneously and conflict?',
        'Does the RADIUS write and billing write happen in a way that\'s safe if the request times out mid-way?',
        'If a webhook (payment gateway) and a manual admin action hit the same invoice simultaneously, which wins — and is it deterministic?',
        'Is there a queue/job system for async operations, or are long operations done synchronously (risking timeouts and partial states)?',
        'Does mass activation process subscribers sequentially or in parallel, and how are partial failures surfaced?',
        'Can retrying a failed API call (client-side retry logic) cause duplicate processing without an idempotency key?',
        'Is there a distributed lock (or DB-level lock) preventing the same subscriber from being modified by two processes at once?',
        'Does high load (e.g., mass renewal day) cause any of the above race conditions to surface more often — has it been load-tested?',
      ],
    },
    {
      id: 'K',
      title: 'Notifications & audit trail',
      questions: [
        'Is every activation, suspension, reversal, and refund logged with actor, timestamp, and before/after state?',
        'Can audit logs be filtered by hierarchy level (franchise sees their whole tree\'s logs)?',
        'Are audit logs immutable (no delete/edit capability, even for admins)?',
        'Does the subscriber get notified (SMS/email) for activation, suspension, and reversal events?',
        'Does the dealer get notified when their wallet balance changes unexpectedly (large debit/credit)?',
        'Is there a notification when a reversal/dispute is raised, sent to the appropriate approver?',
        'Can notification templates be customized per franchise (white-label branding)?',
        'Is there a way to search audit logs by transaction ID, subscriber ID, or dealer ID quickly?',
        'Are failed login attempts and permission changes part of the security audit log, separate from the business audit log?',
        'Can audit logs be exported for compliance/dispute purposes?',
      ],
    },
    {
      id: 'L',
      title: 'Voucher / prepaid across hierarchy',
      questions: [
        'Are vouchers/prepaid cards assigned to a specific dealer\'s batch, traceable to who generated them?',
        'Can a voucher be redeemed twice (race condition on redemption)?',
        'Does voucher redemption correctly credit the dealer who originally sold/distributed it, not the top franchise?',
        'Can vouchers be deactivated/blacklisted if reported stolen or misprinted?',
        'Is there an expiry check on vouchers enforced server-side (not just UI validation)?',
        'Can a sub-dealer generate their own voucher batches, or only receive allocations from the parent?',
        'Does voucher generation deduct from the generating dealer\'s wallet immediately or only on redemption?',
        'Is there reporting on unredeemed vouchers per dealer (unsold inventory tracking)?',
        'Can a voucher\'s PIN be regenerated if compromised, invalidating the old one?',
        'Does bulk voucher generation handle partial failures (e.g., ran out of unique codes) gracefully?',
      ],
    },
    {
      id: 'M',
      title: 'Reporting consistency across hierarchy',
      questions: [
        'Does a franchise\'s consolidated report exactly match the sum of all their sub-dealers\' individual reports?',
        'Are reports generated in real-time from the ledger, or from a cached/batch snapshot that could be stale?',
        'Can a sub-dealer export reports scoped only to their own data (no leakage of sibling data)?',
        'Do revenue reports correctly exclude reversed/refunded transactions, or double-count them?',
        'Is there a report specifically for "pending reversals/disputes" visible to franchise level?',
        'Can reports be filtered by date range and does that correctly handle timezone differences across dealer locations?',
        'Does the reseller performance report account for commission correctly after reversals are applied?',
        'Are network/usage reports (bandwidth, sessions) reconciled against billing reports, or are they separate systems that can disagree?',
        'Can custom reports be built without direct DB access (safe query builder for non-technical franchise owners)?',
        'Is there an automated daily/weekly summary report emailed to each hierarchy level?',
      ],
    },
    {
      id: 'N',
      title: 'RADIUS/network sync with billing state',
      questions: [
        'If a subscriber is deactivated in billing but the RADIUS session is still live, is there a job that force-disconnects it?',
        'Does a RADIUS accounting "stop" record (session ended) ever fail to reach the billing system, leaving a stale "online" status?',
        'Is there a periodic sync job comparing RADIUS state vs application subscriber status to catch drift?',
        'If CoA (Change of Authorization) fails to reach the NAS (router offline), does the system retry, or silently assume success?',
        'Does bandwidth/package change reflect in RADIUS immediately, or only on the subscriber\'s next reconnect?',
        'If a NAS/router goes offline entirely, does billing still process renewals correctly for subscribers on that router?',
        'Is there an alert when RADIUS and billing subscriber counts diverge beyond a threshold (early warning for sync bugs)?',
      ],
    },
  ],
};

@Controller()
export class AppController {

  @Get('health')
  health() {
    // `build` lets a deploy/smoke-test confirm the NEW code is actually live
    // (deterministic, unlike grepping one-shot startup logs across cluster
    // workers). Bump BUILD_MARKER in main.ts alongside significant changes.
    return { ok: true, build: (globalThis as any).__JB_BUILD__ || 'unknown', ts: new Date().toISOString() };
  }

  /**
   * Server CPU % + RAM for the dashboard KPI row.
   *
   * Host-level details are ISP-only: SUPER_ADMIN / ADMIN see the numbers;
   * any other role gets `visible:false` and the UI hides the cards. CPU% is a
   * delta between two os.cpus() samples ~300ms apart (instantaneous busy share),
   * RAM is used/total from the os module — no shell, works on any platform.
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('system/stats')
  async systemStats(@Req() req: any) {
    const role = req?.user?.role;
    if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
      return { visible: false };
    }

    const sample = (list: os.CpuInfo[]) => {
      let idle = 0;
      let total = 0;
      for (const c of list) {
        idle += c.times.idle;
        total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      }
      return { idle, total };
    };

    const a = sample(os.cpus());
    await new Promise((r) => setTimeout(r, 300));
    const b = sample(os.cpus());
    const dTotal = b.total - a.total;
    const cpu = dTotal > 0 ? Math.round(((dTotal - (b.idle - a.idle)) / dTotal) * 100) : 0;

    const ramTotal = os.totalmem();
    const ramUsed = ramTotal - os.freemem();

    return {
      visible: true,
      cpu: Math.min(100, Math.max(0, cpu)),
      ramPct: ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : 0,
      ramUsedGb: +(ramUsed / 1024 ** 3).toFixed(1),
      ramTotalGb: +(ramTotal / 1024 ** 3).toFixed(1),
      uptimeSecs: os.uptime(),
    };
  }

  private assertSuperAdmin(req: any) {
    if (req?.user?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only SUPER_ADMIN may access update operations.');
    }
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('profile')
  profile(@Req() req: any) {
    return {
      message: 'Protected Profile 🔐',
      user: req.user,
    };
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('update/check')
  async checkForUpdate(@Req() req: any) {
    this.assertSuperAdmin(req);

    try {
      const gitBranch = (await runGitCommand('git rev-parse --abbrev-ref HEAD')).stdout.trim();
      const remoteBranch = `origin/${gitBranch}`;

      await runGitCommand(`git fetch origin ${gitBranch}`);

      const localHash = (await runGitCommand('git rev-parse HEAD')).stdout.trim();
      const remoteHash = (await runGitCommand(`git rev-parse ${remoteBranch}`)).stdout.trim();
      const latest = (await runGitCommand('git log -1 --pretty=format:%H%n%an%n%ar%n%s')).stdout.trim().split('\n');

      return {
        ok: true,
        branch: gitBranch,
        behind: localHash !== remoteHash,
        localHash,
        remoteHash,
        latest: {
          commit: latest[0] || '',
          author: latest[1] || '',
          age: latest[2] || '',
          message: latest[3] || '',
        },
      };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Update check failed: ${error?.message || String(error)}`,
      );
    }
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Post('update/pull')
  async pullUpdate(@Req() req: any, @Body() body?: { force?: boolean }) {
    this.assertSuperAdmin(req);

    // WHY delegate to update-jointbox.sh instead of running git/build inline:
    //  • the old inline version computed the frontend path from the backend's
    //    cwd, so it looked for backend/frontend and never rebuilt the UI;
    //  • it never ran DB migrations, so new columns were missing after update
    //    (the "panel breaks after update" bug);
    //  • committed build artifacts made `git status` dirty and blocked it.
    // The committed script already handles clean-up, `npm run db:deploy`,
    // both builds and a pm2 reload correctly. We run it DETACHED (nohup) so it
    // survives the backend restart it performs mid-run, and log to a file the
    // UI can poll.
    try {
      const repoRoot = (await runGitCommand('git rev-parse --show-toplevel')).stdout.trim();
      const script = path.join(repoRoot, 'update-jointbox.sh');
      if (!(await fs.stat(script).then(() => true).catch(() => false))) {
        return { ok: false, message: `update-jointbox.sh not found at ${repoRoot}. Run it from the server shell instead.` };
      }

      const gitBranch = (await runGitCommand('git rev-parse --abbrev-ref HEAD')).stdout.trim();

      /**
       * WHY the button used to do nothing.
       *
       * `git fetch` was wrapped in `.catch(() => undefined)` and, when it
       * failed, remoteHash fell back to localHash — so the hashes matched, the
       * method returned "Already up to date" and the update NEVER RAN. From the
       * UI that looks like a dead button, which is exactly what operators saw,
       * while `bash update-jointbox.sh` on the server worked fine.
       *
       * Fetch can legitimately fail here even when it works in a shell: the pm2
       * environment differs, and git refuses a repo owned by another user
       * ("dubious ownership") unless it is marked safe. So:
       *   1. mark the repo safe before any git call,
       *   2. never swallow a fetch failure — surface it,
       *   3. when the operator explicitly clicks Update, RUN THE SCRIPT even if
       *      we cannot tell whether we are behind. The script does its own
       *      fetch/reset/pull and is safe to run when already current.
       */
      await runGitCommand(`git config --global --add safe.directory "${repoRoot}"`).catch(() => undefined);

      let fetchFailed = false;
      try {
        await runGitCommand(`git fetch origin ${gitBranch}`, repoRoot);
      } catch (e: any) {
        fetchFailed = true;
        this.logger?.warn?.(`update: git fetch failed (${e?.message || e}) — running the update script anyway.`);
      }

      const localHash = (await runGitCommand('git rev-parse HEAD', repoRoot)).stdout.trim();
      let remoteHash = '';
      try {
        remoteHash = (await runGitCommand(`git rev-parse origin/${gitBranch}`, repoRoot)).stdout.trim();
      } catch { /* unknown — fall through and run the script */ }

      // Only claim "up to date" when we actually PROVED it.
      if (!fetchFailed && remoteHash && localHash === remoteHash && body?.force !== true) {
        return { ok: true, message: 'Already up to date.', branch: gitBranch };
      }

      // Fire-and-forget: nohup + detached so killing the backend (which the
      // script does via pm2) can't abort the update. Output goes to a log.
      const logFile = path.join(repoRoot, 'update.log');
      const child = spawn('bash', ['-lc', `cd "${repoRoot}" && bash update-jointbox.sh > "${logFile}" 2>&1`], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();

      return {
        ok: true,
        started: true,
        branch: gitBranch,
        message: 'Update started. The panel will pull the latest code, migrate the database, rebuild and restart automatically (about 1–2 minutes). Refresh the page shortly. Progress is logged to update.log on the server.',
        logFile,
      };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Update pull failed: ${error?.message || String(error)}`,
      );
    }
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('features/reseller-capability-checklist')
  async resellerCapabilityChecklistPayload() {
    const assessmentStore = await readAssessmentStore();
    const sections = resellerCapabilityChecklist.sections.map((section) => ({
      ...section,
      questions: section.questions.map((question, index) => ({
        id: `${section.id}-${index + 1}`,
        text: question,
        status: assessmentStore[`${section.id}-${index + 1}`] ?? 'unassessed',
      })),
    }));

    return {
      generatedAt: new Date().toISOString(),
      totalQuestions: sections.reduce((sum, section) => sum + section.questions.length, 0),
      sections,
    };
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Post('features/reseller-capability-checklist')
  async updateResellerCapabilityChecklist(
    @Body() body: { questionId: string; status: ChecklistStatus },
    @Req() req: any,
  ) {
    if (!body?.questionId || !body?.status || !CHECKLIST_STATUS.includes(body.status)) {
      return { ok: false, message: 'questionId and a valid status are required.' };
    }

    const assessmentStore = await readAssessmentStore();
    assessmentStore[body.questionId] = body.status;
    await writeAssessmentStore(assessmentStore);

    return {
      ok: true,
      questionId: body.questionId,
      status: body.status,
      updatedBy: req?.user?.id ?? null,
    };
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Get('features/advanced')
  advancedFeatures() {
    return {
      generatedAt: new Date().toISOString(),
      strategy: 'next-generation-isp-platform',
      categories: [
        {
          id: 'ai-automation',
          label: 'AI & Automation',
          description: 'Operator assistance, recommendations, and network intelligence.',
          features: [
            {
              name: 'Intelligent assistant',
              maturity: 'Planned',
              status: 'planned',
              description: 'Guided troubleshooting and contextual next-best actions for operators.',
            },
            {
              name: 'AI-powered network management',
              maturity: 'Planned',
              status: 'planned',
              description: 'Predictive monitoring, anomaly detection, and proactive operations.',
            },
            {
              name: 'Personalized recommendations',
              maturity: 'Planned',
              status: 'planned',
              description: 'Behavior-driven package, pricing, and support recommendations.',
            },
          ],
        },
        {
          id: 'ops-visibility',
          label: 'Operations & Visibility',
          description: 'Live telemetry and faster decision support for field and support teams.',
          features: [
            {
              name: 'Real-time monitoring 2.0',
              maturity: 'In Progress',
              status: 'in-progress',
              description: 'Expanded live observability across subscriber, router, and segment health.',
            },
            {
              name: 'Customizable dashboards 2.0',
              maturity: 'In Progress',
              status: 'in-progress',
              description: 'Role-based, KPI-focused widgets for operators, managers, and resellers.',
            },
            {
              name: 'Mobile optimization 2.0',
              maturity: 'Planned',
              status: 'planned',
              description: 'A field-ready responsive experience for mobile operations.',
            },
          ],
        },
        {
          id: 'security-trust',
          label: 'Security & Trust',
          description: 'Stronger access, authentication, and platform integrity controls.',
          features: [
            {
              name: 'Enhanced security features 2.0',
              maturity: 'In Progress',
              status: 'in-progress',
              description: 'Advanced identity protection, privilege controls, and hardened session handling.',
            },
            {
              name: 'Integrated security protocols 2.0',
              maturity: 'Planned',
              status: 'planned',
              description: 'Forward-looking protocol defense layered across network and application flows.',
            },
            {
              name: 'Blockchain-based security and authentication',
              maturity: 'Research',
              status: 'research',
              description: 'Tamper-resistant identity and verification patterns for trust-critical operations.',
            },
          ],
        },
        {
          id: 'scale-growth',
          label: 'Scale & Network Evolution',
          description: 'Automation and architecture readiness for complex ISP growth.',
          features: [
            {
              name: 'Scalable architecture 2.0',
              maturity: 'In Progress',
              status: 'in-progress',
              description: 'A modular backbone for larger ISP, franchise, and reseller deployments.',
            },
            {
              name: 'Automated network management 2.0',
              maturity: 'Planned',
              status: 'planned',
              description: 'Policy-based automation for network health and service continuity.',
            },
            {
              name: 'Advanced routing and switching 2.0',
              maturity: 'Planned',
              status: 'planned',
              description: 'Traffic shaping and resilience improvements for growth-stage networks.',
            },
            {
              name: 'Machine learning-based network optimization 2.0',
              maturity: 'Research',
              status: 'research',
              description: 'Adaptive traffic optimization using measurable performance signals.',
            },
            {
              name: 'Edge computing and IoT integration',
              maturity: 'Research',
              status: 'research',
              description: 'Distributed services and smart device support at the network edge.',
            },
          ],
        },
        {
          id: 'engagement',
          label: 'Engagement & Collaboration',
          description: 'Tools for motivating teams and shared operational execution.',
          features: [
            {
              name: 'Gamification and incentives',
              maturity: 'Planned',
              status: 'planned',
              description: 'Rewards and achievement loops for improved operator performance.',
            },
            {
              name: 'Social sharing and collaboration',
              maturity: 'Planned',
              status: 'planned',
              description: 'Shared knowledge and coordinated support workflows across teams.',
            },
          ],
        },
      ],
    };
  }
}