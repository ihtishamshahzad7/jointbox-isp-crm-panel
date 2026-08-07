"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { silent } from "../components/silent";
import API from "../components/api";
import { WinBoxLog } from "../components/winbox-log";

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

const money = (n: number) => n.toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// ── Component ─────────────────────────────────────────────────────

export default function LogsPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [activeTab, setActiveTab] = useState("timeline");
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  // ── Data ───────────────────────────────────────────────────────
  const [loginLogs, setLoginLogs] = useState<any[]>([]);
  const [activityLogs, setActivityLogs] = useState<any[]>([]);
  const [networkLogs, setNetworkLogs] = useState<any[]>([]);
  const [systemLogs, setSystemLogs] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [failedActs, setFailedActs] = useState<any[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [diag, setDiag] = useState<any>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [timelineLimit, setTimelineLimit] = useState(100);

  // ── Filters ────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [filterTypes, setFilterTypes] = useState<Record<string, boolean>>({
    login: true, activity: true, network: true, system: true,
  });
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
    try {
      const params = new URLSearchParams();
      params.set("limit", String(timelineLimit));
      if (focusUser) params.set("forUser", focusUser);
      if (filterSeverity !== "ALL") params.set("severity", filterSeverity);
      const res = await fetch(`${API}/logs/timeline?${params}`, { headers });
      if (res.ok) setTimeline(await res.json());
    } catch { /* silent */ }
  }, [token, timelineLimit, focusUser, filterSeverity]);

  const fetchStats = useCallback(async () => {
    if (!token) return;
    try {
      const h = filterPeriod === "1h" ? 1 : filterPeriod === "6h" ? 6 : filterPeriod === "7d" ? 168 : 24;
      const res = await fetch(`${API}/logs/stats?hours=${h}`, { headers });
      if (res.ok) setStats(await res.json());
    } catch { /* silent */ }
  }, [token, filterPeriod]);

  const fetchAllLogs = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const fu = focusUser ? `&forUser=${focusUser}` : "";
      const fuq = focusUser ? `?forUser=${focusUser}` : "";
      const [loginRes, activityRes, networkRes, systemRes, sessionsRes] = await Promise.all([
        fetch(`${API}/logs/login?limit=100${fu}`, { headers }).catch((err) => { console.error('Login logs fetch failed', err); return null; }),
        fetch(`${API}/logs/activity?limit=100${fu}`, { headers }).catch((err) => { console.error('Activity logs fetch failed', err); return null; }),
        fetch(`${API}/logs/network?limit=100`, { headers }).catch((err) => { console.error('Network logs fetch failed', err); return null; }),
        fetch(`${API}/logs/system?limit=100`, { headers }).catch((err) => { console.error('System logs fetch failed', err); return null; }),
        fetch(`${API}/logs/sessions${fuq}`, { headers }).catch((err) => { console.error('Session logs fetch failed', err); return null; }),
      ]);
      if (loginRes) {
        if (loginRes.ok) { const d = await loginRes.json(); setLoginLogs(d.logs || []); }
        else console.error('Login logs HTTP error', loginRes.status, await loginRes.text());
      }
      if (activityRes) {
        if (activityRes.ok) { const d = await activityRes.json(); setActivityLogs(d.logs || []); }
        else console.error('Activity logs HTTP error', activityRes.status, await activityRes.text());
      }
      if (networkRes) {
        if (networkRes.ok) { const d = await networkRes.json(); setNetworkLogs(d.logs || []); }
        else console.error('Network logs HTTP error', networkRes.status, await networkRes.text());
      }
      if (systemRes) {
        if (systemRes.ok) { const d = await systemRes.json(); setSystemLogs(d.logs || []); }
        else console.error('System logs HTTP error', systemRes.status, await systemRes.text());
      }
      if (sessionsRes) {
        if (sessionsRes.ok) { const d = await sessionsRes.json(); setSessions(Array.isArray(d) ? d : []); }
        else console.error('Session logs HTTP error', sessionsRes.status, await sessionsRes.text());
      }
    } finally { setLoading(false); }
  }, [token, focusUser]);

  // Initial load
  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    fetch(`${API}/profile`, { headers })
      .then(res => { if (res.status === 401) { localStorage.removeItem("token"); router.push("/login"); return null; } return res.json(); })
      .then(data => { if (data?.user) setUser(data.user); })
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

  // Auto-refresh timeline every 15s
  useEffect(() => {
    if (activeTab !== "timeline" || !token) return;
    const iv = setInterval(() => { fetchTimeline(); fetchStats(); }, 15_000);
    return () => clearInterval(iv);
  }, [activeTab, token, fetchTimeline, fetchStats]);

  // RADIUS diag
  const loadDiag = useCallback(() => {
    if (!token) return;
    setDiagBusy(true);
    fetch(`${API}/logs/radius/diagnostics`, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setDiag(d))
      .catch(silent("radiusDiag"))
      .finally(() => setDiagBusy(false));
  }, [token]);

  useEffect(() => {
    if (activeTab !== "radius" || !token) return;
    loadDiag();
    const iv = setInterval(loadDiag, 30_000);
    return () => clearInterval(iv);
  }, [activeTab, token, loadDiag]);

  // ── Filter helpers ─────────────────────────────────────────────

  const filterData = (data: any[], fields: string[]) => {
    if (!search) return data;
    const q = search.toLowerCase();
    return data.filter(item => fields.some(f => String(item[f] || "").toLowerCase().includes(q)));
  };

  const filteredTimeline = timeline.filter(e => {
    if (!filterTypes[e._type]) return false;
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

  const tabs = [
    { id: "console",    label: "🖥️ Console" },
    { id: "timeline",   label: "📋 Timeline" },
    { id: "login",      label: "🔐 Login" },
    { id: "activity",   label: "📝 Activity" },
    { id: "network",    label: "🖧 Network" },
    { id: "system",     label: "⚙️ System" },
    { id: "sessions",   label: "🟢 Sessions" },
    { id: "failed",     label: "⛔ Failed" },
    { id: "radius",     label: "🩺 RADIUS" },
  ];

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: t.bg, color: t.text, fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>

          {/* ═══════════════ TOP KPI CARDS ═══════════════ */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10, marginBottom: 18 }}>
            {[
              { label: "Events (24h)",  val: stats ? stats.totals.login + stats.totals.activity + stats.totals.network + stats.totals.system : "—", sub: "all types", color: t.accent },
              { label: "Failed Logins", val: stats?.errors?.failedLogins ?? "—", sub: "last 24h", color: t.red },
              { label: "Network Errors", val: stats?.errors?.networkErrors ?? "—", sub: "last 24h", color: t.amber },
              { label: "Sessions",      val: stats?.activeSessions ?? "—", sub: "active now", color: t.green },
            ].map((c, i) => (
              <div key={i} style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: t.textMuted }}>{c.label}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: c.color, marginTop: 2 }}>{loading ? "—" : c.val}</div>
                <div style={{ fontSize: 10, color: t.textMuted, marginTop: 2 }}>{c.sub}</div>
              </div>
            ))}
          </div>

          {/* ═══════════════ FILTER BAR ═══════════════ */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
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

            {/* Collapsible advanced filters */}
            {showFilters && (
              <div style={{ marginTop: 10, padding: 12, background: t.card, borderRadius: 10, border: `1px solid ${t.cardBorder}`, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                {/* Type filter */}
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: t.textSub }}>Types:</span>
                  {Object.entries(typeConfig).map(([k, v]) => (
                    <label key={k} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11 }}>
                      <input type="checkbox" checked={filterTypes[k]} onChange={e => setFilterTypes(p => ({ ...p, [k]: e.target.checked }))} />
                      <span style={{ opacity: filterTypes[k] ? 1 : .5 }}>{v.icon} {v.label}</span>
                    </label>
                  ))}
                </div>

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

          {/* ═══════════════ TABS ═══════════════ */}
          <div style={{ display: "flex", gap: 4, marginBottom: 14, borderBottom: `1px solid ${t.cardBorder}`, paddingBottom: 10, flexWrap: "wrap" }}>
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                style={{ padding: "6px 14px", background: activeTab === tab.id ? t.accent : "transparent",
                  color: activeTab === tab.id ? "#fff" : t.textSub, border: activeTab === tab.id ? "none" : `1px solid ${t.cardBorder}`,
                  borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 500, transition: "all .15s" }}>
                {tab.label}
              </button>
            ))}
          </div>

          {/* ═══════════════ LOADING ═══════════════ */}
          {loading && activeTab !== "timeline" && activeTab !== "console" && (
            <div style={{ textAlign: "center", padding: 40, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ width: 30, height: 30, border: `3px solid ${t.cardBorder}`, borderTopColor: t.accent, borderRadius: "50%", animation: "spin .8s linear infinite", margin: "0 auto 12px" }}></div>
              <p style={{ color: t.textMuted, fontSize: 12 }}>Loading...</p>
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
          )}

          {/* ═══════════════ TAB: CONSOLE (WinBox Log window) ═══════════════ */}
          {activeTab === "console" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: t.green, animation: "pulse 2s infinite" }}></span>
                <span style={{ fontSize: 11, color: t.textMuted }}>Live · auto-refresh 15s</span>
                <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
              </div>
              <WinBoxLog entries={filteredTimeline} />
            </div>
          )}

          {/* ═══════════════ TAB: TIMELINE ═══════════════ */}
          {activeTab === "timeline" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

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
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: t.green, animation: "pulse 2s infinite" }}></span>
                <span style={{ fontSize: 11, color: t.textMuted }}>Live · auto-refresh 15s</span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: t.textMuted }}>{timeline.length} events</span>
                <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
              </div>

              {/* Timeline entries */}
              {filteredTimeline.length === 0 ? (
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
                        <div style={{ fontSize: 11, fontWeight: 600, color: t.text }} title={new Date(entry.ts).toLocaleString()}>
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
                          <Detail label="Time" val={new Date(entry.ts).toLocaleString()} />
                          <Detail label="Type" val={`${tc.icon} ${tc.label}`} />
                          <Detail label="Severity" val={entry.severity} />
                          {entry.user && <Detail label="User" val={entry.user} />}
                          {entry.email && <Detail label="Email" val={entry.email} />}
                          {entry.ipAddress && <Detail label="IP" val={entry.ipAddress} />}
                          {entry.action && <Detail label="Action" val={entry.action} />}
                          {entry.details && <Detail label="Details" val={entry.details} />}
                          {entry.message && <Detail label="Message" val={entry.message} />}
                          {entry.username && <Detail label="Username" val={entry.username} />}
                          {entry.nasName && <Detail label="NAS" val={`${entry.nasName} (${entry.nasIp || ""})`} />}
                          {entry.framedIp && <Detail label="Framed IP" val={entry.framedIp} />}
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
          {activeTab === "login" && (
            <LogTable data={filterData(loginLogs, ["email", "ipAddress", "user.name"])} d={d} t={t}
              headers={["User", "Email", "IP", "Status", "Time"]}
              render={(log: any) => (
                <tr key={log.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: `var(--surface-2)` }}>
                  <td style={{ padding: "8px 12px", fontSize: 12, fontWeight: 500 }}>{log.user?.name || "—"}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textSub }}>{log.email}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, fontFamily: "monospace", color: t.accent }}>{log.ipAddress}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <Badge color={log.status === "SUCCESS" ? "#4ade80" : "#f87171"} bg={log.status === "SUCCESS" ? "#14532d" : "#450a0a"}>
                      {log.status === "SUCCESS" ? "✅ Success" : "❌ Failed"}{log.failReason ? ` · ${log.failReason}` : ""}
                    </Badge>
                  </td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{new Date(log.createdAt).toLocaleString()}</td>
                </tr>
              )} />
          )}

          {/* ═══════════════ TAB: ACTIVITY LOGS ═══════════════ */}
          {activeTab === "activity" && (
            <LogTable data={filterData(activityLogs, ["user.name", "action", "entity", "details"])} d={d} t={t}
              headers={["User", "Action", "Entity", "Details", "IP", "Time"]}
              render={(log: any) => (
                <tr key={log.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: `var(--surface-2)` }}>
                  <td style={{ padding: "8px 12px", fontSize: 12, fontWeight: 500 }}>{log.user?.name || "System"}</td>
                  <td style={{ padding: "8px 12px" }}><Badge color="#60a5fa" bg="var(--surface)">{log.action}</Badge></td>
                  <td style={{ padding: "8px 12px", fontSize: 11 }}>{log.entity}{log.entityId ? ` #${log.entityId}` : ""}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textSub, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{log.details || "—"}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, fontFamily: "monospace" }}>{log.ipAddress || "—"}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{new Date(log.createdAt).toLocaleString()}</td>
                </tr>
              )} />
          )}

          {/* ═══════════════ TAB: NETWORK LOGS ═══════════════ */}
          {activeTab === "network" && (
            <LogTable data={filterData(networkLogs, ["nas?.nasname", "username", "message"])} d={d} t={t}
              headers={["NAS Device", "Event", "User", "Message", "Time"]}
              render={(log: any) => (
                <tr key={log.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: `var(--surface-2)` }}>
                  <td style={{ padding: "8px 12px" }}>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{log.nas?.nasname || "Unknown"}</div>
                    <div style={{ fontSize: 10, color: t.textMuted }}>{log.nas?.nasIp}</div>
                  </td>
                  <td style={{ padding: "8px 12px" }}><Badge color="#8b5cf6" bg="#3b0764">{log.eventType || "—"}</Badge></td>
                  <td style={{ padding: "8px 12px" }}>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{log.username || "—"}</div>
                    <div style={{ fontSize: 10, color: t.textMuted }}>{log.framedIp}</div>
                  </td>
                  <td style={{ padding: "8px 12px", fontSize: 12, maxWidth: 300 }}>
                    {log.message || "—"}
                    {log.severity === "ERROR" && <span style={{ color: t.red, fontSize: 10, marginLeft: 6 }}>⚠️</span>}
                  </td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{new Date(log.loggedAt || log.createdAt).toLocaleString()}</td>
                </tr>
              )} />
          )}

          {/* ═══════════════ TAB: SYSTEM LOGS ═══════════════ */}
          {activeTab === "system" && (
            <LogTable data={filterData(systemLogs, ["message", "source"])} d={d} t={t}
              headers={["Level", "Source", "Message", "Time"]}
              render={(log: any) => {
                const lc = log.level === "ERROR" ? { color: "#f87171", bg: "#450a0a" } : log.level === "WARNING" ? { color: "#fbbf24", bg: "#422006" } : { color: "#60a5fa", bg: "var(--surface)" };
                return (
                  <tr key={log.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: `var(--surface-2)` }}>
                    <td style={{ padding: "8px 12px" }}><Badge color={lc.color} bg={lc.bg}>{log.level}</Badge></td>
                    <td style={{ padding: "8px 12px", fontSize: 11 }}>{log.source}</td>
                    <td style={{ padding: "8px 12px", fontSize: 12 }}>{log.message}</td>
                    <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{new Date(log.createdAt).toLocaleString()}</td>
                  </tr>
                );
              }} />
          )}

          {/* ═══════════════ TAB: SESSIONS ═══════════════ */}
          {activeTab === "sessions" && (
            <LogTable data={sessions} d={d} t={t}
              headers={["User", "Role", "IP", "Login Time", "Expires"]}
              render={(s: any) => (
                <tr key={s.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: `var(--surface-2)` }}>
                  <td style={{ padding: "8px 12px" }}><div style={{ fontWeight: 600, fontSize: 12 }}>{s.user?.name}</div><div style={{ fontSize: 10, color: t.textMuted }}>{s.user?.email}</div></td>
                  <td style={{ padding: "8px 12px" }}><Badge color="#4ade80" bg="#14532d">{s.user?.role}</Badge></td>
                  <td style={{ padding: "8px 12px", fontSize: 11, fontFamily: "monospace", color: t.accent }}>{s.ipAddress}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{new Date(s.loginAt || s.createdAt).toLocaleString()}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.amber }}>{new Date(s.expiresAt).toLocaleString()}</td>
                </tr>
              )} />
          )}

          {/* ═══════════════ TAB: FAILED ACTIVATIONS ═══════════════ */}
          {activeTab === "failed" && (
            <LogTable data={failedActs} d={d} t={t}
              headers={["ID", "Username", "Reason", "Attempted By", "When"]}
              render={(f: any, i: number) => (
                <tr key={f.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: i % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{f.id}</td>
                  <td style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600 }}>{f.username || "—"}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>{f.reason}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textSub }}>{f.by}</td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: t.textMuted }}>{new Date(f.createdAt).toLocaleString()}</td>
                </tr>
              )}
              emptyMsg="No failed activations — good news." />
          )}

          {/* ═══════════════ TAB: RADIUS HEALTH ═══════════════ */}
          {activeTab === "radius" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ padding: "6px 14px", borderRadius: 20, fontSize: 12, fontWeight: 700,
                  background: diag?.summary?.failures ? "rgba(239,68,68,.15)" : diag?.summary?.warnings ? "rgba(245,158,11,.15)" : "rgba(34,197,94,.15)",
                  color: diag?.summary?.failures ? "#ef4444" : diag?.summary?.warnings ? "#f59e0b" : "#16a34a" }}>
                  {!diag ? "Checking…" : diag.summary.failures ? `${diag.summary.failures} problem(s)` : diag.summary.warnings ? `${diag.summary.warnings} warning(s)` : "✅ All systems healthy"}
                </div>
                <button onClick={loadDiag} disabled={diagBusy}
                  style={{ background: t.accent, color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: diagBusy ? .6 : 1 }}>
                  {diagBusy ? "⟳ Refreshing…" : "↻ Refresh"}
                </button>
                {!!diag?.staleSessions?.length && (
                  <button onClick={async () => { setDiagBusy(true); await fetch(`${API}/logs/radius/close-stale`, { method: "POST", headers }); loadDiag(); }}
                    disabled={diagBusy} style={{ background: "transparent", color: "#f59e0b", border: "1px solid #f59e0b", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                    Close {diag.staleSessions.length} stale
                  </button>
                )}
                <span style={{ fontSize: 11, color: t.textMuted, marginLeft: "auto" }}>Auto-refresh 30s</span>
              </div>

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

          {/* Footer */}
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${t.cardBorder}`, fontSize: 11, color: t.textMuted, textAlign: "center" }}>
            © {new Date().getFullYear()} <strong style={{ color: t.accent }}>JointBox</strong> ISP CRM Platform. All rights reserved.
          </div>
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
    <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
          <thead>
            <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
              {headers.map((h: string) => (
                <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>{data.map((row: any, i: number) => render(row, i))}</tbody>
        </table>
      </div>
    </div>
  );
}
