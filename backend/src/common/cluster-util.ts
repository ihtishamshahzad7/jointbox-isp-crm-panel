/**
 * Should THIS process run singleton work (cron jobs, pollers)?
 *
 * In pm2 fork mode there is one process → always yes. In pm2 CLUSTER mode there
 * are N identical workers; pm2 sets NODE_APP_INSTANCE=0,1,2… so we let only
 * worker 0 run scheduled jobs. Without this, every worker would run every cron
 * — duplicate emails, double reconciles, racing session syncs.
 *
 * Set CRON_DISABLED=true to turn all scheduled work off on a box (e.g. a
 * read-replica/standby node).
 */
export function isPrimaryInstance(): boolean {
  if (process.env.CRON_DISABLED === 'true') return false;
  const inst = process.env.NODE_APP_INSTANCE ?? process.env.pm_id;
  return inst == null || inst === '0';
}
