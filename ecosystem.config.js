/**
 * PM2 process definition for Jointbox — used on every deployment.
 *
 * WHY THIS EXISTS (the bug it prevents):
 * Starting the apps with `pm2 start npm -- run start` makes pm2 manage the npm
 * WRAPPER, not the real server. On `pm2 restart`, pm2 kills npm but its child
 * (node / next) survives, keeps holding the port, and the replacement crashes
 * with EADDRINUSE — forever. That's what caused the 300+ restart loop.
 *
 * Here pm2 launches the REAL entrypoints directly (backend dist/main.js and the
 * next binary), so a restart cleanly stops the actual process and frees the
 * port. `min_uptime`/`max_restarts` also stop a genuine failure from looping
 * hundreds of times — after 10 quick failures it parks as "errored" instead.
 *
 * Deploy with:  pm2 startOrReload ecosystem.config.js && pm2 save
 *
 * SCALING (use all CPU cores):
 * Set BACKEND_INSTANCES / FRONTEND_INSTANCES in the environment (or edit the
 * defaults below) to a number or 'max'. When >1, pm2 runs CLUSTER mode and load
 * balances across cores. This is SAFE because:
 *   • scheduled crons run on worker 0 only (isPrimaryInstance / NODE_APP_INSTANCE),
 *   • the background-job queue claims each job atomically (QUEUED→RUNNING),
 *   • the in-flight guards stop any cron from overlapping itself.
 * BEFORE clustering the backend, set REDIS_URL in backend/.env so the cache and
 * job queue are shared across workers (otherwise each worker caches separately),
 * and put Postgres behind pgBouncer (or raise max_connections) since each worker
 * opens its own pool. See SCALING.md.
 */
const path = require('path');

const backendInstances = process.env.BACKEND_INSTANCES || 1;   // set to 'max' or a number to cluster
const frontendInstances = process.env.FRONTEND_INSTANCES || 1;
// Port the web UI listens on. Default 3000. Set FRONTEND_PORT=80 to serve the
// domain (jb.panel.net) directly with NO nginx/proxy — pm2 runs as root so it
// can bind the privileged port, and pm2 keeps it alive across reboots.
const frontendPort = process.env.FRONTEND_PORT || 3000;
const workerInstances = process.env.WORKER_INSTANCES || 0;    // >0 → run a dedicated worker service (microservice split)
const asCount = (v) => (v === 'max' ? 'max' : Number(v) || 1);
const modeFor = (v) => (v === 'max' || Number(v) > 1 ? 'cluster' : 'fork');

// Microservice split. Set WORKER_INSTANCES>0 to run a dedicated worker service
// that handles ALL background work (crons, pollers, queue jobs); the web nodes
// then serve HTTP only. Default (0) = monolith: the web process also does the
// background work on worker 0. Requires REDIS_URL so jobs are shared.
const splitWorker = Number(workerInstances) > 0;
const backend = path.join(__dirname, 'backend', 'dist', 'main.js');
const backendCwd = path.join(__dirname, 'backend');

/**
 * HOW LONG PM2 WAITS FOR A PROCESS TO FINISH ITS WORK BEFORE SIGKILL.
 *
 * PM2's default is 1600ms, and that default silently undoes the graceful
 * shutdown the app already implements. `main.ts` calls
 * `app.enableShutdownHooks()`, and `QueueService.onModuleDestroy` closes each
 * BullMQ worker — which by design waits for the jobs currently running to
 * finish. But the work this app does on shutdown routinely takes longer than
 * 1.6 seconds:
 *
 *   · an SNMP sweep has a 25s budget (SNMP_SWEEP_BUDGET_MS);
 *   · a RADIUS profile sync is several network round trips per subscriber;
 *   · a radacct archival batch is a database transaction over 10,000 rows.
 *
 * At 1600ms PM2 hard-kills all of it mid-flight on every deploy. The queue job
 * is left in `active` with no worker, the archival transaction rolls back, and
 * the SNMP sweep stops halfway with `this.running` never cleared. The app was
 * doing the right thing and the process manager was not letting it.
 *
 * 30s is chosen to exceed the SNMP sweep budget, which is the longest of them.
 * PM2 only waits as long as it actually needs — a process that exits cleanly in
 * 200ms is not delayed by this.
 */
const KILL_TIMEOUT_MS = Number(process.env.PM2_KILL_TIMEOUT_MS) || 30000;

const workerApp = {
  name: 'jointbox-worker',
  script: backend,
  cwd: backendCwd,
  exec_mode: 'fork',
  instances: asCount(workerInstances),
  autorestart: true,
  min_uptime: '15s',
  max_restarts: 10,
  restart_delay: 3000,
  max_memory_restart: '600M',
  // Let in-flight queue jobs, SNMP sweeps and archival batches finish.
  kill_timeout: KILL_TIMEOUT_MS,
  // JOINTBOX_ROLE=worker → runs background services, binds NO HTTP port.
  env: { NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=512', JOINTBOX_ROLE: 'worker' },
};

module.exports = {
  apps: [
    {
      name: 'jointbox-backend',
      script: backend,
      cwd: backendCwd,
      exec_mode: modeFor(backendInstances),
      instances: asCount(backendInstances),
      autorestart: true,
      min_uptime: '15s',
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '600M', // recycle a worker if it leaks past 600MB
      // Let in-flight requests and background work drain before SIGKILL.
      kill_timeout: KILL_TIMEOUT_MS,
      // Cap V8 heap so a worker can't balloon RAM on a small VM, and so the GC
      // runs sooner. 512MB is plenty for the API; raise if you cluster heavily.
      // When a dedicated worker is running, the web nodes serve HTTP ONLY.
      env: Object.assign(
        { NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=512' },
        splitWorker ? { JOINTBOX_ROLE: 'web' } : {},
      ),
    },
    {
      name: 'jointbox-frontend',
      // Run Next's own binary directly (never `npm run start` — that wrapper
      // orphans the port). `next start` serves the app AND /_next/static
      // reliably, unlike the standalone server which needed static copied in.
      script: path.join(__dirname, 'frontend', 'node_modules', 'next', 'dist', 'bin', 'next'),
      args: `start -H 0.0.0.0 -p ${frontendPort}`,
      cwd: path.join(__dirname, 'frontend'),
      exec_mode: modeFor(frontendInstances),
      instances: asCount(frontendInstances),
      autorestart: true,
      min_uptime: '15s',
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=512', PORT: String(frontendPort), HOSTNAME: '0.0.0.0' },
    },
    // Dedicated background worker — only added when WORKER_INSTANCES>0.
    ...(splitWorker ? [workerApp] : []),
  ],
};
