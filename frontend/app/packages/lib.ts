"use client";

/**
 * Shared types + helpers for the Packages (Plans & Stock) page.
 *
 * All shapes mirror what the NestJS backend actually returns — nothing here
 * invents data. Where the backend does not expose a value, components show an
 * honest "— / Unknown" state instead of fabricating one. In particular the FUP
 * display is derived exactly from the fields the enforcement sweep reads:
 *   - no dataQuotaGb            → Unlimited (no quota)
 *   - quota, no FUP speeds      → quota is a hard cap; NO throttle is applied
 *     (previously rendered "then blocked", which is wrong — null means the
 *     quota is simply not enforced.)
 *   - quota + FUP speeds        → throttle to ↓dl ↑ul after the allowance
 */

export type ServiceType = "RESIDENTIAL" | "BUSINESS" | "CORPORATE" | "EDUCATIONAL" | "GOVERNMENT";
export type DurationType = "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "YEARLY";

export interface PackageRow {
  id: number;
  name: string;
  description: string | null;
  invoiceDescription?: string | null;
  serviceType?: ServiceType;
  durationType?: DurationType;
  price: number;
  duration: number;
  isActive: boolean;
  downloadSpeed: number;
  uploadSpeed: number;
  burstDownload?: number | null;
  burstUpload?: number | null;
  burstThreshold?: number | null;
  burstTime?: number | null;
  dataQuotaGb: number | null;
  fupDownloadSpeed: number | null;
  fupUploadSpeed: number | null;
  poolId: number | null;
  pool: { id: number; name: string; network?: string; subnet?: string } | null;
  _count?: { subscribers: number };
  settings?: any;
  warnings?: string[];
  [k: string]: any;
}

export interface PackageStats {
  total: number;
  active: number;
  inactive: number;
  totalSubscribers: number;
}

export interface Tax {
  id: number;
  groupName: string;
  name: string;
  type: "FIXED" | "PERCENTAGE" | "FORMULA";
  value: string;
  description?: string;
  isActive: boolean;
}

export interface Policy {
  id: number;
  groupName: string;
  attributeName: string;
  attributeType: "TEXT" | "NUMBER" | "DATE" | "BOOLEAN";
  attributeOp: "=" | "!=" | ">" | "<" | ">=" | "<=" | "CONTAINS";
  attributeValue: string;
  description?: string;
}

export interface Allocation {
  id: number;
  groupName: string;
  isActive: boolean;
  days: string[];
  startTime: string;
  endTime: string;
  policyId?: number | null;
  description?: string;
}

// ─── GET /packages/:id/overview ──────────────────────────────────
export interface OverviewResponse {
  package: PackageRow;
  pricing: {
    basePrice: number;
    taxDetail: Array<Tax & { appliedAmount: number }>;
    taxTotal: number;
    finalWithTax: number;
    resellerPrices: Array<{
      id: number;
      price: number;
      retailPrice: number | null;
      subresellerProfit: number | null;
      subscriberProfit: number | null;
      createdAt: string;
      user: { id: number; name: string; email: string | null; role: string };
    }>;
    note: string;
  };
  revenue: {
    monthlyRevenue: number;
    arpu: number;
    active: number;
    note: string;
  };
  fup: { quotaGb: number | null; mode: "UNLIMITED" | "NO_THROTTLE" | "THROTTLE"; download: number | null; upload: number | null; label: string };
  pool: {
    id: number;
    name: string;
    network: string;
    subnet: string;
    capacity: number;
    estimatedUsed: number;
    utilizationPct: number;
    note: string;
  } | null;
  radius: {
    rateLimit: string;
    poolName: string | null;
    policyAttributes: Array<{ attribute: string; op: string; value: string }>;
    note: string;
  };
  impact: {
    subscribers: number;
    resellers: number;
    groups: number;
    pools: number;
    expiringSoon: number;
    subStatus: Record<string, number>;
    note: string;
  };
  policies: Policy[];
  allocations: Allocation[];
  audit: Array<{
    id: number;
    action: string;
    details: string | null;
    createdAt: string;
    user: { id: number; name: string; email: string | null; role: string } | null;
  }>;
  health: HealthCheck[];
  /** Blocking problems only — a non-empty list means new activations are refused. */
  errors?: HealthCheck[];
  warnings: HealthCheck[];
  healthStatus?: {
    status: "HEALTHY" | "WARNING" | "ERROR";
    errors: number;
    warnings: number;
    canActivateNewSubscribers: boolean;
    summary: string;
  };
}

export type HealthLevel = "error" | "warn" | "ok" | "info";

export interface HealthCheck {
  level: HealthLevel;
  code: string;
  message: string;
  /** Optional hint for a remediation action, e.g. "FIX_FUP". */
  fix?: string;
}

/** Correct FUP semantics from the fields the enforcement sweep actually reads.
 *  The sweep only throttles packages WITH fup speeds set (fup.service filters
 *  `package: { is: { fupDownloadSpeed: { not: null } } }`) — so a quota with no
 *  FUP speeds is simply NOT enforced, never "blocked". */
export function fupInfo(p: PackageRow): { quotaGb: number | null; mode: "UNLIMITED" | "NO_THROTTLE" | "THROTTLE"; download: number | null; upload: number | null; label: string } {
  const quota = p.dataQuotaGb;
  const dl = p.fupDownloadSpeed;
  const ul = p.fupUploadSpeed;
  if (!quota) return { quotaGb: null, mode: "UNLIMITED", download: null, upload: null, label: "Unlimited (no quota)" };
  if (!dl && !ul) return { quotaGb: quota, mode: "NO_THROTTLE", download: null, upload: null, label: `${quota} GB quota, no FUP speeds — not enforced by the sweep` };
  return { quotaGb: quota, mode: "THROTTLE", download: dl, upload: ul, label: `${quota} GB then ↓${dl ?? "—"} ↑${ul ?? "—"} Mbps` };
}

export const DURATION_LABEL: Record<string, string> = {
  DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly",
  QUARTERLY: "Quarterly", HALF_YEARLY: "Half-yearly", YEARLY: "Yearly",
};

export const SERVICE_TYPE_LABEL: Record<string, string> = {
  RESIDENTIAL: "Residential", BUSINESS: "Business", CORPORATE: "Corporate",
  EDUCATIONAL: "Educational", GOVERNMENT: "Government",
};

export function durationLabel(d: DurationType | undefined): string {
  return DURATION_LABEL[d ?? "MONTHLY"] ?? "Monthly";
}

export function serviceTypeLabel(s: ServiceType | undefined): string {
  return SERVICE_TYPE_LABEL[s ?? "RESIDENTIAL"] ?? "Residential";
}

/** Health badge tone mapping for the overview's check list. */
/**
 * Four distinct levels, deliberately. Collapsing `error` into `warn` is what
 * made an impossible FUP configuration look like a housekeeping note.
 *   error — cannot work as configured; blocks new activations
 *   warn  — works, but needs a look
 *   ok    — verified good
 *   info  — neutral fact
 */
export function healthTone(level: HealthLevel): { color: string; bg: string; icon: string } {
  switch (level) {
    case "error": return { color: "#ff7070", bg: "rgba(255,112,112,.12)", icon: "✕" };
    case "warn":  return { color: "#F59E0B", bg: "rgba(245,158,11,.10)", icon: "⚠" };
    case "ok":    return { color: "#10B981", bg: "rgba(16,185,129,.10)", icon: "✓" };
    default:      return { color: "var(--muted)", bg: "rgba(148,163,184,.08)", icon: "•" };
  }
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "—";
  }
}