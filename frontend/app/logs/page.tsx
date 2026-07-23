"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";

const API = (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

// ─── Icons (Complete set matching dashboard) ──────────────────────────────────────────────────
const Icons = {
  Dashboard:   () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  Subscribers: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  Payments:    () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>,
  Invoices:    () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  Packages:    () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  Pool:        () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
  Vouchers:    () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h14"/><line x1="12" y1="4" x2="12" y2="20"/><path d="M20 15h2M20 19h2"/></svg>,
  NAS:         () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>,
  Areas:       () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  Complaints:  () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Reports:     () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  Users:       () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Logs:        () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  Settings:    () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83-2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  Menu:        () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>,
  ChevronLeft: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>,
  Sun:         () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>,
  Moon:        () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
  Refresh:     () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  Plus:        () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Logout:      () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  X:           () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Search:      () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
};

// ✅ Complete 14 menu items (matching dashboard)
export default function LogsPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [time, setTime] = useState("");
  const [greeting, setGreeting] = useState("Welcome");
  const [activeTab, setActiveTab] = useState("radius");
  const [diag, setDiag] = useState<any>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // Per-child drill-down: pick one downstream account to see just its logs
  // (that account and its own downline) instead of the whole merged feed.
  const [focusUser, setFocusUser] = useState("");
  const [accounts, setAccounts] = useState<any[]>([]);

  const [loginLogs, setLoginLogs] = useState<any[]>([]);
  const [activityLogs, setActivityLogs] = useState<any[]>([]);
  const [networkLogs, setNetworkLogs] = useState<any[]>([]);
  const [systemLogs, setSystemLogs] = useState<any[]>([]);
  const [pppoeLogs, setPppoeLogs] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [failedActs, setFailedActs] = useState<any[]>([]);
  
  const [stats, setStats] = useState({
    totalLogins: 0,
    totalActivities: 0,
    totalNetworkEvents: 0,
    failedAuth: 0,
    activeSessions: 0
  });

  const token = typeof window !== 'undefined' ? localStorage.getItem("token") : "";
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  useEffect(() => {
    if (activeTab !== "failed" || !token) return;
    fetch(`${API}/logs/failed-activations?limit=200`, { headers })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setFailedActs(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [activeTab, token]);

  // RADIUS health — auto-refreshes so you never need to SSH to check the server.
  const loadDiag = () => {
    if (!token) return;
    setDiagBusy(true);
    fetch(`${API}/logs/radius/diagnostics`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setDiag(d))
      .catch(() => {})
      .finally(() => setDiagBusy(false));
  };
  useEffect(() => {
    if (activeTab !== "radius" || !token) return;
    loadDiag();
    const iv = setInterval(loadDiag, 30_000);
    return () => clearInterval(iv);
  }, [activeTab, token]);

  const closeStale = async () => {
    setDiagBusy(true);
    try {
      await fetch(`${API}/logs/radius/close-stale`, { method: "POST", headers });
      loadDiag();
    } finally {
      setDiagBusy(false);
    }
  };

  const d = darkMode;
  const t = {
    bg:          d ? "var(--bg)" : "#f0f4fa",
    sidebar:     d ? "var(--surface)" : "var(--border)",
    card:        d ? "var(--surface)" : "#ffffff",
    cardBorder:  d ? "var(--border)" : "var(--text)",
    header:      d ? "var(--surface)" : "var(--border)",
    text:        d ? "var(--text)" : "var(--surface)",
    textMuted:   d ? "var(--muted)" : "var(--muted)",
    textSub:     d ? "var(--muted)" : "#475569",
    input:       d ? "var(--bg)" : "#f8fafc",
    inputBorder: d ? "var(--border)" : "#cbd5e1",
    tableRow:    d ? "var(--surface-2)" : "#f8fafc",
    tableRow2:   d ? "#121d30" : "#ffffff",
    accent:      "#0ea5e9",
    green:       "#22c55e",
    red:         "#ef4444",
    amber:       "#f59e0b",
    purple:      "#8b5cf6",
  };

  useEffect(() => {
    if (!token) {
      router.push("/login");
      return;
    }

    fetch(`${API}/profile`, { headers })
      .then(res => {
        if (res.status === 401) {
          localStorage.removeItem("token");
          router.push("/login");
          return null;
        }
        return res.json();
      })
      .then(data => {
        if (data?.user) setUser(data.user);
      })
      .catch(err => console.error("Profile fetch error:", err));

    fetchAllLogs();

    // Downstream accounts, to populate the drill-down picker. /users already
    // returns only the caller's own subtree.
    fetch(`${API}/users`, { headers })
      .then(r => (r.ok ? r.json() : []))
      .then(rows => setAccounts(Array.isArray(rows) ? rows : rows?.data ?? []))
      .catch(() => {});

    const tick = () => {
      const now = new Date();
      const h = now.getHours();
      setGreeting(h < 12 ? "Good Morning" : h < 18 ? "Good Afternoon" : "Good Evening");
      setTime(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Re-pull when the drill-down target changes (skips the initial mount, which
  // the auth effect above already covers).
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    if (token) fetchAllLogs();
  }, [focusUser]);

  const fetchAllLogs = async () => {
    setLoading(true);

    try {
      const fu = focusUser ? `&forUser=${focusUser}` : "";
      const fuq = focusUser ? `?forUser=${focusUser}` : "";
      const [loginRes, activityRes, networkRes, systemRes, sessionsRes] = await Promise.all([
        fetch(`${API}/logs/login?limit=100${fu}`, { headers }).catch(() => null),
        fetch(`${API}/logs/activity?limit=100${fu}`, { headers }).catch(() => null),
        fetch(`${API}/logs/network?limit=100`, { headers }).catch(() => null),
        fetch(`${API}/logs/system?limit=100`, { headers }).catch(() => null),
        fetch(`${API}/logs/sessions${fuq}`, { headers }).catch(() => null),
      ]);

      let loginData: any[] = [];
      let activityData: any[] = [];
      let networkData: any[] = [];

      if (loginRes && loginRes.ok) {
        const data = await loginRes.json();
        loginData = data.logs || [];
        setLoginLogs(loginData);
      }

      if (activityRes && activityRes.ok) {
        const data = await activityRes.json();
        activityData = data.logs || [];
        setActivityLogs(activityData);
      }

      if (networkRes && networkRes.ok) {
        const data = await networkRes.json();
        networkData = data.logs || [];
        setNetworkLogs(networkData);
        const pppoe = networkData.filter((log: any) => 
          log.eventType === 'PPPoE' || log.eventType === 'RADIUS' || 
          log.message?.includes('PPP') || log.message?.includes('PPPoE')
        );
        setPppoeLogs(pppoe);
      }

      if (systemRes && systemRes.ok) {
        const data = await systemRes.json();
        setSystemLogs(data.logs || []);
      }

      let sessionsData: any[] = [];
      if (sessionsRes && sessionsRes.ok) {
        const data = await sessionsRes.json();
        sessionsData = Array.isArray(data) ? data : [];
        setSessions(sessionsData);
      }

      setStats({
        totalLogins: loginData.length,
        totalActivities: activityData.length,
        totalNetworkEvents: networkData.length,
        failedAuth: networkData.filter((l: any) => l.status === "FAILED").length,
        activeSessions: sessionsData.length
      });

    } catch (error) {
      console.error("Error fetching logs:", error);
    } finally {
      setLoading(false);
    }
  };

  const getInitials = (name?: string) => {
    if (!name) return "U";
    return name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
  };

  const Btn = ({ onClick, children, variant = "default", size = "sm", disabled = false, title = "" }: any) => {
    const vs: Record<string, React.CSSProperties> = {
      default: { background: "var(--border)", color: t.textSub },
      primary: { background: t.accent,  color: "#fff" },
      success: { background: "#14532d", color: "#4ade80" },
      danger:  { background: "#450a0a", color: "#f87171" },
      warning: { background: "#422006", color: "#fbbf24" },
      ghost:   { background: "transparent", color: t.textSub, border: `1px solid ${t.cardBorder}` },
    };
    return (
      <button onClick={onClick} disabled={disabled} title={title} style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: size === "xs" ? "3px 8px" : "5px 12px",
        borderRadius: 6, border: "none", cursor: disabled ? "not-allowed" : "pointer",
        fontSize: size === "xs" ? 11 : 12, fontWeight: 600, opacity: disabled ? 0.5 : 1,
        transition: "all .15s", ...vs[variant],
      }}>{children}</button>
    );
  };

  const Badge = ({ children, color, bg }: { children: React.ReactNode; color: string; bg: string }) => (
    <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, color, background: bg, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );

  const getStatusColor = (status: string) => {
    switch(status?.toUpperCase()) {
      case 'SUCCESS': return { bg: '#14532d', color: '#4ade80' };
      case 'FAILED': return { bg: '#450a0a', color: '#f87171' };
      default: return { bg: 'var(--border)', color: 'var(--muted)' };
    }
  };

  const getLevelColor = (level: string) => {
    switch(level?.toUpperCase()) {
      case 'ERROR': return { bg: '#450a0a', color: '#f87171' };
      case 'WARNING': return { bg: '#422006', color: '#fbbf24' };
      case 'INFO': return { bg: 'var(--surface)', color: '#60a5fa' };
      default: return { bg: 'var(--border)', color: 'var(--muted)' };
    }
  };

  const filterData = (data: any[], searchFields: string[]) => {
    if (!search) return data;
    const query = search.toLowerCase();
    return data.filter((item) =>
      searchFields.some((field) => {
        const value = field.split(".").reduce((obj: any, key: string) => obj?.[key], item);
        return String(value || "").toLowerCase().includes(query);
      })
    );
  };

  const statCards = [
    { label: "Total Logins", value: loginLogs.length, sub: "all login attempts", icon: "🔐", bg: "linear-gradient(135deg,#3b82f6,#2563eb)" },
    { label: "Activities", value: activityLogs.length, sub: "user actions", icon: "📝", bg: "linear-gradient(135deg,#a855f7,#7c3aed)" },
    { label: "Network Events", value: networkLogs.length, sub: "NAS & RADIUS logs", icon: "🖧", bg: "linear-gradient(135deg,#10b981,#059669)" },
    { label: "Failed Auth", value: stats.failedAuth, sub: "failed attempts", icon: "❌", bg: "linear-gradient(135deg,#ef4444,#dc2626)" },
    { label: "Active Sessions", value: sessions.length, sub: "current users", icon: "🟢", bg: "linear-gradient(135deg,#f59e0b,#d97706)" },
  ];

  const tabs = [
    { id: "radius", label: "🩺 RADIUS Health" },
    { id: "login", label: "🔐 Login Logs" },
    { id: "activity", label: "📝 Activity Logs" },
    { id: "network", label: "🖧 Network Logs" },
    { id: "pppoe", label: "📡 PPPoE / RADIUS" },
    { id: "system", label: "⚙️ System Logs" },
    { id: "sessions", label: "🟢 Web Sessions" },
    { id: "failed", label: "⛔ Failed Activations" },
  ];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: t.bg, color: t.text, fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>

      {/* MAIN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* CONTENT */}
        <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>
          
          {/* Stat Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12, marginBottom: 24 }}>
            {statCards.map((card, idx) => (
              <div key={idx} style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: "14px", transition: "transform .15s" }}
                onMouseEnter={e => (e.currentTarget.style.transform = "translateY(-2px)")}
                onMouseLeave={e => (e.currentTarget.style.transform = "")}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", background: card.bg, fontSize: 18 }}>{card.icon}</div>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "rgba(14,165,233,0.15)", color: t.accent }}>Live</span>
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: t.textMuted }}>{card.label}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: t.text }}>{loading ? "—" : card.value}</div>
                <div style={{ fontSize: 10, color: t.textMuted, marginTop: 4 }}>{card.sub}</div>
              </div>
            ))}
          </div>

          {/* Search Bar + per-account drill-down */}
          <div style={{ marginBottom: 20, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div style={{ position: "relative", flex: 1, minWidth: 220 }}>
              <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: t.textMuted }}><Icons.Search /></span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search logs by user, IP, action, message, username..."
                style={{
                  width: "100%",
                  padding: "10px 12px 10px 38px",
                  borderRadius: 10,
                  border: `1px solid ${t.cardBorder}`,
                  fontSize: 12,
                  background: t.input,
                  color: t.text,
                  outline: "none",
                }}
                onFocus={(e) => { e.target.style.borderColor = t.accent; }}
                onBlur={(e) => { e.target.style.borderColor = t.cardBorder; }}
              />
            </div>
            {/* Pick one downstream account to see just its logs — a parent can
                inspect Booni alone, or Mastuj alone, instead of the merged feed. */}
            {accounts.length > 0 && (
              <select
                value={focusUser}
                onChange={(e) => setFocusUser(e.target.value)}
                title="Show logs for one account (and its downline) only"
                style={{
                  minWidth: 200, padding: "10px 12px", borderRadius: 10,
                  border: `1px solid ${focusUser ? t.accent : t.cardBorder}`,
                  fontSize: 12, background: t.input, color: t.text, cursor: "pointer",
                }}
              >
                <option value="">All accounts (my whole downline)</option>
                {accounts.map((u: any) => (
                  <option key={u.id} value={u.id}>{u.name} · {u.role}</option>
                ))}
              </select>
            )}
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 6, marginBottom: 20, borderBottom: `1px solid ${t.cardBorder}`, paddingBottom: 12, flexWrap: "wrap" }}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: "6px 16px",
                  background: activeTab === tab.id ? t.accent : "transparent",
                  color: activeTab === tab.id ? "#fff" : t.textSub,
                  border: activeTab === tab.id ? "none" : `1px solid ${t.cardBorder}`,
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 500,
                  transition: "all 0.2s",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ width: 36, height: 36, border: `3px solid ${t.cardBorder}`, borderTopColor: t.accent, borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 14px" }}></div>
              <p style={{ color: t.textMuted, fontSize: 13 }}>Loading logs...</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          ) : (
            <>
              {/* ── RADIUS HEALTH ─────────────────────────────────
                  Surfaces everything that previously required SSH-ing
                  into the RADIUS server: clock skew, stale sessions,
                  interim-update flow, NAS client validity, schema, and
                  whether requests are arriving at all. */}
              {activeTab === "radius" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div style={{
                      padding: "6px 14px", borderRadius: 20, fontSize: 12, fontWeight: 700,
                      background: diag?.summary?.failures ? "rgba(239,68,68,.15)" : diag?.summary?.warnings ? "rgba(245,158,11,.15)" : "rgba(34,197,94,.15)",
                      color: diag?.summary?.failures ? "#ef4444" : diag?.summary?.warnings ? "#f59e0b" : "#16a34a",
                    }}>
                      {!diag ? "Checking…" : diag.summary.failures ? `${diag.summary.failures} problem(s)` : diag.summary.warnings ? `${diag.summary.warnings} warning(s)` : "All systems healthy"}
                    </div>
                    <button onClick={loadDiag} disabled={diagBusy} style={{ background: t.accent, color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: diagBusy ? .6 : 1 }}>
                      {diagBusy ? "Refreshing…" : "Refresh"}
                    </button>
                    {!!diag?.staleSessions?.length && (
                      <button onClick={closeStale} disabled={diagBusy} style={{ background: "transparent", color: "#f59e0b", border: "1px solid #f59e0b", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                        Close {diag.staleSessions.length} stale session(s)
                      </button>
                    )}
                    <span style={{ fontSize: 11, color: t.textMuted, marginLeft: "auto" }}>Auto-refresh 30s</span>
                  </div>

                  {/* Checks */}
                  <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
                    {(diag?.checks || []).map((c: any) => {
                      const col = c.status === "FAIL" ? "#ef4444" : c.status === "WARN" ? "#f59e0b" : "#16a34a";
                      return (
                        <div key={c.key} style={{ display: "flex", gap: 12, padding: "12px 14px", borderBottom: `1px solid ${t.cardBorder}`, alignItems: "flex-start" }}>
                          <span style={{ color: col, fontSize: 14, lineHeight: "18px", flexShrink: 0 }}>
                            {c.status === "FAIL" ? "✖" : c.status === "WARN" ? "▲" : "✔"}
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 12.5, fontWeight: 700, color: t.text }}>{c.label}</div>
                            <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>{c.detail}</div>
                            {c.hint && (
                              <div style={{ fontSize: 11.5, color: t.textMuted, marginTop: 5, padding: "6px 9px", background: d ? "var(--surface-2)" : "#f8fafc", borderLeft: `2px solid ${col}`, borderRadius: 4 }}>
                                💡 {c.hint}
                              </div>
                            )}
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 800, color: col, flexShrink: 0 }}>{c.status}</span>
                        </div>
                      );
                    })}
                    {!diag && <div style={{ padding: 18, fontSize: 12, color: t.textMuted }}>Loading RADIUS diagnostics…</div>}
                  </div>

                  {/* Stale sessions detail */}
                  {!!diag?.staleSessions?.length && (
                    <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
                      <div style={{ padding: "10px 14px", fontSize: 12.5, fontWeight: 700, color: t.text, borderBottom: `1px solid ${t.cardBorder}` }}>
                        Stale sessions — NAS stopped reporting without closing these
                      </div>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
                          <thead>
                            <tr style={{ background: d ? "var(--bg)" : "#f1f5f9" }}>
                              {["Username", "NAS IP", "Leased IP", "MAC", "Silent for"].map((h) => (
                                <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {diag.staleSessions.map((s: any, i: number) => (
                              <tr key={i} style={{ borderTop: `1px solid ${t.cardBorder}` }}>
                                <td style={{ padding: "8px 12px", fontSize: 12, color: t.text, fontWeight: 600 }}>{s.username}</td>
                                <td style={{ padding: "8px 12px", fontSize: 12, color: t.textSub }}>{s.nasipaddress}</td>
                                <td style={{ padding: "8px 12px", fontSize: 12, color: t.textSub }}>{s.framedipaddress || "—"}</td>
                                <td style={{ padding: "8px 12px", fontSize: 11.5, color: t.textMuted }}>{s.callingstationid || "—"}</td>
                                <td style={{ padding: "8px 12px", fontSize: 12, color: "#f59e0b", fontWeight: 600 }}>
                                  {Math.floor((s.silent_seconds || 0) / 60)} min
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Login Logs Table */}
              {activeTab === "login" && (
                <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
                      <thead>
                        <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>User</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Email</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>IP Address</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Status</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filterData(loginLogs, ["email", "ipAddress", "user.name"]).map((log: any, i: number) => {
                          const statusColor = getStatusColor(log.status);
                          return (
                            <tr key={log.id || i} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: i % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                              <td style={{ padding: "10px 14px", fontSize: 12, fontWeight: 500 }}>{log.user?.name || "Unknown"}</td>
                              <td style={{ padding: "10px 14px", fontSize: 11, color: t.textSub }}>{log.email}</td>
                              <td style={{ padding: "10px 14px", fontSize: 11, fontFamily: "monospace", color: t.accent }}>{log.ipAddress}</td>
                              <td style={{ padding: "10px 14px" }}>
                                <Badge color={statusColor.color} bg={statusColor.bg}>{log.status === "SUCCESS" ? "Success" : "Failed"}</Badge>
                              </td>
                              <td style={{ padding: "10px 14px", fontSize: 11, color: t.textMuted }}>{new Date(log.createdAt).toLocaleString()}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Activity Logs Table */}
              {activeTab === "activity" && (
                <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
                      <thead>
                        <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>User</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Action</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Entity</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>IP Address</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filterData(activityLogs, ["user.name", "action", "entity"]).map((log: any, i: number) => (
                          <tr key={log.id || i} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: i % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                            <td style={{ padding: "10px 14px", fontSize: 12, fontWeight: 500 }}>{log.user?.name || "System"}</td>
                            <td style={{ padding: "10px 14px" }}><Badge color="#60a5fa" bg="var(--surface)">{log.action}</Badge></td>
                            <td style={{ padding: "10px 14px", fontSize: 11 }}>{log.entity}</td>
                            <td style={{ padding: "10px 14px", fontSize: 11, fontFamily: "monospace" }}>{log.ipAddress || "-"}</td>
                            <td style={{ padding: "10px 14px", fontSize: 11, color: t.textMuted }}>{new Date(log.createdAt).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Network Logs Table */}
              {activeTab === "network" && (
                <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                      <thead>
                        <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>NAS Device</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Event</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Username</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Message</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Status</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filterData(networkLogs, ["nas.nasName", "username", "message"]).map((log: any, i: number) => {
                          const statusColor = getStatusColor(log.status);
                          return (
                            <tr key={log.id || i} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: i % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                              <td style={{ padding: "10px 14px" }}>
                                <div style={{ fontWeight: 600, fontSize: 12 }}>{log.nas?.nasName || "Unknown"}</div>
                                <div style={{ fontSize: 10, color: t.textMuted }}>{log.nas?.nasIp}</div>
                              </td>
                              <td style={{ padding: "10px 14px" }}><Badge color="#8b5cf6" bg="#3b0764">{log.eventType || "Unknown"}</Badge></td>
                              <td style={{ padding: "10px 14px" }}>
                                <div style={{ fontWeight: 600, fontSize: 12 }}>{log.username || "-"}</div>
                                <div style={{ fontSize: 10, color: t.textMuted }}>{log.framedIp}</div>
                              </td>
                              <td style={{ padding: "10px 14px", fontSize: 12 }}>{log.message}{log.failReason && <div style={{ color: t.red, fontSize: 10, marginTop: 2 }}>⚠️ {log.failReason}</div>}</td>
                              <td style={{ padding: "10px 14px" }}>{log.status && <Badge color={statusColor.color} bg={statusColor.bg}>{log.status}</Badge>}</td>
                              <td style={{ padding: "10px 14px", fontSize: 11, color: t.textMuted }}>{new Date(log.loggedAt || log.createdAt).toLocaleString()}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* PPPoE Logs Table */}
              {activeTab === "pppoe" && (
                <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
                      <thead>
                        <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Time</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Username</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>NAS</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Event</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Details</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filterData(pppoeLogs, ["username", "message"]).map((log: any, i: number) => {
                          const statusColor = getStatusColor(log.status);
                          return (
                            <tr key={log.id || i} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: i % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                              <td style={{ padding: "10px 14px", fontSize: 11, color: t.textMuted }}>{new Date(log.loggedAt || log.createdAt).toLocaleString()}</td>
                              <td style={{ padding: "10px 14px" }}><div style={{ fontWeight: 600, fontSize: 12 }}>{log.username || "-"}</div><div style={{ fontSize: 10, color: t.textMuted }}>{log.framedIp}</div></td>
                              <td style={{ padding: "10px 14px", fontSize: 11 }}>{log.nas?.nasName}<br/>{log.nas?.nasIp}</td>
                              <td style={{ padding: "10px 14px" }}><Badge color="#60a5fa" bg="var(--surface)">{log.eventType}</Badge></td>
                              <td style={{ padding: "10px 14px", fontSize: 12 }}>{log.message}{log.failReason && <div style={{ color: t.red, fontSize: 10, marginTop: 2 }}>❌ {log.failReason}</div>}</td>
                              <td style={{ padding: "10px 14px" }}>{log.status && <Badge color={statusColor.color} bg={statusColor.bg}>{log.status}</Badge>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* System Logs Table */}
              {activeTab === "system" && (
                <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 600 }}>
                      <thead>
                        <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Level</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Source</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Message</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filterData(systemLogs, ["message", "source"]).map((log: any, i: number) => {
                          const levelColor = getLevelColor(log.level);
                          return (
                            <tr key={log.id || i} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: i % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                              <td style={{ padding: "10px 14px" }}><Badge color={levelColor.color} bg={levelColor.bg}>{log.level}</Badge></td>
                              <td style={{ padding: "10px 14px", fontSize: 11 }}>{log.source}</td>
                              <td style={{ padding: "10px 14px", fontSize: 12 }}>{log.message}</td>
                              <td style={{ padding: "10px 14px", fontSize: 11, color: t.textMuted }}>{new Date(log.createdAt).toLocaleString()}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Web Sessions Table */}
              {activeTab === "sessions" && (
                <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
                      <thead>
                        <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>User</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Role</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>IP Address</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Login Time</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Expires</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sessions.map((session: any, i: number) => (
                          <tr key={session.id || i} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: i % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                            <td style={{ padding: "10px 14px" }}><div style={{ fontWeight: 600, fontSize: 12 }}>{session.user?.name}</div><div style={{ fontSize: 10, color: t.textMuted }}>{session.user?.email}</div></td>
                            <td style={{ padding: "10px 14px" }}><Badge color="#4ade80" bg="#14532d">{session.user?.role}</Badge></td>
                            <td style={{ padding: "10px 14px", fontSize: 11, fontFamily: "monospace", color: t.accent }}>{session.ipAddress}</td>
                            <td style={{ padding: "10px 14px", fontSize: 11, color: t.textMuted }}>{new Date(session.loginAt || session.createdAt).toLocaleString()}</td>
                            <td style={{ padding: "10px 14px", fontSize: 11, color: t.amber }}>{new Date(session.expiresAt).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Failed Activations Table */}
              {activeTab === "failed" && (
                <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${t.cardBorder}` }}>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>ID</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Username</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Reason</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>Attempted By</th>
                          <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted }}>When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {failedActs.map((f: any, i: number) => (
                          <tr key={f.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: i % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                            <td style={{ padding: "10px 14px", fontSize: 11, color: t.textMuted }}>{f.id}</td>
                            <td style={{ padding: "10px 14px", fontSize: 12, fontWeight: 600 }}>{f.username || "—"}</td>
                            <td style={{ padding: "10px 14px", fontSize: 11, color: "#f87171" }}>{f.reason}</td>
                            <td style={{ padding: "10px 14px", fontSize: 11, color: t.textSub }}>{f.by}</td>
                            <td style={{ padding: "10px 14px", fontSize: 11, color: t.textMuted }}>{new Date(f.createdAt).toLocaleString()}</td>
                          </tr>
                        ))}
                        {failedActs.length === 0 && (
                          <tr><td colSpan={5} style={{ padding: "20px", textAlign: "center", color: t.textMuted, fontSize: 12 }}>No failed activations — good news.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Footer */}
          <div className="page-footer" style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${t.cardBorder}`, fontSize: 11, color: t.textMuted, textAlign: "center" }}>
            © {new Date().getFullYear()} <strong style={{ color: t.accent }}>JointBox</strong> ISP CRM Platform. All rights reserved.
          </div>
        </div>
      </div>
    </div>
  );
}
