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

/**
 * How many connections Postgres will accept, and how many belong to others.
 *
 * `max_connections` cannot be read before we connect, so the static check uses
 * the stock default unless the operator states otherwise. The reserve exists
 * because this database is shared: FreeRADIUS authenticates subscribers
 * against it, and a panel that consumes the last connection takes people
 * OFFLINE rather than merely breaking a dashboard. The panel is the process
 * that must yield.
 */
export const DEFAULT_MAX_CONNECTIONS = 100;
export const DEFAULT_RESERVED_FOR_OTHERS = 25;

export function connectionBudget(env: NodeJS.ProcessEnv = process.env): {
  maxConnections: number;
  reserved: number;
  available: number;
} {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const maxConnections = num(env.POSTGRES_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS);
  const reserved = num(env.DB_RESERVED_CONNECTIONS, DEFAULT_RESERVED_FOR_OTHERS);
  return { maxConnections, reserved, available: Math.max(1, maxConnections - reserved) };
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

  // PgBouncer multiplexes: the pool sizes above stop being the number of real
  // server connections, so the arithmetic no longer applies.
  if (usesPgBouncer(url)) return base;

  const { maxConnections, reserved, available } = connectionBudget(env);

  const arithmetic =
    `${totalProcesses} backend process(es) × ${perWorker} connection(s) each = ` +
    `~${projectedConnections} PostgreSQL connections`;

  /**
   * THE BUG THIS REPLACES.
   *
   * The original guard refused EVERY multi-process deployment that was not
   * behind PgBouncer, without ever comparing projectedConnections to a limit —
   * while its own message told the operator to "set connection_limit so the
   * total stays under max_connections". Following that advice could not
   * possibly work: an operator who dropped connection_limit from 20 to 5 got
   * the identical refusal, now quoting a total of 60 against a stated ceiling
   * of 100. A guard that names a remedy it does not implement is worse than no
   * guard, because it sends the operator somewhere that cannot help while
   * production is down.
   *
   * So the rule is now the arithmetic it always claimed to be: refuse only
   * when the projected total genuinely does not fit.
   */
  if (projectedConnections > available) {
    const detail =
      `${arithmetic}, but only ~${available} are available for the panel ` +
      `(max_connections=${maxConnections}, ${reserved} reserved for FreeRADIUS and admin ` +
      `access — if the panel takes the last connection, subscriber authentication fails ` +
      `and people go offline). Fix by ANY of: lower connection_limit in DATABASE_URL ` +
      `(e.g. connection_limit=${Math.max(1, Math.floor(available / totalProcesses))}), ` +
      `reduce BACKEND_INSTANCES, raise max_connections and set POSTGRES_MAX_CONNECTIONS ` +
      `to match, or put Postgres behind PgBouncer (SCALING.md Step 1).`;

    // Outside production this is a warning: a developer briefly running two
    // instances locally should not be blocked by a capacity rule.
    return isProd ? { ...base, error: detail } : { ...base, warning: detail };
  }

  // It fits, but without a pooler there is no elasticity: every worker holds
  // its pool open whether or not it is busy. Worth saying once at boot, not
  // worth refusing to start over.
  if (projectedConnections > available * 0.8) {
    return {
      ...base,
      warning:
        `${arithmetic}, close to the ~${available} available for the panel. ` +
        `There is no pooler in front of Postgres, so this has little headroom. ` +
        `Consider PgBouncer (SCALING.md Step 1) before scaling further.`,
    };
  }

  return base;
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
