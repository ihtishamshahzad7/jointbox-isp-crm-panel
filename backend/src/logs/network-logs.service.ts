import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';
import { terminateInfo } from '../common/radius-terminate';
import { mapLimit, withTimeout } from '../common/concurrency';
import { DatabaseSetupService } from '../common/database-setup.service';
import { ScopeService, Actor } from '../common/scope.service';

@Injectable()
export class NetworkLogsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NetworkLogsService.name);
  private pollingInterval: NodeJS.Timeout | null = null;

  // Track last-seen radacct & radpostauth rows to detect new entries
  private lastRadAcctId = 0;
  private lastRadPostAuthId = BigInt(0);

  constructor(
    private prisma: PrismaService,
    private mikrotikSync: MikrotikSyncService,
    private dbSetup: DatabaseSetupService,
    private scope: ScopeService,
  ) {}

  /**
   * Subtree filter for network logs.
   *
   * These rows carry usernames, phone numbers, IPs and per-router events — a
   * sibling's whole customer base, if left unscoped. A non-ISP caller sees a
   * row only when it belongs to their own tree:
   *
   *   • the subscriber on the row is in their subtree, OR
   *   • the router on the row is one they own or were shared.
   *
   * NAS-level events (NAS_ONLINE/OFFLINE) have no subscriber, so the router
   * clause is what keeps a franchise's own-router events visible to it while
   * hiding a sibling franchise's routers. The ISP (admin) sees everything.
   */
  private async networkScopeWhere(actor?: Actor): Promise<any> {
    if (!actor || this.scope.isAdmin(actor.role)) return {};
    const [subWhere, nasList] = await Promise.all([
      this.scope.subscriberWhere(actor),
      this.prisma.nas.findMany({ where: await this.scope.nasWhere(actor), select: { id: true } }),
    ]);
    const nasIds = nasList.map((n) => n.id);
    return {
      OR: [
        { subscriber: subWhere },
        ...(nasIds.length ? [{ nasId: { in: nasIds } }] : []),
      ],
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────

  // ── Scale tuning (override in .env) ─────────────────────────
  // FAST cycle  : live sessions + counters. One cheap API call per router.
  // SLOW cycle  : reachability probes + full syncDetails. Expensive, rare.
  // CONCURRENCY : routers polled in parallel. 200 routers × ~300ms at 20-wide
  //               ≈ 3s per sweep, versus ~17 minutes sequentially.
  private readonly fastMs      = Number(process.env.NAS_FAST_POLL_MS      || 30_000);
  private readonly slowMs      = Number(process.env.NAS_SLOW_POLL_MS      || 300_000);
  private readonly concurrency = Number(process.env.NAS_POLL_CONCURRENCY  || 20);
  private slowInterval: NodeJS.Timeout | null = null;
  private fastRunning = false;
  private slowRunning = false;

  async onModuleInit() {
    // Seed high-water marks so we don't flood logs on first boot
    await this.seedHighWaterMarks();
    this.startPolling(this.fastMs);

    // Heavy health sweep on its own, much slower, timer.
    this.slowInterval = setInterval(() => this.runSlowCycle(), this.slowMs);
    this.slowInterval.unref?.();

    // Nightly-ish archival, in-process, so a fresh install needs no crontab.
    // radacct is the fastest-growing table in the system; left alone it reaches
    // millions of rows a year and every session query slows with it.
    const archiveEvery = Number(process.env.RADACCT_ARCHIVE_INTERVAL_MS || 24 * 60 * 60 * 1000);
    const archiveTimer = setInterval(() => {
      this.dbSetup.archiveOldSessions().catch(() => {});
    }, archiveEvery);
    archiveTimer.unref?.();
    this.logger.log(
      `NAS polling: fast ${this.fastMs / 1000}s · health ${this.slowMs / 1000}s · concurrency ${this.concurrency}`,
    );
  }

  onModuleDestroy() {
    this.stopPolling();
  }

  private async seedHighWaterMarks() {
    try {
      const [latestAcct, latestAuth] = await Promise.all([
        this.prisma.radAcct.findFirst({ orderBy: { radacctid: 'desc' } }),
        this.prisma.radPostAuth.findFirst({ orderBy: { id: 'desc' } }),
      ]);
      if (latestAcct) this.lastRadAcctId = latestAcct.radacctid;
      if (latestAuth) this.lastRadPostAuthId = latestAuth.id;
      this.logger.log(`High-water marks: radacct=${this.lastRadAcctId}, radpostauth=${this.lastRadPostAuthId}`);
    } catch (err: any) {
      this.logger.warn(`Could not seed high-water marks: ${err.message}`);
    }
  }

  // ── Polling ─────────────────────────────────────────────────

  startPolling(intervalMs = 30_000) {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    this.pollingInterval = setInterval(() => this.runPollCycle(), intervalMs);
    this.logger.log(`Polling started (every ${intervalMs / 1000}s)`);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      this.logger.log('Polling stopped');
    }
  }

  /**
   * FAST cycle — everything needed for live status. Deliberately excludes the
   * reachability probes and syncDetails, which used to make each router take
   * ~5s and capped the whole system at about 6 NAS.
   *
   * Guarded by `fastRunning` so a slow sweep can never stack on itself.
   */
  async runPollCycle() {
    if (this.fastRunning) {
      this.logger.warn('Fast poll still running — skipping this tick (raise NAS_FAST_POLL_MS?)');
      return;
    }
    this.fastRunning = true;
    const started = Date.now();
    try {
      await Promise.all([
        this.reconcileWithRouters(),
        this.closeStaleSessions(),
        this.syncRadAcctEvents(),
        this.syncRadPostAuthEvents(),
      ]);
    } catch (err: any) {
      this.logger.error(`Poll cycle error: ${err.message}`);
    } finally {
      this.fastRunning = false;
      const ms = Date.now() - started;
      if (ms > this.fastMs * 0.8) {
        this.logger.warn(`Fast cycle took ${ms}ms of a ${this.fastMs}ms budget — nearing overload`);
      }
    }
  }

  /** SLOW cycle — reachability + full device details for every router. */
  async runSlowCycle() {
    if (this.slowRunning) return;
    this.slowRunning = true;
    const started = Date.now();
    try {
      await this.pollAllNasDevices();
    } catch (err: any) {
      this.logger.error(`Health cycle error: ${err.message}`);
    } finally {
      this.slowRunning = false;
      this.logger.debug(`NAS health sweep finished in ${Date.now() - started}ms`);
    }
  }

  // ── Reconcile RADIUS sessions against the ROUTER (source of truth) ──
  // RADIUS only learns a user disconnected if the NAS sends Accounting-Stop.
  // When that packet is lost the session stays open forever and the panel shows
  // the user online indefinitely. Timestamp-based staleness can't save us either
  // if the router and server clocks disagree. So we ask the router directly:
  // anyone not in /ppp/active is not online, full stop.
  async reconcileWithRouters() {
    let nasList: any[] = [];
    try {
      nasList = await this.prisma.nas.findMany({ where: { isActive: true } });
    } catch {
      return 0;
    }

    // Routers are reconciled in parallel (bounded) — this is the hot path that
    // decides who shows as online, so it must finish well inside the fast tick.
    const usable = nasList.filter((n) => n.nasIp && n.apiUsername && n.apiPassword);
    const perNas = await mapLimit(usable, this.concurrency, (nas) =>
      withTimeout(this.reconcileOneRouter(nas), 15_000, `NAS ${nas.nasname} reconcile`),
    );
    return perNas.reduce((sum, r) => sum + (r.ok ? r.value : 0), 0);
  }

  /** Reconcile a single router's sessions against RADIUS. */
  private async reconcileOneRouter(nas: any): Promise<number> {
    let closedTotal = 0;
    {

      let active: Array<{
        username: string; uploadBytes: number | null; downloadBytes: number | null;
      }> = [];
      try {
        active = await this.mikrotikSync.getActivePppoeUsers(
          nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword,
        );
      } catch (err: any) {
        // Router unreachable — do NOT close sessions, we simply don't know.
        this.logger.debug(`Reconcile skipped for ${nas.nasname}: ${err?.message || err}`);
        return 0;
      }

      const online = new Set(active.map((a) => a.username));

      // Push the router's LIVE byte counters into the open sessions.
      //
      // SCALE: this used to run one UPDATE per online user per cycle — at 5,000
      // online that was 10,000 queries every 30 seconds and would flatten the
      // database. It is now a SINGLE statement per router using a VALUES list,
      // so 5,000 users cost one query instead of ten thousand.
      const withCounters = active.filter((a) => a.uploadBytes != null || a.downloadBytes != null);
      if (withCounters.length) {
        // Chunked so a router with tens of thousands of sessions doesn't build
        // a single statement large enough to blow the parameter limit.
        const CHUNK = 1000;
        for (let i = 0; i < withCounters.length; i += CHUNK) {
          const slice = withCounters.slice(i, i + CHUNK);
          // $1 = nas ip, then (username, up, down) triples from $2 onward.
          const params: any[] = [nas.nasIp];
          const tuples = slice.map((a) => {
            const base = params.length;
            params.push(
              a.username,
              Math.max(0, Number(a.uploadBytes || 0)),
              Math.max(0, Number(a.downloadBytes || 0)),
            );
            return `($${base + 1}, $${base + 2}::bigint, $${base + 3}::bigint)`;
          });

          try {
            await this.prisma.$executeRawUnsafe(
              `UPDATE radacct r
                  SET acctinputoctets  = GREATEST(COALESCE(r.acctinputoctets, 0),  v.up),
                      acctoutputoctets = GREATEST(COALESCE(r.acctoutputoctets, 0), v.down),
                      acctupdatetime   = NOW()
                 FROM (VALUES ${tuples.join(',')}) AS v(username, up, down)
                WHERE r.acctstoptime IS NULL
                  AND r.username      = v.username
                  AND r.nasipaddress  = $1::inet`,
              ...params,
            );

            // Same treatment for the panel's own session table.
            const pParams: any[] = [];
            const pTuples = slice.map((a) => {
              const base = pParams.length;
              pParams.push(
                a.username,
                Math.max(0, Number(a.uploadBytes || 0)),
                Math.max(0, Number(a.downloadBytes || 0)),
              );
              return `($${base + 1}, $${base + 2}::int, $${base + 3}::int)`;
            });
            await this.prisma.$executeRawUnsafe(
              `UPDATE "PppoeSession" p
                  SET "inputOctets" = v.up, "outputOctets" = v.down, "lastSeenAt" = NOW()
                 FROM (VALUES ${pTuples.join(',')}) AS v(username, up, down)
                WHERE p."isActive" = true AND p.username = v.username`,
              ...pParams,
            );
          } catch (e: any) {
            this.logger.debug(`Bulk counter update failed for ${nas.nasname}: ${e?.message || e}`);
          }
        }
      }

      // Open RADIUS sessions on this NAS that the router says are gone.
      let orphans: any[] = [];
      try {
        orphans = await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT radacctid, username, acctsessionid
             FROM radacct
            WHERE acctstoptime IS NULL AND nasipaddress = $1::inet`,
          nas.nasIp,
        );
      } catch {
        return 0;
      }

      const toClose = orphans.filter((o) => o.username && !online.has(o.username));
      if (!toClose.length) return 0;

      // SCALE: close them all in two statements rather than two per session.
      // A router reboot can orphan thousands of sessions at once; looping would
      // mean thousands of queries in a single cycle.
      try {
        const ids = toClose.map((o) => Number(o.radacctid));
        await this.prisma.$executeRawUnsafe(
          `UPDATE radacct
              SET acctstoptime       = COALESCE(acctupdatetime, acctstarttime),
                  acctterminatecause = 'Session-Gone-From-NAS',
                  acctsessiontime    = COALESCE(
                    acctsessiontime,
                    EXTRACT(EPOCH FROM (COALESCE(acctupdatetime, acctstarttime) - acctstarttime))::int)
            WHERE acctstoptime IS NULL AND radacctid = ANY($1::int[])`,
          ids,
        );
        await this.prisma.pppoeSession.updateMany({
          where: { sessionId: { in: toClose.map((o) => o.acctsessionid) }, isActive: true },
          data: { isActive: false, endTime: new Date(), disconnectReason: 'Session-Gone-From-NAS' },
        });
        closedTotal += ids.length;
      } catch (e: any) {
        this.logger.debug(`Bulk session close failed for ${nas.nasname}: ${e?.message || e}`);
      }

      this.logger.log(
        `Reconciled ${nas.nasname}: router reports ${online.size} online, ` +
          `closed ${toClose.length} orphaned RADIUS session(s).`,
      );
    }

    return closedTotal;
  }

  // ── RADIUS HEALTH / DIAGNOSTICS (surfaced in the GUI) ────────
  // Everything here was previously only discoverable by SSH-ing into the RADIUS
  // box and reading `freeradius -X` output. Each check maps to a real failure
  // we can otherwise only find by hand.
  async getRadiusDiagnostics() {
    const checks: Array<{
      key: string; label: string; status: 'OK' | 'WARN' | 'FAIL';
      detail: string; hint?: string;
    }> = [];
    const push = (c: (typeof checks)[number]) => checks.push(c);
    const one = async <T>(sql: string): Promise<T | null> => {
      try {
        const r = await this.prisma.$queryRawUnsafe<any[]>(sql);
        return (r?.[0] ?? null) as T;
      } catch {
        return null;
      }
    };

    // 1. Clock skew between this server and the NAS (breaks uptime, staleness,
    //    session billing). NAS timestamps arrive via Event-Timestamp.
    const skew = await one<{ skew_seconds: number | null }>(`
      SELECT EXTRACT(EPOCH FROM (MAX(acctstarttime) - NOW()))::int AS skew_seconds
      FROM radacct WHERE acctstarttime > NOW() - INTERVAL '2 days'
    `);
    const skewSecs = Number(skew?.skew_seconds ?? 0);
    push({
      key: 'clock',
      label: 'Server ⇄ NAS clock sync',
      status: Math.abs(skewSecs) > 120 ? 'FAIL' : Math.abs(skewSecs) > 30 ? 'WARN' : 'OK',
      detail: Math.abs(skewSecs) > 30
        ? `NAS timestamps are ${Math.round(skewSecs / 60)} min ${skewSecs > 0 ? 'ahead of' : 'behind'} this server`
        : 'Clocks agree',
      hint: Math.abs(skewSecs) > 30
        ? 'Run `sudo timedatectl set-ntp true` on the RADIUS server and enable NTP on the router. Uptime, session duration and stale detection are all wrong until this matches.'
        : undefined,
    });

    // 2. Sessions the NAS abandoned without sending Accounting-Stop.
    const stale = await one<{ n: number }>(`
      SELECT COUNT(*)::int AS n FROM radacct
      WHERE acctstoptime IS NULL
        AND COALESCE(acctupdatetime, acctstarttime) <= NOW() - INTERVAL '15 minutes'
    `);
    push({
      key: 'stale',
      label: 'Stale sessions',
      status: (stale?.n ?? 0) > 0 ? 'WARN' : 'OK',
      detail: `${stale?.n ?? 0} session(s) open with no NAS update in 15 min`,
      hint: (stale?.n ?? 0) > 0
        ? 'The NAS never sent Accounting-Stop (router reboot / packet loss). These are auto-closed every 30s and shown as Offline.'
        : undefined,
    });

    // 3. Are interim updates actually arriving? Without them TX/RX stay at 0.
    const interim = await one<{ open: number; updating: number }>(`
      SELECT COUNT(*)::int AS open,
             COUNT(*) FILTER (WHERE acctupdatetime IS NOT NULL
                              AND acctupdatetime > acctstarttime)::int AS updating
      FROM radacct WHERE acctstoptime IS NULL
    `);
    const openN = interim?.open ?? 0;
    const updN = interim?.updating ?? 0;
    push({
      key: 'interim',
      label: 'Interim accounting updates',
      status: openN === 0 ? 'OK' : updN === 0 ? 'FAIL' : updN < openN ? 'WARN' : 'OK',
      detail: openN === 0
        ? 'No open sessions to evaluate'
        : `${updN}/${openN} live session(s) reporting interim updates`,
      hint: openN > 0 && updN < openN
        ? 'Live upload/download stay at 0 without interim updates. Ensure Acct-Interim-Interval is returned in the Access-Accept (Sync All to RADIUS), or set `/ppp aaa set interim-update=1m` on the router.'
        : undefined,
    });

    // 4. FreeRADIUS matches clients on `nasname`, which must be the NAS IP.
    const badNas = await one<{ n: number }>(`
      SELECT COUNT(*)::int AS n FROM nas
      WHERE "nasIp" IS NULL OR nasname IS DISTINCT FROM "nasIp"
    `);
    push({
      key: 'nas',
      label: 'NAS client records',
      status: (badNas?.n ?? 0) > 0 ? 'FAIL' : 'OK',
      detail: (badNas?.n ?? 0) > 0
        ? `${badNas?.n} NAS record(s) where nasname ≠ IP — FreeRADIUS will ignore that router`
        : 'All NAS records valid',
      hint: (badNas?.n ?? 0) > 0
        ? 'Requests from that router are silently dropped and appear as "RADIUS timeout". Re-save the NAS in the panel — it is auto-repaired on backend restart.'
        : undefined,
    });

    // 5. Duplicate NAS on the same IP.
    const dupNas = await one<{ n: number }>(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT "nasIp" FROM nas WHERE "nasIp" IS NOT NULL
        GROUP BY "nasIp" HAVING COUNT(*) > 1
      ) d
    `);
    push({
      key: 'nas_dup',
      label: 'Duplicate NAS entries',
      status: (dupNas?.n ?? 0) > 0 ? 'WARN' : 'OK',
      detail: (dupNas?.n ?? 0) > 0 ? `${dupNas?.n} IP(s) registered more than once` : 'No duplicates',
    });

    // 6. Subscribers that can never authenticate (no radcheck password).
    const noAuth = await one<{ n: number }>(`
      SELECT COUNT(*)::int AS n FROM "Subscriber" s
      WHERE s.username IS NOT NULL AND s.username <> ''
        AND NOT EXISTS (SELECT 1 FROM radcheck r WHERE r.username = s.username)
    `);
    push({
      key: 'radcheck',
      label: 'Subscribers synced to RADIUS',
      status: (noAuth?.n ?? 0) > 0 ? 'WARN' : 'OK',
      detail: (noAuth?.n ?? 0) > 0
        ? `${noAuth?.n} subscriber(s) have no radcheck entry and cannot log in`
        : 'All subscribers present in radcheck',
      hint: (noAuth?.n ?? 0) > 0 ? 'Use "Sync All to RADIUS" on the Subscribers page.' : undefined,
    });

    // 7. radacct schema completeness (a missing column silently kills accounting).
    const cols = await this.prisma
      .$queryRawUnsafe<any[]>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='radacct' AND column_name IN
        ('acctupdatetime','acctinterval','framedipv6address','framedipv6prefix',
         'framedinterfaceid','delegatedipv6prefix')
      `)
      .catch(() => [] as any[]);
    push({
      key: 'schema',
      label: 'radacct schema',
      status: (cols?.length ?? 0) >= 6 ? 'OK' : 'FAIL',
      detail: `${cols?.length ?? 0}/6 accounting columns present`,
      hint: (cols?.length ?? 0) < 6
        ? 'FreeRADIUS accounting INSERTs fail entirely — no sessions are recorded. Run `npx prisma db push` on the backend.'
        : undefined,
    });

    // 8. Recent auth activity — proves requests are reaching the server at all.
    const auth = await one<{ accepts: number; rejects: number }>(`
      SELECT COUNT(*) FILTER (WHERE reply ILIKE '%accept%')::int AS accepts,
             COUNT(*) FILTER (WHERE reply NOT ILIKE '%accept%')::int AS rejects
      FROM radpostauth WHERE authdate > NOW() - INTERVAL '24 hours'
    `);
    push({
      key: 'auth',
      label: 'Authentication activity (24h)',
      status: (auth?.accepts ?? 0) + (auth?.rejects ?? 0) === 0 ? 'WARN' : 'OK',
      detail: `${auth?.accepts ?? 0} accepted · ${auth?.rejects ?? 0} rejected`,
      hint: (auth?.accepts ?? 0) + (auth?.rejects ?? 0) === 0
        ? 'No RADIUS requests received in 24h. Check the shared secret and that the router points at this server.'
        : undefined,
    });

    // Stale session detail rows for the table in the UI.
    const staleRows = await this.prisma
      .$queryRawUnsafe<any[]>(`
        SELECT username, nasipaddress, framedipaddress, callingstationid,
               acctstarttime, acctupdatetime,
               EXTRACT(EPOCH FROM (NOW() - COALESCE(acctupdatetime, acctstarttime)))::int AS silent_seconds
        FROM radacct
        WHERE acctstoptime IS NULL
          AND COALESCE(acctupdatetime, acctstarttime) <= NOW() - INTERVAL '15 minutes'
        ORDER BY COALESCE(acctupdatetime, acctstarttime) ASC
        LIMIT 100
      `)
      .catch(() => [] as any[]);

    const summary = {
      failures: checks.filter((c) => c.status === 'FAIL').length,
      warnings: checks.filter((c) => c.status === 'WARN').length,
      healthy: checks.every((c) => c.status === 'OK'),
      clockSkewSeconds: skewSecs,
      generatedAt: new Date().toISOString(),
    };

    return { summary, checks, staleSessions: staleRows };
  }

  // ── Stale-session janitor ───────────────────────────────────
  // If a NAS reboots, loses power, or the RADIUS server restarts mid-session,
  // the Accounting-Stop never arrives and the radacct row stays open forever —
  // so the panel shows the user "online" indefinitely with frozen counters.
  // Close anything the NAS hasn't reported on for 15 minutes and mark why.
  // Requires interim-updates on the NAS to be accurate.
  async closeStaleSessions() {
    try {
      const closed = await this.prisma.$executeRawUnsafe(`
        UPDATE radacct
        SET acctstoptime       = COALESCE(acctupdatetime, acctstarttime),
            acctterminatecause = 'Stale-Session',
            acctsessiontime    = COALESCE(
              acctsessiontime,
              EXTRACT(EPOCH FROM (COALESCE(acctupdatetime, acctstarttime) - acctstarttime))::int
            )
        WHERE acctstoptime IS NULL
          AND COALESCE(acctupdatetime, acctstarttime) <= NOW() - INTERVAL '15 minutes'
      `);
      if (closed > 0) {
        this.logger.warn(
          `Closed ${closed} stale RADIUS session(s) with no NAS update in 15 min. ` +
            `If this recurs, enable interim-update on the router.`,
        );
        // Mirror into the app's own session table so the UI agrees.
        await this.prisma.pppoeSession.updateMany({
          where: { isActive: true, lastSeenAt: { lte: new Date(Date.now() - 15 * 60_000) } },
          data: { isActive: false, endTime: new Date(), disconnectReason: 'Stale-Session' },
        });
      }
      return closed;
    } catch (err: any) {
      this.logger.warn(`Stale-session cleanup skipped: ${err.message}`);
      return 0;
    }
  }

  // ── RADIUS radacct → NetworkLog (connections / disconnections) ──

  async syncRadAcctEvents() {
    // New stopped sessions (have acctstoptime, id > last seen)
    const stoppedSessions = await this.prisma.radAcct.findMany({
      where: {
        radacctid:    { gt: this.lastRadAcctId },
        acctstoptime: { not: null },
      },
      orderBy: { radacctid: 'asc' },
      take: 200,
    });

    // New active sessions (no acctstoptime, id > last seen)
    const activeSessions = await this.prisma.radAcct.findMany({
      where: {
        radacctid:    { gt: this.lastRadAcctId },
        acctstoptime: null,
        acctstarttime: { not: null },
      },
      orderBy: { radacctid: 'asc' },
      take: 200,
    });

    const allNew = [...activeSessions, ...stoppedSessions].sort(
      (a, b) => a.radacctid - b.radacctid,
    );

    // SCALE: resolve every subscriber in ONE query up front instead of one
    // lookup per row. With a batch of 200 rows that is 1 query, not 200.
    const usernames = [...new Set(allNew.map((a) => a.username).filter(Boolean))] as string[];
    const subs = usernames.length
      ? await this.prisma.subscriber.findMany({
          where: { username: { in: usernames } },
          select: { id: true, username: true },
        })
      : [];
    const subByName = new Map(subs.map((s) => [s.username, s]));

    for (const acct of allNew) {
      try {
        const nas = await this.resolveNasByIp(acct.nasipaddress);
        if (!nas) {
          this.logger.warn(`No NAS found for IP ${acct.nasipaddress} — skipping radacct ${acct.radacctid}`);
          continue;
        }

        const subscriber = acct.username ? subByName.get(acct.username) ?? null : null;

        if (acct.acctstoptime) {
          // Session ended
          await this.prisma.pppoeSession.updateMany({
            where: { sessionId: acct.acctsessionid },
            data: {
              endTime: acct.acctstoptime,
              disconnectReason: acct.acctterminatecause ?? 'unknown',
              isActive: false,
              sessionTime: acct.acctsessiontime ?? undefined,
              inputOctets: acct.acctinputoctets ? Number(acct.acctinputoctets) : undefined,
              outputOctets: acct.acctoutputoctets ? Number(acct.acctoutputoctets) : undefined,
            },
          });

          await this.logNetworkEvent({
            nasId:        nas.id,
            eventType:    'DISCONNECTION',
            eventReason:  acct.acctterminatecause ?? undefined,
            subscriberId: subscriber?.id,
            username:     acct.username ?? undefined,
            callerId:     acct.callingstationid ?? undefined,
            framedIp:     acct.framedipaddress ?? undefined,
            sessionId:    acct.acctsessionid,
            severity:     'INFO',
            message:      `Session ended for ${acct.username ?? 'unknown'} — ${terminateInfo(acct.acctterminatecause).label}: ${terminateInfo(acct.acctterminatecause).description} (duration: ${acct.acctsessiontime ?? '?'}s)`,
          });
        } else {
          // New active session
          await this.prisma.pppoeSession.upsert({
            where: { sessionId: acct.acctsessionid },
            update: { lastSeenAt: new Date(), isActive: true },
            create: {
              sessionId:    acct.acctsessionid,
              nasId:        nas.id,
              subscriberId: subscriber?.id ?? null,
              username:     acct.username ?? 'unknown',
              callerId:     acct.callingstationid ?? '',
              framedIp:     acct.framedipaddress ?? undefined,
              startTime:    acct.acctstarttime ?? new Date(),
              isActive:     true,
              lastSeenAt:   new Date(),
            },
          });

          await this.logNetworkEvent({
            nasId:        nas.id,
            eventType:    'CONNECTION',
            subscriberId: subscriber?.id,
            username:     acct.username ?? undefined,
            callerId:     acct.callingstationid ?? undefined,
            framedIp:     acct.framedipaddress ?? undefined,
            sessionId:    acct.acctsessionid,
            severity:     'INFO',
            message:      `PPPoE session started for ${acct.username ?? 'unknown'} (IP: ${acct.framedipaddress ?? 'N/A'})`,
          });
        }

        if (acct.radacctid > this.lastRadAcctId) {
          this.lastRadAcctId = acct.radacctid;
        }
      } catch (err: any) {
        this.logger.error(`Error processing radacct ${acct.radacctid}: ${err.message}`);
      }
    }

    if (allNew.length > 0) {
      this.logger.log(`Synced ${allNew.length} radacct events`);
    }
  }

  // ── RADIUS radpostauth → NetworkLog (auth success / fail) ──

  async syncRadPostAuthEvents() {
    const newAuths = await this.prisma.radPostAuth.findMany({
      where: { id: { gt: this.lastRadPostAuthId } },
      orderBy: { id: 'asc' },
      take: 500,
    });

    // SCALE: batch the subscriber and last-session lookups. This loop used to
    // issue 2 queries per auth row — 1,000 queries for a 500-row batch.
    const authNames = [...new Set(newAuths.map((a) => a.username).filter(Boolean))] as string[];
    const [authSubs, recentAccts] = await Promise.all([
      authNames.length
        ? this.prisma.subscriber.findMany({
            where: { username: { in: authNames } },
            select: { id: true, username: true },
          })
        : Promise.resolve([] as any[]),
      authNames.length
        ? this.prisma.$queryRawUnsafe<any[]>(
            `SELECT DISTINCT ON (username) username, nasipaddress::text AS nasipaddress
               FROM radacct WHERE username = ANY($1::text[])
              ORDER BY username, radacctid DESC`,
            authNames,
          )
        : Promise.resolve([] as any[]),
    ]);
    const authSubByName = new Map(authSubs.map((s: any) => [s.username, s]));
    const nasIpByName = new Map(recentAccts.map((r: any) => [r.username, r.nasipaddress]));

    for (const auth of newAuths) {
      try {
        const subscriber = auth.username ? authSubByName.get(auth.username) ?? null : null;

        const recentIp = auth.username ? nasIpByName.get(auth.username) : null;
        const nas = recentIp ? await this.resolveNasByIp(recentIp) : null;

        if (!nas) {
          // Still log auth events even without a linked NAS (use a fallback)
          if (auth.id > this.lastRadPostAuthId) {
            this.lastRadPostAuthId = auth.id;
          }
          continue;
        }

        const isSuccess = auth.reply?.toLowerCase().includes('accept');

        await this.logNetworkEvent({
          nasId:        nas.id,
          eventType:    isSuccess ? 'AUTH_SUCCESS' : 'AUTH_FAIL',
          subscriberId: subscriber?.id,
          username:     auth.username,
          severity:     isSuccess ? 'INFO' : 'WARNING',
          message:      isSuccess
            ? `Auth accepted for ${auth.username}`
            : `Auth rejected for ${auth.username} — reply: ${auth.reply ?? 'none'}`,
        });

        if (auth.id > this.lastRadPostAuthId) {
          this.lastRadPostAuthId = auth.id;
        }
      } catch (err: any) {
        this.logger.error(`Error processing radpostauth ${auth.id}: ${err.message}`);
      }
    }

    if (newAuths.length > 0) {
      this.logger.log(`Synced ${newAuths.length} radpostauth events`);
    }
  }

  // ── NAS device polling (reachability / online/offline) ──────

  async pollAllNasDevices() {
    const nasDevices = await this.prisma.nas.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    // Bounded parallelism: 200 routers at 20-wide finishes in seconds instead
    // of the ~17 minutes a sequential loop would take.
    const results = await mapLimit(nasDevices, this.concurrency, (nas) =>
      withTimeout(this.pollNasDevice(nas.id), 20_000, `NAS ${nas.id} health check`),
    );
    const failed = results.filter((r) => !r.ok).length;
    if (failed) this.logger.debug(`Health sweep: ${failed}/${nasDevices.length} router(s) unreachable`);
  }

  async pollNasDevice(nasId: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id: nasId } });
    if (!nas || !nas.nasIp) return;

    const apiPort = nas.apiPort ?? 8728;
    const incomingPort = nas.incomingPort ?? 3799;

    try {
      const reachability = await this.mikrotikSync.checkReachability(
        nas.nasIp, apiPort, incomingPort,
      );

      if (!reachability.apiPortOpen) {
        // Only log if the previous log for this NAS was NOT already offline
        const lastLog = await this.prisma.networkLog.findFirst({
          where:   { nasId, eventType: { in: ['NAS_OFFLINE', 'NAS_ONLINE'] } },
          orderBy: { loggedAt: 'desc' },
        });

        if (!lastLog || lastLog.eventType !== 'NAS_OFFLINE') {
          await this.logNetworkEvent({
            nasId,
            eventType: 'NAS_OFFLINE',
            severity:  'ERROR',
            message:   `NAS ${nas.nasname} (${nas.nasIp}) went offline — API port ${apiPort} unreachable`,
          });
        }
        return;
      }

      // Back online?
      const lastLog = await this.prisma.networkLog.findFirst({
        where:   { nasId, eventType: { in: ['NAS_OFFLINE', 'NAS_ONLINE'] } },
        orderBy: { loggedAt: 'desc' },
      });

      if (lastLog?.eventType === 'NAS_OFFLINE') {
        await this.logNetworkEvent({
          nasId,
          eventType: 'NAS_ONLINE',
          severity:  'INFO',
          message:   `NAS ${nas.nasname} (${nas.nasIp}) is back online`,
        });
      }

      // If credentials available, pull full details & sync sessions
      if (nas.apiUsername && nas.apiPassword) {
        const details = await this.mikrotikSync.syncDetails(
          nas.nasIp, apiPort, nas.apiUsername, nas.apiPassword,
        );
        this.logger.debug(`NAS ${nas.nasname}: ${details.activeConnections} active connections`);
      }

    } catch (err: any) {
      this.logger.error(`Failed to poll NAS ${nas.nasname}: ${err.message}`);
      await this.logNetworkEvent({
        nasId,
        eventType: 'RADIUS_TIMEOUT',
        severity:  'ERROR',
        message:   `Poll failed for NAS ${nas.nasname}: ${err.message}`,
      });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private nasIpCache: Map<string, { id: number; nasname: string }> = new Map();
  /** Addresses already known not to match any NAS — stops repeated lookups. */
  private nasMissCache: Set<string> = new Set();

  /** Nas.nasIp is a Postgres INET column, so only a real address may be bound. */
  private isIpv4(v: string): boolean {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
    return !!m && m.slice(1).every((o) => +o >= 0 && +o <= 255);
  }

  private async resolveNasByIp(nasIp: string) {
    // An INET column cast to text keeps any prefix length — "192.168.1.127/32".
    // Prisma then can't parse it back as a plain address and Postgres rejects
    // the bind. Strip the mask before matching; a host address is what we want.
    const key = String(nasIp ?? '').trim().split('/')[0];
    if (!key) return null;
    if (this.nasIpCache.has(key)) return this.nasIpCache.get(key)!;
    if (this.nasMissCache.has(key)) return null;

    // RADIUS sends NAS-IP-Address, which must match a NAS record. Match on
    // `nasIp` first, then fall back to `nasname` (FreeRADIUS keys its clients
    // on nasname, so that column often holds the router's real IP), and finally
    // to a single-NAS deployment. Without this fallback a mismatch between the
    // two columns silently drops every session/auth event.
    //
    // The IP filter is skipped for anything that isn't a valid address.
    // Querying an INET column with e.g. a hostname or "ip:port" makes Postgres
    // fail the cast (AddrParseError), and because this runs per accounting row
    // a single malformed value floods the log and stalls the whole sweep.
    // nasname is plain text, so it is always safe to try.
    let nas = this.isIpv4(key)
      ? await this.prisma.nas.findFirst({ where: { nasIp: key } })
      : null;
    if (!nas) nas = await this.prisma.nas.findFirst({ where: { nasname: key } });
    if (!nas) {
      const all = await this.prisma.nas.findMany({ take: 2 });
      if (all.length === 1) {
        nas = all[0];
        this.logger.warn(
          `radacct NAS-IP ${key} matched no NAS record; falling back to the only NAS "${nas.nasname}". ` +
            `Set that NAS's IP to ${key} in the panel to silence this.`,
        );
      }
    }

    if (nas) {
      this.nasIpCache.set(key, { id: nas.id, nasname: nas.nasname });
    } else {
      // Remember the miss as well. Accounting rows repeat the same NAS address
      // thousands of times, and without this every one of them re-runs three
      // queries and re-logs the same warning.
      if (!this.nasMissCache.has(key)) {
        this.nasMissCache.add(key);
        this.logger.warn(`No NAS record matches "${key}" — related events will be skipped until one exists.`);
      }
    }
    return nas ?? null;
  }

  // ── Public API ───────────────────────────────────────────────

  async logNetworkEvent(data: {
    nasId: number;
    eventType: string;
    eventReason?: string;
    subscriberId?: number;
    username?: string;
    callerId?: string;
    framedIp?: string;
    sessionId?: string;
    message?: string;
    severity: string;
  }) {
    return this.prisma.networkLog.create({
      data: {
        nasId:        data.nasId,
        eventType:    data.eventType as any,
        eventReason:  data.eventReason,
        subscriberId: data.subscriberId,
        username:     data.username,
        callerId:     data.callerId,
        framedIp:     data.framedIp,
        sessionId:    data.sessionId,
        message:      data.message,
        severity:     data.severity,
      },
    });
  }

  async logPppoeConnection(data: {
    nasId: number; username: string; callerId: string;
    framedIp?: string; sessionId: string; subscriberId?: number;
  }) {
    await this.prisma.pppoeSession.upsert({
      where:  { sessionId: data.sessionId },
      update: { lastSeenAt: new Date(), isActive: true },
      create: {
        sessionId:    data.sessionId,
        nasId:        data.nasId,
        subscriberId: data.subscriberId ?? null,
        username:     data.username,
        callerId:     data.callerId,
        framedIp:     data.framedIp,
        startTime:    new Date(),
        isActive:     true,
        lastSeenAt:   new Date(),
      },
    });
    return this.logNetworkEvent({
      ...data,
      eventType: 'CONNECTION',
      severity:  'INFO',
      message:   `PPPoE connection established for ${data.username}`,
    });
  }

  async logPppoeDisconnection(data: {
    nasId: number; username: string; sessionId: string;
    reason: string; subscriberId?: number;
  }) {
    await this.prisma.pppoeSession.updateMany({
      where: { sessionId: data.sessionId, isActive: true },
      data:  { endTime: new Date(), disconnectReason: data.reason, isActive: false },
    });
    return this.logNetworkEvent({
      ...data,
      eventType:   'DISCONNECTION',
      eventReason: data.reason,
      severity:    data.reason === 'admin-reset' ? 'WARNING' : 'INFO',
      message:     `PPPoE disconnected for ${data.username}: ${data.reason}`,
    });
  }

  async getNetworkLogs(page = 1, limit = 50, filters?: {
    eventType?: string; nasId?: number; username?: string;
    severity?: string; dateFrom?: string; dateTo?: string;
  }, actor?: Actor) {
    const skip = (page - 1) * limit;
    // Subtree gate first, then the caller's own filters on top of it.
    const where: any = { ...(await this.networkScopeWhere(actor)) };
    if (filters?.eventType) where.eventType = filters.eventType;
    if (filters?.nasId)     where.nasId     = filters.nasId;
    if (filters?.severity)  where.severity  = filters.severity;
    if (filters?.username)  where.username  = { contains: filters.username, mode: 'insensitive' };
    if (filters?.dateFrom || filters?.dateTo) {
      where.loggedAt = {};
      if (filters.dateFrom) where.loggedAt.gte = new Date(filters.dateFrom);
      if (filters.dateTo)   where.loggedAt.lte = new Date(filters.dateTo);
    }

    const [logs, total] = await Promise.all([
      this.prisma.networkLog.findMany({
        where,
        include: {
          nas:        { select: { nasname: true, nasIp: true } },
          subscriber: { select: { fullName: true, phone: true } },
        },
        orderBy: { loggedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.networkLog.count({ where }),
    ]);
    return { logs, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getActiveSessions(actor?: Actor) {
    return this.prisma.pppoeSession.findMany({
      where:   { isActive: true, ...(await this.networkScopeWhere(actor)) },
      include: {
        nas:        { select: { nasname: true, nasIp: true } },
        subscriber: { select: { fullName: true, phone: true } },
      },
      orderBy: { startTime: 'desc' },
    });
  }

  async getNetworkStats(actor?: Actor) {
    const now    = new Date();
    const today  = new Date(now); today.setHours(0, 0, 0, 0);
    const hour1  = new Date(now.getTime() - 60 * 60 * 1000);
    // Counts leak the same information as the rows, so gate them the same way.
    const s = await this.networkScopeWhere(actor);

    const [
      totalConnections, activeSessions, failedAuth, nasOfflineEvents,
      connectionsToday, authFailsLastHour,
      recentLogs,
    ] = await Promise.all([
      this.prisma.networkLog.count({ where: { ...s, eventType: 'CONNECTION' } }),
      this.prisma.pppoeSession.count({ where: { ...s, isActive: true } }),
      this.prisma.networkLog.count({ where: { ...s, eventType: 'AUTH_FAIL' } }),
      this.prisma.networkLog.count({ where: { ...s, eventType: { in: ['NAS_REBOOT', 'NAS_OFFLINE', 'NAS_ONLINE'] } } }),
      this.prisma.networkLog.count({ where: { ...s, eventType: 'CONNECTION', loggedAt: { gte: today } } }),
      this.prisma.networkLog.count({ where: { ...s, eventType: 'AUTH_FAIL', loggedAt: { gte: hour1 } } }),
      this.prisma.networkLog.findMany({
        where:   s,
        take:    10,
        include: { nas: { select: { nasname: true } }, subscriber: { select: { fullName: true } } },
        orderBy: { loggedAt: 'desc' },
      }),
    ]);

    return {
      totalConnections, activeSessions, failedAuth, nasOfflineEvents,
      connectionsToday, authFailsLastHour, recentLogs,
    };
  }

  // Fetch radacct sessions directly for the logs page
  async getRadiusSessions(page = 1, limit = 50, filters?: {
    username?: string; nasIp?: string; active?: boolean;
  }, actor?: Actor) {
    const skip = (page - 1) * limit;
    const where: any = {};
    // A reseller may only read sessions for subscribers in its own subtree, so
    // it cannot type a sibling's username and pull that customer's session
    // history, IPs and data counters.
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.subscriber = await this.scope.subscriberWhere(actor);
    }
    if (filters?.username) where.username = { contains: filters.username, mode: 'insensitive' };
    if (filters?.nasIp)    where.nasipaddress = filters.nasIp;
    if (filters?.active === true)  where.acctstoptime = null;
    if (filters?.active === false) where.acctstoptime = { not: null };

    const [sessions, total] = await Promise.all([
      this.prisma.radAcct.findMany({
        where,
        orderBy: { radacctid: 'desc' },
        skip,
        take: limit,
        include: { subscriber: { select: { fullName: true, phone: true } } },
      }),
      this.prisma.radAcct.count({ where }),
    ]);
    return { sessions, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // Auth log from radpostauth
  async getAuthLogs(page = 1, limit = 50, filters?: {
    username?: string; replyFilter?: 'accept' | 'reject';
  }, actor?: Actor) {
    const skip = (page - 1) * limit;
    const where: any = {};
    // Same subtree gate as sessions — auth attempts name the customer too.
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.subscriber = await this.scope.subscriberWhere(actor);
    }
    if (filters?.username) where.username = { contains: filters.username, mode: 'insensitive' };
    if (filters?.replyFilter === 'accept') where.reply = { contains: 'Accept', mode: 'insensitive' };
    if (filters?.replyFilter === 'reject') where.reply = { not: { contains: 'Accept', mode: 'insensitive' } };

    const [logs, total] = await Promise.all([
      this.prisma.radPostAuth.findMany({
        where,
        orderBy: { authdate: 'desc' },
        skip,
        take: limit,
        include: { subscriber: { select: { fullName: true, phone: true } } },
      }),
      this.prisma.radPostAuth.count({ where }),
    ]);
    return { logs, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}