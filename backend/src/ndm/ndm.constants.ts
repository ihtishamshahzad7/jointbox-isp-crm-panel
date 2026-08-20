/**
 * Network Device Monitoring — shared constants.
 *
 * Everything the SNMP poller, syslog parser, event engine and alert engine
 * agree on lives here so the pieces cannot drift: OIDs, severity names,
 * event types, the alert-rule condition DSL, and the scope helpers.
 */

// ── SNMP OIDs (standard IF-MIB, works on every SNMP device) ──────────
export const NDM_IF = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  descr: '1.3.6.1.2.1.2.2.1.2',        // ifDescr
  ifType: '1.3.6.1.2.1.2.2.1.3',       // ifType (IANAifType) — classification signal
  adminStatus: '1.3.6.1.2.1.2.2.1.7',  // ifAdminStatus 1=up 2=down
  operStatus: '1.3.6.1.2.1.2.2.1.8',   // ifOperStatus 1=up 2=down
  lastChange: '1.3.6.1.2.1.2.2.1.9',   // ifLastChange (ticks)
  inOctets: '1.3.6.1.2.1.2.2.1.10',    // 32-bit counters (fallback)
  inUcastPkts: '1.3.6.1.2.1.2.2.1.11',
  outOctets: '1.3.6.1.2.1.2.2.1.16',
  outUcastPkts: '1.3.6.1.2.1.2.2.1.17',
  inDiscards: '1.3.6.1.2.1.2.2.1.13',
  inErrors: '1.3.6.1.2.1.2.2.1.14',
  outErrors: '1.3.6.1.2.1.2.2.1.20',
  outDiscards: '1.3.6.1.2.1.2.2.1.19',
  // 64-bit "high capacity" counters — preferred, wrap in centuries.
  hcName: '1.3.6.1.2.1.31.1.1.1.1',
  hcInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  hcInUcastPkts: '1.3.6.1.2.1.31.1.1.1.7',
  hcOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  hcOutUcastPkts: '1.3.6.1.2.1.31.1.1.1.11',
  hcSpeed: '1.3.6.1.2.1.31.1.1.1.15',   // ifHighSpeed, Mbps
  alias: '1.3.6.1.2.1.31.1.1.1.18',     // ifAlias — operator description
  physAddress: '1.3.6.1.2.1.2.2.1.6',
  duplex: '1.3.6.1.2.1.10.7.2.1.19',    // dot3StatsDuplexStatus (if present)
};

export const NDM_IF_OPER = { UP: 1, DOWN: 2, TESTING: 3 };
export const NDM_IF_ADMIN = { UP: 1, DOWN: 2 };

/**
 * Vendor best-effort CRC-error OID bases. The IF-MIB only exposes aggregate
 * ifInErrors; CRCs specifically live in private MIBs. When a walk returns
 * nothing the poller simply leaves crcErrors null (UI shows "—").
 */
export const NDM_CRC_OIDS: Record<string, string> = {
  CISCO: '1.3.6.1.4.1.9.2.2.1.1.6',     // locIfInputErrors (Cisco device table)
  HUAWEI: '1.3.6.1.4.1.2011.5.25.31.1.1.1.6.2.1.6',
};

/** Duplex mapping for dot3StatsDuplexStatus: 1=unknown 2=half 3=full 4=negotiated. */
export function duplexName(v: any): string | null {
  const n = Number(v);
  if (n === 2) return 'Half';
  if (n === 3) return 'Full';
  if (n === 4) return 'Auto';
  return null;
}

/// Syslog severity (RFC 5424 PRI & 7 values): index → name.
export const SYSLOG_SEVERITIES = [
  'EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR', 'WARNING', 'NOTICE', 'INFORMATIONAL', 'DEBUG',
] as const;

/// Syslog facility (RFC 5424): index → name (common ones; others fall back to "localN"/"USER").
const FACILITIES: Record<number, string> = {
  0: 'KERN', 1: 'USER', 2: 'MAIL', 3: 'DAEMON', 4: 'AUTH', 5: 'SYSLOG',
  6: 'LPR', 7: 'NEWS', 8: 'UUCP', 9: 'CRON', 10: 'AUTHPRIV', 11: 'FTP',
  12: 'NTP', 13: 'AUDIT', 14: 'ALERT', 15: 'CLOCK', 16: 'LOCAL0',
  17: 'LOCAL1', 18: 'LOCAL2', 19: 'LOCAL3', 20: 'LOCAL4', 21: 'LOCAL5',
  22: 'LOCAL6', 23: 'LOCAL7',
};

export function facilityName(f: number | null | undefined): string {
  if (f == null) return 'USER';
  return FACILITIES[f] || `LOCAL${f - 16}`;
}

/// Severity ranking for filtering: critical > error > warning > notice > info > debug.
export const SEV_RANK: Record<string, number> = {
  EMERGENCY: 0, ALERT: 1, CRITICAL: 2, ERROR: 3, WARNING: 4,
  NOTICE: 5, INFORMATIONAL: 6, DEBUG: 7,
};

/** Map a syslog severity name onto an event severity (lowercase). */
export function eventSeverity(sev: string | null | undefined): 'critical' | 'error' | 'warning' | 'notice' | 'info' | 'debug' {
  const s = String(sev || 'INFO').toUpperCase();
  if (s === 'EMERGENCY' || s === 'ALERT' || s === 'CRITICAL') return s === 'CRITICAL' ? 'critical' : 'critical';
  if (s === 'ERROR') return 'error';
  if (s === 'WARNING') return 'warning';
  if (s === 'NOTICE') return 'notice';
  if (s === 'DEBUG') return 'debug';
  return 'info';
}

/// ── Event types produced by the poller / parser / engines ──────────────
export type NdmEventType =
  | 'PORT_DOWN' | 'PORT_UP' | 'LINK_DOWN' | 'LINK_UP' | 'BGP_DOWN' | 'BGP_UP'
  | 'OSPF_DOWN' | 'OSPF_UP' | 'STP_CHANGE' | 'CPU_HIGH' | 'MEMORY_HIGH'
  | 'AUTH_FAILURE' | 'CONFIG_CHANGE' | 'LINK_FLAP' | 'DEVICE_REBOOT'
  | 'POWER_FAILURE' | 'SYSLOG_STOPPED' | 'DEVICE_DOWN' | 'DEVICE_UP'
  | 'SYSLOG' | 'PORT_ERROR';

/** Human-friendly label for each event type (the table/UI text). */
export const EVENT_LABELS: Record<string, string> = {
  PORT_DOWN: 'Port DOWN', PORT_UP: 'Port UP', LINK_DOWN: 'Link DOWN', LINK_UP: 'Link UP',
  BGP_DOWN: 'BGP neighbor DOWN', BGP_UP: 'BGP neighbor UP',
  OSPF_DOWN: 'OSPF adjacency DOWN', OSPF_UP: 'OSPF adjacency UP',
  STP_CHANGE: 'STP topology change', CPU_HIGH: 'High CPU', MEMORY_HIGH: 'High memory',
  AUTH_FAILURE: 'Authentication failure', CONFIG_CHANGE: 'Configuration change',
  LINK_FLAP: 'Link flapping', DEVICE_REBOOT: 'Device reboot', POWER_FAILURE: 'Power failure',
  SYSLOG_STOPPED: 'Syslog stopped', DEVICE_DOWN: 'Device DOWN', DEVICE_UP: 'Device UP',
  SYSLOG: 'Syslog', PORT_ERROR: 'Port errors',
};

/// Default event severity per type (used when a source doesn't say otherwise).
export const EVENT_DEFAULT_SEVERITY: Record<string, 'critical' | 'warning' | 'info'> = {
  PORT_DOWN: 'critical', PORT_UP: 'info', LINK_DOWN: 'warning', LINK_UP: 'info',
  BGP_DOWN: 'critical', BGP_UP: 'info', OSPF_DOWN: 'critical', OSPF_UP: 'info',
  STP_CHANGE: 'warning', CPU_HIGH: 'warning', MEMORY_HIGH: 'warning',
  AUTH_FAILURE: 'warning', CONFIG_CHANGE: 'info', LINK_FLAP: 'critical',
  DEVICE_REBOOT: 'warning', POWER_FAILURE: 'critical', SYSLOG_STOPPED: 'warning',
  DEVICE_DOWN: 'critical', DEVICE_UP: 'info', SYSLOG: 'info', PORT_ERROR: 'warning',
};

/// ── Alert-rule condition DSL ────────────────────────────────────────────
/**
 * A rule's `condition` is one of:
 *   ""                 → every event of eventType matches
 *   "DURATION:120"     → event sustained > 120 s → re-fire notification (escalate)
 *   "FLAP:5:600"       → eventType happened 5+ times within 600 s → critical
 *   "THRESHOLD:90:CPU" → device metric CPU (or memory/temperature) ≥ 90 → warning
 *   "SYSLOG_SILENCE:300" → device stopped sending syslog for 300 s → warning
 */
export type ParsedCondition =
  | { kind: 'ANY' }
  | { kind: 'DURATION'; seconds: number }
  | { kind: 'FLAP'; count: number; windowSec: number }
  | { kind: 'THRESHOLD'; value: number; metric: string }
  | { kind: 'SYSLOG_SILENCE'; seconds: number };

export function parseCondition(cond: string | null | undefined): ParsedCondition {
  const c = String(cond || '').trim().toUpperCase();
  if (!c) return { kind: 'ANY' };
  const m = c.match(/^DURATION:(\d+)$/);
  if (m) return { kind: 'DURATION', seconds: Math.max(10, Number(m[1])) };
  const f = c.match(/^FLAP:(\d+):(\d+)$/);
  if (f) return { kind: 'FLAP', count: Math.max(2, Number(f[1])), windowSec: Math.max(30, Number(f[2])) };
  const t = c.match(/^THRESHOLD:([\d.]+):(CPU|MEMORY|TEMPERATURE)$/);
  if (t) return { kind: 'THRESHOLD', value: Number(t[1]), metric: t[2].toLowerCase() };
  const s = c.match(/^SYSLOG_SILENCE:(\d+)$/);
  if (s) return { kind: 'SYSLOG_SILENCE', seconds: Math.max(60, Number(s[1])) };
  return { kind: 'ANY' };
}

// ── Interface classification (which interfaces are real ports) ───────────
/**
 * Categories understood by the GUI. PPPoE/dynamic/tunnel/PPP session links
 * are NOT real outage indicators (they flap with the ISP), so by default
 * they are discovered + tracked but excluded from monitoring (no alerts,
 * no traffic history, not counted in port totals).
 */
export type InterfaceCategory =
  | 'PHYSICAL' | 'VLAN' | 'LOOPBACK' | 'BRIDGE' | 'BOND'
  | 'TUNNEL' | 'PPP' | 'PPPOE_SESSION' | 'DYNAMIC' | 'UNKNOWN';

/** IANAifType values RouterOS/Cisco/Huawei actually send (fallback signals). */
const IANA_IF_TYPE_CATEGORY: Record<number, InterfaceCategory> = {
  6: 'PHYSICAL',     // ethernetCsmacd
  24: 'LOOPBACK',    // softwareLoopback
  135: 'VLAN',       // l2vlan
  209: 'BRIDGE',     // bridge (incl. RouterOS bridge)
  161: 'BOND',       // ieee8023adLag
  131: 'TUNNEL',     // tunnel (gre/eoip/vxlan…)
};

/**
 * Decide what an interface IS. RouterOS names are the primary signal
 * (ifName is reliable; proprietary ifType values are not), ifType is the
 * fallback, then UNKNOWN.
 */
export function classifyInterface(ifType: number | null | undefined, name: string | null | undefined): InterfaceCategory {
  const nm = String(name || '').toLowerCase().trim();
  // Name signals first — they are what operators actually see in Winbox.
  if (/^pppoe-/i.test(nm) || (/pppoe/i.test(nm) && /\d/.test(nm))) return 'PPPOE_SESSION';
  if (/^vlan[\d.:-]*$/i.test(nm)) return 'VLAN';
  if (/^(lo|loopback[\d.:-]*)$/i.test(nm)) return 'LOOPBACK';
  if (/^bridge[\d.:-]*$/i.test(nm)) return 'BRIDGE';
  if (/^bond[\d.:-]*$/i.test(nm)) return 'BOND';
  if (/^(gre|gre6|eoip|vxlan|ipip|eip|wireguard|tun[\d.:-]*)$/i.test(nm)) return 'TUNNEL';
  if (/^(ppp|l2tp|sstp|ovpn)[\d.:-]*$/i.test(nm)) return 'PPP';
  if (/^dynamic/i.test(nm)) return 'DYNAMIC';
  // ifType fallback (works even when a vendor mangles names).
  const t = ifType != null ? Number(ifType) : null;
  if (t != null && IANA_IF_TYPE_CATEGORY[t]) {
    if (t === 23) return /pppoe/i.test(nm) ? 'PPPOE_SESSION' : 'PPP';
    return IANA_IF_TYPE_CATEGORY[t];
  }
  return 'UNKNOWN';
}

/** Default monitoring policy per category — PPPoE/dynamic links excluded. */
export function defaultMonitored(category: InterfaceCategory): boolean {
  return category === 'PHYSICAL' || category === 'VLAN' || category === 'LOOPBACK'
    || category === 'BRIDGE' || category === 'BOND';
}

/** Human label for the category (used by the UI + wizard). */
export const CATEGORY_LABELS: Record<InterfaceCategory, string> = {
  PHYSICAL: 'Physical', VLAN: 'VLAN', LOOPBACK: 'Loopback', BRIDGE: 'Bridge', BOND: 'Bond',
  TUNNEL: 'Tunnel', PPP: 'PPP', PPPOE_SESSION: 'PPPoE session', DYNAMIC: 'Dynamic', UNKNOWN: 'Unknown',
};

// ── Sound defaults ───────────────────────────────────────────────────────
/**
 * Conservative sound policy: only CRITICAL/HIGH alerts make noise by
 * default. WARNING/INFO/Debug stay silent unless a rule explicitly asks
 * (rule.channels.sound). This is the "no fireworks at 3am" default.
 */
export function severityDefaultSound(severity: string | null | undefined): boolean {
  const s = String(severity || '').toUpperCase();
  return s === 'CRITICAL' || s === 'HIGH';
}

// ── Polling intervals the UI offers (seconds) ───────────────────────────
export const POLL_INTERVALS = [10, 30, 60, 300];

// ── Formatting helpers shared by services (no deps) ─────────────────────
export function fmtBits(s: number): string {
  const bps = Number(s) || 0;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(bps >= 1e10 ? 0 : 1)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} Kbps`;
  return `${Math.round(bps)} bps`;
}

export function fmtPps(v: number): string {
  const n = Number(v) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M pps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k pps`;
  return `${Math.round(n)} pps`;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${r}s`;
  return `${r}s`;
}

export function fmtUptime(sec: number | bigint | null | undefined): string {
  if (sec == null) return '—';
  return fmtDuration(Number(BigInt(sec)));
}

/** Rate-safe counter delta (handles wrap + reboot reset by returning null). */
export function counterDelta(cur: bigint | number | null | undefined, prev: bigint | number | null | undefined): bigint | null {
  if (cur == null || prev == null) return null;
  let c: bigint, p: bigint;
  try {
    c = typeof cur === 'bigint' ? cur : BigInt(Number(cur));
    p = typeof prev === 'bigint' ? prev : BigInt(Number(prev));
  } catch { return null; }
  if (c < 0n || p < 0n) return null;
  if (c >= p) return c - p;
  // 32-bit wrap (never on HC counters, handle anyway)
  const w32 = 0x100000000n;
  if (p < w32) return (w32 - p) + c;
  return null;
}