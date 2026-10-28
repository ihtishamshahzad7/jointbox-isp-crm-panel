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
  { id: "authentication", label: "Authentication (AAA)", description: "Inspect subscriber RADIUS authentication and application sign-ins." },
  { id: "audit", label: "Audit Trail", description: "Review administrative activity and system events." },
];
const LEGACY_LOG_TABS: Record<string, string> = {
  console: "connections", network: "connections", failed: "connections",
  timeline: "connections", radsess: "sessions", disconnects: "sessions",
  authrec: "authentication", login: "authentication", radius: "authentication",
  sessions: "sessions", actrec: "audit", activity: "audit", system: "audit",
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
  const setActiveTab = (id: string) => {
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
  const [systemLogs, setSystemLogs] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [radiusSessions, setRadiusSessions] = useState<any[]>([]);
  const [radWindow, setRadWindow] = useState<number>(0);  // 0 = all time, else hours
  const [failedActs, setFailedActs] = useState<any[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [statsError, setStatsError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [timelineError, setTimelineError] = useState("");
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [diag, setDiag] = useState<any>(null);
  const [diagError, setDiagError] = useState("");
  const [diagBusy, setDiagBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [timelineLimit, setTimelineLimit] = useState(100);

  // ── Filters ────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [filterSeverity, setFilterSeverity] = useState<string>("ALL");
  const [filterPeriod, setFilterPeriod] = useState("24h");
  const [focusUser, setFocusUser] = useState("");
  const [accounts, setAccounts] = useState<any[]>([]);

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

  const fetchTimeline = useCallback(async () => {
    if (!token) return;
    setTimelineLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(timelineLimit));
      params.set("type", "network");
      if (focusUser) params.set("forUser", focusUser);
      if (filterSeverity !== "ALL") params.set("severity", filterSeverity);
      const res = await fetch(`${API}/logs/timeline?${params}`, { headers });
      if (!res.ok) throw new Error(`Unable to load connection events (HTTP ${res.status}).`);
      const events = await res.json();
      if (!Array.isArray(events)) throw new Error("The connection event response was invalid.");
      setTimeline(events);
      setTimelineError("");
    } catch (e) {
      setTimelineError(e instanceof Error ? e.message : "Unable to load connection events.");
    } finally {
      setTimelineLoading(false);
    }
  }, [token, timelineLimit, focusUser, filterSeverity]);

  const fetchStats = useCallback(async () => {
    if (!token) return;
    try {
      const h = filterPeriod === "1h" ? 1 : filterPeriod === "6h" ? 6 : filterPeriod === "7d" ? 168 : 24;
      const res = await fetch(`${API}/logs/stats?hours=${h}`, { headers });
      if (!res.ok) throw new Error(`Unable to load summary metrics (HTTP ${res.status}).`);
      setStats(await res.json());
      setStatsError("");
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : "Unable to load summary metrics.");
    }
  }, [token, filterPeriod]);

  const fetchAllLogs = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setLoadError("");
    try {
      const fuq = focusUser ? `?forUser=${focusUser}` : "";
      const [systemRes, sessionsRes, radiusRes, failedRes] = await Promise.all([
        fetch(`${API}/logs/system?limit=100`, { headers }),
        fetch(`${API}/logs/sessions${fuq}`, { headers }),
        fetch(`${API}/logs/radius-sessions?limit=500&cause=current${radWindow ? `&sinceHours=${radWindow}` : ""}`, { headers }),
        fetch(`${API}/logs/failed-activations?limit=200`, { headers }),
      ]);
      const failedResponse = [systemRes, sessionsRes, radiusRes, failedRes].find((response) => !response.ok);
      if (failedResponse) throw new Error(`Unable to load log data (HTTP ${failedResponse.status}).`);
      const [systemData, sessionsData, radiusData, failedData] = await Promise.all([
        systemRes.json(), sessionsRes.json(), radiusRes.json(), failedRes.json(),
      ]);
      setSystemLogs(Array.isArray(systemData?.logs) ? systemData.logs : Array.isArray(systemData) ? systemData : []);
      setSessions(Array.isArray(sessionsData) ? sessionsData : []);
      setRadiusSessions(Array.isArray(radiusData?.items) ? radiusData.items : []);
      setFailedActs(Array.isArray(failedData) ? failedData : []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Unable to load log data.");
    } finally {
      setLoading(false);
    }
  }, [token, focusUser, radWindow]);

  // Preserve old log-view bookmarks by redirecting their view id to a category.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const searchTerm = q.get("search") || q.get("username");
      if (searchTerm) setSearch(searchTerm);
      if (!embedded) {
        const destination = resolveLogTab(q.get("logTab") || q.get("tab"));
        if (destination) setInternalTab(destination);
      }
    } catch { /* no query */ }
    const handlePopState = () => {
      if (embedded) return;
      const params = new URLSearchParams(window.location.search);
      const destination = resolveLogTab(params.get("logTab") || params.get("tab"));
      setInternalTab(destination || "connections");
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Initial load
  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    fetch(`${API}/profile`, { headers })
      .then(res => { if (res.status === 401) { localStorage.removeItem("token"); router.push("/login"); } })
      .catch(silent("profileFetch"));

    fetchTimeline();
    fetchStats();
    fetchAllLogs();

    fetch(`${API}/users`, { headers })
      .then(r => r.ok ? r.json() : [])
      .then(rows => setAccounts(Array.isArray(rows) ? rows : rows?.data ?? []))
      .catch(silent("usersFetch"));
  }, []);

  // Re-fetch when filters change for timeline / stats tabs
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    if (token) { fetchTimeline(); fetchStats(); }
  }, [focusUser, filterSeverity, filterPeriod, timelineLimit]);

  const didMountDataFilters = useRef(false);
  useEffect(() => {
    if (!didMountDataFilters.current) { didMountDataFilters.current = true; return; }
    if (token) fetchAllLogs();
  }, [focusUser, radWindow]);

  // Auto-refresh the connection event stream every 15s.
  useEffect(() => {
    if (activeTab !== "connections" || !token) return;
    const iv = setInterval(() => { fetchTimeline(); fetchStats(); }, 15_000);
    return () => clearInterval(iv);
  }, [activeTab, token, fetchTimeline, fetchStats]);

  // RADIUS diag
  const loadDiag = useCallback(() => {
    if (!token) return;
    setDiagBusy(true);
    setDiagError("");
    fetch(`${API}/logs/radius/diagnostics`, { headers })
      .then(r => {
        if (!r.ok) throw new Error(`Unable to load RADIUS diagnostics (HTTP ${r.status}).`);
        return r.json();
      })
      .then(setDiag)
      .catch(e => setDiagError(e instanceof Error ? e.message : "Unable to load RADIUS diagnostics."))
      .finally(() => setDiagBusy(false));
  }, [token]);

  useEffect(() => {
    if (activeTab !== "authentication" || !token) return;
    loadDiag();
    const iv = setInterval(loadDiag, 30_000);
    return () => clearInterval(iv);
  }, [activeTab, token, loadDiag]);

  const refreshAll = () => {
    setRefreshKey((key) => key + 1);
    fetchTimeline();
    fetchStats();
    fetchAllLogs();
    if (activeTab === "authentication") loadDiag();
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

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", minHeight: embedded ? "auto" : "100vh", background: embedded ? "transparent" : t.bg, color: t.text, fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <div style={{ flex: 1, padding: embedded ? 0 : "16px 20px", overflowY: embedded ? "visible" : "auto" }}>

          {/* Layout styles: left vertical view sidebar + content. */}
          <style>{`
            .logs-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-items:start}
            .logs-layout.embedded{grid-template-columns:1fr}
            .logs-main{min-width:0}
            .logs-side{display:flex;gap:5px;overflow-x:auto;overscroll-behavior-x:contain;
              background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:6px;
              box-shadow:0 1px 2px rgba(0,0,0,.05);scrollbar-width:thin}
            .logs-side-tab{flex:1 0 auto;border:none;background:transparent;padding:10px 14px;border-radius:9px;
              font-size:13px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit;
              text-align:center;white-space:nowrap;
              transition:background .12s,color .12s}
            .logs-side-tab:hover{color:var(--text);background:var(--surface-2)}
            .logs-side-tab.on{background:var(--accent);color:#fff;
              box-shadow:0 2px 8px color-mix(in srgb,var(--accent) 40%,transparent)}
            .logs-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:0 0 16px}
            .logs-heading h1{font-size:22px;line-height:1.2;margin:0;font-weight:750}
            .logs-heading p{font-size:13px;color:var(--muted);margin:5px 0 0}
            .logs-tab-description{font-size:12px;color:var(--muted);margin:-7px 0 14px}
            @media (max-width:640px){
              .logs-side{border-radius:11px}
              .logs-side-tab{padding:10px 12px}
              .logs-heading h1{font-size:20px}
              .logs-tab-description{margin-top:-5px}
            }
          `}</style>

          {/* ═══════════════ TOP KPI CARDS ═══════════════ */}
      {showOverview && (
        <>
          {statsError && <p role="alert" style={{ color: t.red, fontSize: 12, margin: "0 0 10px" }}>{statsError}</p>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10, marginBottom: 18 }}>
            {[
              { label: `Events (${filterPeriod})`, val: stats ? stats.totals.login + stats.totals.activity + stats.totals.network + stats.totals.system : "—", sub: "all event types", color: t.accent },
              { label: "Failed app sign-ins", val: stats?.errors?.failedLogins ?? "—", sub: filterPeriod, color: t.red },
              { label: "Network errors", val: stats?.errors?.networkErrors ?? "—", sub: filterPeriod, color: t.amber },
              { label: "Active app sessions", val: stats?.activeSessions ?? "—", sub: "current", color: t.green },
            ].map((c, i) => (
              <div key={i} style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: t.textMuted }}>{c.label}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: c.color, marginTop: 2 }}>{loading ? "—" : c.val}</div>
                <div style={{ fontSize: 10, color: t.textMuted, marginTop: 2 }}>{c.sub}</div>
              </div>
            ))}
          </div>
        </>
      )}

          {/* ═══════════════ FILTER BAR ═══════════════ */}
          <header className="logs-heading">
            <div>
              <h1>Logs</h1>
              <p>Investigate connections, sessions, authentication, and system changes.</p>
            </div>
          </header>
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {/* Overview toggle — sits with the search for a clean single bar. */}
              <button onClick={() => setShowOverview(v => !v)} style={{ background: showOverview ? `${t.accent}15` : "transparent", border: `1px solid ${showOverview ? t.accent : t.cardBorder}`, color: showOverview ? t.accent : t.textSub, borderRadius: 8, padding: "9px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                {showOverview ? "▲ Hide overview" : "▼ Show overview"}
              </button>
              {/* Search */}
              <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search logs by user, IP, message, action..."
                  style={{ width: "100%", padding: "9px 12px 9px 34px", borderRadius: 8,
                    border: `1px solid ${t.cardBorder}`, fontSize: 12, background: t.input, color: t.text, outline: "none" }}
                  onFocus={e => e.target.style.borderColor = t.accent}
                  onBlur={e => e.target.style.borderColor = t.cardBorder} />
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: t.textMuted, fontSize: 14 }}>🔍</span>
              </div>

              <button onClick={() => setShowFilters(!showFilters)}
                style={{ padding: "9px 14px", borderRadius: 8, border: `1px solid ${showFilters ? t.accent : t.cardBorder}`,
                  background: showFilters ? `${t.accent}15` : "transparent", color: showFilters ? t.accent : t.textSub, cursor: "pointer", fontSize: 12 }}>
                ⚙️ Filters {showFilters ? "▲" : "▼"}
              </button>
              <button type="button" onClick={refreshAll} disabled={loading}
                style={{ padding: "9px 14px", borderRadius: 8, border: `1px solid ${t.cardBorder}`,
                  background: "transparent", color: t.textSub, cursor: loading ? "wait" : "pointer", fontSize: 12 }}>
                {loading ? "Refreshing…" : "↻ Refresh"}
              </button>

              {/* Account drill-down */}
              {accounts.length > 0 && (
                <select value={focusUser} onChange={e => setFocusUser(e.target.value)}
                  style={{ padding: "9px 12px", borderRadius: 8, border: `1px solid ${focusUser ? t.accent : t.cardBorder}`,
                    fontSize: 12, background: t.input, color: t.text, cursor: "pointer", minWidth: 160 }}>
                  <option value="">📋 All accounts</option>
                  {accounts.map((u: any) => <option key={u.id} value={u.id}>{u.name} · {u.role}</option>)}
                </select>
              )}
            </div>
            {loadError && (
              <div role="alert" style={{ margin: "0 0 14px", padding: "10px 12px", border: "1px solid #ef4444",
                borderRadius: 8, color: "#ef4444", fontSize: 12 }}>
                {loadError}
              </div>
            )}

            {/* Collapsible advanced filters */}
            {showFilters && (
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

                {/* Period */}
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: t.textSub }}>Period:</span>
                  {["1h", "6h", "24h", "7d"].map(p => (
                    <button key={p} onClick={() => setFilterPeriod(p)}
                      style={{ padding: "3px 10px", borderRadius: 6, cursor: "pointer", fontSize: 10, fontWeight: 600,
                        background: filterPeriod === p ? t.accent : "transparent",
                        color: filterPeriod === p ? "#fff" : t.textSub, border: filterPeriod === p ? "none" : `1px solid ${t.cardBorder}` }}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ═══════════════ FOUR-TAB LOGS WORKSPACE ═══════════════ */}
          <div className={`logs-layout${embedded ? " embedded" : ""}`}>
            <nav className="logs-side" role="tablist" aria-label="Log views">
              {tabs.map(tab => (
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
                  onKeyDown={(event) => handleTabKeyDown(event, tabs.indexOf(tab))}
                  ref={(element) => { tabRefs.current[tabs.indexOf(tab)] = element; }}
                >
                  {tab.label}
                </button>
              ))}
            </nav>

            {/* Right content area. */}
            <div
              className="logs-main"
              id="logs-tabpanel"
              role="tabpanel"
              aria-labelledby={`logs-tab-${tabs[activeTabIndex].id}`}
              tabIndex={0}
            >
          <p className="logs-tab-description">{tabs.find((tab) => tab.id === activeTab)?.description}</p>

          {/* ═══════════════ LOADING ═══════════════ */}
          {loading && activeTab !== "connections" && activeTab !== "audit" && activeTab !== "authentication" && (
            <div style={{ textAlign: "center", padding: 40, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ width: 30, height: 30, border: `3px solid ${t.cardBorder}`, borderTopColor: t.accent, borderRadius: "50%", animation: "spin .8s linear infinite", margin: "0 auto 12px" }}></div>
              <p style={{ color: t.textMuted, fontSize: 12 }}>Loading...</p>
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
          )}

          {/* ═══════════════ TAB: ACTIVITY LOGS (paginated) ═══════════════ */}
          {activeTab === "audit" && (
            <>
            <h2 style={{ fontSize: 15, margin: "0 0 9px" }}>Administrative activity</h2>
            <LogRecordsTable
              endpoint="/logs/activity"
              refreshKey={refreshKey}
              searchText={search}
              onSearchTextChange={setSearch}
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
          {activeTab === "authentication" && (
            <>
            <h2 style={{ fontSize: 15, margin: "0 0 9px" }}>Subscriber RADIUS authentication</h2>
            <LogRecordsTable
              endpoint="/logs/radius-auth"
              refreshKey={refreshKey}
              searchText={search}
              onSearchTextChange={setSearch}
              days={7}
              daysOptions={[{ label: "Last 24 hours", value: 1 }, { label: "Last 7 days", value: 7 }, { label: "Last 30 days", value: 30 }, { label: "All time", value: 0 }]}
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

          {/* ═══════════════ TAB: TIMELINE ═══════════════ */}
          {activeTab === "connections" && (
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

          {/* ═══════════════ TAB: LOGIN LOGS ═══════════════ */}
          {activeTab === "authentication" && (
            <>
            <h2 style={{ fontSize: 15, margin: "16px 0 9px" }}>Application sign-ins</h2>
            <LogRecordsTable
              endpoint="/logs/login"
              refreshKey={refreshKey}
              searchText={search}
              onSearchTextChange={setSearch}
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
          {activeTab === "audit" && (
            <>
            <h2 style={{ fontSize: 15, margin: "18px 0 9px" }}>System events</h2>
            <LogTable data={filterData(systemLogs, ["message", "source", "level"])} d={d} t={t}
              headers={["Level", "Source", "Message", "Time"]}
              render={(log: any) => {
                const lc = log.level === "ERROR" ? { color: "#f87171", bg: "#450a0a" } : log.level === "WARNING" ? { color: "#fbbf24", bg: "#422006" } : { color: "#60a5fa", bg: "var(--surface)" };
                return (
                  <tr key={log.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: `var(--surface-2)` }}>
                    <td style={{ padding: "8px 12px" }}><Badge color={lc.color} bg={lc.bg}>{log.level}</Badge></td>
                    <td style={{ padding: "8px 12px", fontSize: 11 }}>{log.source}</td>
                    <td style={{ padding: "8px 12px", fontSize: 12 }}>{log.message}</td>
                    <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{dateTime(log.createdAt)}</td>
                  </tr>
                );
              }} />
            </>
          )}

          {/* ═══════════════ TAB: SESSIONS ═══════════════ */}
          {activeTab === "authentication" && (
            <>
            <h2 style={{ fontSize: 15, margin: "18px 0 9px" }}>Application sessions</h2>
            <LogTable data={filterData(sessions, ["user.name", "user.email", "ipAddress", "userAgent"])} d={d} t={t}
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
          {activeTab === "sessions" && (
          <>
            <h2 style={{ fontSize: 15, margin: "0 0 9px" }}>RADIUS accounting sessions</h2>
            {/* Time window */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: t.textMuted, marginRight: 4 }}>Window:</span>
              {[[0,"All"],[24,"24h"],[72,"3d"],[168,"7d"]].map(([h,lbl]) => (
                <button key={h as number} onClick={() => setRadWindow(h as number)}
                  style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, cursor: "pointer",
                    border: `1px solid ${radWindow === h ? t.accent : t.cardBorder}`,
                    background: radWindow === h ? t.accent : "transparent", color: radWindow === h ? "#fff" : t.textSub }}>
                  {lbl as string}
                </button>
              ))}
            </div>
            <LogTable data={filterData(radiusSessions, ["username", "nasIp", "framedIp", "callingStation", "sessionState", "terminateLabel"])} d={d} t={t}
              headers={["Subscriber / Session", "Session state", "Subscriber / NAS IP", "Started", "Duration", "Last accounting update", "Down / Up"]}
              render={(s: any) => {
                const dur = s.durationSec != null
                  ? (s.durationSec >= 3600 ? `${Math.floor(s.durationSec/3600)}h ${Math.floor((s.durationSec%3600)/60)}m` : s.durationSec >= 60 ? `${Math.floor(s.durationSec/60)}m ${s.durationSec%60}s` : `${s.durationSec}s`)
                  : "—";
                return (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: `var(--surface-2)` }}>
                    <td style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600 }}>
                      {s.username}
                      <div style={{ fontSize: 10, color: t.textMuted }}>Subscriber ID: {s.subscriberId ?? "Not recorded"}</div>
                      <div style={{ fontSize: 10, color: t.textMuted, fontFamily: "monospace" }}>Acct-Session-Id: {s.sessionId || "Not recorded"}</div>
                      <div style={{ fontSize: 10, color: t.textMuted, fontFamily: "monospace" }}>Calling-Station-Id: {s.callingStation || "Not recorded"}</div>
                    </td>
                    <td style={{ padding: "8px 12px" }}>
                      {s.sessionState === "active"
                        ? <Badge color="#4ade80" bg="#14532d">Active · accounting fresh</Badge>
                        : s.sessionState === "stale"
                          ? <Badge color="#fbbf24" bg="#422006">Stale · no update for over 30 minutes</Badge>
                          : s.sessionState === "unknown"
                            ? <Badge color="#cbd5e1" bg="#334155">Unknown · no tracked PPPoE state</Badge>
                            : <span style={{ display: "grid", gap: 3, maxWidth: 360 }}>
                            <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                              <CauseBadge compact cause={causeOf(s)} />
                              <SeverityTag severity={s.terminateSeverity} />
                            </span>
                            <span style={{ fontSize: 10.5, color: t.textMuted, lineHeight: 1.45 }}>{s.terminateHow || s.terminateMeaning || s.terminateDescription}</span>
                          </span>}
                    </td>
                    <td style={{ padding: "8px 12px", fontSize: 11, fontFamily: "monospace", color: t.accent }}>
                      Subscriber IP: {s.framedIp || "Not assigned"}
                      <div style={{ fontSize: 10, color: t.textMuted }}>NAS: {s.nasName || "Not recorded"}{s.nasId ? ` · #${s.nasId}` : ""}</div>
                      <div style={{ fontSize: 10, color: t.textMuted }}>NAS IP: {s.nasIp || "Not recorded"}</div>
                    </td>
                    <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{s.start ? dateTime(s.start) : "—"}</td>
                    <td style={{ padding: "8px 12px", fontSize: 11 }}>{dur}</td>
                    <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{s.lastSeen ? dateTime(s.lastSeen) : "Not recorded"}</td>
                    <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{s.downloadMB != null ? `${s.downloadMB} / ${s.uploadMB} MB` : "—"}</td>
                  </tr>
                );
              }} />
          </>
          )}

          {/* ═══════════════ TAB: DISCONNECT REASONS (all 18 RFC 2866 causes) ═══════════════ */}
          {activeTab === "sessions" && (
            <>
              <h2 style={{ fontSize: 15, margin: "20px 0 9px" }}>Disconnect report</h2>
              <DisconnectsPanel refreshKey={refreshKey} searchText={search} onSearchTextChange={setSearch} />
            </>
          )}

          {/* ═══════════════ TAB: FAILED ACTIVATIONS ═══════════════ */}
          {activeTab === "connections" && (
            <>
            <h2 style={{ fontSize: 15, margin: "18px 0 9px" }}>Refused subscriber logins</h2>
            <DisconnectsPanel mode="connections" refreshKey={refreshKey} searchText={search} onSearchTextChange={setSearch} />
            <h2 style={{ fontSize: 15, margin: "18px 0 9px" }}>Failed activations</h2>
            <LogTable data={filterData(failedActs, ["username", "reason", "by"])} d={d} t={t}
              headers={["ID", "Username", "Reason", "Attempted By", "When"]}
              render={(f: any, i: number) => (
                <tr key={f.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: i % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{f.id}</td>
                  <td style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600 }}>{f.username || "—"}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>{f.reason}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textSub }}>{f.by}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{dateTime(f.createdAt)}</td>
                </tr>
              )}
              emptyMsg="No failed activations — good news." />
            </>
          )}

          {/* ═══════════════ TAB: RADIUS HEALTH ═══════════════ */}
          {activeTab === "authentication" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <h2 style={{ fontSize: 15, margin: "18px 0 0" }}>RADIUS diagnostics</h2>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ padding: "6px 14px", borderRadius: 20, fontSize: 12, fontWeight: 700,
                  background: diag?.summary?.failures ? "rgba(239,68,68,.15)" : diag?.summary?.warnings ? "rgba(245,158,11,.15)" : "rgba(34,197,94,.15)",
                  color: diag?.summary?.failures ? "#ef4444" : diag?.summary?.warnings ? "#f59e0b" : "#16a34a" }}>
                  {diagError ? "Diagnostics unavailable" : !diag ? "Checking…" : diag.summary.failures ? `${diag.summary.failures} problem(s)` : diag.summary.warnings ? `${diag.summary.warnings} warning(s)` : "No alerts in returned checks"}
                </div>
                <button onClick={loadDiag} disabled={diagBusy}
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
