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
const asCount = (v) => (v === 'max' ? 'max' : Number(v) || 1);
const modeFor = (v) => (v === 'max' || Number(v) > 1 ? 'cluster' : 'fork');

module.exports = {
  apps: [
    {
      name: 'jointbox-backend',
      script: path.join(__dirname, 'backend', 'dist', 'main.js'),
      cwd: path.join(__dirname, 'backend'),
      exec_mode: modeFor(backendInstances),
      instances: asCount(backendInstances),
      autorestart: true,
      min_uptime: '15s',
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '600M', // recycle a worker if it leaks past 600MB
      // Cap V8 heap so a worker can't balloon RAM on a small VM, and so the GC
      // runs sooner. 512MB is plenty for the API; raise if you cluster heavily.
      env: { NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=512' },
    },
    {
      name: 'jointbox-frontend',
      // Standalone server produced by `next build` (output:'standalone'). Runs
      // the traced server.js directly — tiny footprint, no npm wrapper to orphan
      // the port. update-jointbox.sh copies .next/static + public in after build.
      script: path.join(__dirname, 'frontend', '.next', 'standalone', 'server.js'),
      cwd: path.join(__dirname, 'frontend', '.next', 'standalone'),
      exec_mode: modeFor(frontendInstances),
      instances: asCount(frontendInstances),
      autorestart: true,
      min_uptime: '15s',
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=512', PORT: '3000', HOSTNAME: '0.0.0.0' },
    },
  ],
};
