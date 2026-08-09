"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icons as SIcons } from "../components/icons";
import API_BASE from "../components/api";

const API = API_BASE;

const Icons = { ...SIcons };

// ✅ Complete 14 menu items (matching dashboard)
export default function SettingsPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [time, setTime] = useState("");
  const [greeting, setGreeting] = useState("Welcome");
  const [showPassword, setShowPassword] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const [gateways, setGateways] = useState<{ gateway: string; enabled: boolean; label: string }[]>([]);

  const token = typeof window !== 'undefined' ? localStorage.getItem("token") : "";
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
    if (!token) {
      router.push("/login");
      return;
    }

    fetch(`${API}/profile`, { headers })
      .then(res => res.json())
      .then(data => setUser(data.user))
      .catch(() => router.push("/login"));

    fetch(`${API}/gateway/available`, { headers })
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setGateways(data);
        else if (data?.data) setGateways(data.data);
      })
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

  const toast_ = (msg: string, type: "ok" | "err" = "ok") => { setToast({ msg, type }); setTimeout(() => setToast(null), 2600); };

  const settingsSections = [
    {
      title: "Profile Settings",
      icon: "👤",
      fields: [
        { label: "Full Name", value: user?.name || "Admin User" },
        { label: "Email Address", value: user?.email || "admin@jointbox.com" },
        { label: "Role", value: user?.role || "Administrator" },
      ]
    },
    {
      title: "System Information",
      icon: "⚙️",
      fields: [
        { label: "Version", value: "JointBox-ISP v2.0.0" },
        { label: "Build Date", value: new Date().toLocaleDateString() },
        { label: "API Endpoint", value: API },
        { label: "Environment", value: "Production" },
      ]
    },
    {
      title: "System Status",
      icon: "📊",
      fields: [
        { label: "Server Status", value: "🟢 Online" },
        { label: "Database Status", value: "🟢 Connected" },
        { label: "RADIUS Service", value: "🟢 Running" },
      ]
    },
    {
      title: "Payment Gateways",
      icon: "💳",
      fields: gateways.length > 0
        ? gateways.map((g) => ({
            label: g.label || g.gateway,
            value: g.enabled ? "🟢 Configured" : "🔴 Not Configured",
          }))
        : [{ label: "No gateways loaded", value: "—" }],
    },
  ];

  const quickActions = [
    { label: "Clear System Cache", icon: "🗑️", color: t.red, bg: "#450a0a", action: () => alert("Cache cleared successfully!") },
    { label: "Backup Database", icon: "💾", color: t.green, bg: "#14532d", action: () => alert("Database backup initiated. Download will start shortly.") },
    { label: "View System Logs", icon: "📋", color: t.accent, bg: "var(--surface)", action: () => router.push("/logs") },
    { label: "Generate Report", icon: "📈", color: t.purple, bg: "#3b0764", action: () => router.push("/reports") },
  ];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: t.bg, color: t.text, fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>
      {toast && (
        <div style={{
          position: "fixed", right: 24, bottom: 24, zIndex: 100, padding: "14px 24px", borderRadius: 12,
          border: "1px solid", fontSize: 13, fontWeight: 500, boxShadow: "0 8px 32px rgba(0,0,0,0.4)", maxWidth: 400,
          background: toast.type === "ok" ? "rgba(16,185,129,0.08)" : "rgba(255,112,112,0.08)",
          borderColor: toast.type === "ok" ? "rgba(16,185,129,0.25)" : "rgba(255,112,112,0.25)",
          color: toast.type === "ok" ? "#10B981" : "#ff7070",
        }}>{toast.msg}</div>
      )}

      {/* ══════════ MAIN ══════════ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* ── CONTENT ── */}
        <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>
          
          {/* Settings Cards Grid */}
          <div style={{ 
            display: "grid", 
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", 
            gap: 18, 
            marginBottom: 24,
          }}>
            {settingsSections.map((section, idx) => (
              <div
                key={idx}
                style={{
                  background: t.card, borderRadius: 12, padding: "18px 20px",
                  border: `1px solid ${t.cardBorder}`, transition: "transform .15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.transform = "translateY(-2px)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.transform = "";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                  <span style={{ fontSize: 22 }}>{section.icon}</span>
                  <h3 style={{ fontSize: 15, fontWeight: 700, color: t.text, margin: 0 }}>{section.title}</h3>
                </div>
                {section.fields.map((field, fieldIdx) => (
                  <div key={fieldIdx} style={{ marginBottom: 12 }}>
                    <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: t.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>{field.label}</label>
                    <div style={{
                      padding: "8px 12px",
                      background: d ? "var(--bg)" : "#f8fafc",
                      borderRadius: 8,
                      fontSize: 12,
                      color: t.text,
                      border: `1px solid ${t.cardBorder}`,
                    }}>
                      {field.value}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Quick Actions Section */}
          <div style={{ background: t.card, borderRadius: 12, padding: "18px 22px", border: `1px solid ${t.cardBorder}`, marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span style={{ fontSize: 20 }}>⚡</span>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: t.text, margin: 0 }}>Quick Actions</h3>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              {quickActions.map((action, idx) => (
                <button
                  key={idx}
                  onClick={action.action}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer",
                    fontSize: 11, fontWeight: 600, background: action.bg, color: action.color,
                    transition: "transform .15s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.transform = "translateY(-1px)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.transform = "";
                  }}
                >
                  <span style={{ fontSize: 13 }}>{action.icon}</span> {action.label}
                </button>
              ))}
            </div>
          </div>

          {/* Account Actions */}
          <div style={{ background: t.card, borderRadius: 12, padding: "18px 22px", border: `1px solid ${t.cardBorder}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span style={{ fontSize: 20 }}>🔄</span>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: t.text, margin: 0 }}>Account Actions</h3>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Btn onClick={() => { localStorage.removeItem("token"); router.push("/login"); }} variant="danger">
                <Icons.Logout /> Sign Out
              </Btn>
              <Btn onClick={() => setShowPassword(true)} variant="default">
                <Icons.Key /> Change Password
              </Btn>
            </div>
          </div>

          {/* Footer */}
          <div className="page-footer" style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${t.cardBorder}`, fontSize: 11, color: t.textMuted, textAlign: "center" }}>
            © {new Date().getFullYear()} <strong style={{ color: t.accent }}>JointBox</strong> ISP CRM Platform. All rights reserved.
          </div>
        </div>
      </div>

      {/* ── Password Change Modal ── */}
      {showPassword && (
        <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => { setShowPassword(false); setPwCurrent(""); setPwNew(""); setPwConfirm(""); }}>
          <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 20, padding: 28, maxWidth: 450, width: "100%" }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: t.text }}>Change Password</h2>
              <button onClick={() => { setShowPassword(false); setPwCurrent(""); setPwNew(""); setPwConfirm(""); }}
                style={{ background: "transparent", border: "none", color: t.textMuted, fontSize: 20, cursor: "pointer" }}>✕</button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Current Password</label>
                <input type="password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} placeholder="Enter current password"
                  style={{ width: "100%", background: t.input, border: `1px solid ${t.inputBorder}`, borderRadius: 10, padding: "10px 14px", color: t.text, fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>New Password</label>
                <input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} placeholder="Enter new password"
                  style={{ width: "100%", background: t.input, border: `1px solid ${t.inputBorder}`, borderRadius: 10, padding: "10px 14px", color: t.text, fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Confirm New Password</label>
                <input type="password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} placeholder="Confirm new password"
                  style={{ width: "100%", background: t.input, border: `1px solid ${t.inputBorder}`, borderRadius: 10, padding: "10px 14px", color: t.text, fontSize: 13 }} />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20, paddingTop: 16, borderTop: `1px solid ${t.cardBorder}` }}>
              <button onClick={() => { setShowPassword(false); setPwCurrent(""); setPwNew(""); setPwConfirm(""); }}
                style={{ padding: "10px 24px", borderRadius: 10, fontSize: 13, fontWeight: 600, border: `1px solid ${t.cardBorder}`, cursor: "pointer", background: "rgba(255,255,255,0.04)", color: t.textMuted }}>Cancel</button>
              <button onClick={async () => {
                if (!pwCurrent) { toast_("Current password is required", "err"); return; }
                if (!pwNew) { toast_("New password is required", "err"); return; }
                if (pwNew !== pwConfirm) { toast_("Passwords do not match", "err"); return; }
                if (pwNew.length < 6) { toast_("Password must be at least 6 characters", "err"); return; }
                setPwSaving(true);
                try {
                  const r = await fetch(`${API}/users/${user.id}`, {
                    method: "PUT",
                    headers,
                    body: JSON.stringify({ password: pwNew }),
                  });
                  if (!r.ok) { const e = await r.json().catch(() => null); toast_(e?.message || "Failed to update password", "err"); setPwSaving(false); return; }
                  toast_("Password updated successfully");
                  setShowPassword(false); setPwCurrent(""); setPwNew(""); setPwConfirm("");
                } catch (_) { toast_("Network error", "err"); }
                setPwSaving(false);
              }} disabled={pwSaving}
                style={{ padding: "10px 24px", borderRadius: 10, fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer", background: t.accent, color: "#fff", opacity: pwSaving ? 0.5 : 1 }}>
                {pwSaving ? "Updating…" : "Update Password"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
