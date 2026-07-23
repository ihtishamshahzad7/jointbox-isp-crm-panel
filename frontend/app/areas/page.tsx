"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Wizard, Field } from "../components/wizard";

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
  Settings:    () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  Menu:        () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>,
  ChevronLeft: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>,
  Sun:         () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>,
  Moon:        () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
  Refresh:     () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  Plus:        () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Logout:      () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  X:           () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Search:      () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  Edit:        () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Trash:       () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
  Eye:         () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
};

// ✅ Complete 14 menu items (matching dashboard)
export default function AreasPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [time, setTime] = useState("");
  const [greeting, setGreeting] = useState("Welcome");
  const [areas, setAreas] = useState<any[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, inactive: 0 });
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const [form, setForm] = useState({ name: '', city: '', description: '' });

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : '';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── Theme ─────────────────────────────────────────────────────────────
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
    const token = localStorage.getItem("token");
    if (!token) { router.push("/login"); return; }

    fetch(`${API}/profile`, { headers })
      .then((r) => r.json())
      .then((d) => setUser(d.user))
      .catch(() => router.push("/login"));

    loadData();

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

  async function loadData() {
    setLoading(true);
    try {
      const [areaRes, statRes] = await Promise.all([
        fetch(`${API}/areas`, { headers }),
        fetch(`${API}/areas/stats`, { headers }),
      ]);
      
      const areasData = await areaRes.json();
      setAreas(Array.isArray(areasData) ? areasData : areasData?.data || []);
      
      const statsData = await statRes.json();
      if (statsData && typeof statsData.total === 'number') {
        setStats(statsData);
      }
    } catch (error) {
      console.error('Error loading areas:', error);
      setAreas([]);
    }
    setLoading(false);
  }

  async function handleSubmit(e: any) {
    e.preventDefault();
    if (!form.name) {
      alert("Area name is required.");
      return;
    }
    
    /**
     * The response was never checked.
     *
     * `await fetch(...)` resolves for a 403 or a 500 exactly as it does for a
     * 201 — fetch only rejects on a network failure. So the dialog closed, the
     * list refreshed, and the area silently did not exist. A permission error
     * and a success were indistinguishable from the outside.
     */
    try {
      const res = editItem
        ? await fetch(`${API}/areas/${editItem.id}`, { method: 'PUT', headers, body: JSON.stringify(form) })
        : await fetch(`${API}/areas`, { method: 'POST', headers, body: JSON.stringify(form) });

      if (!res.ok) {
        const body: any = await res.json().catch(() => null);
        const msg = Array.isArray(body?.message) ? body.message.join(' ') : body?.message;
        throw new Error(msg || `Could not save this area (HTTP ${res.status})`);
      }

      setShowForm(false);
      setEditItem(null);
      setForm({ name: '', city: '', description: '' });
      loadData();
    } catch (err: any) {
      // Thrown on, so the wizard holds the dialog open and names the reason.
      throw err instanceof Error ? err : new Error('Save failed');
    }
  }

  async function handleDelete(id: number, name: string) {
    if (!confirm(`Delete area "${name}"? This will affect subscribers in this area.`)) return;
    await fetch(`${API}/areas/${id}`, { method: 'DELETE', headers });
    loadData();
  }

  async function handleToggle(id: number) {
    await fetch(`${API}/areas/${id}/toggle`, { method: 'PATCH', headers });
    loadData();
  }

  function openEdit(area: any) {
    setEditItem(area);
    setForm({
      name: area.name,
      city: area.city || '',
      description: area.description || '',
    });
    setShowForm(true);
  }

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

  const statCards = [
    { label: "Total Areas", value: stats.total, sub: "coverage zones", icon: "📍", bg: "linear-gradient(135deg,#3b82f6,#2563eb)" },
    { label: "Active Areas", value: stats.active, sub: "operational zones", icon: "✅", bg: "linear-gradient(135deg,#10b981,#059669)" },
    { label: "Inactive Areas", value: stats.inactive, sub: "temporarily offline", icon: "⭕", bg: "linear-gradient(135deg,#f59e0b,#d97706)" },
  ];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: t.bg, color: t.text, fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>

      {/* ══════════ MAIN ══════════ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* ── CONTENT ── */}
        <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>

          {/* Page header with a persistent Add button */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
            <div>
            </div>
            <button
              onClick={() => { setEditItem(null); setForm({ name: '', city: '', description: '' }); setShowForm(true); }}
              style={{ background: t.accent, color: "#fff", border: "none", padding: "10px 18px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              + Add Area
            </button>
          </div>

          {/* Stat Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12, marginBottom: 24 }}>
            {statCards.map((card, idx) => (
              <div key={idx} style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: "16px", transition: "transform .15s" }}
                onMouseEnter={e => (e.currentTarget.style.transform = "translateY(-2px)")}
                onMouseLeave={e => (e.currentTarget.style.transform = "")}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", background: card.bg, fontSize: 20 }}>{card.icon}</div>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "rgba(14,165,233,0.15)", color: t.accent }}>Live</span>
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: t.textMuted }}>{card.label}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: t.text }}>{loading ? "—" : card.value}</div>
                <div style={{ fontSize: 11, color: t.textMuted, marginTop: 6 }}>{card.sub}</div>
              </div>
            ))}
          </div>

          {/* Areas Grid */}
          {loading ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ width: 36, height: 36, border: `3px solid ${t.cardBorder}`, borderTopColor: t.accent, borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 14px" }}></div>
              <p style={{ color: t.textMuted, fontSize: 13 }}>Loading areas...</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          ) : areas.length === 0 ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>📍</div>
              <h3 style={{ fontSize: 18, color: t.text, marginBottom: 6 }}>No Areas Yet</h3>
              <p style={{ color: t.textMuted, fontSize: 13, marginBottom: 20 }}>Add your first coverage area to start assigning subscribers.</p>
              <button onClick={() => { setEditItem(null); setForm({ name: '', city: '', description: '' }); setShowForm(true); }} style={{ background: t.accent, color: "#fff", border: "none", padding: "10px 22px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>+ Add Your First Area</button>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
              {areas.map((area: any) => (
                <div key={area.id} style={{
                  background: t.card,
                  borderRadius: 12,
                  padding: "16px",
                  border: `1px solid ${t.cardBorder}`,
                  transition: "transform .15s",
                  opacity: area.isActive ? 1 : 0.7,
                  cursor: "pointer",
                }}
                onClick={() => setViewItem(area)}
                title="Open area"
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.transform = "translateY(-2px)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.transform = "";
                }}>
                  {/* Header */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: "rgba(14,165,233,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>📍</div>
                    <div style={{ flex: 1 }}>
                      <h3 style={{ fontSize: 15, fontWeight: 700, color: t.text, margin: 0 }}>{area.name}</h3>
                      {area.city && <p style={{ fontSize: 11, color: t.textMuted, margin: "2px 0 0" }}>{area.city}</p>}
                    </div>
                    <Badge color={area.isActive ? "#4ade80" : "var(--muted)"} bg={area.isActive ? "#14532d" : "var(--border)"}>
                      {area.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>

                  {/* Description */}
                  {area.description && (
                    <p style={{ fontSize: 11, color: t.textSub, lineHeight: 1.4, margin: "0 0 12px", padding: "8px 10px", background: d ? "var(--bg)" : "#f8fafc", borderRadius: 8 }}>{area.description}</p>
                  )}

                  {/* Stats */}
                  <div style={{ background: d ? "var(--bg)" : "#f8fafc", borderRadius: 8, padding: "8px 12px", margin: "12px 0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 11, color: t.textMuted }}>📊 Subscribers</span>
                      <span style={{ fontSize: 15, fontWeight: 700, color: t.green }}>{area._count?.subscribers ?? 0}</span>
                    </div>
                  </div>

                  {/* Actions — stop propagation so they don't also open the card */}
                  <div style={{ display: "flex", gap: 6, marginTop: 12 }} onClick={(e) => e.stopPropagation()}>
                    <Btn onClick={() => setViewItem(area)} variant="default" size="xs"><Icons.Eye /> View</Btn>
                    <Btn onClick={() => openEdit(area)} variant="warning" size="xs"><Icons.Edit /> Edit</Btn>
                    <Btn onClick={() => handleToggle(area.id)} variant={area.isActive ? "danger" : "success"} size="xs">
                      {area.isActive ? "Deactivate" : "Activate"}
                    </Btn>
                    <Btn onClick={() => handleDelete(area.id, area.name)} variant="danger" size="xs"><Icons.Trash /></Btn>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Footer */}
          <div className="page-footer" style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${t.cardBorder}`, fontSize: 11, color: t.textMuted, textAlign: "center" }}>
            © {new Date().getFullYear()} <strong style={{ color: t.accent }}>JointBox</strong> ISP CRM Platform. All rights reserved.
          </div>
        </div>
      </div>

      {/* Add/Edit Modal */}
      {showForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setShowForm(false)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 500, maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>{editItem ? '✏️ Edit Area' : '📍 Add New Area'}</h2>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>
            <p style={{ fontSize: 11, color: t.textMuted, marginBottom: 20 }}>Define coverage zones for your subscribers.</p>

            {/* Stepped form for NEW areas; editing keeps the single page.
                An area is only three fields, so this is one step plus review —
                the value is consistency with every other create form, not the
                stepping itself. */}
            {!editItem && (
              <Wizard
                onCancel={() => setShowForm(false)}
                onFinish={() => handleSubmit({ preventDefault: () => {} } as any)}
                finishLabel="Create area"
                steps={[{
                  id: "area",
                  title: "Area",
                  hint: "A named place you can filter subscribers and outages by. Most operators use the neighbourhood or village name.",
                  validate: () => (form.name.trim() ? null : "An area name is required."),
                  summary: () => [
                    ["Name", form.name],
                    ["City", form.city],
                    ["Description", form.description],
                  ],
                  render: () => (
                    <>
                      <Field label="Area name" required hint="e.g. Booni, Sor Laspur, Gulberg.">
                        <input value={form.name}
                          onChange={(e) => setForm({ ...form, name: e.target.value })} />
                      </Field>
                      <Field label="City / district">
                        <input value={form.city}
                          onChange={(e) => setForm({ ...form, city: e.target.value })} />
                      </Field>
                      <Field label="Description" hint="Optional note — coverage, landmark, anything useful.">
                        <input value={form.description}
                          onChange={(e) => setForm({ ...form, description: e.target.value })} />
                      </Field>
                    </>
                  ),
                }]}
              />
            )}

            {editItem && (
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Area Name *</label>
                <input 
                  value={form.name} 
                  onChange={e => setForm({ ...form, name: e.target.value })} 
                  placeholder="e.g., Gulshan, DHA, Gulberg" 
                  required 
                  style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }} 
                />
                <p style={{ fontSize: 10, color: t.textMuted, marginTop: 3 }}>This name will appear in subscriber forms and reports.</p>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>City / Location</label>
                <input 
                  value={form.city} 
                  onChange={e => setForm({ ...form, city: e.target.value })} 
                  placeholder="e.g., Karachi, Lahore, Islamabad" 
                  style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }} 
                />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Description</label>
                <textarea 
                  value={form.description} 
                  onChange={e => setForm({ ...form, description: e.target.value })} 
                  placeholder="Additional information about this area..." 
                  rows={2} 
                  style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text, resize: "none" }} 
                />
              </div>

              <div style={{ background: d ? "var(--surface)" : "#eff6ff", borderRadius: 8, padding: 10, fontSize: 11, color: d ? "#93c5fd" : "#1e40af", margin: "16px 0" }}>
                💡 <strong>Tip:</strong> Areas help organize subscribers by location. Each subscriber can be assigned to one area.
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button type="submit" style={{ flex: 1, background: t.accent, color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{editItem ? 'Update Area' : 'Save Area'}</button>
                <button type="button" onClick={() => setShowForm(false)} style={{ flex: 1, background: "transparent", border: `1px solid ${t.cardBorder}`, color: t.textSub, padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              </div>
            </form>
            )}
          </div>
        </div>
      )}

      {/* View Modal */}
      {viewItem && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setViewItem(null)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 450 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>📍 Area Details</h2>
              <button onClick={() => setViewItem(null)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>
            
            <div style={{ margin: "16px 0" }}>
              {[
                ["Area Name", viewItem.name],
                ["City", viewItem.city || "—"],
                ["Description", viewItem.description || "—"],
                ["Status", viewItem.isActive ? "Active" : "Inactive"],
                ["Subscribers", viewItem._count?.subscribers ?? 0],
                ["Created", new Date(viewItem.createdAt).toLocaleString()],
                ["Last Updated", new Date(viewItem.updatedAt).toLocaleString()],
              ].map(([k, v]) => (
                <div key={String(k)} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${t.cardBorder}` }}>
                  <span style={{ fontSize: 11, color: t.textMuted, fontWeight: 500 }}>{k}:</span>
                  <span style={{ fontSize: 11, color: t.text, fontWeight: 600 }}>{String(v)}</span>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button onClick={() => { setViewItem(null); openEdit(viewItem); }} style={{ flex: 1, background: t.accent, color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Edit Area</button>
              <button onClick={() => setViewItem(null)} style={{ flex: 1, background: "transparent", border: `1px solid ${t.cardBorder}`, color: t.textSub, padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
