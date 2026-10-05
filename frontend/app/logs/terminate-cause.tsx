"use client";

/**
 * RADIUS Acct-Terminate-Cause — badges for the Logs page.
 *
 * The backend resolves every cause (number, "Lost-Carrier", vendor text) and
 * sends terminateCode / terminateLabel / terminateCategory / terminateSeverity
 * plus a meaning and an action. These components draw that consistently, and
 * fall back to the local RFC 2866 table when a row only has the raw value.
 */
import React from "react";
import styles from "./terminate-cause.module.css";

export type CauseCategory =
  | "customer" | "timer" | "operator" | "link" | "router" | "port" | "service" | "panel" | "other" | "open";
export type CauseSeverity = "normal" | "info" | "warn" | "critical";

export interface CauseEntry {
  code: number;
  key: string;
  label: string;
  description: string;
  category: CauseCategory;
  severity: CauseSeverity;
}

/** RFC 2866 §5.10 — the eighteen standard causes, worded as the RFC has them. */
export const TERMINATE_CAUSES: CauseEntry[] = [
  { code: 1,  key: "User-Request",        label: "User Request",        category: "customer", severity: "normal",   description: "User initiated the disconnect (logout)." },
  { code: 2,  key: "Lost-Carrier",        label: "Lost Carrier",        category: "link",     severity: "warn",     description: "DCD was dropped on the port." },
  { code: 3,  key: "Lost-Service",        label: "Lost Service",        category: "link",     severity: "warn",     description: "Service can no longer be provided; for example, the user’s connection to a host was interrupted." },
  { code: 4,  key: "Idle-Timeout",        label: "Idle Timeout",        category: "timer",    severity: "normal",   description: "Idle timer expired." },
  { code: 5,  key: "Session-Timeout",     label: "Session Timeout",     category: "timer",    severity: "normal",   description: "Subscriber reached the maximum continuous time allowed for the service or session." },
  { code: 6,  key: "Admin-Reset",         label: "Admin Reset",         category: "operator", severity: "info",     description: "System administrator reset the port or session." },
  { code: 7,  key: "Admin-Reboot",        label: "Admin Reboot",        category: "operator", severity: "info",     description: "System administrator terminated the session on the NAS; for example, prior to rebooting the NAS." },
  { code: 8,  key: "Port-Error",          label: "Port Error",          category: "port",     severity: "critical", description: "NAS detected an error on the port that required ending the session." },
  { code: 9,  key: "NAS-Error",           label: "NAS Error",           category: "router",   severity: "critical", description: "NAS detected an error (other than on the port) that required ending the session." },
  { code: 10, key: "NAS-Request",         label: "NAS Request",         category: "router",   severity: "info",     description: "NAS ended the session for a non-error reason." },
  { code: 11, key: "NAS-Reboot",          label: "NAS Reboot",          category: "router",   severity: "critical", description: "NAS ended the session due to a non-administrative reboot." },
  { code: 12, key: "Port-Unneeded",       label: "Port Unneeded",       category: "port",     severity: "info",     description: "NAS ended the session because the resource usage fell below the low threshold; for example, the bandwidth-on-demand algorithm determined that the port was no longer needed." },
  { code: 13, key: "Port-Preempted",      label: "Port Preempted",      category: "port",     severity: "info",     description: "NAS ended the session to allocate the port to a higher-priority use." },
  { code: 14, key: "Port-Suspended",      label: "Port Suspended",      category: "port",     severity: "info",     description: "NAS ended the session to suspend a virtual session." },
  { code: 15, key: "Service-Unavailable", label: "Service Unavailable", category: "service",  severity: "critical", description: "NAS was unable to provide the requested service." },
  { code: 16, key: "Callback",            label: "Callback",            category: "service",  severity: "info",     description: "NAS is terminating the current session in order to perform callback for a new session." },
  { code: 17, key: "User-Error",          label: "User Error",          category: "customer", severity: "warn",     description: "Error in the user input caused the session to be terminated." },
  { code: 18, key: "Host-Request",        label: "Host Request",        category: "customer", severity: "normal",   description: "Login host terminated the session normally." },
];

export const CATEGORY_META: Record<CauseCategory, { label: string; color: string }> = {
  customer: { label: "Customer side", color: "#0f766e" },
  timer:    { label: "Timers",        color: "#4f46e5" },
  operator: { label: "Operator",      color: "#7c3aed" },
  link:     { label: "Line / link",   color: "#b45309" },
  router:   { label: "Router (NAS)",  color: "#c2410c" },
  port:     { label: "Port",          color: "#0369a1" },
  service:  { label: "Service",       color: "#a21caf" },
  panel:    { label: "Panel cleanup", color: "#475569" },
  other:    { label: "Non-standard",  color: "#57534e" },
  open:     { label: "Online",        color: "#15803d" },
};
export const CATEGORY_ORDER: CauseCategory[] = ["customer", "timer", "operator", "link", "router", "port", "service", "panel", "other"];

export const SEVERITY_META: Record<CauseSeverity, { label: string; color: string; about: string }> = {
  normal:   { label: "Expected",  color: "#16a34a", about: "Normal end of a session — no action needed." },
  info:     { label: "Info",      color: "#2563eb", about: "Ended by an operator or the router for a known reason." },
  warn:     { label: "Check",     color: "#d97706", about: "Worth a look — the customer probably noticed." },
  critical: { label: "Fault",     color: "#dc2626", about: "A fault on the router, port or service." },
};

const PANEL: Record<string, CauseEntry> = {
  "stalesession":          { code: 0, key: "Stale-Session",          label: "Session Stale",    category: "panel", severity: "warn", description: "The router stopped reporting on this session without closing it." },
  "sessiongonefromnas":    { code: 0, key: "Session-Gone-From-NAS",  label: "Gone From Router", category: "panel", severity: "warn", description: "The session vanished from the router without a proper stop." },
  "ghostcleanup":          { code: 0, key: "Ghost-Cleanup",          label: "Ghost Cleanup",    category: "panel", severity: "info", description: "A stale open session left by a clock or reporting fault was closed by the panel." },
  "clearstale":            { code: 0, key: "Clear-Stale",            label: "Cleared Stale",    category: "panel", severity: "info", description: "An old open session was closed during maintenance." },
  "reconcilednotonrouter": { code: 0, key: "Reconciled-NotOnRouter", label: "Not On Router",    category: "panel", severity: "info", description: "The panel closed a session the router no longer had." },
  "notreported":           { code: 0, key: "Not-Reported",           label: "Not Reported",     category: "other", severity: "info", description: "The session ended but the router sent no Acct-Terminate-Cause." },
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");
const LOOKUP = new Map<string, CauseEntry>();
for (const c of TERMINATE_CAUSES) {
  LOOKUP.set(String(c.code), c);
  LOOKUP.set(norm(c.key), c);
}
for (const [k, c] of Object.entries(PANEL)) LOOKUP.set(k, c);

/** Resolve a raw cause value locally (number, RFC string or panel cause). */
export function resolveCause(raw: string | number | null | undefined, ended = true): CauseEntry {
  if (raw == null || String(raw).trim() === "") {
    return ended ? PANEL.notreported : { code: 0, key: "", label: "Online", category: "open", severity: "normal", description: "The session is still open." };
  }
  const s = String(raw).trim();
  return LOOKUP.get(s) || LOOKUP.get(norm(s)) || {
    code: 0, key: s.slice(0, 32), label: s.slice(0, 32), category: "other", severity: "info",
    description: "Non-standard termination cause reported by the router.",
  };
}

export interface CauseView extends CauseEntry {
  meaning?: string | null;
  action?: string | null;
  raw?: string | null;
}

/**
 * Read the cause off any session row the backend sends (subscriber sessions,
 * the logs, the disconnect report). Server fields win; the raw value is the
 * fallback for older payloads.
 */
export function causeOf(row: any): CauseView {
  if (!row) return { ...resolveCause(null) };
  const raw = row.acctterminatecause ?? row.rawCause ?? null;
  const base = row.terminateKey || row.terminateLabel
    ? {
        code: Number(row.terminateCode) || 0,
        key: String(row.terminateKey || row.terminateLabel || ""),
        label: String(row.terminateLabel || row.terminateKey || ""),
        description: String(row.terminateDescription || resolveCause(raw).description),
        category: (row.terminateCategory || resolveCause(raw).category) as CauseCategory,
        severity: (row.terminateSeverity || resolveCause(raw).severity) as CauseSeverity,
      }
    : resolveCause(raw);
  return { ...base, meaning: row.terminateMeaning ?? null, action: row.terminateAction ?? null, raw };
}

export function catVar(category: CauseCategory | string | undefined): React.CSSProperties {
  const c = CATEGORY_META[(category as CauseCategory) || "other"] || CATEGORY_META.other;
  return { ["--cat" as any]: c.color };
}

/** Number tile + name. Hover shows the RFC wording and what it usually means. */
export function CauseBadge({ cause, compact, showCode = true, title }: {
  cause: Partial<CauseView> & { label: string };
  compact?: boolean;
  showCode?: boolean;
  title?: string;
}) {
  const tip = title ?? [
    cause.code ? `#${cause.code} ${cause.label}${cause.key && cause.key !== cause.label ? ` (${cause.key})` : ""}` : cause.label,
    cause.description,
    cause.meaning,
  ].filter(Boolean).join("\n");
  return (
    <span className={`${styles.mark}${compact ? " " + styles.compact : ""}`} style={catVar(cause.category)} title={tip}>
      {showCode && (
        <span className={`${styles.code}${cause.code ? "" : " " + styles.none}`} aria-hidden={!cause.code}>
          {cause.code ? cause.code : "•"}
        </span>
      )}
      <span className={styles.label}>{cause.label}</span>
    </span>
  );
}

export function SeverityTag({ severity }: { severity?: CauseSeverity | string | null }) {
  const s = SEVERITY_META[(severity as CauseSeverity) || "info"] || SEVERITY_META.info;
  return (
    <span className={styles.sev} title={s.about}
      style={{ ["--sev" as any]: s.color, ["--sev-ink" as any]: "var(--text)" }}>
      {s.label}
    </span>
  );
}
