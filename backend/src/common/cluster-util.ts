/**
 * Should THIS process run singleton background work (cron jobs, pollers, queue
 * workers)? Every cron/poller in the app already gates on this, so this one
 * function is what routes background work in every deployment topology:
 *
 *  • JOINTBOX_ROLE unset ("all", the default) → monolith. In pm2 cluster mode
 *    only worker 0 runs it (NODE_APP_INSTANCE=0); in fork mode the one process.
 *  • JOINTBOX_ROLE="web"    → web node: HTTP only, NEVER runs background work.
 *  • JOINTBOX_ROLE="worker" → dedicated worker service: ALWAYS runs background
 *    work (and main.ts skips the HTTP server). This is the microservice split —
 *    web and worker scale independently and a heavy poll can't block a request.
 *
 * Set CRON_DISABLED=true to force background work off on any box.
 */
export function isPrimaryInstance(): boolean {
  if (process.env.CRON_DISABLED === 'true') return false;
  const role = process.env.JOINTBOX_ROLE;
  if (role === 'worker') return true;
  if (role === 'web') return false;
  const inst = process.env.NODE_APP_INSTANCE ?? process.env.pm_id;
  return inst == null || inst === '0';
}

/** True when this process should NOT bind the HTTP server (pure worker). */
export function isWorkerOnly(): boolean {
  return process.env.JOINTBOX_ROLE === 'worker';
}
