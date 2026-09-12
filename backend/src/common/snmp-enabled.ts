/**
 * IS SNMP MONITORING TURNED ON?
 *
 * It is not, by default.
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * The SNMP stack polled every device every TEN SECONDS, plus a health sweep
 * every thirty and a port poll on top. Against 43 real devices that is already
 * a constant load; against a seeded sandbox's 500 invented routers it was ~488
 * UDP probes six times a minute to addresses that do not exist, each failure
 * writing a CRITICAL alert that buried the real ones.
 *
 * The operator's own conclusion: keep ping, traceroute and port/service checks,
 * drop SNMP — it is the part that makes the panel slow, and the part they can
 * live without.
 *
 * ── Why a flag rather than deleted code, for now ─────────────────────────
 * The SNMP services are still referenced by the device, port, syslog and alert
 * pages. Deleting them before those pages are simplified would break the panel
 * outright. So the polling stops here first — which is where the cost is — and
 * the code is removed once nothing points at it. The flag also means an
 * operator who needs SNMP back for an afternoon has a way that is not a
 * redeploy of reverted code.
 *
 * Set MONITOR_SNMP=1 to re-enable.
 */
export function snmpEnabled(): boolean {
  return process.env.MONITOR_SNMP === '1';
}

/** One-line reason for the log, so a silent poller is never a mystery. */
export const SNMP_DISABLED_NOTE =
  'SNMP polling is off (set MONITOR_SNMP=1 to enable). Ping, traceroute and port/service checks are unaffected.';
