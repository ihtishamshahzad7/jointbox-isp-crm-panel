import {
  connectionLimit,
  defaultPoolSize,
  evaluateAgainstServer,
  evaluateConnectionPolicy,
  resolveInstanceCount,
  usesPgBouncer,
} from './connection-policy';

/**
 * DATABASE CONNECTION POLICY.
 *
 * THE INCIDENT
 * SCALING.md correctly says: put Postgres behind PgBouncer BEFORE raising
 * BACKEND_INSTANCES, because every PM2 worker opens its own Prisma pool.
 * Nothing enforced it, so the prerequisite was one an operator could skip by
 * not reading that paragraph:
 *
 *   export BACKEND_INSTANCES=max     # 16-core box
 *   pm2 startOrReload ecosystem.config.js
 *
 * → 16 workers × their own pool, against a Postgres whose `max_connections` is
 *   very often still the stock 100. Everything starts fine. Under load the
 *   server begins refusing connections — to the panel AND to FreeRADIUS, which
 *   means subscribers drop, not merely that a dashboard breaks. It reads as an
 *   application fault and is a configuration one.
 *
 * WHAT MAKES THE GUARD WORTH HAVING RATHER THAN JUST NOISY
 * It must be silent on the common install. One instance without PgBouncer is
 * the normal supported topology for nearly every Jointbox deployment, and a
 * guard that shouts at those users gets muted, then ignored, then removed.
 * Only the combination that genuinely multiplies connections is refused.
 */
describe('connection policy', () => {
  // ───────────────────────────────────────────────────────────────
  // Parsing — where a lazy implementation gets it wrong
  // ───────────────────────────────────────────────────────────────
  describe('usesPgBouncer', () => {
    it('recognises a pooled URL', () => {
      expect(usesPgBouncer('postgresql://u:p@h:6432/db?pgbouncer=true')).toBe(true);
    });

    it('is false for a direct URL', () => {
      expect(usesPgBouncer('postgresql://u:p@h:5432/db')).toBe(false);
    });

    it('is not fooled by the text appearing in the PASSWORD', () => {
      /**
       * The obvious implementation is `url.includes('pgbouncer=true')`. A
       * password containing that string would satisfy it, and the guard would
       * then pass on a deployment that is NOT pooled — the single outcome that
       * makes the whole check worthless, and one that would never be noticed
       * because the check appears to be working.
       */
      expect(usesPgBouncer('postgresql://u:pgbouncer=true@h:5432/db')).toBe(false);
    });

    it('is not fooled by a similarly-named parameter', () => {
      expect(usesPgBouncer('postgresql://u:p@h:5432/db?notpgbouncer=true')).toBe(false);
    });

    it('requires the value to be true, not merely present', () => {
      expect(usesPgBouncer('postgresql://u:p@h:5432/db?pgbouncer=false')).toBe(false);
    });

    it('treats an unparseable or absent URL as not pooled', () => {
      // Fail toward the safe verdict: assuming pooling we cannot prove would
      // silence the guard exactly where the configuration is already suspect.
      expect(usesPgBouncer('not a url')).toBe(false);
      expect(usesPgBouncer(undefined)).toBe(false);
    });
  });

  describe('resolveInstanceCount', () => {
    it("resolves 'max' to the core count, as ecosystem.config.js does", () => {
      // Both must agree, or the guard reasons about a different topology than
      // the one PM2 actually starts.
      expect(resolveInstanceCount('max', 16)).toBe(16);
    });

    it('reads a plain number', () => expect(resolveInstanceCount('4', 8)).toBe(4));
    it('defaults to 1 when unset', () => expect(resolveInstanceCount(undefined, 8)).toBe(1));
    it('treats nonsense as 1 rather than NaN', () => expect(resolveInstanceCount('lots', 8)).toBe(1));
  });

  describe('connectionLimit / defaultPoolSize', () => {
    it('reads connection_limit from the URL', () => {
      expect(connectionLimit('postgresql://u:p@h:5432/db?connection_limit=10')).toBe(10);
    });

    it('is null when unset, so the caller uses the real default', () => {
      expect(connectionLimit('postgresql://u:p@h:5432/db')).toBeNull();
    });

    it("Prisma's default pool is num_cpus × 2 + 1, not 10", () => {
      /**
       * This is the detail that makes the real number worse than SCALING.md's
       * worked example. The doc reasons with `connection_limit=10`, but an
       * operator who never set it gets 33 per worker on a 16-core box — so
       * "4 workers = 40 connections" is really 16 × 33 = 528.
       */
      expect(defaultPoolSize(16)).toBe(33);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // The verdict
  // ───────────────────────────────────────────────────────────────
  describe('evaluateConnectionPolicy', () => {
    const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

    it('says nothing about the ordinary single-instance install', () => {
      // The overwhelmingly common Jointbox deployment. A guard that warns here
      // gets ignored everywhere else too.
      const r = evaluateConnectionPolicy(
        env({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@h:5432/db' }),
        8,
      );
      expect(r.error).toBeUndefined();
      expect(r.warning).toBeUndefined();
    });

    it('THE FIX: refuses a clustered production install with no pooler', () => {
      const r = evaluateConnectionPolicy(
        env({
          NODE_ENV: 'production',
          BACKEND_INSTANCES: 'max',
          DATABASE_URL: 'postgresql://u:p@h:5432/db',
        }),
        16,
      );
      expect(r.error).toBeDefined();
      // The message has to carry the arithmetic, or the operator cannot act.
      expect(r.error).toMatch(/16 backend process/);
      expect(r.error).toMatch(/PgBouncer/);
      expect(r.projectedConnections).toBe(16 * 33);
    });

    /**
     * THE PRODUCTION OUTAGE THIS PREVENTS.
     *
     * The first version of this guard refused every multi-process deployment
     * without PgBouncer and never compared the total to a limit — while its
     * message told the operator to lower connection_limit. On a live panel that
     * meant: 12 workers × 20 = 240 refused, operator follows the advice, sets
     * connection_limit=5, and gets the SAME refusal quoting 60 against a stated
     * ceiling of 100. The backend stayed down and the stated fix was a dead
     * end. These two cases pin the arithmetic so that can never recur.
     */
    it('REGRESSION: accepts a clustered install whose total genuinely fits', () => {
      const r = evaluateConnectionPolicy(
        env({
          NODE_ENV: 'production',
          BACKEND_INSTANCES: '12',
          DATABASE_URL: 'postgresql://u:p@h:5432/db?connection_limit=5',
        }),
        12,
      );
      expect(r.projectedConnections).toBe(60); // vs 100 - 25 reserved = 75 available
      expect(r.error).toBeUndefined();
    });

    it('REGRESSION: lowering connection_limit actually changes the verdict', () => {
      const at = (limit: number) =>
        evaluateConnectionPolicy(
          env({
            NODE_ENV: 'production',
            BACKEND_INSTANCES: '12',
            DATABASE_URL: `postgresql://u:p@h:5432/db?connection_limit=${limit}`,
          }),
          12,
        );
      // The advice the message gives must be advice that works.
      expect(at(20).error).toBeDefined();
      expect(at(5).error).toBeUndefined();
    });

    it('the refusal names a connection_limit that would actually fit', () => {
      const r = evaluateConnectionPolicy(
        env({
          NODE_ENV: 'production',
          BACKEND_INSTANCES: '12',
          DATABASE_URL: 'postgresql://u:p@h:5432/db?connection_limit=20',
        }),
        12,
      );
      const suggested = Number(/connection_limit=(\d+)\)/.exec(r.error ?? '')?.[1]);
      expect(suggested).toBeGreaterThan(0);
      // Take the guard's own advice and re-run it: it must now pass.
      const after = evaluateConnectionPolicy(
        env({
          NODE_ENV: 'production',
          BACKEND_INSTANCES: '12',
          DATABASE_URL: `postgresql://u:p@h:5432/db?connection_limit=${suggested}`,
        }),
        12,
      );
      expect(after.error).toBeUndefined();
    });

    it('respects a raised max_connections', () => {
      const r = evaluateConnectionPolicy(
        env({
          NODE_ENV: 'production',
          BACKEND_INSTANCES: '12',
          POSTGRES_MAX_CONNECTIONS: '500',
          DATABASE_URL: 'postgresql://u:p@h:5432/db?connection_limit=20',
        }),
        12,
      );
      expect(r.error).toBeUndefined();
    });

    it('still reserves connections for FreeRADIUS', () => {
      // 12 × 7 = 84 fits under 100 but NOT under 100-25. Subscribers going
      // offline matters more than the panel running more workers.
      const r = evaluateConnectionPolicy(
        env({
          NODE_ENV: 'production',
          BACKEND_INSTANCES: '12',
          DATABASE_URL: 'postgresql://u:p@h:5432/db?connection_limit=7',
        }),
        12,
      );
      expect(r.projectedConnections).toBe(84);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/FreeRADIUS/);
    });

    it('is satisfied once PgBouncer is in front', () => {
      const r = evaluateConnectionPolicy(
        env({
          NODE_ENV: 'production',
          BACKEND_INSTANCES: 'max',
          DATABASE_URL: 'postgresql://u:p@h:6432/db?pgbouncer=true',
        }),
        16,
      );
      expect(r.error).toBeUndefined();
    });

    it('warns instead of failing outside production', () => {
      // A developer running two instances locally should not be blocked by a
      // capacity rule about someone else's server.
      const r = evaluateConnectionPolicy(
        env({ NODE_ENV: 'development', BACKEND_INSTANCES: '4', DATABASE_URL: 'postgresql://u:p@h:5432/db' }),
        8,
      );
      expect(r.error).toBeUndefined();
      expect(r.warning).toBeDefined();
    });

    it('counts the dedicated worker processes too', () => {
      /**
       * The microservice split (WORKER_INSTANCES>0) starts ANOTHER set of
       * processes with their own pools. Omitting them would under-count
       * precisely the topology most likely to exhaust the server — the one an
       * operator reaches for when the load is already high.
       */
      const r = evaluateConnectionPolicy(
        env({
          NODE_ENV: 'production',
          BACKEND_INSTANCES: '4',
          WORKER_INSTANCES: '2',
          DATABASE_URL: 'postgresql://u:p@h:5432/db?connection_limit=10',
        }),
        8,
      );
      expect(r.instances).toBe(6);
      expect(r.projectedConnections).toBe(60);
    });

    it('uses an explicit connection_limit when given', () => {
      const r = evaluateConnectionPolicy(
        env({
          NODE_ENV: 'production',
          BACKEND_INSTANCES: '4',
          DATABASE_URL: 'postgresql://u:p@h:5432/db?connection_limit=5',
        }),
        16,
      );
      expect(r.perWorker).toBe(5);
      expect(r.projectedConnections).toBe(20);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // The wiring
  // ───────────────────────────────────────────────────────────────
  describe('PrismaService actually calls it', () => {
    /**
     * WHY THIS TEST EXISTS
     * Everything above tests `connection-policy.ts` in isolation, and all of it
     * passes whether or not PrismaService ever invokes the policy. Deleting the
     * `enforceConnectionPolicy()` line from `onModuleInit` would leave 22 green
     * tests and zero protection — the guard would be dead code that looks
     * thoroughly tested. Found by reverting prisma.service.ts and watching
     * every test still pass.
     *
     * It is asserted against the SOURCE rather than by booting the service,
     * because PrismaService extends PrismaClient and cannot be constructed
     * without a generated Prisma client. A source assertion is weaker than an
     * integration test and much stronger than nothing: it fails the moment
     * somebody removes the call.
     */
    const src = require('fs').readFileSync(require('path').join(__dirname, 'prisma.service.ts'), 'utf8');

    it('invokes the policy from onModuleInit', () => {
      const onInit = src.slice(src.indexOf('async onModuleInit'));
      expect(onInit).toMatch(/this\.enforceConnectionPolicy\(\)/);
    });

    it('checks BEFORE connecting, so a config error is reported as one', () => {
      // After `$connect()` the failure would surface as a connection error
      // under load instead of a clear message at boot.
      const onInit = src.slice(src.indexOf('async onModuleInit'));
      expect(onInit.indexOf('enforceConnectionPolicy')).toBeLessThan(onInit.indexOf('$connect'));
    });

    it('throws rather than only logging', () => {
      // A warning on a 16-worker box that will exhaust max_connections scrolls
      // past in the PM2 log and nobody sees it until FreeRADIUS starts failing.
      expect(src).toMatch(/if \(verdict\.error\) throw new Error/);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Against the live server
  // ───────────────────────────────────────────────────────────────
  describe('evaluateAgainstServer', () => {
    it('is quiet when the connections fit', () => {
      expect(evaluateAgainstServer(40, 100, 3).warning).toBeUndefined();
    });

    it('subtracts the superuser reservation', () => {
      // Those slots exist so an admin can still get in during an incident;
      // counting them as available is how you lose your way back in.
      const r = evaluateAgainstServer(98, 100, 3);
      expect(r.usableConnections).toBe(97);
      expect(r.warning).toBeDefined();
    });

    it('names FreeRADIUS in the warning', () => {
      // The consequence an operator needs to weigh is subscribers dropping,
      // not a slow dashboard. A capacity warning that does not say so reads
      // as a performance nag and gets deferred.
      const r = evaluateAgainstServer(528, 100, 3);
      expect(r.warning).toMatch(/FreeRADIUS/);
      expect(r.headroom).toBeLessThan(0);
    });
  });
});
