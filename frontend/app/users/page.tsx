"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { UserWizard } from "./user-wizard";
import ImageUpload from "../components/image-upload";

const API = (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

// Strict one-level-down creation: each role creates only the role directly below it.
const NEXT_ROLE: Record<string, string | null> = {
  SUPER_ADMIN: 'RESELLER', ADMIN: 'RESELLER', RESELLER: 'SUB_RESELLER',
  SUB_RESELLER: 'RETAILER', RETAILER: null, SALES: null,
};
const ROLE_LABEL: Record<string, string> = {
  RESELLER: 'Franchise', SUB_RESELLER: 'Dealer', RETAILER: 'Retailer', ADMIN: 'ISP', SALES: 'Sales',
};

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
  Check:       () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>,
  Toggle:      () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="1" y="5" width="22" height="14" rx="7"/><circle cx="16" cy="12" r="3" fill="currentColor"/></svg>,
};

// ✅ Complete 14 menu items (matching dashboard)
export default function UsersPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [time, setTime] = useState("");
  const [greeting, setGreeting] = useState("Welcome");
  const [users, setUsers] = useState<any[]>([]);
  const [usersView, setUsersView] = useState<"table" | "tree">("table");
  const [treeExpanded, setTreeExpanded] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'RESELLER',
    phone: '',
    balance: '0',
    parentId: '',
    photoUrl: '',
    cnicFrontUrl: '',
    cnicBackUrl: '',
    // Status, contact preferences and location (Zal Ultra profile fields).
    isActive: true,
    smsEnabled: true,
    emailEnabled: true,
    address: '',
    country: '',
    province: '',
    city: '',
  });
  const [saving, setSaving] = useState(false);

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
    if (!token) {
      router.push("/login");
      return;
    }

    fetch(`${API}/profile`, { headers })
      .then(res => res.json())
      .then(data => setUser(data.user))
      .catch(() => router.push("/login"));

    fetchUsers();

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

  const fetchUsers = async () => {
    try {
      const response = await fetch(`${API}/users`, { headers });
      if (response.status === 401) {
        setError("Session expired. Please login again.");
        setTimeout(() => router.push("/login"), 2000);
        return;
      }
      const data = await response.json();
      setUsers(Array.isArray(data) ? data : data?.data || []);
      setError("");
    } catch (err: any) {
      console.error("Error:", err);
      setError("Failed to load users. Make sure backend is running.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.email) {
      setError("Name and Email are required.");
      return;
    }
    if (!editingUser && !form.password) {
      setError("Password is required for new users.");
      return;
    }
    
    setSaving(true);
    setError("");
    
    const payload: any = {
      name: form.name,
      email: form.email,
      role: form.role,
      phone: form.phone,
      balance: Number(form.balance) || 0,
      photoUrl: form.photoUrl || null,
      cnicFrontUrl: form.cnicFrontUrl || null,
      cnicBackUrl: form.cnicBackUrl || null,
      isActive: form.isActive,
      smsEnabled: form.smsEnabled,
      emailEnabled: form.emailEnabled,
      address: form.address || null,
      country: form.country || null,
      province: form.province || null,
      city: form.city || null,
    };
    if (form.password) payload.password = form.password;
    if (form.parentId) payload.parentId = Number(form.parentId);
    
    try {
      const url = editingUser 
        ? `${API}/users/${editingUser.id}` 
        : `${API}/users`;
      const method = editingUser ? "PUT" : "POST";
      
      const response = await fetch(url, { method, headers, body: JSON.stringify(payload) });
      
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || `Server error (${response.status})`);
      }
      
      setShowForm(false);
      setEditingUser(null);
      resetForm();
      fetchUsers();
    } catch (err: any) {
      setError(err.message || "Failed to save user");
      // Re-throw so the wizard keeps the dialog open and shows the reason.
      // Without this it closed on failure and the account was never created —
      // the "A Dealer can only create a Retailer" case looked like success.
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`Delete user "${name}"? This action cannot be undone.`)) return;
    
    try {
      await fetch(`${API}/users/${id}`, { method: "DELETE", headers });
      fetchUsers();
    } catch (err) {
      setError("Failed to delete user");
    }
  };

  const handleToggleStatus = async (id: number, currentStatus: boolean) => {
    try {
      await fetch(`${API}/users/${id}/toggle`, { 
        method: "PATCH", 
        headers 
      });
      fetchUsers();
    } catch (err) {
      setError("Failed to update user status");
    }
  };

  const openEdit = (u: any) => {
    setEditingUser(u);
    setForm({
      name: u.name || '',
      email: u.email || '',
      password: '',
      role: u.role || 'USER',
      phone: u.phone || '',
      balance: String(u.balance || 0),
      parentId: u.parentId ? String(u.parentId) : '',
      photoUrl: u.photoUrl || '',
      cnicFrontUrl: u.cnicFrontUrl || '',
      cnicBackUrl: u.cnicBackUrl || '',
      isActive: u.isActive !== undefined ? u.isActive : true,
      smsEnabled: u.smsEnabled !== undefined ? u.smsEnabled : true,
      emailEnabled: u.emailEnabled !== undefined ? u.emailEnabled : true,
      address: u.address || '',
      country: u.country || '',
      province: u.province || '',
      city: u.city || '',
    });
    setShowForm(true);
  };

  // The only role this account may create (the level directly below it).
  const childRole = NEXT_ROLE[user?.role || ''] ?? null;
  const childLabel = childRole ? (ROLE_LABEL[childRole] || childRole) : null;
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(user?.role || '');

  const resetForm = () => {
    setForm({
      name: '',
      email: '',
      password: '',
      role: childRole || 'RESELLER',
      phone: '',
      balance: '0',
      parentId: '',
      photoUrl: '',
      cnicFrontUrl: '',
      cnicBackUrl: '',
      isActive: true,
      smsEnabled: true,
      emailEnabled: true,
      address: '',
      country: '',
      province: '',
      city: '',
    });
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

  const getRoleBadge = (role: string) => {
    switch(role) {
      case "ADMIN": return { bg: '#d1fae5', color: '#059669', label: '👑 Admin' };
      case "SALES": return { bg: '#dbeafe', color: '#2563eb', label: '💰 Sales' };
      case "RESELLER": return { bg: '#fef3c7', color: '#d97706', label: '🔄 Reseller' };
      case "SUB_RESELLER": return { bg: '#e0e7ff', color: '#4f46e5', label: '📎 Sub Reseller' };
      case "RETAILER": return { bg: '#fce7f3', color: '#db2777', label: '🏪 Retailer' };
      default: return { bg: '#f1f5f9', color: 'var(--muted)', label: '👤 User' };
    }
  };

  const statCards = [
    { label: "Total Users", value: users.length, sub: "all accounts", icon: "👥", bg: "linear-gradient(135deg,#3b82f6,#2563eb)" },
    { label: "Admins", value: users.filter((u: any) => u.role === "ADMIN").length, sub: "administrators", icon: "👑", bg: "linear-gradient(135deg,#10b981,#059669)" },
    { label: "Sales", value: users.filter((u: any) => u.role === "SALES").length, sub: "sales team", icon: "💰", bg: "linear-gradient(135deg,#f59e0b,#d97706)" },
    { label: "Resellers", value: users.filter((u: any) => u.role === "RESELLER").length, sub: "distribution partners", icon: "🔄", bg: "linear-gradient(135deg,#a855f7,#7c3aed)" },
  ];

  // Hierarchy for the tree view: nest each account under its parent so a large
  // roster is navigable instead of a flat 100-row table. Roots are accounts
  // whose parent isn't in the list (the top of what this account can see).
  const userRoots = (() => {
    const byId = new Map<number, any>(users.map((u: any) => [u.id, { ...u, _kids: [] as any[] }]));
    const roots: any[] = [];
    for (const n of byId.values()) {
      const p = n.parentId != null ? byId.get(n.parentId) : null;
      if (p) p._kids.push(n); else roots.push(n);
    }
    const sortRec = (ns: any[]) => { ns.sort((a, b) => String(a.name).localeCompare(String(b.name))); ns.forEach((n) => sortRec(n._kids)); };
    sortRec(roots);
    return roots;
  })();

  const userTreeRows: { u: any; depth: number; hasKids: boolean }[] = [];
  (function walk(ns: any[], depth: number) {
    for (const n of ns) {
      const hasKids = n._kids.length > 0;
      userTreeRows.push({ u: n, depth, hasKids });
      if (hasKids && treeExpanded[n.id]) walk(n._kids, depth + 1);
    }
  })(userRoots, 0);

  const expandAllUsers = () => {
    const all: Record<number, boolean> = {};
    (function walk(ns: any[]) { ns.forEach((n) => { all[n.id] = true; walk(n._kids); }); })(userRoots);
    setTreeExpanded(all);
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", background: t.bg }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 40, height: 40, border: `3px solid ${t.cardBorder}`, borderTopColor: t.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 16px" }} />
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          <div style={{ color: t.textMuted }}>Loading users...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: t.bg, color: t.text, fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>

      {/* ══════════ MAIN ══════════ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* ── CONTENT ── */}
        <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>
          
          {/* Page header with a permanent Add User button */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
            {/* View switch — flat table, or the account hierarchy as a tree.
                Tree keeps a big roster navigable instead of endless scrolling. */}
            <div style={{ display: "inline-flex", background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 999, padding: 3 }}>
              {(["table", "tree"] as const).map((v) => (
                <button key={v} onClick={() => setUsersView(v)}
                  style={{ border: "none", cursor: "pointer", borderRadius: 999, padding: "6px 16px", fontSize: 12, fontWeight: 700, textTransform: "capitalize", fontFamily: "inherit", background: usersView === v ? t.accent : "transparent", color: usersView === v ? "#fff" : t.textMuted }}>
                  {v} view
                </button>
              ))}
            </div>
            <button onClick={() => { setEditingUser(null); resetForm(); setShowForm(true); }}
              style={{ background: t.accent, color: "#fff", border: "none", padding: "10px 20px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
              + Add {childRole ? `${childLabel} / Staff` : "Staff"}
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
              <div key={idx} style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: "14px", transition: "transform .15s" }}
                onMouseEnter={e => (e.currentTarget.style.transform = "translateY(-2px)")}
                onMouseLeave={e => (e.currentTarget.style.transform = "")}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", background: card.bg, fontSize: 18 }}>{card.icon}</div>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "rgba(14,165,233,0.15)", color: t.accent }}>Live</span>
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: t.textMuted }}>{card.label}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: t.text }}>{card.value}</div>
                <div style={{ fontSize: 10, color: t.textMuted, marginTop: 4 }}>{card.sub}</div>
              </div>
            ))}
          </div>

          {/* Users Table */}
          {users.length === 0 ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>👤</div>
              <h3 style={{ fontSize: 18, color: t.text, marginBottom: 6 }}>No Users Yet</h3>
              <p style={{ color: t.textMuted, fontSize: 13, marginBottom: 20 }}>Add your first user to get started.</p>
              <button onClick={() => { setEditingUser(null); resetForm(); setShowForm(true); }} style={{ background: t.accent, color: "#fff", border: "none", padding: "10px 22px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>+ Add User</button>
            </div>
          ) : usersView === "tree" ? (
            <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${t.cardBorder}` }}>
                <span style={{ fontSize: 11, color: t.textMuted }}>{users.length} accounts · click a row to open, +/− to expand</span>
                <button onClick={() => (Object.keys(treeExpanded).length ? setTreeExpanded({}) : expandAllUsers())}
                  style={{ border: "none", background: "transparent", color: t.textMuted, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                  {Object.keys(treeExpanded).length ? "Collapse all" : "Expand all"}
                </button>
              </div>
              <div style={{ maxHeight: "62vh", overflowY: "auto", padding: 8 }}>
                {userTreeRows.map(({ u, depth, hasKids }) => {
                  const rb = getRoleBadge(u.role);
                  return (
                    <div key={u.id}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", marginLeft: depth * 20, borderRadius: 9, borderLeft: depth ? `2px solid ${t.cardBorder}` : "none", cursor: "pointer" }}
                      onClick={() => router.push(`/users/${u.id}`)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = d ? "rgba(56,189,248,0.07)" : "#eef6ff")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                      {hasKids ? (
                        <button onClick={(e) => { e.stopPropagation(); setTreeExpanded((m) => ({ ...m, [u.id]: !m[u.id] })); }}
                          aria-label={treeExpanded[u.id] ? "Collapse" : "Expand"}
                          style={{ width: 20, height: 20, flexShrink: 0, border: `1px solid ${t.cardBorder}`, borderRadius: 6, background: t.card, color: t.textMuted, cursor: "pointer", fontSize: 12, lineHeight: 1 }}>
                          {treeExpanded[u.id] ? "−" : "+"}
                        </button>
                      ) : <span style={{ width: 20, flexShrink: 0 }} />}
                      <div style={{ width: 30, height: 30, borderRadius: 9, background: "rgba(14,165,233,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: t.accent, flexShrink: 0 }}>
                        {getInitials(u.name)}
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: t.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {u.name}{!u.isActive && <span style={{ color: "#f87171", fontSize: 10, marginLeft: 6 }}>inactive</span>}
                        </div>
                        <div style={{ fontSize: 10.5, color: t.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</div>
                      </div>
                      <Badge color={rb.color} bg={rb.bg}>{rb.label}</Badge>
                      <div style={{ textAlign: "right", flexShrink: 0, minWidth: 70 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: t.text }}>{u._count?.ownedSubscribers ?? 0} <span style={{ fontSize: 9.5, color: t.textMuted, fontWeight: 400 }}>subs</span></div>
                        {hasKids && <div style={{ fontSize: 9.5, color: t.textMuted }}>{u._kids.length} below</div>}
                      </div>
                    </div>
                  );
                })}
                {userTreeRows.length === 0 && (
                  <div style={{ textAlign: "center", padding: 30, color: t.textMuted, fontSize: 12 }}>No accounts to show.</div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                  <thead>
                    <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>User</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Email</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Role</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Phone</th>
                      <th style={{ padding: "10px 14px", textAlign: "right", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Balance</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Subs</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Downline</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Created By</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Last Login</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Status</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u: any, idx: number) => {
                      const roleBadge = getRoleBadge(u.role);
                      return (
                        <tr
                          key={u.id}
                          // Whole row opens the profile; action buttons stop propagation.
                          onClick={() => router.push(`/users/${u.id}`)}
                          title="Open profile"
                          style={{
                            borderBottom: `1px solid ${t.cardBorder}`,
                            background: idx % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card,
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = d ? "rgba(56,189,248,0.07)" : "#eef6ff")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = idx % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card)}
                        >
                          <td style={{ padding: "10px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <div style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(14,165,233,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: t.accent }}>
                                {getInitials(u.name)}
                              </div>
                              <div>
                                <div style={{ fontSize: 12, fontWeight: 600, color: t.text }}>{u.name || "-"}</div>
                                <div style={{ fontSize: 10, color: t.textMuted }}>ID: {u.id}</div>
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: "10px 14px", fontSize: 11, color: t.textSub }}>{u.email}</td>
                          <td style={{ padding: "10px 14px", textAlign: "center" }}>
                            <Badge color={roleBadge.color} bg={roleBadge.bg}>{roleBadge.label}</Badge>
                          </td>
                          <td style={{ padding: "10px 14px", fontSize: 11 }}>{u.phone || "-"}</td>
                          <td style={{ padding: "10px 14px", textAlign: "right", fontSize: 12, fontWeight: 600, color: t.green }}>PKR {u.balance || 0}</td>
                          <td style={{ padding: "10px 14px", textAlign: "center", fontSize: 12, color: t.text }}>{u._count?.ownedSubscribers ?? 0}</td>
                          <td style={{ padding: "10px 14px", textAlign: "center", fontSize: 12, color: t.text }}>{u._count?.children ?? 0}</td>
                          <td style={{ padding: "10px 14px", fontSize: 11, color: t.textSub }}>{u.parent?.name || "—"}</td>
                          <td style={{ padding: "10px 14px", fontSize: 11, color: t.textSub }}>{u.lastLogin ? new Date(u.lastLogin).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—"}</td>
                          <td style={{ padding: "10px 14px", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => handleToggleStatus(u.id, u.isActive)}
                              style={{
                                padding: "3px 10px", borderRadius: 20, fontSize: 10, fontWeight: 600,
                                background: u.isActive ? "#14532d" : "#450a0a",
                                color: u.isActive ? "#4ade80" : "#f87171",
                                border: "none", cursor: "pointer"
                              }}>
                              {u.isActive ? "Active" : "Inactive"}
                            </button>
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                            <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                              <Btn onClick={() => openEdit(u)} variant="warning" size="xs"><Icons.Edit /> Edit</Btn>
                              <Btn onClick={() => handleDelete(u.id, u.name)} variant="danger" size="xs"><Icons.Trash /></Btn>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: "10px 14px", borderTop: `1px solid ${t.cardBorder}`, fontSize: 10, color: t.textMuted }}>
                Showing {users.length} users
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="page-footer" style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${t.cardBorder}`, fontSize: 11, color: t.textMuted, textAlign: "center" }}>
            © {new Date().getFullYear()} <strong style={{ color: t.accent }}>JointBox</strong> ISP CRM Platform. All rights reserved.
          </div>
        </div>
      </div>

      {/* Add/Edit User Modal */}
      {showForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, overflowY: "auto" }} onClick={() => setShowForm(false)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 500, maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>{editingUser ? "✏️ Edit User" : "➕ Add New User"}</h2>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>

            {/* Stepped form for NEW accounts. Editing keeps the single page. */}
            {!editingUser && (
              <UserWizard
                form={form}
                setForm={(fn: any) => setForm((p: any) => fn(p))}
                saving={saving}
                // Without this the wizard offered "Franchise" to everyone, and
                // a dealer submitting it was rejected by the server's
                // one-level-down rule.
                myRole={user?.role}
                onSave={() => handleSubmit({ preventDefault: () => {} } as any)}
                onCancel={() => setShowForm(false)}
              />
            )}

            {editingUser && (
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Full Name *</label>
                <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Email *</label>
                <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>
                  {editingUser ? "Password (leave blank to keep)" : "Password *"}
                </label>
                <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required={!editingUser} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Account type</label>
                  <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text, fontWeight: 700 }}>
                    {childRole && <option value={childRole}>{childLabel} (downline)</option>}
                    <option value="SALES">👤 Staff (my helper)</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Phone</label>
                  <input type="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }} />
                </div>
              </div>

              <div style={{ background: "rgba(14,165,233,0.1)", borderRadius: 8, padding: 10, fontSize: 11, color: t.textSub, margin: "0 0 14px" }}>
                👨‍👦 New accounts are created directly under you. To create the level below, switch into that account (top bar → Act as).
              </div>

              {isAdmin && !editingUser && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Initial Balance (PKR)</label>
                  <input type="number" value={form.balance} onChange={e => setForm({ ...form, balance: e.target.value })} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }} />
                </div>
              )}

              <div style={{ borderTop: `1px solid ${t.cardBorder}`, margin: "4px 0 14px", paddingTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: t.text, marginBottom: 10 }}>📷 Photo &amp; Identity (CNIC)</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
                  <ImageUpload label="Profile picture" shape="avatar" value={form.photoUrl} onChange={(url) => setForm({ ...form, photoUrl: url })} />
                  <ImageUpload label="CNIC — Front" value={form.cnicFrontUrl} onChange={(url) => setForm({ ...form, cnicFrontUrl: url })} />
                  <ImageUpload label="CNIC — Back" value={form.cnicBackUrl} onChange={(url) => setForm({ ...form, cnicBackUrl: url })} />
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button type="submit" disabled={saving} style={{ flex: 1, background: t.accent, color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: saving ? 0.6 : 1 }}>
                  {saving ? "Saving..." : "Update User"}
                </button>
                <button type="button" onClick={() => setShowForm(false)} style={{ flex: 1, background: "transparent", border: `1px solid ${t.cardBorder}`, color: t.textSub, padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                  Cancel
                </button>
              </div>
            </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}