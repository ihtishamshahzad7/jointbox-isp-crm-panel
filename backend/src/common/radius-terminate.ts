/**
 * RADIUS Acct-Terminate-Cause — the single source of truth for what ended a
 * session.
 *
 * RFC 2866 §5.10 defines eighteen standard causes. A NAS may send them as the
 * NUMBER (1–18) or the STRING ("Lost-Carrier"); MikroTik sends the string. Every
 * form maps to one entry here, so the subscriber profile, the logs, the
 * disconnect report and the customer portal all explain a drop the same way.
 *
 * Each entry carries:
 *   - name / description — the standard wording, exactly as the RFC table has it
 *   - meaning            — what that usually means on an ISP network
 *   - action             — what the operator should check
 *   - category           — who or what ended it (customer, timer, operator, …)
 *   - severity           — normal | info | warn | critical, for colour and triage
 *   - customer           — the short line a subscriber sees in the portal
 */

export type TerminateCategory =
  | 'customer' | 'timer' | 'operator' | 'link' | 'router' | 'port' | 'service' | 'panel' | 'other' | 'open';
export type TerminateSeverity = 'normal' | 'info' | 'warn' | 'critical';

export interface TerminateInfo {
  code: number;
  key: string;          // canonical RFC string, e.g. "Lost-Carrier"
  label: string;        // short name, e.g. "Lost Carrier"
  description: string;  // the RFC 2866 meaning
  meaning: string;      // what it usually means on an ISP network
  action: string;       // what to check
  category: TerminateCategory;
  severity: TerminateSeverity;
  customer: string;     // plain line for the customer portal
  how: string;          // how it was disconnected, in one line
  standard: boolean;    // true for the 18 RFC causes
}

type Row = Omit<TerminateInfo, 'standard'>;

const TABLE: Row[] = [
  { code: 1, key: 'User-Request', label: 'User Request', category: 'customer', severity: 'normal',
    description: 'User initiated the disconnect (logout).',
    meaning: 'The customer’s router or dialer logged out on purpose — a restart, a manual disconnect or a reconnect.',
    action: 'No action. If it repeats every few minutes, check the customer’s router for a dial-on-demand or reconnect schedule.',
    customer: 'You disconnected',
    how: "Customer's side ended it — their router logged out, restarted or redialled" },
  { code: 2, key: 'Lost-Carrier', label: 'Lost Carrier', category: 'link', severity: 'warn',
    description: 'DCD was dropped on the port.',
    meaning: 'The link to the customer dropped — a cable, ONU or customer router lost power or signal.',
    action: 'Check the customer’s ONU light, cable and power. Many drops on one router at the same time point to an upstream fiber or switch fault.',
    customer: 'Cable or device disconnected',
    how: "Line dropped at the customer — cable, ONU or their router lost power or signal" },
  { code: 3, key: 'Lost-Service', label: 'Lost Service', category: 'link', severity: 'warn',
    description: 'Service can no longer be provided; for example, the user’s connection to a host was interrupted.',
    meaning: 'The path between the router and the customer broke while the session was up.',
    action: 'Check the upstream link and the PPPoE server path. Compare with other customers dropped at the same minute.',
    customer: 'Connection interrupted',
    how: "The connection path broke while the session was up" },
  { code: 4, key: 'Idle-Timeout', label: 'Idle Timeout', category: 'timer', severity: 'normal',
    description: 'Idle timer expired.',
    meaning: 'No traffic passed for the idle period set on the plan or router.',
    action: 'Expected when an Idle-Timeout is set. Raise or remove it on the package if customers complain.',
    customer: 'Idle timeout',
    how: "Idle timer on the router — no traffic for the idle period" },
  { code: 5, key: 'Session-Timeout', label: 'Session Timeout', category: 'timer', severity: 'normal',
    description: 'Subscriber reached the maximum continuous time allowed for the service or session.',
    meaning: 'The Session-Timeout from the plan or the expiry time was reached; the customer reconnects automatically.',
    action: 'Expected. If it cuts customers mid-day, check the Session-Timeout on the package and the expiry date.',
    customer: 'Session time limit reached',
    how: "Session time limit reached — the plan's limit or the expiry time" },
  { code: 6, key: 'Admin-Reset', label: 'Admin Reset', category: 'operator', severity: 'info',
    description: 'System administrator reset the port or session.',
    meaning: 'Someone disconnected the session — a kick from the panel, a plan change, a suspension or a router reset.',
    action: 'Check the activity log for who disconnected the customer and why.',
    customer: 'Disconnected by your provider',
    how: "Reset by an administrator — on the router, or from the panel" },
  { code: 7, key: 'Admin-Reboot', label: 'Admin Reboot', category: 'operator', severity: 'info',
    description: 'System administrator terminated the session on the NAS; for example, prior to rebooting the NAS.',
    meaning: 'An administrator rebooted or shut down the router, ending every session on it.',
    action: 'Confirm the reboot was planned. Check the router’s maintenance log.',
    customer: 'Network maintenance',
    how: "An administrator rebooted or shut down the router" },
  { code: 8, key: 'Port-Error', label: 'Port Error', category: 'port', severity: 'critical',
    description: 'NAS detected an error on the port that required ending the session.',
    meaning: 'The router saw a fault on the interface or VLAN carrying the customer.',
    action: 'Check the router interface for errors, the VLAN and the cable. Replace the port or patch if it repeats.',
    customer: 'Network port error',
    how: "The router found an error on the customer's port" },
  { code: 9, key: 'NAS-Error', label: 'NAS Error', category: 'router', severity: 'critical',
    description: 'NAS detected an error (other than on the port) that required ending the session.',
    meaning: 'The router hit an internal error — memory, CPU, licence or RADIUS trouble.',
    action: 'Check the router log, CPU and RAM, its licence limit and whether it can reach the RADIUS server.',
    customer: 'Network equipment error',
    how: "The router hit an internal error" },
  { code: 10, key: 'NAS-Request', label: 'NAS Request', category: 'router', severity: 'info',
    description: 'NAS ended the session for a non-error reason.',
    meaning: 'The router closed the session normally — a profile change, a duplicate login replacing the old one, or keepalive loss.',
    action: 'Usually no action. Many in a row for one customer can mean two devices sharing the account.',
    customer: 'Network closed the session',
    how: "The router closed the session for a normal reason" },
  { code: 11, key: 'NAS-Reboot', label: 'NAS Reboot', category: 'router', severity: 'critical',
    description: 'NAS ended the session due to a non-administrative reboot.',
    meaning: 'The router restarted on its own — a power cut, a crash or a watchdog reboot.',
    action: 'Check the router’s power and UPS (load-shedding), its uptime and its crash log.',
    customer: 'Network equipment restarted',
    how: "The router restarted by itself — power cut, crash or watchdog" },
  { code: 12, key: 'Port-Unneeded', label: 'Port Unneeded', category: 'port', severity: 'info',
    description: 'NAS ended the session because the resource usage fell below the low threshold; for example, the bandwidth-on-demand algorithm determined that the port was no longer needed.',
    meaning: 'A bandwidth-on-demand rule released the port because traffic was low.',
    action: 'Normal on bandwidth-on-demand setups. No action.',
    customer: 'Released due to low usage',
    how: "The router released the port because usage was low" },
  { code: 13, key: 'Port-Preempted', label: 'Port Preempted', category: 'port', severity: 'info',
    description: 'NAS ended the session to allocate the port to a higher-priority use.',
    meaning: 'The router needed the port for a higher-priority session.',
    action: 'Check the router’s session capacity and licence limit if this happens often.',
    customer: 'Line reassigned',
    how: "The router gave the port to a higher-priority session" },
  { code: 14, key: 'Port-Suspended', label: 'Port Suspended', category: 'port', severity: 'info',
    description: 'NAS ended the session to suspend a virtual session.',
    meaning: 'The router suspended a virtual session.',
    action: 'Usually no action.',
    customer: 'Session suspended',
    how: "The router suspended the virtual session" },
  { code: 15, key: 'Service-Unavailable', label: 'Service Unavailable', category: 'service', severity: 'critical',
    description: 'NAS was unable to provide the requested service.',
    meaning: 'The router could not give the customer the service — often an empty IP pool, a missing profile or a licence cap.',
    action: 'Check the IP pool for free addresses, the PPP profile and rate-limit names, and the router licence.',
    customer: 'Service unavailable',
    how: "The router could not provide the service" },
  { code: 16, key: 'Callback', label: 'Callback', category: 'service', severity: 'info',
    description: 'NAS is terminating the current session in order to perform callback for a new session.',
    meaning: 'The router ended the session to call the customer back on a new one.',
    action: 'Normal on callback setups. No action.',
    customer: 'Reconnecting',
    how: "The router ended it to call the customer back" },
  { code: 17, key: 'User-Error', label: 'User Error', category: 'customer', severity: 'warn',
    description: 'Error in the user input caused the session to be terminated.',
    meaning: 'The customer’s device sent something wrong — usually the PPPoE settings.',
    action: 'Check the username and password on the customer’s router and its PPPoE settings.',
    customer: 'Check your router settings',
    how: "The customer's router sent wrong login details" },
  { code: 18, key: 'Host-Request', label: 'Host Request', category: 'customer', severity: 'normal',
    description: 'Login host terminated the session normally.',
    meaning: 'The login host closed the session in the normal way.',
    action: 'No action.',
    customer: 'Session ended normally',
    how: "The login host ended it normally" },
];

// Causes the panel itself writes (not RFC) — explained in the same shape.
const SYNTHETIC_ROWS: Row[] = [
  { code: 0, key: 'Stale-Session', label: 'Session Stale', category: 'panel', severity: 'warn',
    description: 'The router stopped reporting on this session without closing it.',
    meaning: 'No interim update arrived for the grace period, so the panel closed the open record.',
    action: 'Make sure the router sends interim updates and can reach the RADIUS server.',
    customer: 'Connection ended',
    how: "Closed by the panel — the router stopped reporting on it" },
  { code: 0, key: 'Session-Gone-From-NAS', label: 'Gone From Router', category: 'panel', severity: 'warn',
    description: 'The session vanished from the router without a proper stop.',
    meaning: 'The router no longer lists the session, but never sent an Accounting-Stop.',
    action: 'Check the router’s RADIUS accounting settings and packet loss to the RADIUS server.',
    customer: 'Connection ended',
    how: "Closed by the panel — it vanished from the router without a stop" },
  { code: 0, key: 'Ghost-Cleanup', label: 'Ghost Cleanup', category: 'panel', severity: 'info',
    description: 'A stale open session left by a clock or reporting fault was closed by the panel.',
    meaning: 'A leftover open record was tidied up; the customer was not actually cut.',
    action: 'No action. Frequent cleanups point to a wrong clock on the router.',
    customer: 'Connection ended',
    how: "Closed by the panel — a leftover record was tidied up" },
  { code: 0, key: 'Clear-Stale', label: 'Cleared Stale', category: 'panel', severity: 'info',
    description: 'An old open session was closed during maintenance.',
    meaning: 'An administrator cleared stale sessions from the RADIUS health screen.',
    action: 'No action.',
    customer: 'Connection ended',
    how: "Closed by an administrator from the RADIUS health screen" },
  { code: 0, key: 'Reconciled-NotOnRouter', label: 'Not On Router', category: 'panel', severity: 'info',
    description: 'The panel closed a session the router no longer had.',
    meaning: 'Integrity reconcile found the session open in RADIUS but missing on the router.',
    action: 'No action. If frequent, check accounting delivery from that router.',
    customer: 'Connection ended',
    how: "Closed by the panel — the router no longer had it" },
];

const STANDARD: TerminateInfo[] = TABLE.map((r) => ({ ...r, standard: true }));
const SYNTHETIC: TerminateInfo[] = SYNTHETIC_ROWS.map((r) => ({ ...r, standard: false }));

// Lookups by every form we might receive: 2, "Lost-Carrier", "Lost Carrier",
// "lost_carrier", "LostCarrier".
const BY_ANY = new Map<string, TerminateInfo>();
const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, '');
for (const t of [...STANDARD, ...SYNTHETIC]) {
  if (t.code) BY_ANY.set(String(t.code), t);
  BY_ANY.set(norm(t.key), t);
  BY_ANY.set(norm(t.label), t);
}

const OPEN: TerminateInfo = {
  code: 0, key: '', label: 'Still Open', category: 'open', severity: 'normal', standard: false,
  description: 'No termination cause recorded — the session is still open or the stop never arrived.',
  meaning: 'The session has not ended yet.',
  action: 'No action.',
  customer: '',
  how: 'Still connected',
};

/** Resolve any Acct-Terminate-Cause form to its meaning, or a safe fallback. */
export function terminateInfo(cause: string | number | null | undefined): TerminateInfo {
  if (cause == null || String(cause).trim() === '') return OPEN;
  const raw = String(cause).trim();
  return (
    BY_ANY.get(raw) ||
    BY_ANY.get(norm(raw)) || {
      code: 0,
      key: raw.slice(0, 32),
      label: raw.slice(0, 32),
      category: 'other',
      severity: 'info',
      standard: false,
      description: 'Non-standard termination cause reported by the router.',
      meaning: 'The router used a vendor-specific reason.',
      action: 'Look the value up in the router vendor’s documentation.',
      customer: 'Connection ended',
      how: 'The router ended it with a vendor-specific reason',
    }
  );
}

/** A stopped session whose router sent no cause at all. */
export const NOT_REPORTED: TerminateInfo = {
  code: 0, key: 'Not-Reported', label: 'Not Reported', category: 'other', severity: 'info', standard: false,
  description: 'The session ended but the router sent no Acct-Terminate-Cause.',
  meaning: 'The stop arrived without a reason, so why it ended is not known.',
  action: 'Enable accounting with terminate cause on the router (MikroTik sends it by default).',
  customer: 'Connection ended',
  how: 'Not reported — the router sent no reason',
};

BY_ANY.set(norm(NOT_REPORTED.key), NOT_REPORTED);

/** Like terminateInfo, for a session known to have ENDED (never "Still Open"). */
export function endedInfo(cause: string | number | null | undefined): TerminateInfo {
  const t = terminateInfo(cause);
  return t.category === 'open' ? NOT_REPORTED : t;
}

/** Flat fields for an API row, so every endpoint names them the same way. */
export function terminateFields(cause: string | number | null | undefined) {
  return fieldsOf(terminateInfo(cause));
}

/** Same flat fields, from an already-resolved entry. */
export function fieldsOf(t: TerminateInfo) {
  return {
    terminateCode: t.code,
    terminateKey: t.key,
    terminateLabel: t.label,
    terminateDescription: t.description,
    terminateMeaning: t.meaning,
    terminateAction: t.action,
    terminateHow: t.how,
    terminateCategory: t.category,
    terminateSeverity: t.severity,
  };
}

/** The eighteen RFC 2866 causes, in code order. */
export const TERMINATE_TABLE: readonly TerminateInfo[] = STANDARD;
/** The panel's own causes. */
export const TERMINATE_SYNTHETIC: readonly TerminateInfo[] = SYNTHETIC;

export const TERMINATE_CATEGORIES: ReadonlyArray<{ id: TerminateCategory; label: string; about: string }> = [
  { id: 'customer', label: 'Customer side', about: 'The customer’s device or login host ended it.' },
  { id: 'timer',    label: 'Timers',        about: 'An idle or session time limit was reached.' },
  { id: 'operator', label: 'Operator',      about: 'An administrator reset the session or rebooted the router.' },
  { id: 'link',     label: 'Line / link',   about: 'The cable, ONU or path to the customer dropped.' },
  { id: 'router',   label: 'Router (NAS)',  about: 'The router ended it — an error, a reboot or a normal close.' },
  { id: 'port',     label: 'Port',          about: 'A port error, or the port was released, preempted or suspended.' },
  { id: 'service',  label: 'Service',       about: 'The service could not be provided, or a callback.' },
  { id: 'panel',    label: 'Panel cleanup', about: 'The panel closed a record the router never stopped.' },
  { id: 'other',    label: 'Non-standard',  about: 'A vendor-specific reason.' },
];
