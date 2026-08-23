"use client";

/**
 * Network device monitoring — typed API client + formatters for the
 * SNMP/syslog screens. One place for paths, auth headers and the byte/rate
 * number crunching so the pages stay readable.
 */
import API from "../components/api";

export const token = () => (typeof window !== "undefined" ? localStorage.getItem("token") : "");
export const H = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token()}` });

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...H(), ...(opts.headers || {}) } });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d?.message || d?.error || `Request failed (${r.status})`);
  }
  return r.json() as Promise<T>;
}

// ── Types mirrored from the backend ───────────────────────────────
export type NdmDevice = {
  id: number; name: string; ip: string; vendor: string; deviceType: string | null;
  groupName: string | null; location: string | null; description: string | null;
  enabled: boolean; isReachable: boolean | null; uptimeSec: string | null;
  interfaceCount: number; upPorts: number; downPorts: number;
  lastSnmpPollAt: string | null; lastSyslogAt: string | null; lastError: string | null;
  soundEnabled: boolean; soundUpEnabled: boolean;
  openAlerts: number; portCount: number; createdAt: string;
  /**
   * How this target is ACTUALLY checked. Never infer it from the address — a
   * switch can sit on a public IP, and an internal host can be ping-only.
   * SNMP → ports/traffic/uptime. ICMP/HTTP → reachability + latency only.
   */
  monitorMethod?: "SNMP" | "ICMP" | "HTTP";
  lastLatencyMs?: number | null;
  lastLossPct?: number | null;
  lastOkAt?: string | null;
  downSince?: string | null;
};

/** Label + failure wording per method, so the UI never says "SNMP timeout"
 *  about a target that is only pinged. */
export const METHOD_META: Record<string, { label: string; short: string; timeout: string }> = {
  SNMP: { label: "SNMP", short: "SNMP", timeout: "SNMP timeout" },
  ICMP: { label: "ICMP Ping", short: "Ping", timeout: "Ping timeout" },
  HTTP: { label: "HTTP Check", short: "HTTP", timeout: "Connection timeout" },
};
export const methodOf = (d: { monitorMethod?: string | null }) =>
  METHOD_META[String(d.monitorMethod || "SNMP").toUpperCase()] || METHOD_META.SNMP;
/** SNMP is the only method that yields interfaces, traffic and device uptime. */
export const isSnmp = (d: { monitorMethod?: string | null }) =>
  String(d.monitorMethod || "SNMP").toUpperCase() === "SNMP";

export type NdmPort = {
  id: number; ifIndex: number; name: string; description: string | null;
  adminStatus: number; operStatus: number; speedMbps: number | null; duplex: string | null;
  rxRateBps: number | null; txRateBps: number | null; rxPps: number | null; txPps: number | null; errorRatePerMin: number | null;
  mac: string | null; ifLastChangeTicks: string | null; lastStateChangeAt: string | null;
  firstSeen: string | null; lastSeen: string | null;
  ifType: number | null; interfaceCategory: string | null;
  monitoringEnabled: boolean; monitoringExplicit: boolean; excludedReason: string | null;
  soundEnabled: boolean; soundUpEnabled: boolean;
  inOctets: string | null; outOctets: string | null; inErrors: string | null; outErrors: string | null; crcErrors: string | null;
};

export type NdmEvent = {
  id: number; deviceId: number | null; sourceIp: string | null; interfaceId: number | null;
  interfaceName: string | null; eventType: string; severity: string; message: string;
  status: string; count: number; createdAt: string; resolvedAt: string | null; label: string;
};

export type NdmAlert = {
  id: number; ruleId: number | null; deviceId: number | null; interfaceId: number | null;
  interfaceName: string | null; eventType: string; title: string; message: string;
  severity: string; key: string; status: string; openedAt: string; resolvedAt: string | null;
  acknowledgedAt: string | null; fireCount: number;
  device?: { name: string; ip: string } | null;
  rule?: { name: string; condition: string | null; channels: any } | null;
  notifications?: Array<{ channel: string; status: string }>;
};

export type NdmRule = {
  id: number; ownerId: number | null; name: string; eventType: string; condition: string | null;
  severity: string; enabled: boolean; channels: any; description: string | null;
  createdAt: string; updatedAt: string; _count?: { alerts: number };
};

export type SyslogRow = {
  id: number; deviceId: number | null; sourceIp: string; hostname: string | null;
  facility: number | null; facilityName: string | null; severity: number | null;
  severityName: string; tag: string | null; message: string; eventType: string | null;
  status: string; raw: string | null; receivedAt: string;
};

export type Stats = {
  devices: { total: number; enabled: number; reachable: number; down: number; ports: number; upPorts: number; downPorts: number; perDevice: Array<any> };
  alerts: { open: number; critical: number };
  events: { open: number; last24h: number };
  syslog: { last24h: number };
};

export interface SnmpTestBody {
  ip: string; name?: string; snmpVersion?: string; snmpPort?: number;
  community?: string; v3Username?: string; v3AuthProto?: string; v3AuthKey?: string;
  v3PrivProto?: string; v3PrivKey?: string;
}
export interface SnmpTestResult { ok: boolean; error?: string; sysDescr?: string | null; sysName?: string | null; uptimeTicks?: number | null; interfaceCount?: number; port?: number; }

// ── API ───────────────────────────────────────────────────────────
export const ndm = {
  stats: () => req<Stats>("/monitoring/ndm/stats"),
  devices: () => req<NdmDevice[]>("/monitoring/ndm/devices"),
  device: (id: number) => req<any>(`/monitoring/ndm/devices/${id}`),
  test: (b: SnmpTestBody) => req<SnmpTestResult>("/monitoring/ndm/devices/test", { method: "POST", body: JSON.stringify(b) }),
  discover: (b: SnmpTestBody) => req<any>("/monitoring/ndm/devices/discover", { method: "POST", body: JSON.stringify(b) }),
  create: (b: any) => req<any>("/monitoring/ndm/devices", { method: "POST", body: JSON.stringify(b) }),
  update: (id: number, b: any) => req<any>(`/monitoring/ndm/devices/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  remove: (id: number) => req<any>(`/monitoring/ndm/devices/${id}`, { method: "DELETE" }),
  check: (id: number) => req<any>(`/monitoring/ndm/devices/${id}/check`, { method: "POST", body: "{}" }),
  discoverDevice: (id: number) => req<any>(`/monitoring/ndm/devices/${id}/discover`, { method: "POST", body: "{}" }),
  ports: (id: number) => req<NdmPort[]>(`/monitoring/ndm/devices/${id}/ports`),
  setPort: (deviceId: number, portId: number, b: { monitoringEnabled?: boolean; soundEnabled?: boolean; soundUpEnabled?: boolean }) =>
    req<NdmPort>(`/monitoring/ndm/devices/${deviceId}/ports/${portId}`, { method: "PUT", body: JSON.stringify(b) }),
  testPortAlert: (deviceId: number, portId: number, direction: "down" | "up") =>
    req<{ ok: boolean; eventType: string; eventId: number; message: string }>(`/monitoring/ndm/devices/${deviceId}/ports/${portId}/test`, { method: "POST", body: JSON.stringify({ direction }) }),
  portHistory: (deviceId: number, portId: number, range: string) =>
    req<any>(`/monitoring/ndm/devices/${deviceId}/ports/${portId}/history?range=${range}`),
  deviceStream: (id: number, range: string) => req<any>(`/monitoring/ndm/devices/${id}/stream?range=${range}`),
  syslog: (q: { deviceId?: number; severity?: string; limit?: number; page?: number }) => {
    const p = new URLSearchParams();
    if (q.deviceId) p.set("deviceId", String(q.deviceId));
    if (q.severity) p.set("severity", q.severity);
    if (q.limit) p.set("limit", String(q.limit));
    if (q.page) p.set("page", String(q.page));
    return req<{ total: number; page: number; rows: SyslogRow[] }>(`/monitoring/ndm/syslog?${p}`);
  },
  events: (q: { deviceId?: number; status?: string; type?: string; limit?: number; page?: number }) => {
    const p = new URLSearchParams();
    if (q.deviceId) p.set("deviceId", String(q.deviceId));
    if (q.status) p.set("status", q.status);
    if (q.type) p.set("type", q.type);
    if (q.limit) p.set("limit", String(q.limit));
    if (q.page) p.set("page", String(q.page));
    return req<{ total: number; page: number; rows: NdmEvent[] }>(`/monitoring/ndm/events?${p}`);
  },
  alerts: (q: { status?: string; deviceId?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.status) p.set("status", q.status);
    if (q.deviceId) p.set("deviceId", String(q.deviceId));
    if (q.limit) p.set("limit", String(q.limit));
    return req<{ total: number; page: number; rows: NdmAlert[] }>(`/monitoring/ndm/alerts?${p}`);
  },
  ackAlert: (id: number) => req<any>(`/monitoring/ndm/alerts/${id}/ack`, { method: "POST", body: "{}" }),
  resolveAlert: (id: number) => req<any>(`/monitoring/ndm/alerts/${id}/resolve`, { method: "POST", body: "{}" }),
  rules: () => req<NdmRule[]>("/monitoring/ndm/rules"),
  createRule: (b: any) => req<NdmRule>("/monitoring/ndm/rules", { method: "POST", body: JSON.stringify(b) }),
  updateRule: (id: number, b: any) => req<NdmRule>(`/monitoring/ndm/rules/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  deleteRule: (id: number) => req<any>(`/monitoring/ndm/rules/${id}`, { method: "DELETE" }),
  ruleHelp: () => req<{ eventTypes: { type: string; label: string }[]; conditions: { value: string; label: string }[]; channels: string[] }>("/monitoring/ndm/rule-help"),
  settings: () => req<any>("/monitoring/ndm/settings"),
  updateSettings: (b: any) => req<any>("/monitoring/ndm/settings", { method: "PUT", body: JSON.stringify(b) }),
};

// ── Formatters ────────────────────────────────────────────────────
export const fmtBits = (s: number) => {
  const b = Number(s) || 0;
  if (b >= 1e9) return `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} Gbps`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} Mbps`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} Kbps`;
  return `${Math.round(b)} bps`;
};
export const fmtPps = (v: number) => {
  const n = Number(v) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M pps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k pps`;
  return `${Math.round(n)} pps`;
};
export const fmtDuration = (sec: number) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${r}s`;
  return `${r}s`;
};
export const fmtUptime = (sec: string | number | null | undefined) =>
  sec == null ? "—" : fmtDuration(Number(BigInt(String(sec))));
/** Long form for the device card/detail: 11d 4h 23m (not just 11d 4h). */
export const fmtUptimeFull = (sec: string | number | null | undefined) => {
  if (sec == null) return "—";
  const s = Math.max(0, Math.round(Number(sec)));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return fmtDuration(s);
};

export const CATEGORY_LABELS: Record<string, string> = {
  PHYSICAL: "Physical", VLAN: "VLAN", LOOPBACK: "Loopback", BRIDGE: "Bridge", BOND: "Bond",
  TUNNEL: "Tunnel", PPP: "PPP", PPPOE_SESSION: "PPPoE", DYNAMIC: "Dynamic", UNKNOWN: "Unknown",
};
export const catLabel = (c: string | null | undefined) => CATEGORY_LABELS[String(c || "").toUpperCase()] || "Unknown";
export const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleString();
};

export const SEV_COLORS: Record<string, string> = {
  CRITICAL: "#B02A37", ERROR: "#B02A37", WARNING: "#B45309", NOTICE: "#8A6209",
  INFORMATIONAL: "#157F43", INFO: "#157F43", DEBUG: "#64748B", EMERGENCY: "#7F1D1D", ALERT: "#B02A37",
};
export const sevColor = (s: string) => SEV_COLORS[String(s || "").toUpperCase()] || "#64748B";
export const isUp = (p: { operStatus: number }) => p.operStatus === 1;
export const portState = (p: { operStatus: number; adminStatus: number }) =>
  p.adminStatus === 2 ? "disabled" : isUp(p) ? "up" : "down";