"use client";

/**
 * Shared types + helpers for the Subscriber 360 detail page.
 *
 * All shapes mirror what the NestJS backend actually returns — nothing here
 * invents data. Where the backend does not expose a value yet, components show
 * an honest "— / Unknown / Unavailable" state instead of fabricating one.
 */
import API from "../../components/api";

export const API_BASE = API;

// ─── Core record shapes (from the backend) ────────────────────────
export interface Subscriber {
  id: number;
  fullName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  username: string | null;
  password: string | null;
  identity: string | null;
  connectionType: string;
  authMethod: string;
  status: string;
  balance: number;
  packageId: number | null;
  areaId: number | null;
  nasId: number | null;
  salespersonId: number | null;
  userId: number | null;
  installationDate: string | null;
  createdAt: string;
  updatedAt: string;
  onHold?: boolean;
  onHoldReason?: string | null;
  fupApplied?: boolean;
  package?: Package | null;
  area?: { id: number; name: string } | null;
  nas?: NasBrief | null;
  salesperson?: { id: number; name: string; role: string } | null;
  user?: { id: number; name: string; role: string } | null;
  serviceSettings?: ServiceSettings | null;
  [key: string]: any;
}

export interface Package {
  id: number;
  name: string;
  downloadSpeed: number;
  uploadSpeed: number;
  price: number;
  duration: number;
  dataQuotaGb?: number | null;
  fupDownloadSpeed?: number | null;
  fupUploadSpeed?: number | null;
  pool?: { id: number; name: string } | null;
}

export interface NasBrief {
  id: number;
  nasname: string;
  nasIp?: string | null;
}

export interface ServiceSettings {
  id?: number;
  subscriberId?: number;
  expiryDate: string | null;
  duration?: number | null;
  ipAddress?: string | null;
  ipType?: string | null;
  macAddress?: string | null;
  macLockEnabled?: boolean;
  vlanId?: string | null;
  quota?: number | null;
  bonusQuotaGb?: number | null;
  quotaResetDate?: string | null;
  customPrice?: number | null;
  discountType?: string | null;
  discountValue?: number | null;
  smsEnabled?: boolean;
  allowMultipleSessions?: boolean;
  uploadSpeed?: number | null;
  downloadSpeed?: number | null;
  boxNumber?: string | null;
  boxAddress?: string | null;
  uplinkPort?: string | null;
  fiberCode?: string | null;
  fiberColor?: string | null;
  cableType?: string | null;
  switchBoard?: string | null;
  switchPort?: string | null;
  electricSocket?: string | null;
  onuNote?: string | null;
  ontSerial?: string | null;
  ontModel?: string | null;
  signalLevel?: string | null;
  rxPower?: string | null;
  txPower?: string | null;
  pptpUsername?: string | null;
  pptpPassword?: string | null;
  hasBackup?: boolean;
  notes?: string | null;
  [key: string]: any;
}

/** GET /subscribers/:id/profile-bundle */
export interface ProfileBundle {
  subscriber: Subscriber;
  serviceSettings: ServiceSettings | null;
  invoices: Invoice[];
  payments: Payment[];
  tickets: Ticket[];
}

export interface Invoice {
  id: number;
  invoiceNo: string;
  status: string;
  total: number;
  paidAmount: number;
  dueAmount: number;
  createdAt: string;
  dueDate?: string | null;
  items?: Array<{ description?: string; amount?: number }>;
  [key: string]: any;
}

export interface Payment {
  id: number;
  paymentNo: string;
  method: string;
  amount: number;
  referenceNo?: string | null;
  createdAt: string;
  [key: string]: any;
}

export interface Ticket {
  id: number;
  ticketNo: string;
  status: string;
  priority: string;
  category: string;
  subject: string;
  createdAt: string;
  messages?: any[];
  [key: string]: any;
}

// ─── RADIUS live data ────────────────────────────────────────────
export interface RadiusSession {
  username: string;
  nasipaddress: string;
  framedipaddress: string | null;
  callingstationid: string | null;
  acctstarttime: string | null;
  acctupdatetime?: string | null;
  acctstoptime: string | null;
  duration_seconds: number | null;
  upload_bytes: number | null;
  download_bytes: number | null;
  nasportid?: string | null;
  nasporttype?: string | null;
  framedprotocol?: string | null;
  servicetype?: string | null;
  acctterminatecause?: string | null;
  terminateLabel?: string | null;
  terminateDescription?: string | null;
  terminateCode?: number | null;
  acctinterval?: number | null;
  lastactivity?: string | null;
}

export interface RadiusSessionResponse {
  session: RadiusSession | null;
  history: RadiusSession[];
  openCount: number;
  duplicate: boolean;
}

export interface RadiusAuth {
  username: string;
  reply: string;
  authdate: string;
}

export interface RadiusCheck {
  id: number;
  username: string;
  attribute: string;
  op: string;
  value: string;
}

/** GET /subscribers/radius-status/:username */
export interface RadiusStatus {
  username: string;
  existsInRadius: boolean;
  profile?: any;
  error?: string;
}

// ─── Static IP ───────────────────────────────────────────────────
export interface StaticIp {
  id: number;
  ipAddress: string;
  monthlyPrice?: number | null;
  gateway?: string | null;
  status?: string;
  assignedAt: string | null;
  nextBillingDate?: string | null;
  nas?: { nasname?: string } | null;
  [key: string]: any;
}

export type StaticHealthStatus = "HEALTHY" | "MISMATCH" | "NOT_ONLINE" | "DYNAMIC";

export interface StaticIpHealth {
  subscriberId: number;
  username: string;
  ipType: string;
  wantsStatic: boolean;
  configuredIp: string | null;
  register: any;
  nas: string | null;
  database: { ok: boolean; ip: string | null };
  radius: { ok: boolean; ip: string | null; note?: string | null };
  session: { online: boolean; ip: string | null; ok: boolean | null; source?: string | null };
  status: StaticHealthStatus;
}

// ─── FUP / data allowance ────────────────────────────────────────
export interface FupUsage {
  subscriberId: number;
  username: string;
  cycleStart: string;
  usedGb: number;
  quotaGb: number;
  bonusGb: number;
  remainingGb: number | null;
  percentUsed: number | null;
  mode: string;
  fupApplied: boolean;
  state: "BLOCKED" | "THROTTLED" | "OK";
  throttledTo: string | null;
}

// ─── Router log + diagnosis ──────────────────────────────────────
export interface RouterLogRow {
  id: number;
  loggedAt: string;
  message: string;
  severity?: string;
  nas?: { id: number; nasname: string; nasIp: string } | null;
}

export interface RouterDiagnosis {
  severity: "critical" | "warning" | null;
  title: string;
  detail: string;
  cause: string;
  fix: string;
  occurrences?: number;
}

export interface RouterLogResponse {
  username: string | null;
  lines: RouterLogRow[];
  diagnosis: RouterDiagnosis | null;
}

// ─── Bandwidth history ───────────────────────────────────────────
export interface BwPoint {
  timestamp: string;
  uploadBps: number;
  downloadBps: number;
  uploadBytes: number;
  downloadBytes: number;
}

export interface BwHistory {
  samples: BwPoint[];
}

export interface DailyUsage {
  days: Array<{ day: string; uploadGb: number; downloadGb: number }>;
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

/** bytes → B/KB/MB/GB/TB. Guards against BIGINT string garbage. */
export function fmtBytes(v: number | string | null | undefined): string {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n) || n <= 0) return "0 B";
  if (n > 1e15) return "—"; // absurd value = data fault, don't print it
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}

/** seconds → "1d 2h" / "1h 32m" / "45m" / "10s". null → "—". */
export function fmtDuration(secs?: number | string | null): string {
  const s = Number(secs);
  if (secs === null || secs === undefined || Number.isNaN(s) || s < 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s)}s`;
}

/** ISO date → compact "16 Aug 14:20". Invalid → "—". */
export function fmtDateTime(iso?: string | Date | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** ISO date → full local "16 Aug 2026, 14:20:05". */
export function fmtDateTimeFull(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** ISO date → "16 Aug 2026". */
export function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

/** ISO time → "14:20:05". */
export function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Value that is 0/""/null/undefined/"Unknown" → fallback (keeps real zeros). */
export function show(v: any, fallback = "—"): string {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v === "string" && /^(unknown|not available|n\/a)$/i.test(v.trim())) return fallback;
  return String(v);
}

/** Postgres BIGINT → safe number (0 when invalid/negative). */
export function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** True when a value is honestly "no data" (null/undefined/empty). */
export function u(v: any): boolean {
  return v === null || v === undefined || v === "" || v === "Unknown";
}

export const MS = 1000;

// ─── Connection state (normalized, one source of truth) ──────────
export type ConnLevel = "online" | "offline" | "unknown";

/**
 * The single normalized connection state for the page header + panels.
 * LIVE session (radacct, fresh within 15 min) is the authority; subscriber
 * status/payment state is separate (shown as its own chip, never blended
 * into ONLINE/OFFLINE).
 */
export function connLevel(opts: { liveSession: RadiusSession | null; sessionChecked: boolean }): { level: ConnLevel; text: string } {
  if (!opts.sessionChecked) return { level: "unknown", text: "Checking…" };
  if (opts.liveSession) return { level: "online", text: "Online" };
  return { level: "offline", text: "Offline" };
}

// ─── Session-flapping detection ──────────────────────────────────
export interface FlapInfo {
  flagged: boolean;
  count: number;
  windowStart: string;
  windowHrs: number;
  avgSecs: number;
  reason: string;
}

/**
 * A session that starts and dies repeatedly within a short window points to a
 * physical fault (cable/ONT/PoE), a bad credential race with the router, or a
 * looping PPPoE client — not to a random "disconnected". Detection rule:
 *  >= 5 ended sessions whose start falls inside the last `windowHrs` hours,
 *  and whose average duration is under `shortSecs` (a minute is plenty to be
 *  sure these are not normal logins).
 */
export function detectFlapping(
  history: RadiusSession[],
  opts: { windowHrs?: number; shortSecs?: number } = {},
): FlapInfo | null {
  const windowHrs = opts.windowHrs ?? 3;
  const shortSecs = opts.shortSecs ?? 120;
  const cutoff = Date.now() - windowHrs * 3600 * 1000;
  const ended = (history || []).filter(
    (s) => s.acctstoptime && s.acctstarttime && new Date(s.acctstarttime).getTime() >= cutoff,
  );
  if (ended.length < 5) return null;
  const avgSecs =
    ended.reduce((a, s) => a + num(s.duration_seconds), 0) / ended.length;
  if (avgSecs > shortSecs) return null;
  return {
    flagged: true,
    count: ended.length,
    windowStart: ended[ended.length - 1].acctstarttime as string,
    windowHrs,
    avgSecs: Math.round(avgSecs),
    reason: `${ended.length} sessions started and ended in the last ${windowHrs}h (avg ${Math.round(avgSecs)}s each) — repeated connect/disconnect, likely a physical or credential fault.`,
  };
}