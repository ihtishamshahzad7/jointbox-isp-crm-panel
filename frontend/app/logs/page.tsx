"use client";

import { useEffect, useState, useRef, useCallback, type KeyboardEvent } from "react";
import { BRAND } from "../../lib/brand";
import { useRouter } from "next/navigation";
import { silent } from "../components/silent";
import API from "../components/api";
import { LogRecordsTable } from "../components/log-records-table";
import { CauseBadge, SeverityTag, causeOf } from "./terminate-cause";
import DisconnectsPanel from "./disconnects-panel";
import { mustOk } from "../../lib/http";

// ── Helpers ──────────────────────────────────────────────────────

const timeAgo = (ts: string | Date) => {
  const sec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
};

const dateTime = (value: string | Date) => new Date(value).toLocaleString(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  second: "2-digit", timeZoneName: "short",
});

// ── The four primary Logs categories ────────────────────────────
export const LOG_VIEWS = [
  { id: "connections", label: "Connections", description: "Investigate connection events, network records, and failed activations." },
  { id: "sessions", label: "Sessions", description: "Review RADIUS accounting sessions and recorded disconnect causes." },
  { id: "authentication", label: "Login", description: "Review disconnect analysis, subscriber logins, and RADIUS diagnostics." },
  { id: "audit", label: "Audit Trail", description: "Review administrative activity and system events." },
];
const LOG_FEATURES: Record<string, Array<{ id: string; label: string }>> = {
  connections: [
    { id: "console", label: "Connection Events" },
    { id: "network", label: "NAS & Network" },
    { id: "failed", label: "Failed Connections" },
    { id: "nas", label: "Connection Diagnostics" },
  ],
  sessions: [
    { id: "live", label: "Active Sessions" },
    { id: "accounting", label: "Accounting Logs" },
    { id: "timeline", label: "Session History" },
    { id: "disconnects", label: "Disconnect Analysis" },
  ],
  authentication: [
    { id: "disconnects", label: "Disconnect Analysis" },
    { id: "subscriber", label: "Authentication" },
    { id: "health", label: "AAA / RADIUS Server" },
  ],
  audit: [
    { id: "activity", label: "User Activity" },
    { id: "changes", label: "CRUD & Record Changes" },
    { id: "security", label: "Security & Access" },
    { id: "system", label: "System & Configuration" },
  ],
};
const DEFAULT_LOG_FEATURES: Record<string, string> = {
  connections: "console",
  sessions: "live",
  authentication: "disconnects",
  audit: "activity",
};
const LEGACY_LOG_TABS: Record<string, string> = {
  console: "connections", network: "connections", failed: "connections",
  timeline: "connections", radsess: "sessions", disconnects: "sessions",
  authrec: "authentication", login: "audit", radius: "authentication",
  sessions: "sessions", actrec: "audit", activity: "audit", system: "audit",
};
const LEGACY_LOG_FEATURES: Record<string, string> = {
  console: "console", network: "network", failed: "failed",
  timeline: "timeline", radsess: "accounting", disconnects: "disconnects",
  authrec: "subscriber", login: "security", radius: "health",
  sessions: "live", actrec: "activity", activity: "activity", system: "system",
};

const resolveLogTab = (value: string | null) => {
  if (!value) return null;
  const tab = LEGACY_LOG_TABS[value] || value;
  return LOG_VIEWS.some((item) => item.id === tab) ? tab : null;
};

// ── Component ─────────────────────────────────────────────────────

/**
 * The page can be embedded in Insights or opened directly; both modes use the
 * same four-tab Logs navigation.
 */
export default function LogsPage({ embedded = false, view, onViewChange }: {
  embedded?: boolean; view?: string; onViewChange?: (id: string) => void;
} = {}) {
  const router = useRouter();
  const [darkMode] = useState(true);
  const [internalTab, setInternalTab] = useState("connections");
  const activeTab = embedded && view && onViewChange ? view : internalTab;
  const [featureByTab, setFeatureByTab] = useState(DEFAULT_LOG_FEATURES);
  const [auditEntity, setAuditEntity] = useState("");
  const [auditEntityId, setAuditEntityId] = useState("");
  const activeFeature = featureByTab[activeTab] || DEFAULT_LOG_FEATURES[activeTab] || "console";
  const activeFeatures = LOG_FEATURES[activeTab] || LOG_FEATURES.connections;
  const [authOutcome, setAuthOutcome] = useState("ALL");
  const setActiveTab = (id: string) => {
    if (id === "authentication") {
      setFeatureByTab((current) => ({ ...current, authentication: "disconnects" }));
      setRecordsSummary(null);
    }
    if (embedded && view && onViewChange) onViewChange(id);
    else {
      setInternalTab(id);
      if (!embedded && typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.set("logTab", id);
        window.history.pushState(null, "", url);
      }
    }
  };
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [showOverview, setShowOverview] = useState(false);

  // ── Data ───────────────────────────────────────────────────────
  const [timeline, setTimeline] = useState<any[]>([]);
  const [timelineLimit, setTimelineLimit] = useState(100);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState("");
  const timelineRequest = useRef(0);
  const [stats, setStats] = useState<any>(null);
  const [statsError, setStatsError] = useState("");
  const statsRequest = useRef(0);
  const [sessions, setSessions] = useState<any[]>([]);
  const [loadError, setLoadError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [diag, setDiag] = useState<any>(null);
  const [diagError, setDiagError] = useState("");
  const [diagBusy, setDiagBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [nasList, setNasList] = useState<any[]>([]);
  const [nasId, setNasId] = useState("");
  const [nasLogs, setNasLogs] = useState<any[]>([]);
  const [nasLogError, setNasLogError] = useState("");
  const [nasLogNote, setNasLogNote] = useState("");
  const [recordsSummary, setRecordsSummary] = useState<{ rows: any[]; total: number } | null>(null);

  // ── Filters ────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [filterSeverity, setFilterSeverity] = useState<string>("ALL");
  const [filterPeriod, setFilterPeriod] = useState("24h");
  const [filterOutcome, setFilterOutcome] = useState("ALL");
  const [focusUser, setFocusUser] = useState("");
  const [accounts, setAccounts] = useState<any[]>([]);
  const diagRequest = useRef(0);

  const setFeature = (id: string) => {
    setFeatureByTab((current) => ({ ...current, [activeTab]: id }));
    setRecordsSummary(null);
    if (activeTab === "connections") setFilterSeverity(id === "network" ? "ERROR" : "ALL");
    if (
      (activeTab === "connections" && (id === "failed" || id === "nas")) ||
      (activeTab === "sessions" && id === "disconnects") ||
      (activeTab === "authentication" && id === "disconnects") ||
      (activeTab === "audit" && id === "system")
    ) setFocusUser("");
  };
  const sinceHours = filterPeriod === "1h" ? 1
    : filterPeriod === "6h" ? 6
      : filterPeriod === "24h" ? 24
        : filterPeriod === "7d" ? 168
          : filterPeriod === "30d" ? 720
            : filterPeriod === "90d" ? 2160
              : undefined;
  const accountFilterAvailable =
    activeFeature !== "nas" &&
    !(activeTab === "connections" && activeFeature === "failed") &&
    !(activeTab === "sessions" && activeFeature === "disconnects") &&
    !(activeTab === "audit" && activeFeature === "system");
  const canShowAccountFilter = accounts.length > 0 && accountFilterAvailable;
  const onRecordsChange = useCallback((rows: any[], total: number) => {
    setRecordsSummary({ rows, total });
  }, []);
  useEffect(() => {
    setRecordsSummary(null);
  }, [activeTab, activeFeature, search, focusUser, filterPeriod, filterSeverity, filterOutcome]);

  // ── Auth ────────────────────────────────────────────────────────
  const token = typeof window !== 'undefined' ? localStorage.getItem("token") : "";
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── Theme ───────────────────────────────────────────────────────
  const d = darkMode;
  const t = {
    bg:          d ? "var(--bg)" : "#f0f4fa",
    card:        d ? "var(--surface)" : "#ffffff",
    cardBorder:  d ? "var(--border)" : "#e2e8f0",
    text:        d ? "var(--text)" : "#0f172a",
    textMuted:   d ? "var(--muted)" : "#64748b",
    textSub:     d ? "var(--muted)" : "#475569",
    input:       d ? "var(--bg)" : "#f8fafc",
    inputBorder: d ? "var(--border)" : "#cbd5e1",
    surface2:    d ? "var(--surface-2)" : "#f8fafc",
    accent:      "#0ea5e9",
    green:       "#22c55e",
    red:         "#ef4444",
    amber:       "#f59e0b",
    purple:      "#8b5cf6",
  };

  // ── Type config ─────────────────────────────────────────────────
  const typeConfig: Record<string, { icon: string; label: string; color: string; bg: string }> = {
    login:    { icon: "🔐", label: "Login",    color: "#3b82f6", bg: "#1e3a5f" },
    activity: { icon: "📝", label: "Activity", color: "#a855f7", bg: "#3b0764" },
    network:  { icon: "🖧",  label: "Network",  color: "#10b981", bg: "#064e3b" },
    system:   { icon: "⚙️", label: "System",   color: "#f59e0b", bg: "#422006" },
  };

  const severityColor = (sev: string) => {
    switch (sev?.toUpperCase()) {
      case "ERROR": return { dot: "#ef4444", bg: "rgba(239,68,68,.15)", text: "#f87171" };
      case "WARN": case "WARNING": return { dot: "#f59e0b", bg: "rgba(245,158,11,.15)", text: "#fbbf24" };
      default: return { dot: "#22c55e", bg: "rgba(34,197,94,.1)", text: "#4ade80" };
    }
  };

  // ── Data fetching ──────────────────────────────────────────────

  const fetchTimeline = useCallback(async (signal?: AbortSignal) => {
    if (!token) return;
    const requestId = ++timelineRequest.current;
    setTimelineLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(timelineLimit));
      params.set("type", "network");
      if (focusUser) params.set("forUser", focusUser);
      if (filterSeverity !== "ALL") params.set("severity", filterSeverity);
      if (sinceHours) params.set("sinceHours", String(sinceHours));
      const res = await fetch(`${API}/logs/timeline?${params}`, { headers, signal });
      if (!res.ok) throw new Error(`Unable to load connection events (HTTP ${res.status}).`);
      const events = await res.json();
      if (!Array.isArray(events)) throw new Error("The connection event response was invalid.");
      if (signal?.aborted || requestId !== timelineRequest.current) return;
      setTimeline(events);
      setTimelineError("");
    } catch (e) {
      if (signal?.aborted || requestId !== timelineRequest.current) return;
      setTimelineError(e instanceof Error ? e.message : "Unable to load connection events.");
    } finally {
      if (!signal?.aborted && requestId === timelineRequest.current) setTimelineLoading(false);
    }
  }, [token, timelineLimit, focusUser, filterSeverity, sinceHours]);

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    if (!token) return;
    const requestId = ++statsRequest.current;
    try {
      if (!sinceHours) return;
      const h = sinceHours;
      const res = await fetch(`${API}/logs/stats?hours=${h}`, { headers, signal });
      if (!res.ok) throw new Error(`Unable to load summary metrics (HTTP ${res.status}).`);
      const result = await res.json();
      if (signal?.aborted || requestId !== statsRequest.current) return;
      setStats(result);
      setStatsError("");
    } catch (e) {
      if (signal?.aborted || requestId !== statsRequest.current) return;
      setStatsError(e instanceof Error ? e.message : "Unable to load summary metrics.");
    }
  }, [token, sinceHours]);

  const fetchTabData = useCallback(async (signal: AbortSignal) => {
    if (!token) return;
    if (activeTab !== "sessions" || activeFeature !== "timeline") {
      setLoading(false);
      setLoadError("");
      return;
    }
    setLoading(true);
    setLoadError("");
    setSessions([]);
    try {
      const params = new URLSearchParams();
      if (focusUser) params.set("forUser", focusUser);
      const response = await fetch(`${API}/logs/sessions?${params}`, { headers, signal });
      if (!response.ok) throw new Error(`Unable to load panel sessions (HTTP ${response.status}).`);
      const records = await response.json();
      if (!Array.isArray(records)) throw new Error("The panel session response was invalid.");
      if (!signal.aborted) setSessions(records);
    } catch (e) {
      if (signal.aborted) return;
      setLoadError(e instanceof Error ? e.message : "Unable to load panel sessions.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [activeTab, activeFeature, token, focusUser]);

  // Preserve old log-view bookmarks by redirecting their view id to a category.
  useEffect(() => {
    const applyLocation = () => {
      try {
        const q = new URLSearchParams(window.location.search);
        const searchTerm = q.get("search") || q.get("username");
        if (searchTerm) setSearch(searchTerm);
        setAuditEntity(q.get("entity") || "");
        setAuditEntityId(q.get("entityId") || "");
        if (!embedded) {
          const legacyKey = q.get("logTab") || q.get("tab") || "";
          const destination = resolveLogTab(legacyKey);
          if (destination) {
            setInternalTab(destination);
            const requestedFeature = q.get("logFeature") || LEGACY_LOG_FEATURES[legacyKey];
            const supported = LOG_FEATURES[destination]?.some((feature) => feature.id === requestedFeature);
            if (requestedFeature && supported) {
              setFeatureByTab((current) => ({ ...current, [destination]: requestedFeature }));
            }
          }
        }
      } catch { /* no query */ }
    };

    const handlePopState = () => {
      if (embedded) return;
      const params = new URLSearchParams(window.location.search);
      const legacyKey = params.get("logTab") || params.get("tab") || "";
      const destination = resolveLogTab(legacyKey);
      setInternalTab(destination || "connections");
      setAuditEntity(params.get("entity") || "");
      setAuditEntityId(params.get("entityId") || "");
      const requestedFeature = params.get("logFeature") || LEGACY_LOG_FEATURES[legacyKey];
      if (destination && requestedFeature && LOG_FEATURES[destination]?.some((feature) => feature.id === requestedFeature)) {
        setFeatureByTab((current) => ({ ...current, [destination]: requestedFeature }));
      }
    };
    applyLocation();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Load shared account options once; records themselves are loaded by the
  // selected tab so another category cannot replace its results.
  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    fetch(`${API}/profile`, { headers })
      .then(res => { if (res.status === 401) { localStorage.removeItem("token"); router.push("/login"); } })
      .catch(silent("profileFetch"));

    fetch(`${API}/users`, { headers })
      .then(r => r.ok ? r.json() : [])
      .then(rows => setAccounts(Array.isArray(rows) ? rows : rows?.data ?? []))
      .catch(silent("usersFetch"));
  }, []);

  useEffect(() => {
    if (activeTab !== "connections" || activeFeature !== "nas" || !token) return;
    const controller = new AbortController();
    setNasList([]);
    setNasLogError("");
    fetch(`${API}/nas`, { headers, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Unable to load authorized NAS devices (HTTP ${response.status}).`);
        return response.json();
      })
      .then((response) => {
        if (controller.signal.aborted) return;
        const rows = Array.isArray(response) ? response : response?.data ?? [];
        if (!Array.isArray(rows)) throw new Error("The NAS list response was invalid.");
        const safeNas = rows.map((row: any) => ({
          id: String(row.id),
          name: row.shortname || row.nasname || `NAS ${row.id}`,
          ip: row.nasIp || row.nasname || "",
        }));
        setNasList(safeNas);
        setNasId((current) => safeNas.some((nas: any) => nas.id === current) ? current : safeNas[0]?.id || "");
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setNasLogError(error instanceof Error ? error.message : "Unable to load authorized NAS devices.");
        }
      });
    return () => controller.abort();
  }, [activeTab, activeFeature, token, refreshKey]);

  useEffect(() => {
    if (activeTab !== "connections" || activeFeature !== "nas" || !token || !nasId) {
      setNasLogs([]);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ nasId, limit: "120" });
    setNasLogs([]);
    setNasLogError("");
    setNasLogNote("");
    fetch(`${API}/logs/router?${params}`, { headers, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Unable to load NAS console records (HTTP ${response.status}).`);
        return response.json();
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        const rows = Array.isArray(result) ? result : result?.lines ?? result?.logs ?? [];
        if (!Array.isArray(rows)) throw new Error("The NAS log response was invalid.");
        setNasLogs(rows);
        setNasLogNote(result?.note || "");
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setNasLogError(error instanceof Error ? error.message : "Unable to load NAS console records.");
        }
      });
    return () => controller.abort();
  }, [activeTab, activeFeature, token, nasId, refreshKey]);

  // Each selection owns its request lifecycle. Abort on tab/filter changes so
  // late responses from the previous view cannot overwrite the current view.
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    void fetchTabData(controller.signal);
    if (activeTab === "connections" && activeFeature === "console") {
      if (!focusUser && sinceHours) void fetchStats(controller.signal);
      else {
        setStats(null);
        setStatsError("");
      }
    } else setStatsError("");
    return () => controller.abort();
  }, [activeTab, activeFeature, token, fetchTabData, fetchStats, focusUser, sinceHours, refreshKey]);

  // Keep the live connection console fresh without mounting other log views.
  useEffect(() => {
    if (activeTab !== "connections" || activeFeature !== "console" || !token || focusUser || !sinceHours) return;
    const iv = setInterval(() => setRefreshKey((key) => key + 1), 15_000);
    return () => clearInterval(iv);
  }, [activeTab, activeFeature, token, focusUser, sinceHours]);

  // RADIUS diag
  const loadDiag = useCallback((signal?: AbortSignal) => {
    if (!token) return;
    const requestId = ++diagRequest.current;
    setDiagBusy(true);
    setDiagError("");
    fetch(`${API}/logs/radius/diagnostics`, { headers, signal })
      .then(r => {
        if (!r.ok) throw new Error(`Unable to load RADIUS diagnostics (HTTP ${r.status}).`);
        return r.json();
      })
      .then((result) => {
        if (!signal?.aborted && requestId === diagRequest.current) setDiag(result);
      })
      .catch(e => {
        if (!signal?.aborted && requestId === diagRequest.current) {
          setDiagError(e instanceof Error ? e.message : "Unable to load RADIUS diagnostics.");
        }
      })
      .finally(() => {
        if (!signal?.aborted && requestId === diagRequest.current) setDiagBusy(false);
      });
  }, [token]);

  useEffect(() => {
    if (activeTab !== "authentication" || activeFeature !== "health" || !token || focusUser) return;
    const controller = new AbortController();
    loadDiag(controller.signal);
    const iv = setInterval(() => loadDiag(controller.signal), 30_000);
    return () => { clearInterval(iv); controller.abort(); };
  }, [activeTab, activeFeature, token, focusUser, loadDiag]);

  const refreshAll = () => {
    setRefreshKey((key) => key + 1);
    if (activeTab === "authentication" && activeFeature === "health" && !focusUser) loadDiag();
  };

  // ── Filter helpers ─────────────────────────────────────────────

  const filterData = (data: any[], fields: string[]) => {
    if (!search) return data;
    const q = search.toLowerCase();
    return data.filter(item => fields.some((field) => {
      const value = field.split(".").reduce((current: any, key) => current?.[key], item);
      return String(value ?? "").toLowerCase().includes(q);
    }));
  };

  const filteredSessions = filterData(sessions, ["user.name", "user.email", "ipAddress", "userAgent"]).filter((session) => {
    const timestamp = new Date(session.loginAt || session.createdAt || 0).getTime();
    return !sinceHours || timestamp === 0 || timestamp >= Date.now() - sinceHours * 3600_000;
  });
  const filteredNasLogs = nasLogs.filter((entry: any) => {
    const timestamp = new Date(entry.loggedAt || entry.time || entry.date || 0).getTime();
    if (sinceHours && timestamp > 0 && timestamp < Date.now() - sinceHours * 3600_000) return false;
    if (!search) return true;
    const query = search.toLowerCase();
    return [entry.message, entry.msg, entry.topics, entry.severity, entry.time, entry.loggedAt]
      .some((value) => String(value ?? "").toLowerCase().includes(query));
  });

  const filteredTimeline = timeline.filter(e => {
    if (e._type !== "network") return false;
    if (filterSeverity !== "ALL" && e.severity?.toUpperCase() !== filterSeverity) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    const fields = [e.user, e.email, e.ipAddress, e.message, e.details, e.action, e.username, e.nasName, e.source];
    return fields.some(f => f && String(f).toLowerCase().includes(q));
  });

  // ── Heatmap data (from stats.hourly) ───────────────────────────

  const heatmapData = stats?.hourly || [];
  const maxHeat = Math.max(1, ...heatmapData.map((h: any) => h.count));
  const heatIntensity = (count: number) => {
    if (count === 0) return "transparent";
    const pct = count / maxHeat;
    if (pct < 0.25) return d ? "rgba(14,165,233,.25)" : "rgba(14,165,233,.2)";
    if (pct < 0.5) return d ? "rgba(14,165,233,.45)" : "rgba(14,165,233,.4)";
    if (pct < 0.75) return d ? "rgba(14,165,233,.65)" : "rgba(14,165,233,.6)";
    return d ? "rgba(14,165,233,.9)" : "rgba(14,165,233,.85)";
  };

  // ── Badge component ────────────────────────────────────────────

  const Badge = ({ children, color, bg }: any) => (
    <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, color, background: bg, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );

  // ── Tabs ───────────────────────────────────────────────────────

  const tabs = LOG_VIEWS;
  const activeTabIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTab));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index + tabs.length - 1) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setActiveTab(nextTab.id);
    tabRefs.current[nextIndex]?.focus();
  };

  const pageRows = recordsSummary?.rows ?? [];
  const pageMetric = activeTab === "connections"
    ? { label: "Errors on this page", value: pageRows.filter((row) => row.severity?.toUpperCase() === "ERROR").length }
    : activeTab === "sessions"
      ? { label: "Active on this page", value: pageRows.filter((row) => row.sessionState === "active").length }
      : activeTab === "authentication"
        ? { label: "Rejects on this page", value: pageRows.filter((row) => row.result === "Reject" || /reject/i.test(row.status || "")).length }
        : activeFeature === "system"
          ? { label: "Errors on this page", value: pageRows.filter((row) => row.level?.toUpperCase() === "ERROR").length }
          : { label: "Actor-attributed on this page", value: pageRows.filter((row) => row.user != null).length };

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", minHeight: embedded ? "auto" : "100vh", background: embedded ? "transparent" : t.bg, color: t.text, fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <div className="logs-content" style={{ flex: 1, padding: embedded ? 0 : "16px 20px", overflowY: embedded ? "visible" : "auto" }}>

          {/* Layout styles: left vertical view sidebar + content. */}
          <style>{`
            .logs-content{display:flex;flex-direction:column;gap:12px;min-width:0}
            .logs-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-items:start}
            .logs-layout.embedded{grid-template-columns:1fr}
            .logs-main{min-width:0}
            .logs-side{display:flex;gap:5px;overflow-x:auto;overscroll-behavior-x:contain;width:100%;
              background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:6px;
              box-shadow:0 1px 2px rgba(0,0,0,.05);scrollbar-width:thin}
            .logs-side-tab{flex:1 1 0;min-width:max-content;border:none;background:transparent;padding:10px 14px;border-radius:9px;
              font-size:13px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit;
              text-align:center;white-space:nowrap;
              transition:background .12s,color .12s}
            .logs-side-tab:hover{color:var(--text);background:var(--surface-2)}
            .logs-side-tab.on{background:var(--accent);color:#fff;
              box-shadow:0 2px 8px color-mix(in srgb,var(--accent) 40%,transparent)}
            .logs-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
            .logs-heading h1{display:flex;align-items:center;gap:9px;font-size:22px;line-height:1.2;margin:0;font-weight:750}
            .logs-heading p{font-size:13px;color:var(--muted);margin:5px 0 0}
            .logs-tab-description{font-size:12px;color:var(--muted);margin:0 0 10px}
            .logs-toolbar{padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:12px}
            .logs-toolbar-main{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
            .logs-toolbar-main select{height:36px;max-width:220px;padding:0 10px;border:1px solid var(--border);
              border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-size:12px}
            .logs-search{display:flex;align-items:center;gap:8px;flex:1 1 250px;min-width:160px;height:36px;
              padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--muted)}
            .logs-search:focus-within{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent)}
            .logs-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--text);font:inherit;font-size:12px}
            .logs-toolbar-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;
              padding:0 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);
              color:var(--text);font:inherit;font-size:12px;font-weight:650;cursor:pointer;white-space:nowrap}
            .logs-toolbar-button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
            .logs-toolbar-button:disabled{opacity:.55;cursor:wait}
            .logs-overview{margin-top:-2px}
            .logs-summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin:0 0 12px}
            .logs-summary-card{display:flex;flex-direction:column;gap:5px;min-width:0;padding:10px 12px;
              border:1px solid var(--border);border-radius:10px;background:var(--surface)}
            .logs-summary-card span{overflow:hidden;color:var(--muted);font-size:10px;font-weight:700;
              letter-spacing:.045em;text-overflow:ellipsis;text-transform:uppercase;white-space:nowrap}
            .logs-summary-card strong{font-size:20px;line-height:1.1;font-weight:800}
            @media (max-width:640px){
              .logs-side{border-radius:11px}
              .logs-side-tab{flex:0 0 auto;padding:9px 10px;font-size:12px}
              .logs-heading h1{font-size:20px}
              .logs-heading p{font-size:12px}
              .logs-toolbar{padding:8px}
              .logs-toolbar-main select{flex:1 1 135px;max-width:none;min-width:0}
              .logs-search{flex:1 1 100%;min-width:0}
              .logs-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
            }
          `}</style>

          {/* ═══════════════ FILTER BAR ═══════════════ */}
          <header className="logs-heading">
            <div>
              <h1><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg> Logs</h1>
              <p>Investigate connections, sessions, authentication, and system changes.</p>
            </div>
          </header>
          <nav className="logs-side" role="tablist" aria-label="Log views">
            {tabs.map((tab, index) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`logs-tab-${tab.id}`}
                aria-controls="logs-tabpanel"
                aria-selected={activeTab === tab.id}
                tabIndex={activeTab === tab.id ? 0 : -1}
                className={`logs-side-tab${activeTab === tab.id ? " on" : ""}`}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                ref={(element) => { tabRefs.current[index] = element; }}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <div className="logs-toolbar">
            <div className="logs-toolbar-main">
              <label className="logs-search">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
                <input
                  aria-label="Search logs"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search subscriber, IP, NAS, event, or actor"
                />
              </label>
              <select aria-label="Event group" value={activeFeature} onChange={(event) => setFeature(event.target.value)}>
                {activeFeatures.map((feature) => <option key={feature.id} value={feature.id}>{feature.label}</option>)}
              </select>
              <select aria-label="Time range" value={filterPeriod} onChange={(event) => setFilterPeriod(event.target.value)}>
                <option value="1h">Last hour</option>
                <option value="6h">Last 6 hours</option>
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
              </select>
              {canShowAccountFilter && (
                <select aria-label="Account" value={focusUser} onChange={(event) => setFocusUser(event.target.value)}>
                  <option value="">All authorized accounts</option>
                  {accounts.map((account: any) => <option key={account.id} value={account.id}>{account.name} · {account.role}</option>)}
                </select>
              )}
              {activeTab === "connections" && activeFeature === "nas" && (
                <select aria-label="NAS device" value={nasId} onChange={(event) => setNasId(event.target.value)}>
                  <option value="">Select a NAS</option>
                  {nasList.map((nas) => <option key={nas.id} value={nas.id}>{nas.name}{nas.ip ? ` · ${nas.ip}` : ""}</option>)}
                </select>
              )}
              {activeTab === "connections" && (activeFeature === "console" || activeFeature === "network") && (
                <button type="button" className="logs-toolbar-button" onClick={() => setShowFilters((value) => !value)}
                  aria-expanded={showFilters}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 6v0M15 12v0M11 18v0" /></svg> Filters
                </button>
              )}
              {activeTab === "authentication" && activeFeature === "health" && !focusUser && (
                <select aria-label="RADIUS outcome" value={authOutcome} onChange={(event) => setAuthOutcome(event.target.value)}>
                  <option value="ALL">All outcomes</option>
                  <option value="ACCEPT">Accept</option>
                  <option value="REJECT">Reject</option>
                  <option value="CHALLENGE">Challenge</option>
                  <option value="UNKNOWN">Other / unknown</option>
                </select>
              )}
              {activeTab === "connections" && activeFeature === "console" && !focusUser && !search && filterSeverity === "ALL" && sinceHours && (
                <button type="button" className="logs-toolbar-button" onClick={() => setShowOverview((value) => !value)}
                  aria-expanded={showOverview}>
                  {showOverview ? "Hide overview" : "Overview"}
                </button>
              )}
              <button type="button" className="logs-toolbar-button" onClick={refreshAll} disabled={loading}>
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {loadError && (
              <div role="alert" style={{ margin: "0 0 14px", padding: "10px 12px", border: "1px solid #ef4444",
                borderRadius: 8, color: "#ef4444", fontSize: 12 }}>
                {loadError}
              </div>
            )}

            {/* Collapsible advanced filters */}
            {activeTab === "connections" && showFilters && (activeFeature === "console" || activeFeature === "network") && (
              <div style={{ marginTop: 10, padding: 12, background: t.card, borderRadius: 10, border: `1px solid ${t.cardBorder}`, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                {/* Severity filter */}
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: t.textSub }}>Severity:</span>
                  {["ALL", "INFO", "WARN", "ERROR"].map(s => (
                    <button key={s} onClick={() => setFilterSeverity(s)}
                      style={{ padding: "3px 10px", borderRadius: 6, cursor: "pointer", fontSize: 10, fontWeight: 600,
                        background: filterSeverity === s ? (s === "ERROR" ? t.red : s === "WARN" ? t.amber : t.accent) : "transparent",
                        color: filterSeverity === s ? "#fff" : t.textSub, border: filterSeverity === s ? "none" : `1px solid ${t.cardBorder}` }}>
                      {s === "ALL" ? "All" : s}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className={`logs-layout${embedded ? " embedded" : ""}`}>
            <div
              className="logs-main"
              id="logs-tabpanel"
              role="tabpanel"
              aria-labelledby={`logs-tab-${tabs[activeTabIndex].id}`}
              tabIndex={0}
            >
          <p className="logs-tab-description">{tabs.find((tab) => tab.id === activeTab)?.description}</p>
          {recordsSummary && (
            <div className="logs-summary-grid" aria-label="Selected view summary">
              <div className="logs-summary-card">
                <span>Matching records</span>
                <strong>{recordsSummary.total.toLocaleString()}</strong>
              </div>
              <div className="logs-summary-card">
                <span>{pageMetric.label}</span>
                <strong>{pageMetric.value.toLocaleString()}</strong>
              </div>
              <div className="logs-summary-card">
                <span>Rows on this page</span>
                <strong>{recordsSummary.rows.length.toLocaleString()}</strong>
              </div>
            </div>
          )}
          {activeTab === "sessions" && activeFeature === "timeline" && (
            <div className="logs-summary-grid" aria-label="Panel session summary">
              <div className="logs-summary-card"><span>Active panel sessions</span><strong>{filteredSessions.length}</strong></div>
              <div className="logs-summary-card"><span>Accounts in view</span><strong>{new Set(filteredSessions.map((session: any) => session.user?.id).filter(Boolean)).size}</strong></div>
            </div>
          )}
          {activeTab === "connections" && activeFeature === "nas" && nasId && (
            <div className="logs-summary-grid" aria-label="NAS log summary">
              <div className="logs-summary-card"><span>Matching router entries</span><strong>{filteredNasLogs.length}</strong></div>
              <div className="logs-summary-card"><span>Entries returned</span><strong>{nasLogs.length}</strong></div>
            </div>
          )}
          {activeTab === "connections" && activeFeature === "console" && showOverview && !focusUser && !search && filterSeverity === "ALL" && sinceHours && (
            <section className="logs-overview" aria-label="Overall logs overview">
              <div className="logs-summary-grid">
                {[
                  { label: `All log events · ${filterPeriod}`, value: stats ? stats.totals.login + stats.totals.activity + stats.totals.network + stats.totals.system : "—", color: t.accent },
                  { label: "Failed sign-ins", value: stats?.errors?.failedLogins ?? "—", color: t.red },
                  { label: "Network errors", value: stats?.errors?.networkErrors ?? "—", color: t.amber },
                  { label: "Active panel sessions", value: stats?.activeSessions ?? "—", color: t.green },
                ].map((card) => (
                  <div key={card.label} className="logs-summary-card">
                    <span>{card.label}</span>
                    <strong style={{ color: card.color }}>{card.value}</strong>
                  </div>
                ))}
              </div>
              {statsError && <p role="alert" style={{ color: t.red, fontSize: 12, margin: "8px 0 0" }}>{statsError}</p>}
            </section>
          )}
            {activeTab === "connections" && activeFeature === "console" && (
              <>
                <h2 style={{ fontSize: 15, margin: "0 0 9px" }}>Connection events</h2>
                <LogRecordsTable
                  endpoint="/logs/network"
                  detailPanel
                  searchable={false}
                  hideToolbar
                  pageSize={25}
                  refreshKey={refreshKey}
                  searchText={search}
                  onSearchTextChange={setSearch}
                  queryParams={{ sinceHours: sinceHours ? String(sinceHours) : "", forUser: focusUser, severity: filterSeverity }}
                  onRecordsChange={onRecordsChange}
                  columns={[
                    { key: "loggedAt", label: "Timestamp", nowrap: true, primary: true, render: (r) => r.loggedAt ? dateTime(r.loggedAt) : "—" },
                    { key: "username", label: "Subscriber", nowrap: true, primary: true, render: (r) => r.subscriber?.fullName || r.username || "—" },
                    { key: "eventType", label: "Event", nowrap: true, primary: true },
                    { key: "severity", label: "Result", nowrap: true, primary: true },
                    { key: "eventReason", label: "Recorded failure reason", wide: true },
                    { key: "nasName", label: "NAS", render: (r) => r.nas?.nasname || "—" },
                    { key: "nasIp", label: "NAS IP", mono: true, render: (r) => r.nas?.nasIp || r.nasIp || "—" },
                    { key: "framedIp", label: "Subscriber IP", mono: true },
                    { key: "callerId", label: "Calling-Station-Id", mono: true },
                    { key: "sessionId", label: "Session ID", mono: true },
                    { key: "message", label: "Message", wide: true },
                  ]}
                />
              </>
            )}

          {/* ═══════════════ SELECTED TAB WORKSPACE ═══════════════ */}

          {/* ═══════════════ LOADING ═══════════════ */}
          {loading && activeTab !== "connections" && activeTab !== "audit" && activeTab !== "authentication" && (
            <div style={{ textAlign: "center", padding: 40, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ width: 30, height: 30, border: `3px solid ${t.cardBorder}`, borderTopColor: t.accent, borderRadius: "50%", animation: "spin .8s linear infinite", margin: "0 auto 12px" }}></div>
              <p style={{ color: t.textMuted, fontSize: 12 }}>Loading...</p>
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
          )}

          {/* ═══════════════ TAB: ACTIVITY LOGS (paginated) ═══════════════ */}
          {activeTab === "audit" && (activeFeature === "activity" || activeFeature === "changes") && (
            <>
            <h2 style={{ fontSize: 15, margin: "0 0 9px" }}>{activeFeature === "changes" ? "Administrative changes" : "User activity"}</h2>
            <LogRecordsTable
              endpoint="/logs/activity"
              detailPanel
              searchable={false}
              hideToolbar
              refreshKey={refreshKey}
              searchText={search}
              onSearchTextChange={setSearch}
              queryParams={{
                sinceHours: sinceHours ? String(sinceHours) : "",
                forUser: focusUser,
                auditType: activeFeature,
                entity: activeTab === "audit" ? auditEntity : "",
                entityId: activeTab === "audit" ? auditEntityId : "",
              }}
              onRecordsChange={onRecordsChange}
              columns={[
                { key: "id", label: "ID", nowrap: true, primary: true },
                { key: "type", label: "Log Type", nowrap: true, primary: true, render: (r) => <b>{r.action}{r.entity ? ` · ${r.entity}` : ""}</b> },
                { key: "subject", label: "Subject", nowrap: true, primary: true, render: (r) => r.entityId ? `${r.entity || ""} #${r.entityId}` : "—" },
                { key: "createdAt", label: "Datetime", nowrap: true, primary: true, render: (r) => r.createdAt ? dateTime(r.createdAt) : "—" },
                // Expanded detail — the long raw payload is here, not in the row.
                { key: "details", label: "Description / Raw", mono: true, wide: true, render: (r) => r.details || r.action || "—" },
                { key: "causer", label: "Causer", render: (r) => r.user ? `${r.user.name} (${r.user.role || "Staff"})` : "System" },
                { key: "ipAddress", label: "IP Address", mono: true },
                { key: "traceId", label: "Request / correlation ID", mono: true },
              ]}
            />
            </>
          )}

          {/* ═══════════════ TAB: LOGIN LOGS — RADIUS auth (paginated) ═══════════════ */}
          {activeTab === "authentication" && (activeFeature === "subscriber" || activeFeature === "health") && (
            <>
            <h2 style={{ fontSize: 15, margin: "0 0 9px" }}>Subscriber RADIUS authentication</h2>
            <LogRecordsTable
              endpoint="/logs/radius-auth"
              detailPanel
              searchable={false}
              hideToolbar
              refreshKey={refreshKey}
              searchText={search}
              onSearchTextChange={setSearch}
              queryParams={{
                sinceHours: sinceHours ? String(sinceHours) : "",
                forUser: focusUser,
                outcome: activeFeature === "health" && authOutcome !== "ALL" ? authOutcome : "",
              }}
              onRecordsChange={onRecordsChange}
              columns={[
                { key: "id", label: "Record ID", nowrap: true, mono: true, primary: true },
                { key: "authdate", label: "Datetime", nowrap: true, primary: true, render: (r) => r.authdate ? dateTime(r.authdate) : "—" },
                { key: "username", label: "Username", nowrap: true, primary: true, render: (r) => <b>{r.username}</b> },
                { key: "result", label: "Result", nowrap: true, primary: true, render: (r) => {
                    const colors: Record<string, string> = { Accept: "#4caf50", Reject: "#f44336", Challenge: "#d97706", Unknown: "#64748b" };
                    return <span style={{ color: colors[r.result] || colors.Unknown, fontWeight: 700 }}>{r.result || "Unknown"}</span>;
                  } },
                { key: "reason", label: "Recorded RADIUS response", render: (r) => <span style={{ color: r.result === "Accept" ? "#16a34a" : r.result === "Reject" ? "#dc2626" : "#d97706" }}>{r.reason || "Not recorded"}</span> },
                { key: "subscriberId", label: "Subscriber ID", render: (r) => r.subscriberId ?? "Not recorded" },
                { key: "mac", label: "Calling-Station-Id", mono: true, render: (r) => r.mac || "Not recorded" },
                { key: "port", label: "Port", render: (r) => r.port || "—" },
                { key: "nas", label: "NAS", render: (r) => r.nas || "—" },
                { key: "nasip", label: "NAS IP", mono: true, render: (r) => r.nasip || "Not recorded" },
              ]}
            />
            </>
          )}

          {/* Retained only for legacy state recovery; it is not a primary view. */}
          {activeTab === "connections" && activeFeature === "legacy-timeline" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <h2 style={{ fontSize: 15, margin: "0 0 -3px" }}>Connection events</h2>

              {/* Heatmap */}
              {heatmapData.length > 0 && (
                <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
                    <span>📊 Activity Intensity (last {filterPeriod})</span>
                    <span style={{ fontSize: 10, color: t.textSub }}>{heatmapData.length} buckets · max {maxHeat}</span>
                  </div>
                  <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
                    {heatmapData.map((h: any, i: number) => (
                      <div key={i} title={`${h.hour}: ${h.count} events`}
                        style={{ width: 16, height: 16, borderRadius: 3, background: heatIntensity(h.count), border: `1px solid ${t.cardBorder}` }} />
                    ))}
                  </div>
                </div>
              )}

              {/* Live status indicator */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                <span style={{ fontSize: 11, color: t.textMuted }}>Auto-refresh every 15 seconds</span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: t.textMuted }}>{timeline.length} events</span>
              </div>
              {timelineError && <p role="alert" style={{ margin: 0, color: "#ef4444", fontSize: 12 }}>{timelineError}</p>}

              {/* Timeline entries */}
              {timelineError ? null : timelineLoading && timeline.length === 0 ? (
                <div role="status" style={{ textAlign: "center", padding: 30, color: t.textMuted, fontSize: 12, background: t.card, borderRadius: 10, border: `1px solid ${t.cardBorder}` }}>
                  Loading connection events…
                </div>
              ) : filteredTimeline.length === 0 ? (
                <div style={{ textAlign: "center", padding: 30, color: t.textMuted, fontSize: 12, background: t.card, borderRadius: 10, border: `1px solid ${t.cardBorder}` }}>
                  No events match your filters.
                </div>
              ) : filteredTimeline.map((entry: any) => {
                const sev = severityColor(entry.severity);
                const tc = typeConfig[entry._type] || typeConfig.activity;
                const isExpanded = expandedId === entry.id;

                return (
                  <div key={entry.id} style={{ background: t.card, border: `1px solid ${isExpanded ? t.accent : t.cardBorder}`,
                    borderRadius: 10, overflow: "hidden", cursor: "pointer", transition: "border-color .15s" }}
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}>

                    {/* Compact row */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px" }}>
                      {/* Severity dot + connector line */}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0, flexShrink: 0 }}>
                        <div style={{ width: 10, height: 10, borderRadius: "50%", background: sev.dot, border: `2px solid ${t.card}` }} />
                      </div>

                      {/* Type icon */}
                      <div style={{ width: 28, height: 28, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
                        background: tc.bg, fontSize: 14, flexShrink: 0 }}>{tc.icon}</div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          <span style={{ fontSize: 12, fontWeight: 700 }}>{entry.user || entry.username || entry.email || entry.source || "System"}</span>
                          <Badge color={tc.color} bg={tc.bg}>{tc.label}</Badge>
                          {(entry.status || entry.severity) && (
                            <Badge color={sev.text} bg={sev.bg}>{entry.status || entry.severity}</Badge>
                          )}
                        </div>
                        <div style={{ fontSize: 11.5, color: t.textSub, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {entry.details || entry.message || entry.action || `${entry.email || ""} · ${entry.ipAddress || ""}`}
                        </div>
                      </div>

                      {/* Time */}
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: t.text }} title={dateTime(entry.ts)}>
                          {timeAgo(entry.ts)}
                        </div>
                      </div>

                      {/* Expand indicator */}
                      <span style={{ color: t.textMuted, fontSize: 10, transition: "transform .15s", transform: isExpanded ? "rotate(180deg)" : "" }}>▼</span>
                    </div>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div style={{ padding: "12px 14px", borderTop: `1px solid ${t.cardBorder}`, background: d ? "var(--surface-2)" : "#f8fafc", fontSize: 12 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px" }}>
                          <Detail label="Time" val={dateTime(entry.ts)} />
                          <Detail label="Type" val={`${tc.icon} ${tc.label}`} />
                          <Detail label="Severity" val={entry.severity} />
                          {entry.user && <Detail label="User" val={entry.user} />}
                          {entry.email && <Detail label="Email" val={entry.email} />}
                          {entry.ipAddress && <Detail label="Source IP" val={entry.ipAddress} />}
                          {entry.action && <Detail label="Action" val={entry.action} />}
                          {entry.details && <Detail label="Details" val={entry.details} />}
                          {entry.message && <Detail label="Message" val={entry.message} />}
                          {entry.username && <Detail label="Username" val={entry.username} />}
                          {entry.subscriberId && <Detail label="Subscriber ID" val={entry.subscriberId} />}
                          {(entry.nasName || entry.nasIp) && <Detail label="NAS" val={`${entry.nasName || "Not recorded"} (${entry.nasIp || "NAS IP not recorded"})`} />}
                          {entry.framedIp && <Detail label="Subscriber IP" val={entry.framedIp} />}
                          {entry.callerId && <Detail label="Calling-Station-Id" val={entry.callerId} />}
                          {entry.sessionId && <Detail label="Acct-Session-Id" val={entry.sessionId} />}
                          {entry.source && <Detail label="Source" val={entry.source} />}
                          {entry.failReason && <Detail label="Fail Reason" val={entry.failReason} />}
                          {entry.userAgent && <Detail label="User Agent" val={entry.userAgent} />}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Load more */}
              <button onClick={() => setTimelineLimit(p => p + 100)}
                style={{ padding: "10px", borderRadius: 8, border: `1px dashed ${t.cardBorder}`, background: "transparent",
                  color: t.accent, cursor: "pointer", fontSize: 12, fontWeight: 600, textAlign: "center" }}>
                Load more +100
              </button>
            </div>
          )}

          {activeTab === "connections" && activeFeature === "network" && (
            <>
              <h2 style={{ fontSize: 15, margin: "0 0 9px" }}>Network diagnostics</h2>
              <LogRecordsTable
                endpoint="/logs/network"
                detailPanel
                searchable={false}
                hideToolbar
                refreshKey={refreshKey}
                searchText={search}
                onSearchTextChange={setSearch}
                queryParams={{
                  sinceHours: sinceHours ? String(sinceHours) : "",
                  forUser: focusUser,
                  severity: filterSeverity,
                }}
                onRecordsChange={onRecordsChange}
                columns={[
                  { key: "loggedAt", label: "Timestamp", nowrap: true, primary: true, render: (r) => r.loggedAt ? dateTime(r.loggedAt) : "—" },
                  { key: "username", label: "Subscriber", nowrap: true, primary: true, render: (r) => r.subscriber?.fullName || r.username || "—" },
                  { key: "eventType", label: "Event", nowrap: true, primary: true },
                  { key: "severity", label: "Result", nowrap: true, primary: true },
                  { key: "eventReason", label: "Recorded failure reason", wide: true },
                  { key: "nasName", label: "NAS", render: (r) => r.nas?.nasname || "—" },
                  { key: "nasIp", label: "NAS IP", mono: true, render: (r) => r.nas?.nasIp || r.nasIp || "—" },
                  { key: "framedIp", label: "Subscriber IP", mono: true },
                  { key: "callerId", label: "Calling-Station-Id", mono: true },
                  { key: "sessionId", label: "Session ID", mono: true },
                  { key: "message", label: "Message", wide: true },
                ]}
              />
            </>
          )}

          {activeTab === "connections" && activeFeature === "nas" && (
            <section aria-label="NAS connectivity" style={{ display: "grid", gap: 10 }}>
              <h2 style={{ fontSize: 15, margin: 0 }}>NAS connectivity</h2>
              {nasLogNote && <p style={{ margin: 0, color: t.textMuted, fontSize: 12 }}>{nasLogNote}</p>}
              {nasLogError && <p role="alert" style={{ margin: 0, color: t.red, fontSize: 12 }}>{nasLogError}</p>}
              {!nasLogError && !nasList.length && <p style={{ margin: 0, color: t.textMuted, fontSize: 12 }}>No authorized NAS devices are available.</p>}
              <div style={{ display: "grid", gap: 8 }}>
                {filteredNasLogs.map((entry: any, index: number) => (
                    <article key={`${entry.id ?? entry.loggedAt ?? entry.time ?? "nas-log"}-${index}`}
                      style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 9, padding: "10px 12px", display: "grid", gap: 5, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <strong style={{ fontSize: 12 }}>{entry.severity || entry.topics || "NAS event"}</strong>
                        <time style={{ color: t.textMuted, fontSize: 11 }}>{entry.loggedAt || entry.time || entry.date ? dateTime(entry.loggedAt || entry.time || entry.date) : "Timestamp not recorded"}</time>
                      </div>
                      <div style={{ fontSize: 12, overflowWrap: "anywhere" }}>{entry.message || entry.msg || "Message not recorded"}</div>
                    </article>
                  ))}
                {!nasLogError && nasId && nasLogs.length === 0 && (
                  <p style={{ margin: 0, color: t.textMuted, fontSize: 12 }}>No router log entries were returned.</p>
                )}
              </div>
            </section>
          )}

          {/* ═══════════════ TAB: LOGIN LOGS ═══════════════ */}
          {activeTab === "audit" && activeFeature === "security" && (
            <>
            <h2 style={{ fontSize: 15, margin: "16px 0 9px" }}>Security & access · Application sign-ins</h2>
            <LogRecordsTable
              endpoint="/logs/login"
              detailPanel
              searchable={false}
              hideToolbar
              refreshKey={refreshKey}
              searchText={search}
              onSearchTextChange={setSearch}
              queryParams={{ sinceHours: sinceHours ? String(sinceHours) : "", forUser: focusUser }}
              onRecordsChange={onRecordsChange}
              columns={[
                { key: "user", label: "User", nowrap: true, primary: true, render: (r) => r.user?.name || "—" },
                { key: "email", label: "Email", nowrap: true, primary: true, render: (r) => r.email || "—" },
                { key: "ipAddress", label: "Source IP", mono: true, nowrap: true },
                { key: "status", label: "Status", nowrap: true, primary: true, render: (r) => (
                    <span style={{ color: r.status === "SUCCESS" ? "#16a34a" : "#dc2626", fontWeight: 700 }}>
                      {r.status === "SUCCESS" ? "Success" : "Failed"}
                    </span>
                  ) },
                // Expanded detail.
                { key: "createdAt", label: "Timestamp", primary: true, render: (r) => r.createdAt ? dateTime(r.createdAt) : "—" },
                { key: "failReason", label: "Reason", render: (r) => r.failReason || "—" },
                { key: "userAgent", label: "Device / Browser", wide: true, render: (r) => r.userAgent || r.device || "—" },
              ]}
            />
            </>
          )}

          {/* ═══════════════ TAB: SYSTEM LOGS ═══════════════ */}
          {activeTab === "audit" && activeFeature === "system" && (
            <>
            <h2 style={{ fontSize: 15, margin: "18px 0 9px" }}>System events</h2>
            <LogRecordsTable
              endpoint="/logs/system"
              detailPanel
              searchable={false}
              hideToolbar
              refreshKey={refreshKey}
              searchText={search}
              onSearchTextChange={setSearch}
              queryParams={{ sinceHours: sinceHours ? String(sinceHours) : "" }}
              onRecordsChange={onRecordsChange}
              columns={[
                { key: "level", label: "Level", nowrap: true, primary: true },
                { key: "source", label: "Source", nowrap: true, primary: true },
                { key: "message", label: "System event", primary: true },
                { key: "createdAt", label: "Timestamp", nowrap: true, primary: true, render: (r) => r.createdAt ? dateTime(r.createdAt) : "—" },
                { key: "metadata", label: "Recorded metadata", wide: true },
              ]}
            />
            </>
          )}

          {/* ═══════════════ TAB: SESSIONS ═══════════════ */}
          {activeTab === "sessions" && activeFeature === "timeline" && (
            <>
            <h2 style={{ fontSize: 15, margin: "18px 0 9px" }}>Active panel sessions</h2>
            <LogTable data={filteredSessions} d={d} t={t}
              headers={["User", "Role", "IP", "Login Time", "Expires"]}
              render={(s: any) => (
                <tr key={s.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: `var(--surface-2)` }}>
                  <td style={{ padding: "8px 12px" }}><div style={{ fontWeight: 600, fontSize: 12 }}>{s.user?.name}</div><div style={{ fontSize: 10, color: t.textMuted }}>{s.user?.email}</div></td>
                  <td style={{ padding: "8px 12px" }}><Badge color="#4ade80" bg="#14532d">{s.user?.role}</Badge></td>
                  <td style={{ padding: "8px 12px", fontSize: 11, fontFamily: "monospace", color: t.accent }}>{s.ipAddress}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{dateTime(s.loginAt || s.createdAt)}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.amber }}>{dateTime(s.expiresAt)}</td>
                </tr>
              )} />
            </>
          )}

          {/* ═══════════════ TAB: RADIUS SESSIONS (with termination cause) ═══════════════ */}
          {activeTab === "sessions" && (activeFeature === "live" || activeFeature === "accounting") && (
          <>
            <h2 style={{ fontSize: 15, margin: "0 0 9px" }}>{activeFeature === "live" ? "Live PPPoE sessions" : "RADIUS accounting history"}</h2>
            <LogRecordsTable
              endpoint="/logs/radius-sessions"
              detailPanel
              searchable={false}
              hideToolbar
              refreshKey={refreshKey}
              searchText={search}
              onSearchTextChange={setSearch}
              queryParams={{
                limit: "50",
                sinceHours: sinceHours ? String(sinceHours) : "",
                forUser: focusUser,
                cause: activeFeature === "live" ? "current" : "",
              }}
              onRecordsChange={onRecordsChange}
              columns={[
                { key: "username", label: "Subscriber", nowrap: true, primary: true },
                { key: "sessionId", label: "Session ID", mono: true, nowrap: true, primary: true },
                { key: "sessionState", label: "State", nowrap: true, primary: true },
                { key: "start", label: "Started", nowrap: true, primary: true, render: (r) => r.start ? dateTime(r.start) : "—" },
                { key: "stop", label: "Stopped", nowrap: true, render: (r) => r.stop ? dateTime(r.stop) : "—" },
                { key: "durationSec", label: "Duration", render: (r) => r.durationSec == null ? "—" : `${Math.floor(r.durationSec / 60)}m ${r.durationSec % 60}s` },
                { key: "nasName", label: "NAS", render: (r) => r.nasName || "Not recorded" },
                { key: "nasIp", label: "NAS IP", mono: true },
                { key: "framedIp", label: "Assigned IP", mono: true },
                { key: "callingStation", label: "Calling-Station-Id", mono: true },
                { key: "lastSeen", label: "Last accounting update", render: (r) => r.lastSeen ? dateTime(r.lastSeen) : "Not recorded" },
                { key: "downloadMB", label: "Download / upload", render: (r) => r.downloadMB == null ? "—" : `${r.downloadMB} / ${r.uploadMB ?? "—"} MB` },
                { key: "terminateLabel", label: "Disconnect reason", wide: true, render: (r) => r.terminateLabel || "Not recorded" },
              ]}
            />
          </>
          )}

          {/* ═══════════════ TAB: DISCONNECT REASONS (all 18 RFC 2866 causes) ═══════════════ */}
          {activeTab === "sessions" && activeFeature === "disconnects" && (
            <>
              <h2 style={{ fontSize: 15, margin: "20px 0 9px" }}>Disconnect report</h2>
              <DisconnectsPanel
                refreshKey={refreshKey}
                searchText={search}
                onSearchTextChange={setSearch}
                controlledHours={sinceHours ?? 2160}
                onHoursChange={(value) => setFilterPeriod(value === 24 ? "24h" : value === 168 ? "7d" : value === 720 ? "30d" : "90d")}
                hideTimeRange
                hideSearch
              />
            </>
          )}

          {activeTab === "authentication" && activeFeature === "disconnects" && (
            <>
              <h2 style={{ fontSize: 15, margin: "20px 0 9px" }}>Disconnect report</h2>
              <DisconnectsPanel
                refreshKey={refreshKey}
                searchText={search}
                onSearchTextChange={setSearch}
                controlledHours={sinceHours ?? 2160}
                onHoursChange={(value) => setFilterPeriod(value === 24 ? "24h" : value === 168 ? "7d" : value === 720 ? "30d" : "90d")}
                hideTimeRange
                hideSearch
              />
            </>
          )}

          {/* ═══════════════ TAB: FAILED ACTIVATIONS ═══════════════ */}
          {activeTab === "connections" && activeFeature === "failed" && (
            <>
            <DisconnectsPanel
              mode="connections"
              refreshKey={refreshKey}
              searchText={search}
              onSearchTextChange={setSearch}
              controlledHours={sinceHours ?? 2160}
              hideTimeRange
              hideSearch
            />
            <h2 style={{ fontSize: 15, margin: "18px 0 9px" }}>Failed activations</h2>
            <LogRecordsTable
              endpoint="/logs/failed-activations"
              detailPanel
              searchable={false}
              hideToolbar
              refreshKey={refreshKey}
              searchText={search}
              onSearchTextChange={setSearch}
              queryParams={{ sinceHours: sinceHours ? String(sinceHours) : "", forUser: focusUser }}
              onRecordsChange={onRecordsChange}
              columns={[
                { key: "username", label: "Subscriber", nowrap: true, primary: true },
                { key: "reason", label: "Recorded failure reason", primary: true },
                { key: "createdAt", label: "Timestamp", nowrap: true, primary: true, render: (r) => r.createdAt ? dateTime(r.createdAt) : "—" },
                { key: "fullName", label: "Customer name" },
                { key: "createdById", label: "Attempted by (user ID)" },
              ]}
            />
            </>
          )}

          {/* ═══════════════ TAB: RADIUS HEALTH ═══════════════ */}
          {activeTab === "authentication" && activeFeature === "health" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <h2 style={{ fontSize: 15, margin: "18px 0 0" }}>RADIUS diagnostics</h2>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ padding: "6px 14px", borderRadius: 20, fontSize: 12, fontWeight: 700,
                  background: diag?.summary?.failures ? "rgba(239,68,68,.15)" : diag?.summary?.warnings ? "rgba(245,158,11,.15)" : "rgba(34,197,94,.15)",
                  color: diag?.summary?.failures ? "#ef4444" : diag?.summary?.warnings ? "#f59e0b" : "#16a34a" }}>
                  {diagError ? "Diagnostics unavailable" : !diag ? "Checking…" : diag.summary.failures ? `${diag.summary.failures} problem(s)` : diag.summary.warnings ? `${diag.summary.warnings} warning(s)` : "No alerts in returned checks"}
                </div>
                <button onClick={() => loadDiag()} disabled={diagBusy}
                  style={{ background: t.accent, color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: diagBusy ? .6 : 1 }}>
                  {diagBusy ? "⟳ Refreshing…" : "↻ Refresh"}
                </button>
                {!!diag?.staleSessions?.length && (
                  <button onClick={async () => { setDiagBusy(true); await mustOk(await fetch(`${API}/logs/radius/close-stale`, { method: "POST", headers })); loadDiag(); }}
                    disabled={diagBusy} style={{ background: "transparent", color: "#f59e0b", border: "1px solid #f59e0b", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                    Close {diag.staleSessions.length} stale
                  </button>
                )}
                <span style={{ fontSize: 11, color: t.textMuted, marginLeft: "auto" }}>Auto-refresh 30s</span>
              </div>
              {diagError && <p role="alert" style={{ margin: 0, color: "#ef4444", fontSize: 12 }}>{diagError}</p>}
              <p style={{ margin: 0, color: t.textMuted, fontSize: 11 }}>
                Checks summarize stored session and network-log data; they do not establish live NAS reachability or RADIUS server availability.
              </p>

              {/* Summary cards */}
              {diag && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8 }}>
                  {[
                    { label: "OK", val: diag.summary.ok, color: "#22c55e", bg: "rgba(34,197,94,.12)" },
                    { label: "Warnings", val: diag.summary.warnings, color: "#f59e0b", bg: "rgba(245,158,11,.12)" },
                    { label: "Failures", val: diag.summary.failures, color: "#ef4444", bg: "rgba(239,68,68,.12)" },
                    { label: "Active NAS", val: (diag.checks || []).find((c: any) => c.key === "nas-count")?.detail?.match(/\d+/)?.[0] || "—", color: t.accent, bg: "rgba(14,165,233,.12)" },
                  ].map((c, i) => (
                    <div key={i} style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: "10px 12px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: t.textMuted }}>{c.label}</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: c.color }}>{c.val}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Checks */}
              <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
                {(diag?.checks || []).map((c: any) => {
                  const col = c.status === "FAIL" ? "#ef4444" : c.status === "WARN" ? "#f59e0b" : "#16a34a";
                  return (
                    <div key={c.key} style={{ display: "flex", gap: 12, padding: "10px 14px", borderBottom: `1px solid ${t.cardBorder}`, alignItems: "flex-start" }}>
                      <span style={{ color: col, fontSize: 14, flexShrink: 0 }}>
                        {c.status === "FAIL" ? "✖" : c.status === "WARN" ? "▲" : "✔"}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: t.text }}>{c.label}</div>
                        <div style={{ fontSize: 11.5, color: t.textSub, marginTop: 2 }}>{c.detail}</div>
                        {c.hint && <div style={{ fontSize: 11, color: t.textMuted, marginTop: 5, padding: "5px 8px", background: d ? "var(--surface-2)" : "#f8fafc", borderLeft: `2px solid ${col}`, borderRadius: 4 }}>💡 {c.hint}</div>}
                      </div>
                      <span style={{ fontSize: 10, fontWeight: 800, color: col, flexShrink: 0 }}>{c.status}</span>
                    </div>
                  );
                })}
                {!diag && <div style={{ padding: 16, fontSize: 12, color: t.textMuted }}>Loading diagnostics…</div>}
              </div>
            </div>
          )}

            </div>{/* .logs-main */}
          </div>{/* .logs-layout */}

          {/* Footer — only standalone (the hub provides page chrome when embedded). */}
          {!embedded && (
            <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${t.cardBorder}`, fontSize: 11, color: t.textMuted, textAlign: "center" }}>
              © {new Date().getFullYear()} <strong style={{ color: t.accent }}>{BRAND.name}</strong> ISP CRM Platform. All rights reserved.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Detail row helper ─────────────────────────────────────────────

function Detail({ label, val }: { label: string; val?: string }) {
  if (!val) return null;
  return (
    <>
      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ fontSize: 11.5, color: "var(--text)", wordBreak: "break-all" }}>{val}</span>
    </>
  );
}

// ── Reusable log table ───────────────────────────────────────────

function LogTable({ data, headers, render, emptyMsg = "No data found.", d, t }: any) {
  if (data.length === 0) {
    return <div style={{ padding: 30, textAlign: "center", color: t.textMuted, fontSize: 12, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>{emptyMsg}</div>;
  }
  return (
    <div style={{ background: "var(--bg-elev, var(--surface))", border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
      {/* Nothing wraps — IPs, dates and ids stay on one line; the table scrolls
          sideways instead. Solid surfaces for readable dark-mode contrast. */}
      <style>{`
        .logtbl{width:100%;border-collapse:collapse;min-width:700px}
        .logtbl th,.logtbl td{white-space:nowrap;padding:9px 14px}
        .logtbl thead th{text-align:left;font-size:10px;font-weight:700;letter-spacing:.04em;
          text-transform:uppercase;color:var(--muted)}
        .logtbl tbody tr{border-bottom:1px solid var(--border)}
        html[data-theme="dark"] .logtbl tbody tr:nth-child(odd){background:rgba(255,255,255,.02)}
      `}</style>
      <div style={{ overflowX: "auto" }}>
        <table className="logtbl">
          <thead>
            <tr style={{ background: d ? "#0f172a" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
              {headers.map((h: string) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>{data.map((row: any, i: number) => render(row, i))}</tbody>
        </table>
      </div>
    </div>
  );
}
