"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Voucher {
  id: number;
  code: string;
  pin: string;
  type: string;
  amount: number;
  dataQuota?: string;
  validityDays: number;
  status: string;
  usedByUser?: {
    fullName: string;
  };
  usedAt?: string;
}

interface Subscriber {
  id: number;
  fullName: string;
  phone: string;
}

const API = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

// ─── Icons (Complete set matching dashboard) ──────────────────────────────────────────────────
const Ic = {
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
  Eye:         () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  Trash:       () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
  Ticket:      () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 12V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h14"/><line x1="12" y1="4" x2="12" y2="20"/><path d="M20 15h2M20 19h2"/></svg>,
};

// ✅ Complete 14 menu items (matching dashboard)
export default function VouchersPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [time, setTime] = useState("");
  const [greeting, setGreeting] = useState("Welcome");
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [stats, setStats] = useState({
    total: 0,
    unused: 0,
    used: 0,
    expired: 0,
    totalRedeemed: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showRedeemModal, setShowRedeemModal] = useState(false);
  const [form, setForm] = useState({
    type: 'PREPAID',
    quantity: 10,
    amount: 100,
    dataQuota: '',
    validityDays: 30,
  });
  const [redeemForm, setRedeemForm] = useState({
    code: '',
    pin: '',
    subscriberId: '',
  });
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [saving, setSaving] = useState(false);

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

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

  const getInitials = (name?: string) => {
    if (!name) return "U";
    return name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
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

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) return router.push("/login");
    
    fetch(`${API}/profile`, { headers })
      .then(res => res.json())
      .then(data => setUser(data.user))
      .catch(() => router.push("/login"));
    
    loadData();
    loadSubscribers();

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
    setError("");
    try {
      const [voucherRes, statRes] = await Promise.all([
        fetch(`${API}/vouchers`, { headers }),
        fetch(`${API}/vouchers/stats`, { headers }),
      ]);
      
      if (!voucherRes.ok) throw new Error(`Voucher fetch failed: ${voucherRes.status}`);
      if (!statRes.ok) throw new Error(`Voucher stats fetch failed: ${statRes.status}`);
      
      const vouchersData = await voucherRes.json();
      const vouchersArray = Array.isArray(vouchersData) ? vouchersData : (vouchersData?.data || []);
      setVouchers(vouchersArray);
      
      const statsData = await statRes.json();
      if (statsData && typeof statsData.total === 'number') {
        setStats(statsData);
      } else if (vouchersArray.length > 0) {
        const calculatedStats = {
          total: vouchersArray.length,
          unused: vouchersArray.filter((v: Voucher) => v.status === 'UNUSED').length,
          used: vouchersArray.filter((v: Voucher) => v.status === 'USED').length,
          expired: vouchersArray.filter((v: Voucher) => v.status === 'EXPIRED').length,
          totalRedeemed: vouchersArray.filter((v: Voucher) => v.status === 'USED').reduce((sum: number, v: Voucher) => sum + (v.amount || 0), 0),
        };
        setStats(calculatedStats);
      }
    } catch (err) {
      console.error('Error loading vouchers:', err);
      setError('Failed to load vouchers. Please try again.');
      setVouchers([]);
    }
    setLoading(false);
  }

  async function loadSubscribers() {
    try {
      const res = await fetch(`${API}/subscribers`, { headers });
      const subscribersData = await res.json();
      const subscribersArray = Array.isArray(subscribersData) ? subscribersData : (subscribersData?.data || []);
      setSubscribers(subscribersArray);
    } catch (err) {
      console.error('Error loading subscribers:', err);
      setSubscribers([]);
    }
  }

  async function handleCreateBatch(e: React.FormEvent) {
    e.preventDefault();
    if (form.quantity < 1 || form.amount < 0 || form.validityDays < 1) {
      setError("Please enter valid values.");
      return;
    }
    
    setSaving(true);
    setError("");
    
    try {
      const response = await fetch(`${API}/vouchers/bulk`, {
        method: 'POST',
        headers,
        body: JSON.stringify(form),
      });
      
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.message || 'Failed to create batch');
      }
      
      setShowForm(false);
      resetForm();
      loadData();
    } catch (err: any) {
      console.error('Create batch error:', err);
      setError(err.message || 'Failed to create voucher batch');
    }
    setSaving(false);
  }

  async function handleRedeem(e: React.FormEvent) {
    e.preventDefault();
    if (!redeemForm.code || !redeemForm.pin || !redeemForm.subscriberId) {
      setError("Please enter voucher code, PIN and select a subscriber.");
      return;
    }
    
    setSaving(true);
    setError("");
    
    try {
      const response = await fetch(`${API}/vouchers/redeem`, {
        method: 'POST',
        headers,
        body: JSON.stringify(redeemForm),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Redeem failed');
      }
      
      setShowRedeemModal(false);
      setRedeemForm({ code: '', pin: '', subscriberId: '' });
      loadData();
    } catch (err: any) {
      console.error('Redeem error:', err);
      setError(err.message || 'Failed to redeem voucher');
    }
    setSaving(false);
  }

  async function handleDelete(id: number, code: string) {
    if (!confirm(`Delete voucher "${code}"? This action cannot be undone.`)) return;
    
    try {
      const response = await fetch(`${API}/vouchers/${id}`, { method: 'DELETE', headers });
      if (!response.ok) {
        throw new Error('Delete failed');
      }
      loadData();
    } catch (err) {
      console.error('Delete error:', err);
      setError('Failed to delete voucher');
    }
  }

  function resetForm() {
    setForm({
      type: 'PREPAID',
      quantity: 10,
      amount: 100,
      dataQuota: '',
      validityDays: 30,
    });
  }

  const typeColors: any = {
    INTERNET: { bg: '#d1fae5', color: '#059669', label: '🌐 Internet' },
    BALANCE: { bg: '#dbeafe', color: '#2563eb', label: '💰 Balance' },
    DISCOUNT: { bg: '#fef3c7', color: '#d97706', label: '🎁 Discount' },
    PREPAID: { bg: '#ede9fe', color: '#7c3aed', label: '🎫 Prepaid' },
  };

  const statusColors: any = {
    UNUSED: { bg: '#fef3c7', color: '#d97706', label: '🟡 Unused' },
    USED: { bg: '#d1fae5', color: '#059669', label: '✅ Used' },
    EXPIRED: { bg: '#fee2e2', color: '#dc2626', label: '🔴 Expired' },
  };

  const statCards = [
    { label: "Total Vouchers", value: stats.total, sub: "all vouchers", icon: "🎫", bg: "linear-gradient(135deg,#3b82f6,#2563eb)" },
    { label: "Unused", value: stats.unused, sub: "available", icon: "🟡", bg: "linear-gradient(135deg,#f59e0b,#d97706)" },
    { label: "Used", value: stats.used, sub: "redeemed", icon: "✅", bg: "linear-gradient(135deg,#10b981,#059669)" },
    { label: "Expired", value: stats.expired, sub: "expired", icon: "🔴", bg: "linear-gradient(135deg,#ef4444,#dc2626)" },
  ];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: t.bg, color: t.text, fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>

      {/* ══ MAIN ══ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* ── CONTENT ── */}
        <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>

          {/* Page header with a persistent Create button */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
            <div>
            </div>
            <button
              onClick={() => setShowForm(true)}
              style={{ background: t.accent, color: "#fff", border: "none", padding: "10px 18px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              + Create Batch
            </button>
          </div>

          {/* Error Message */}
          {error && (
            <div style={{ marginBottom: 20, padding: "10px 16px", background: d ? "#450a0a" : "#fee2e2", border: `1px solid ${d ? "#7f1d1d" : "#fecaca"}`, borderRadius: 12, color: d ? "#f87171" : "#dc2626", fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>⚠️ {error}</span>
              <button onClick={() => setError("")} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: d ? "#f87171" : "#dc2626" }}>×</button>
            </div>
          )}

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

          {/* Total Redeemed Card */}
          <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: "14px 20px", marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: t.textMuted }}>💰 Total Redeemed Value</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: t.green }}>PKR {(stats.totalRedeemed || 0).toLocaleString()}</span>
          </div>

          {/* Vouchers Table */}
          {loading ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ width: 36, height: 36, border: `3px solid ${t.cardBorder}`, borderTopColor: t.accent, borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 14px" }}></div>
              <p style={{ color: t.textMuted, fontSize: 13 }}>Loading vouchers...</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          ) : vouchers.length === 0 ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🎫</div>
              <h3 style={{ fontSize: 18, color: t.text, marginBottom: 6 }}>No Vouchers Yet</h3>
              <p style={{ color: t.textMuted, fontSize: 13, marginBottom: 20 }}>Create your first voucher batch to start selling prepaid cards.</p>
              <button onClick={() => setShowForm(true)} style={{ background: t.accent, color: "#fff", border: "none", padding: "10px 22px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>+ Create First Batch</button>
            </div>
          ) : (
            <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
                  <thead>
                    <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Code</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>PIN</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Type</th>
                      <th style={{ padding: "10px 14px", textAlign: "right", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Amount</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Validity</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Status</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Used By</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vouchers.map((v, idx) => (
                      <tr key={v.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: idx % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                        <td style={{ padding: "10px 14px" }}>
                          <code style={{ fontSize: 11, fontWeight: 700, color: t.accent }}>{v.code}</code>
                        </td>
                        <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 11, color: t.textSub }}>{v.pin}</td>
                        <td style={{ padding: "10px 14px", textAlign: "center" }}>
                          <Badge color={typeColors[v.type]?.color || t.textMuted} bg={typeColors[v.type]?.bg || t.cardBorder}>
                            {typeColors[v.type]?.label || v.type}
                          </Badge>
                        </td>
                        <td style={{ padding: "10px 14px", textAlign: "right", fontSize: 12, fontWeight: 600, color: t.green }}>PKR {v.amount}</td>
                        <td style={{ padding: "10px 14px", textAlign: "center", fontSize: 11, color: t.textSub }}>{v.validityDays} days</td>
                        <td style={{ padding: "10px 14px", textAlign: "center" }}>
                          <Badge color={statusColors[v.status]?.color || t.textMuted} bg={statusColors[v.status]?.bg || t.cardBorder}>
                            {statusColors[v.status]?.label || v.status}
                          </Badge>
                        </td>
                        <td style={{ padding: "10px 14px" }}>
                          {v.usedByUser ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 28, height: 28, borderRadius: 8, background: "rgba(14,165,233,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: t.accent }}>
                                {getInitials(v.usedByUser.fullName)}
                              </div>
                              <span style={{ fontSize: 11, color: t.text }}>{v.usedByUser.fullName}</span>
                            </div>
                          ) : '—'}
                        </td>
                        <td style={{ padding: "10px 14px", textAlign: "center" }}>
                          <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                            {v.status === 'UNUSED' && (
                              <Btn size="xs" variant="success" onClick={() => { setRedeemForm({ code: v.code, pin: v.pin, subscriberId: '' }); setShowRedeemModal(true); }} title="Redeem">🎫</Btn>
                            )}
                            <Btn size="xs" variant="danger" onClick={() => handleDelete(v.id, v.code)} title="Delete"><Ic.Trash /></Btn>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: "10px 14px", borderTop: `1px solid ${t.cardBorder}`, fontSize: 10, color: t.textMuted }}>
                Showing {vouchers.length} vouchers
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="page-footer" style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${t.cardBorder}`, fontSize: 11, color: t.textMuted, textAlign: "center" }}>
            © {new Date().getFullYear()} <strong style={{ color: t.accent }}>JointBox</strong> ISP CRM Platform. All rights reserved.
          </div>
        </div>
      </div>

      {/* Create Batch Modal */}
      {showForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", overflowY: "auto", padding: 16 }} onClick={() => setShowForm(false)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 550, maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>🎫 Create Voucher Batch</h2>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>

            <form onSubmit={handleCreateBatch}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Voucher Type</label>
                  <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }}>
                    <option value="PREPAID">🎫 Prepaid Voucher</option>
                    <option value="INTERNET">🌐 Internet Voucher</option>
                    <option value="BALANCE">💰 Balance Top-up</option>
                    <option value="DISCOUNT">🎁 Discount Voucher</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Quantity</label>
                  <input type="number" value={form.quantity} onChange={e => setForm({ ...form, quantity: parseInt(e.target.value) || 0 })} min="1" max="1000" required style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }} />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Amount (PKR)</label>
                  <input type="number" value={form.amount} onChange={e => setForm({ ...form, amount: parseFloat(e.target.value) || 0 })} min="0" required style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Data Quota</label>
                  <input value={form.dataQuota} onChange={e => setForm({ ...form, dataQuota: e.target.value })} placeholder="e.g., 10GB, Unlimited" style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }} />
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Validity Days</label>
                <input type="number" value={form.validityDays} onChange={e => setForm({ ...form, validityDays: parseInt(e.target.value) || 0 })} min="1" required style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }} />
              </div>

              <div style={{ background: d ? "var(--surface)" : "#eff6ff", borderRadius: 8, padding: 10, fontSize: 11, color: d ? "#93c5fd" : "#1e40af", margin: "12px 0" }}>
                💡 <strong>Info:</strong> This will create {form.quantity} unique voucher(s) with random codes and PINs.
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button type="submit" disabled={saving} style={{ flex: 1, background: t.accent, color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: saving ? 0.6 : 1 }}>{saving ? "Creating..." : "Create Batch"}</button>
                <button type="button" onClick={() => setShowForm(false)} style={{ flex: 1, background: "transparent", border: `1px solid ${t.cardBorder}`, color: t.textSub, padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Redeem Voucher Modal */}
      {showRedeemModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setShowRedeemModal(false)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 500 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>🎫 Redeem Voucher</h2>
              <button onClick={() => setShowRedeemModal(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>

            <form onSubmit={handleRedeem}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Voucher Code</label>
                <input value={redeemForm.code} onChange={e => setRedeemForm({ ...redeemForm, code: e.target.value })} placeholder="e.g., ABCD-1234-EFGH-5678" required style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, fontFamily: "monospace", background: t.input, color: t.text }} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>PIN Code</label>
                <input type="password" value={redeemForm.pin} onChange={e => setRedeemForm({ ...redeemForm, pin: e.target.value })} placeholder="6-digit PIN" required style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, fontFamily: "monospace", background: t.input, color: t.text }} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Select Subscriber</label>
                <select value={redeemForm.subscriberId} onChange={e => setRedeemForm({ ...redeemForm, subscriberId: e.target.value })} required style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }}>
                  <option value="">Select Customer</option>
                  {subscribers.map((s) => (
                    <option key={s.id} value={s.id}>{s.fullName} - {s.phone}</option>
                  ))}
                </select>
              </div>

              <div style={{ background: d ? "var(--surface)" : "#eff6ff", borderRadius: 8, padding: 10, fontSize: 11, color: d ? "#93c5fd" : "#1e40af", margin: "12px 0" }}>
                💡 <strong>Note:</strong> Once redeemed, the voucher will be marked as used and cannot be reused.
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button type="submit" disabled={saving} style={{ flex: 1, background: t.accent, color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: saving ? 0.6 : 1 }}>{saving ? "Redeeming..." : "Redeem Voucher"}</button>
                <button type="button" onClick={() => setShowRedeemModal(false)} style={{ flex: 1, background: "transparent", border: `1px solid ${t.cardBorder}`, color: t.textSub, padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
