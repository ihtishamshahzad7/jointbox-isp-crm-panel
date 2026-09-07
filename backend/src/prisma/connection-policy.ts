import * as os from 'os';

/**
 * DATABASE CONNECTION POLICY.
 *
 * THE INCIDENT THIS EXISTS TO PREVENT
 * SCALING.md tells the operator, correctly, to put Postgres behind PgBouncer
 * before raising `BACKEND_INSTANCES`, because every PM2 worker opens its own
 * Prisma pool. Nothing enforced it. The failure is the classic one:
 *
 *   export BACKEND_INSTANCES=max     # 16-core box
 *   pm2 startOrReload ecosystem.config.js
 *
 * → 16 workers × a default pool of ~9-17 connections each, against a Postgres
 *   whose `max_connections` is very often still the stock 100. The workers
 *   come up fine, serve traffic fine, and then the pool fills under real load
 *   and the box starts returning "sorry, too many clients already" — to the
 *   panel, to FreeRADIUS, and to whatever else shares that database.
 *
 * The tell is that it looks like an application fault and is a configuration
 * one, and the person who scaled it usually did not read the doc paragraph
 * that would have prevented it. A doc is not an enforcement mechanism.
 *
 * WHY THIS IS A PURE MODULE
 * Every rule below is a decision about strings and numbers. Keeping them out
 * of PrismaService means they can be tested exhaustively without a database,
 * and the service is left with only the wiring.
 */

/** Mirrors `asCount` in ecosystem.config.js so both agree on what "max" means. */
export function resolveInstanceCount(raw: string | undefined, cpuCount = os.cpus().length): number {
  if (!raw) return 1;
  if (raw === 'max') return Math.max(1, cpuCount);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/**
 * Does this connection string route through PgBouncer?
 *
 * Parsed rather than substring-matched. `url.includes('pgbouncer=true')` — the
 * obvious implementation — also matches a PASSWORD that happens to contain
 * that text, and matches `?notpgbouncer=true`. Getting a false positive here
 * means the guard passes on a deployment that is not pooled, which is the one
 * outcome that makes the whole check pointless.
 */
export function usesPgBouncer(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false;
  try {
    return new URL(databaseUrl).searchParams.get('pgbouncer') === 'true';
  } catch {
    return false;
  }
}

/** Per-worker pool size, from `connection_limit` in the URL. */
export function connectionLimit(databaseUrl: string | undefined): number | null {
  if (!databaseUrl) return null;
  try {
    const v = new URL(databaseUrl).searchParams.get('connection_limit');
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Prisma's default pool size when `connection_limit` is absent: num_cpus × 2 + 1.
 * Worth stating explicitly, because the default is what bites — an operator who
 * never set `connection_limit` has a much LARGER pool per worker than the 10
 * that SCALING.md's arithmetic assumes, so the real connection count is far
 * higher than the doc's example suggests.
 */
export function defaultPoolSize(cpuCount = os.cpus().length): number {
  return cpuCount * 2 + 1;
}

export interface ConnectionPolicyResult {
  /** Fatal message — refuse to start. */
  error?: string;
  /** Non-fatal message — log it. */
  warning?: string;
  /** Total connections this deployment will try to open against Postgres. */
  projectedConnections: number;
  instances: number;
  perWorker: number;
}

/**
 * Decide whether this deployment's connection maths is safe.
 *
 * DELIBERATELY NOT FATAL ON A SINGLE INSTANCE. One worker without PgBouncer is
 * the normal, supported, overwhelmingly common Jointbox install. Only the
 * combination that actually multiplies connections — more than one backend
 * instance, in production, with no pooler — is refused.
 */
export function evaluateConnectionPolicy(env: NodeJS.ProcessEnv = process.env, cpuCount = os.cpus().length): ConnectionPolicyResult {
  const url = env.DATABASE_URL;
  const instances = resolveInstanceCount(env.BACKEND_INSTANCES, cpuCount);
  // A dedicated worker service is another set of processes with their own
  // pools. Leaving it out would under-count exactly the topology most likely
  // to exhaust the server.
  const workers = resolveInstanceCount(env.WORKER_INSTANCES, cpuCount);
  const totalProcesses = instances + (Number(env.WORKER_INSTANCES) > 0 ? workers : 0);
  const perWorker = connectionLimit(url) ?? defaultPoolSize(cpuCount);
  const projectedConnections = totalProcesses * perWorker;

  const base = { projectedConnections, instances: totalProcesses, perWorker };
  const isProd = env.NODE_ENV === 'production';

  if (totalProcesses <= 1) return base;
  if (usesPgBouncer(url)) return base;

  const detail =
    `${totalProcesses} backend process(es) × ${perWorker} connection(s) each = ` +
    `~${projectedConnections} PostgreSQL connections, and DATABASE_URL is not routed ` +
    `through PgBouncer (pgbouncer=true). Stock PostgreSQL allows 100. ` +
    `Put Postgres behind PgBouncer (SCALING.md Step 1), or set connection_limit ` +
    `in DATABASE_URL so the total stays under max_connections.`;

  // Outside production this is a warning: a developer briefly running two
  // instances locally should not be blocked by a capacity rule.
  return isProd ? { ...base, error: detail } : { ...base, warning: detail };
}

/**
 * Compare the projected total against what the server will actually accept.
 *
 * The static check above can only reason about the app's side. This asks
 * Postgres for `max_connections` and `superuser_reserved_connections` and does
 * the subtraction, which turns "this looks risky" into a specific number the
 * operator can act on — and catches the opposite mistake too, where someone
 * lowered `max_connections` under a topology that used to fit.
 */
export function evaluateAgainstServer(
  projectedConnections: number,
  maxConnections: number,
  reserved: number,
): { warning?: string; usableConnections: number; headroom: number } {
  // Other clients share this database — FreeRADIUS above all, which must never
  // be the process that gets refused, since that takes subscribers offline
  // rather than merely breaking a dashboard.
  const usable = Math.max(0, maxConnections - reserved);
  const headroom = usable - projectedConnections;
  if (headroom >= 0) return { usableConnections: usable, headroom };
  return {
    usableConnections: usable,
    headroom,
    warning:
      `This deployment may open ~${projectedConnections} PostgreSQL connections but only ` +
      `${usable} are available (max_connections=${maxConnections}, reserved=${reserved}). ` +
      `FreeRADIUS shares this server: once the limit is reached, authentication fails and ` +
      `subscribers drop, not just the panel. Add PgBouncer or lower connection_limit.`,
  };
}
