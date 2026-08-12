/**
 * RADIUS Acct-Terminate-Cause — the single source of truth for what ended a
 * session, in plain language.
 *
 * RFC 2866 defines eighteen standard causes. A NAS may send them as the NUMBER
 * (1–18) or the STRING ("Lost-Carrier"), and MikroTik sends the string. The
 * logs and session views were showing whichever raw form arrived, so an
 * operator saw "Lost-Carrier" or "2" instead of "the customer's cable/ONU
 * dropped". This maps every form to a short label and a full description so the
 * whole app can explain a disconnect the same way.
 */

export interface TerminateInfo {
  code: number;
  key: string;      // canonical RFC string, e.g. "Lost-Carrier"
  label: string;    // short, for a table cell
  description: string; // the RFC meaning, for a tooltip / detail line
}

const TABLE: TerminateInfo[] = [
  { code: 1,  key: 'User-Request',        label: 'User request',        description: 'The user initiated the disconnect (logout).' },
  { code: 2,  key: 'Lost-Carrier',        label: 'Lost carrier',        description: "The customer's cable or ONU dropped — carrier lost on the port." },
  { code: 3,  key: 'Lost-Service',        label: 'Lost service',        description: 'Service could no longer be provided; the connection to a host was interrupted.' },
  { code: 4,  key: 'Idle-Timeout',        label: 'Idle timeout',        description: 'The idle timer expired — no traffic for the allowed period.' },
  { code: 5,  key: 'Session-Timeout',     label: 'Session timeout',     description: 'The maximum continuous session time for the service was reached.' },
  { code: 6,  key: 'Admin-Reset',         label: 'Admin reset',         description: 'An administrator reset the port or session.' },
  { code: 7,  key: 'Admin-Reboot',        label: 'Admin reboot',        description: 'An administrator terminated the session, e.g. before rebooting the NAS.' },
  { code: 8,  key: 'Port-Error',          label: 'Port error',          description: 'The NAS detected an error on the port that required ending the session.' },
  { code: 9,  key: 'NAS-Error',           label: 'NAS error',           description: 'The NAS detected a non-port error that required ending the session.' },
  { code: 10, key: 'NAS-Request',         label: 'NAS request',         description: 'The NAS ended the session for a non-error reason.' },
  { code: 11, key: 'NAS-Reboot',          label: 'NAS reboot',          description: 'The NAS ended the session due to a non-administrative reboot.' },
  { code: 12, key: 'Port-Unneeded',       label: 'Port unneeded',       description: 'Resource usage fell below the low threshold; the port was no longer needed.' },
  { code: 13, key: 'Port-Preempted',      label: 'Port preempted',      description: 'The NAS ended the session to allocate the port to a higher-priority use.' },
  { code: 14, key: 'Port-Suspended',      label: 'Port suspended',      description: 'The NAS ended the session to suspend a virtual session.' },
  { code: 15, key: 'Service-Unavailable', label: 'Service unavailable', description: 'The NAS was unable to provide the requested service.' },
  { code: 16, key: 'Callback',            label: 'Callback',            description: 'The NAS is ending the session to perform a callback for a new session.' },
  { code: 17, key: 'User-Error',          label: 'User error',          description: 'An error in the user input caused the session to be terminated.' },
  { code: 18, key: 'Host-Request',        label: 'Host request',        description: 'The login host terminated the session normally.' },
];

// Lookups by every form we might receive: number, "Lost-Carrier", "Lost Carrier",
// "lost_carrier". Plus the panel's own synthetic causes.
const BY_ANY = new Map<string, TerminateInfo>();
for (const t of TABLE) {
  BY_ANY.set(String(t.code), t);
  BY_ANY.set(t.key.toLowerCase(), t);
  BY_ANY.set(t.key.replace(/-/g, ' ').toLowerCase(), t);
  BY_ANY.set(t.key.replace(/-/g, '_').toLowerCase(), t);
}

// Synthetic causes the panel itself writes (not RFC), given friendly text too.
const SYNTHETIC: Record<string, TerminateInfo> = {
  'stale-session':        { code: 0, key: 'Stale-Session',        label: 'Session stale',        description: 'The router stopped reporting on this session without closing it.' },
  'session-gone-from-nas':{ code: 0, key: 'Session-Gone-From-NAS',label: 'Gone from router',     description: 'The session vanished from the router without a proper stop.' },
  'ghost-cleanup':        { code: 0, key: 'Ghost-Cleanup',        label: 'Cleaned up (ghost)',   description: 'A stale open session left by a clock/reporting fault was closed by the panel.' },
  'clear-stale':          { code: 0, key: 'Clear-Stale',          label: 'Cleared (stale)',      description: 'An old open session was closed during maintenance.' },
};

/** Resolve any Acct-Terminate-Cause form to its meaning, or a safe fallback. */
export function terminateInfo(cause: string | number | null | undefined): TerminateInfo {
  if (cause == null || cause === '') {
    return { code: 0, key: '', label: 'Still open / unknown', description: 'No termination cause recorded — the session may still be open.' };
  }
  const k = String(cause).trim().toLowerCase();
  return (
    BY_ANY.get(String(cause).trim()) ||
    BY_ANY.get(k) ||
    SYNTHETIC[k] || {
      code: 0,
      key: String(cause),
      label: String(cause),
      description: 'Non-standard termination cause reported by the router.',
    }
  );
}

/** The full reference table — for a docs/help view. */
export const TERMINATE_TABLE = TABLE;
