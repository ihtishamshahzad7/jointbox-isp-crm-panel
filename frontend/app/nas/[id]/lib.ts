"use client";

/**
 * Shared types + helpers for the NAS detail page.
 *
 * All shapes mirror what the NestJS backend actually returns — nothing here
 * invents data. Where the backend does not expose a value yet, components show
 * an honest "Unknown / Not available" state instead of fabricating one.
 */
import API from "../../components/api";

export const API_BASE = API;

/** Sanitized NAS record (secrets masked, `hasX` flags present). */
export interface NasRecord {
  id: number;
  nasname: string;
  shortname?: string | null;
  nasIp?: string | null;
  secret?: string;
  hasSecret?: boolean;
  type?: string;
  apiPort: number;
  incomingPort: number;
  apiUsername?: string | null;
  apiPassword?: string;
  hasApiPassword?: boolean;
  description?: string | null;
  isActive: boolean;
  deviceType?: string;
  apiEnabled?: boolean;
  apiPollSec?: number;
  snmpEnabled?: boolean;
  snmpPort?: number;
  snmpCommunity?: string;
  hasSnmpCommunity?: boolean;
  snmpVersion?: string;
  snmpPollSec?: number;
  snmpTimeoutMs?: number;
  snmpRetries?: number;
  syslogEnabled?: boolean;
  syslogPort?: number;
  nasIdentifier?: string | null;
  monitoredPorts?: string | null;
  _count?: { subscribers: number };
  subscribers?: Subscriber[];
  owner?: { id: number; name: string; role: string } | null;
}

/** GET /nas/:id/reachability — the live health snapshot. */
export interface Reachability {
  apiPortOpen: boolean;
  radiusPortOpen: boolean;
  incomingPortOpen: boolean;
  nasRegistered: boolean;
  activeSessionCount: number;
  radiusNasCount: number;
  identity: string;
  version: string;
  cpuLoad: string;
  uptime: string;
  activeConnections: number;
  radiusIp: string;
  radiusPort: number;
  coaPort: number;
  responseTimeMs: number | null;
  lastChecked: Date | null;
}

/** GET /nas/:id/sync — full MikroTik sync (per-command failures kept). */
export interface MikrotikDetails {
  identity: string;
  version: string;
  board: string;
  uptime: string;
  cpuLoad: string;
  totalMemory: string;
  freeMemory: string;
  totalHdd: string;
  freeHdd: string;
  interfaces: MikrotikInterface[];
  pppoeServer: PppoeServerInfo | null;
  pppoeProfiles: PppoeProfile[];
  radiusClients: RadiusClient[];
  apiService: ApiServiceInfo | null;
  ipAddresses: IpAddress[];
  activeConnections: number;
  apiErrors?: string[];
}

export interface MikrotikInterface {
  name: string;
  type: string;
  mtu: string;
  macAddress: string;
  running: string;
  disabled: string;
  comment: string;
}
export interface PppoeServerInfo {
  enabled: boolean;
  interface: string;
  serviceName: string;
  maxMtu: string;
  maxMru: string;
  authentication: string;
  keepaliveTimeout: string;
  defaultProfile: string;
}
export interface PppoeProfile {
  name: string;
  localAddress: string;
  remoteAddress: string;
  rateLimit: string;
  sessionTimeout: string;
  comment: string;
}
export interface RadiusClient {
  service: string;
  address: string;
  secret: string;
  authPort: string;
  acctPort: string;
  timeout: string;
  disabled: string;
}
export interface ApiServiceInfo {
  enabled: boolean;
  port: string;
  tlsPort: string;
  disabled: string;
}
export interface IpAddress {
  address: string;
  network: string;
  interface: string;
  disabled: string;
}

/** Session row — from the router (/ppp/active) or radacct, normalized. */
export interface Session {
  username: string;
  nasipaddress?: string | null;
  framedipaddress?: string | null;
  callingstationid?: string | null;
  acctstarttime?: string | null;
  duration_seconds?: number;
  upload_bytes?: number;
  download_bytes?: number;
  sessionId?: string | null;
  source?: string;
  acctsessionid?: string;
  [key: string]: any;
}

/** GET /nas/radius/stats */
export interface RadiusStats {
  alive: boolean;
  activeSessionCount: number;
  nasCount: number;
  accepts: number;
  rejects: number;
  serverIp: string;
  radiusPort: number;
  acctPort: number;
}

/** GET /telemetry/events?nasId= — one durable telemetry event. */
export interface TelemetryEvent {
  id: number;
  nasId?: number | null;
  eventType: string;
  severity: string;
  message: string;
  loggedAt: string;
  username?: string | null;
  port?: string | null;
  eventReason?: string | null;
  source?: string | null;
  [key: string]: any;
}

/** GET /logs/network */
export interface NetworkLogRow {
  id: number;
  nasId: number;
  eventType: string;
  eventReason?: string | null;
  subscriberId?: number | null;
  username?: string | null;
  callerId?: string | null;
  framedIp?: string | null;
  sessionId?: string | null;
  message?: string | null;
  severity: string;
  loggedAt: string;
  nas?: { id: number; nasname: string; nasIp: string } | null;
  subscriber?: { id: number; fullName: string } | null;
}

export interface Subscriber {
  id: number;
  fullName: string;
  phone: string;
  email?: string | null;
  username: string;
  status?: string;
  balance?: number;
  connectionType?: string;
  authMethod?: string;
  package?: { name: string } | null;
  [key: string]: any;
}

// ─── Auth helper ────────────────────────────────────────────────
export function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

/** GET with a hard timeout so one slow endpoint never freezes the page. */
export async function apiGet<T>(path: string, ms = 15000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${API_BASE}${path}`, { headers: authHeaders(), signal: ctrl.signal });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** POST/PATCH/PUT/DELETE returning parsed JSON or null on failure. */
export async function apiSend<T>(path: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body?: any, ms = 20000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method,
      headers: authHeaders(),
      signal: ctrl.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = Array.isArray(data?.message) ? data.message.join(" ") : data?.message;
      const err: any = new Error(msg || `Request failed (HTTP ${r.status})`);
      err.status = r.status;
      throw err;
    }
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Formatters ──────────────────────────────────────────────────
/** bits/s → bps/Kbps/Mbps/Gbps. */
export function fmtBits(v: number | null | undefined): string {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n) || n < 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 2)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} Kbps`;
  return `${Math.round(n)} bps`;
}

/** bytes → B/KB/MB/GB/TB. */
export function fmtBytes(v: number | null | undefined): string {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n) || n < 0) return "—";
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}

/** seconds → "1d 2h 3m" / "1h 32m". */
export function fmtDuration(secs?: number | null): string {
  const s = Number(secs);
  if (!secs || Number.isNaN(s) || s < 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s)}s`;
}

/** RouterOS uptime ("1w2d3h4m5s") → human. */
export function fmtRouterUptime(raw?: string | null): string {
  if (!raw) return "—";
  return String(raw);
}

/** ISO date → local "HH:MM:SS". */
export function fmtTime(iso?: string | Date | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** ISO date → compact "16 Aug 14:20". */
export function fmtDateTime(iso?: string | Date | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "1w2d" router uptime → approximate seconds (for health display only). */
export function routerUptimeToSecs(up?: string | null): number | null {
  if (!up) return null;
  let s = 0;
  for (const [, n, u] of String(up).matchAll(/(\d+)([dhms])/g)) {
    const v = parseInt(n, 10);
    s += u === "d" ? v * 86400 : u === "h" ? v * 3600 : u === "m" ? v * 60 : v;
  }
  return s || null;
}

export function parseCpu(s?: string | null): number | null {
  const n = parseFloat(String(s ?? "").replace("%", ""));
  return Number.isNaN(n) ? null : n;
}

/** Value that is 0, "", null, undefined or "Unknown" → display fallback. */
export function show(v: any, fallback = "—"): string {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v === "string" && /^(unknown|not available|n\/a|0)$/i.test(v.trim())) return fallback;
  return String(v);
}

export const MS = 1000;

/** A clean null/undefined guard for the "Unknown" requirement. */
export function u(v: any): boolean {
  return v === null || v === undefined || v === "" || v === "Unknown";
}

// ─── Health computation (driven ONLY by real backend state) ───────
export type HealthLevel = "ok" | "warn" | "bad" | "off" | "unknown";

export interface ServiceHealth {
  key: string;
  label: string;
  level: HealthLevel;
  text: string;
  detail?: string;
}

/**
 * Separate DEVICE reachability from API / RADIUS / CoA / SNMP / Syslog health.
 * A router with permission-limited API is ONLINE, not offline.
 */
export function buildServiceHealth(opts: {
  reach: Reachability | null;
  details: MikrotikDetails | null;
  nas: NasRecord | null;
  events: TelemetryEvent[];
  hasSnmpSamples: boolean;
  radiusAlive?: boolean;
  coaTest?: { reachable?: boolean; message?: string } | null;
}): ServiceHealth[] {
  const { reach, details, nas, events, hasSnmpSamples } = opts;

  const apiErrors = details?.apiErrors?.length ?? 0;
  const apiPermLimited = apiErrors > 0;

  // DEVICE: TCP reachable (API port open) — the router itself is online.
  const device: ServiceHealth = reach
    ? reach.apiPortOpen
      ? { key: "device", label: "Device", level: "ok", text: "Online" }
      : { key: "device", label: "Device", level: "bad", text: "Unreachable" }
    : { key: "device", label: "Device", level: "unknown", text: "Checking…" };

  // API: connected + authenticated. Permission gaps degrade, never offline.
  const api: ServiceHealth = !nas?.apiUsername || !nas?.apiPassword
    ? { key: "api", label: "API", level: "off", text: "Not configured", detail: "No API credentials on this device." }
    : !reach
      ? { key: "api", label: "API", level: "unknown", text: "Checking…" }
      : !reach.apiPortOpen
        ? { key: "api", label: "API", level: "bad", text: "Unreachable", detail: `TCP :${nas.apiPort ?? 8728} not reachable.` }
        : apiPermLimited
          ? { key: "api", label: "API", level: "warn", text: "Permission limited", detail: "Authenticated, but RouterOS policies block some commands." }
          : { key: "api", label: "API", level: "ok", text: "Connected", detail: details ? `v${details.version}` : "" };

  // RADIUS: FreeRADIUS server alive (UDP 1812 replies) + this NAS registered.
  const radiusOk = reach?.radiusPortOpen ?? opts.radiusAlive ?? false;
  const radius: ServiceHealth = radiusOk
    ? {
        key: "radius", label: "RADIUS", level: "ok", text: "Healthy",
        detail: reach?.nasRegistered ? "NAS registered" : reach ? "Server up, NAS not registered" : "",
      }
    : { key: "radius", label: "RADIUS", level: "bad", text: "Down", detail: "FreeRADIUS not answering on UDP :1812." };

  // CoA: real probe result preferred, else registration + configured port.
  const coaReachable = opts.coaTest ? opts.coaTest.reachable : undefined;
  const coa: ServiceHealth = coaReachable === false
    ? { key: "coa", label: "CoA", level: "bad", text: "Not reachable", detail: `UDP :${nas?.incomingPort ?? 3799} did not answer.` }
    : coaReachable === true
      ? { key: "coa", label: "CoA", level: "ok", text: "Ready", detail: `UDP :${nas?.incomingPort ?? 3799}` }
      : reach?.nasRegistered
        ? { key: "coa", label: "CoA", level: "ok", text: "Ready", detail: `UDP :${nas?.incomingPort ?? 3799}` }
        : reach
          ? { key: "coa", label: "CoA", level: "warn", text: "Not registered", detail: "NAS not found in RADIUS client list." }
          : { key: "coa", label: "CoA", level: "unknown", text: "Checking…" };

  // SNMP: enabled? polling? any stored samples yet?
  const snmp: ServiceHealth = !nas?.snmpEnabled
    ? { key: "snmp", label: "SNMP", level: "off", text: "Disabled", detail: "Enable SNMP polling in Configuration." }
    : hasSnmpSamples
      ? { key: "snmp", label: "SNMP", level: "ok", text: "Monitoring", detail: `v${nas.snmpVersion?.replace("V", "v") ?? "2c"} · every ${nas.snmpPollSec ?? 30}s` }
      : { key: "snmp", label: "SNMP", level: "warn", text: "Polling", detail: "Enabled — waiting for first sample." };

  // Syslog: enabled? receiving events?
  const syslog: ServiceHealth = !nas?.syslogEnabled
    ? { key: "syslog", label: "Syslog", level: "off", text: "Not configured", detail: "Enable syslog in Configuration." }
    : events.length === 0
      ? { key: "syslog", label: "Syslog", level: "warn", text: "Listening", detail: `UDP :${nas.syslogPort ?? 514} — no events yet.` }
      : { key: "syslog", label: "Syslog", level: "ok", text: "Receiving", detail: `${events.length} recent event(s)` };

  return [device, api, radius, coa, snmp, syslog];
}

// ─── API permission diagnosis (from REAL apiErrors) ──────────────
/** RouterOS commands the panel runs, and the policy each one needs. */
export const PERM_COMMANDS: Array<{ cmd: string; policy: string; label: string; needed: string }> = [
  { cmd: "/system/identity/print", policy: "read", label: "system resource", needed: "identity" },
  { cmd: "/system/resource/print", policy: "read", label: "system resource", needed: "CPU / memory / uptime" },
  { cmd: "/interface/print", policy: "read", label: "interfaces", needed: "interface list" },
  { cmd: "/ppp/active/print", policy: "read", label: "PPPoE server", needed: "active sessions" },
  { cmd: "/ppp/profile/print", policy: "read", label: "PPPoE server", needed: "profiles" },
  { cmd: "/radius/print", policy: "read", label: "RADIUS clients", needed: "RADIUS config" },
  { cmd: "/ip/address/print", policy: "read", label: "IP addresses", needed: "address list" },
];

/** Which sync commands failed (from real apiErrors strings). */
export function parseApiErrors(apiErrors?: string[]): { failed: Set<string>; raw: string[] } {
  const raw = apiErrors ?? [];
  const failed = new Set<string>();
  for (const e of raw) {
    const label = e.split(":")[0]?.trim();
    if (label) failed.add(label.toLowerCase());
  }
  return { failed, raw };
}
