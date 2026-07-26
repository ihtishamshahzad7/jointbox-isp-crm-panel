"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { money, currencySymbol } from "../components/currency";
import { Icons as SIcons } from "../components/icons";

interface Invoice {
  id: number;
  invoiceNo: string;
  amount: number;
  tax: number;
  discount: number;
  total: number;
  paidAmount: number;
  dueAmount: number;
  status: string;
  dueDate: string;
  createdAt: string;
  notes?: string;
  items?: any[];
  subscriber?: { id: number; fullName: string; phone: string; email: string; address: string };
}

const API = (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

// ─── Icons ────────────────────────────────────────────────────────────────────
const Ic = { ...SIcons };

// ✅ Complete 14 menu items (matching dashboard)
export default function InvoicesPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [time, setTime] = useState("");
  const [greeting, setGreeting] = useState("Welcome");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [subscribers, setSubscribers] = useState<any[]>([]);
  const [stats, setStats] = useState({
    total: 0,
    unpaid: 0,
    paid: 0,
    overdue: 0,
    totalAmount: 0,
    totalPaid: 0,
    totalDue: 0,
  });
  const [loading, setLoading] = useState(true);
const [showForm, setShowForm] = useState(false);
const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
const [showPaymentModal, setShowPaymentModal] = useState(false);
const [showDetailsModal, setShowDetailsModal] = useState(false);
const [showReverseModal, setShowReverseModal] = useState(false);
const [reverseReason, setReverseReason] = useState("");
  const [form, setForm] = useState({
    subscriberId: '',
    amount: '',
    tax: '0',
    discount: '0',
    dueDate: '',
    notes: '',
    items: [{ description: '', quantity: 1, unitPrice: 0 }],
  });
  const [paymentForm, setPaymentForm] = useState({
    amount: '',
    method: 'CASH',
    referenceNo: '',
    notes: '',
  });

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
    if (!token) return router.push("/login");
    
    fetch(`${API}/profile`, { headers })
      .then(res => res.json())
      .then(data => setUser(data.user))
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
      const [invRes, statRes, subRes] = await Promise.all([
        fetch(`${API}/invoices`, { headers }),
        fetch(`${API}/invoices/stats`, { headers }),
        fetch(`${API}/subscribers`, { headers }),
      ]);
      
      const invoicesData = await invRes.json();
      setInvoices(Array.isArray(invoicesData) ? invoicesData : invoicesData?.data || []);
      
      const statsData = await statRes.json();
      if (statsData && typeof statsData.total === 'number') {
        setStats(statsData);
      }
      
      const subscribersData = await subRes.json();
      setSubscribers(Array.isArray(subscribersData) ? subscribersData : subscribersData?.data || []);
    } catch (err) {
      console.error('Error loading data:', err);
      setInvoices([]);
      setSubscribers([]);
    }
    setLoading(false);
  }

  async function handleCreateInvoice(e: any) {
    e.preventDefault();
    if (!form.subscriberId || !form.dueDate) {
      alert("Please select a subscriber and due date.");
      return;
    }
    
    const total = parseFloat(form.amount) + parseFloat(form.tax) - parseFloat(form.discount);
    
    const payload = {
      subscriberId: parseInt(form.subscriberId),
      amount: parseFloat(form.amount) || 0,
      tax: parseFloat(form.tax) || 0,
      discount: parseFloat(form.discount) || 0,
      total: total,
      dueDate: form.dueDate,
      notes: form.notes,
      items: form.items.filter(i => i.description).map(i => ({
        description: i.description,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        total: i.quantity * i.unitPrice,
      })),
    };
    
    try {
      await fetch(`${API}/invoices`, {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
      setShowForm(false);
      resetForm();
      loadData();
    } catch (err) {
      alert('Failed to create invoice');
    }
  }

  async function handleRecordPayment(invoiceId: number) {
    if (!paymentForm.amount || parseFloat(paymentForm.amount) <= 0) {
      alert("Please enter a valid amount.");
      return;
    }
    
    const payload: any = {
      amount: parseFloat(paymentForm.amount),
      method: paymentForm.method,
      referenceNo: paymentForm.referenceNo,
      notes: paymentForm.notes,
      receivedBy: user?.id,
    };

    try {
      let res = await fetch(`${API}/invoices/${invoiceId}/payment`, {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
      // Duplicate guard: server returns 409 for a near-identical recent payment.
      // Ask the user to confirm, then resend with force to override.
      if (res.status === 409) {
        const info = await res.json().catch(() => ({}));
        if (!confirm(`${info.message || 'This looks like a duplicate payment.'}\n\nRecord it anyway?`)) return;
        res = await fetch(`${API}/invoices/${invoiceId}/payment`, {
          method: 'POST', headers, body: JSON.stringify({ ...payload, force: true }),
        });
      }
      if (!res.ok) { alert('Failed to record payment'); return; }
      setShowPaymentModal(false);
      setPaymentForm({ amount: '', method: 'CASH', referenceNo: '', notes: '' });
      loadData();
    } catch (err) {
      alert('Failed to record payment');
    }
  }

  async function handleReverse(invoiceId: number) {
    if (!reverseReason.trim()) {
      alert("Please provide a reason for the reversal.");
      return;
    }
    try {
      const res = await fetch(`${API}/accounting/invoices/${invoiceId}/reverse`, {
        method: 'POST', headers, body: JSON.stringify({ reason: reverseReason }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.message || 'Failed to reverse invoice');
        return;
      }
      setShowReverseModal(false);
      setSelectedInvoice(null);
      setReverseReason("");
      loadData();
    } catch (err) {
      alert('Failed to reverse invoice');
    }
  }

  function resetForm() {
    setForm({
      subscriberId: '',
      amount: '',
      tax: '0',
      discount: '0',
      dueDate: '',
      notes: '',
      items: [{ description: '', quantity: 1, unitPrice: 0 }],
    });
  }

  function addInvoiceItem() {
    setForm({
      ...form,
      items: [...form.items, { description: '', quantity: 1, unitPrice: 0 }],
    });
  }

  function updateInvoiceItem(index: number, field: string, value: any) {
    const newItems = [...form.items];
    newItems[index] = { ...newItems[index], [field]: value };
    setForm({ ...form, items: newItems });
  }

  function removeInvoiceItem(index: number) {
    setForm({ ...form, items: form.items.filter((_, i) => i !== index) });
  }

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

  const statusColors: any = {
    PAID: { bg: '#d1fae5', color: '#059669', icon: '✅' },
    UNPAID: { bg: '#fee2e2', color: '#dc2626', icon: '⚠️' },
    PARTIAL: { bg: '#fef3c7', color: '#d97706', icon: '🟡' },
    OVERDUE: { bg: '#fecaca', color: '#ef4444', icon: '🔴' },
  };

  const statCards = [
    { label: "Total Invoices", value: stats.total || invoices.length, sub: "all invoices", icon: "📄", bg: "linear-gradient(135deg,#3b82f6,#2563eb)" },
    { label: "Unpaid", value: stats.unpaid || invoices.filter(i => i.status === 'UNPAID').length, sub: "needs payment", icon: "⚠️", bg: "linear-gradient(135deg,#ef4444,#dc2626)" },
    { label: "Overdue", value: stats.overdue || invoices.filter(i => i.status === 'OVERDUE').length, sub: "past due date", icon: "🔴", bg: "linear-gradient(135deg,#f59e0b,#d97706)" },
    { label: "Paid", value: stats.paid || invoices.filter(i => i.status === 'PAID').length, sub: "completed", icon: "✅", bg: "linear-gradient(135deg,#10b981,#059669)" },
  ];

  const totalBilled = invoices.reduce((sum, inv) => sum + (inv.total || 0), 0);
  const totalCollected = invoices.reduce((sum, inv) => sum + (inv.paidAmount || 0), 0);
  const totalDue = invoices.reduce((sum, inv) => sum + (inv.dueAmount || 0), 0);

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
              onClick={() => { resetForm(); setShowForm(true); }}
              style={{ background: t.accent, color: "#fff", border: "none", padding: "10px 18px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              + Create Invoice
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

          {/* Financial Summary Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginBottom: 24 }}>
            <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: t.textMuted }}>💰 Total Billed</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: t.text }}>{money(stats.totalAmount || totalBilled)}</span>
            </div>
            <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: t.textMuted }}>✅ Total Collected</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: t.green }}>{money(stats.totalPaid || totalCollected)}</span>
            </div>
            <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: t.textMuted }}>📊 Total Due</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: t.amber }}>{money(stats.totalDue || totalDue)}</span>
            </div>
          </div>

          {/* Invoices Table */}
          {loading ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ width: 36, height: 36, border: `3px solid ${t.cardBorder}`, borderTopColor: t.accent, borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 14px" }}></div>
              <p style={{ color: t.textMuted, fontSize: 13 }}>Loading invoices...</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          ) : invoices.length === 0 ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>📄</div>
              <h3 style={{ fontSize: 18, color: t.text, marginBottom: 6 }}>No Invoices Yet</h3>
              <p style={{ color: t.textMuted, fontSize: 13, marginBottom: 20 }}>Create your first invoice to start billing.</p>
              <button onClick={() => { resetForm(); setShowForm(true); }} style={{ background: t.accent, color: "#fff", border: "none", padding: "10px 22px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>
                + Create First Invoice
              </button>
            </div>
          ) : (
            <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
                  <thead>
                    <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Invoice #</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Customer</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Date</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Due Date</th>
                      <th style={{ padding: "10px 14px", textAlign: "right", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Total</th>
                      <th style={{ padding: "10px 14px", textAlign: "right", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Paid</th>
                      <th style={{ padding: "10px 14px", textAlign: "right", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Due</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Status</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv, idx) => {
                      const sc = statusColors[inv.status] || { bg: '#f1f5f9', color: 'var(--muted)', icon: '📄' };
                      return (
                        <tr key={inv.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: idx % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                          <td style={{ padding: "10px 14px" }}>
                            <code style={{ fontSize: 11, fontWeight: 600, color: t.accent }}>{inv.invoiceNo}</code>
                          </td>
                          <td style={{ padding: "10px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 28, height: 28, borderRadius: 8, background: "rgba(14,165,233,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 600, color: t.accent }}>
                                {getInitials(inv.subscriber?.fullName)}
                              </div>
                              <div>
                                <div style={{ fontSize: 12, fontWeight: 500, color: t.text }}>{inv.subscriber?.fullName || '-'}</div>
                                <div style={{ fontSize: 10, color: t.textMuted }}>{inv.subscriber?.phone}</div>
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: "10px 14px", fontSize: 11, color: t.textSub }}>{new Date(inv.createdAt).toLocaleDateString()}</td>
                          <td style={{ padding: "10px 14px", fontSize: 11, color: new Date(inv.dueDate) < new Date() && inv.status !== 'PAID' ? t.red : t.textSub, fontWeight: new Date(inv.dueDate) < new Date() && inv.status !== 'PAID' ? 600 : 400 }}>
                            {new Date(inv.dueDate).toLocaleDateString()}
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "right", fontSize: 12, fontWeight: 600, color: t.text }}>{money(inv.total)}</td>
                          <td style={{ padding: "10px 14px", textAlign: "right", fontSize: 12, color: t.green }}>{money(inv.paidAmount)}</td>
                          <td style={{ padding: "10px 14px", textAlign: "right", fontSize: 12, fontWeight: 600, color: t.red }}>{money(inv.dueAmount)}</td>
                          <td style={{ padding: "10px 14px", textAlign: "center" }}>
                            <span style={{ padding: "3px 10px", borderRadius: 30, fontSize: 10, fontWeight: 500, background: sc.bg, color: sc.color, display: "inline-flex", alignItems: "center", gap: 4 }}>
                              {sc.icon} {inv.status}
                            </span>
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "center" }}>
                            <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                              <Btn size="xs" variant="ghost" onClick={() => { setSelectedInvoice(inv); setShowDetailsModal(true); }} title="View details"><Ic.Eye /></Btn>
                              {inv.status !== 'PAID' && (
                                <Btn size="xs" variant="success" onClick={() => { setSelectedInvoice(inv); setPaymentForm({ amount: inv.dueAmount?.toString(), method: 'CASH', referenceNo: '', notes: '' }); setShowPaymentModal(true); }} title="Record payment">💰</Btn>
                              )}
                              {inv.paidAmount > 0 && inv.status !== 'CANCELLED' && (
                                <Btn size="xs" variant="danger" onClick={() => { setSelectedInvoice(inv); setReverseReason(""); setShowReverseModal(true); }} title="Reverse invoice"><Ic.X /></Btn>
                              )}
                              <Btn size="xs" variant="default" onClick={() => window.open(`${API}/invoices/${inv.id}/print`, '_blank')} title="Print invoice"><Ic.Printer /></Btn>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: "10px 14px", borderTop: `1px solid ${t.cardBorder}`, fontSize: 10, color: t.textMuted }}>
                Showing {invoices.length} invoices
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="page-footer" style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${t.cardBorder}`, fontSize: 11, color: t.textMuted, textAlign: "center" }}>
            © {new Date().getFullYear()} <strong style={{ color: t.accent }}>JointBox</strong> ISP CRM Platform. All rights reserved.
          </div>
        </div>
      </div>

      {/* Create Invoice Modal */}
      {showForm && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, overflowY: "auto" }} onClick={() => setShowForm(false)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 750, maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>📄 Create New Invoice</h2>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>
            <p style={{ fontSize: 11, color: t.textMuted, marginBottom: 20 }}>Generate an invoice for a subscriber.</p>

            <form onSubmit={handleCreateInvoice}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Select Subscriber *</label>
                  <select value={form.subscriberId} onChange={e => setForm({ ...form, subscriberId: e.target.value })} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text }}>
                    <option value="">Select Customer</option>
                    {subscribers.map((s: any) => (
                      <option key={s.id} value={s.id}>{s.fullName} - {s.phone}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Due Date *</label>
                  <input type="date" value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text }} required />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 16 }}>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Amount ({currencySymbol()})</label>
                  <input type="number" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0" style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Tax/GST (PKR)</label>
                  <input type="number" value={form.tax} onChange={e => setForm({ ...form, tax: e.target.value })} placeholder="0" style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Discount (PKR)</label>
                  <input type="number" value={form.discount} onChange={e => setForm({ ...form, discount: e.target.value })} placeholder="0" style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text }} />
                </div>
              </div>

              <div style={{ fontSize: 12, fontWeight: 600, color: t.text, margin: "16px 0 10px", paddingBottom: 5, borderBottom: `2px solid ${t.accent}` }}>📋 Invoice Items</div>
              {form.items.map((item, index) => (
                <div key={index} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                  <div style={{ flex: 2 }}><input value={item.description} onChange={e => updateInvoiceItem(index, 'description', e.target.value)} placeholder="Description" style={{ width: "100%", padding: "6px 10px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 11, background: t.card, color: t.text }} /></div>
                  <div style={{ flex: 1 }}><input type="number" value={item.quantity} onChange={e => updateInvoiceItem(index, 'quantity', parseInt(e.target.value))} placeholder="Qty" style={{ width: "100%", padding: "6px 10px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 11, background: t.card, color: t.text }} /></div>
                  <div style={{ flex: 1 }}><input type="number" value={item.unitPrice} onChange={e => updateInvoiceItem(index, 'unitPrice', parseFloat(e.target.value))} placeholder="Price" style={{ width: "100%", padding: "6px 10px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 11, background: t.card, color: t.text }} /></div>
                  <div style={{ flex: 1 }}><input value={item.quantity * item.unitPrice} readOnly placeholder="Total" style={{ width: "100%", padding: "6px 10px", background: d ? "var(--border)" : "#f3f4f6", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 11, color: t.textMuted }} /></div>
                  <button type="button" onClick={() => removeInvoiceItem(index)} style={{ background: "#450a0a", border: "none", width: 32, height: 32, borderRadius: 8, cursor: "pointer", color: "#f87171" }}>🗑️</button>
                </div>
              ))}
              <button type="button" onClick={addInvoiceItem} style={{ background: "transparent", border: `1px dashed ${t.cardBorder}`, padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 11, marginBottom: 16, color: t.textSub }}>+ Add Item</button>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} placeholder="Additional notes..." style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text, resize: "none" }} />
              </div>

              <div style={{ background: d ? "var(--surface)" : "#eff6ff", borderRadius: 8, padding: 10, fontSize: 11, color: d ? "#93c5fd" : "#1e40af", margin: "12px 0" }}>
                💡 <strong>Total Calculation:</strong> Amount + Tax - Discount = Total
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button type="submit" style={{ flex: 1, background: t.accent, color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Create Invoice</button>
                <button type="button" onClick={() => setShowForm(false)} style={{ flex: 1, background: "transparent", border: `1px solid ${t.cardBorder}`, color: t.textSub, padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {showPaymentModal && selectedInvoice && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setShowPaymentModal(false)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 450 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>💰 Record Payment</h2>
              <button onClick={() => setShowPaymentModal(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>
            <p style={{ fontSize: 11, color: t.textMuted, marginBottom: 20 }}>Invoice: {selectedInvoice.invoiceNo} | Due: PKR {selectedInvoice.dueAmount}</p>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Amount *</label>
              <input type="number" value={paymentForm.amount} onChange={e => setPaymentForm({ ...paymentForm, amount: e.target.value })} placeholder="Enter amount" style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text }} required />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Payment Method</label>
                <select value={paymentForm.method} onChange={e => setPaymentForm({ ...paymentForm, method: e.target.value })} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text }}>
                  <option value="CASH">💵 Cash</option>
                  <option value="BANK_TRANSFER">🏦 Bank Transfer</option>
                  <option value="CHEQUE">📝 Cheque</option>
                  <option value="CARD">💳 Card</option>
                  <option value="ONLINE">🌐 Online</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Reference No</label>
                <input value={paymentForm.referenceNo} onChange={e => setPaymentForm({ ...paymentForm, referenceNo: e.target.value })} placeholder="Transaction ID" style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text }} />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Notes</label>
              <textarea value={paymentForm.notes} onChange={e => setPaymentForm({ ...paymentForm, notes: e.target.value })} rows={2} placeholder="Payment notes..." style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text, resize: "none" }} />
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button onClick={() => handleRecordPayment(selectedInvoice.id)} style={{ flex: 1, background: t.accent, color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Record Payment</button>
              <button onClick={() => setShowPaymentModal(false)} style={{ flex: 1, background: "transparent", border: `1px solid ${t.cardBorder}`, color: t.textSub, padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Invoice Details Modal */}
      {showDetailsModal && selectedInvoice && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, overflowY: "auto" }} onClick={() => setShowDetailsModal(false)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 700, maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>📄 Invoice Details</h2>
              <button onClick={() => setShowDetailsModal(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20, paddingBottom: 16, borderBottom: `2px solid ${t.cardBorder}`, flexWrap: "wrap", gap: 16 }}>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 700, color: t.accent, margin: 0 }}>JointBox</h3>
                  <p style={{ fontSize: 11, color: t.textMuted, margin: "4px 0 0" }}>ISP CRM Platform</p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ margin: 0, fontSize: 12 }}><strong style={{ color: t.text }}>Invoice #:</strong> <span style={{ color: t.accent }}>{selectedInvoice.invoiceNo}</span></p>
                  <p style={{ margin: 0, fontSize: 12 }}><strong style={{ color: t.text }}>Date:</strong> {new Date(selectedInvoice.createdAt).toLocaleDateString()}</p>
                  <p style={{ margin: 0, fontSize: 12 }}><strong style={{ color: t.text }}>Due Date:</strong> {new Date(selectedInvoice.dueDate).toLocaleDateString()}</p>
                </div>
              </div>

              <div style={{ marginBottom: 20, padding: 14, background: d ? "var(--bg)" : "#f8fafc", borderRadius: 12 }}>
                <h4 style={{ fontSize: 12, fontWeight: 600, margin: "0 0 8px", color: t.text }}>Bill To:</h4>
                <p style={{ margin: 0, fontSize: 12, color: t.textSub }}>
                  <strong style={{ color: t.text }}>{selectedInvoice.subscriber?.fullName}</strong><br />
                  {selectedInvoice.subscriber?.phone}<br />
                  {selectedInvoice.subscriber?.email}<br />
                  {selectedInvoice.subscriber?.address}
                </p>
              </div>

              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
                <thead>
                  <tr style={{ background: d ? "var(--bg)" : "#f8fafc" }}>
                    <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, fontWeight: 600, borderBottom: `1px solid ${t.cardBorder}`, color: t.textMuted }}>Description</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", fontSize: 11, fontWeight: 600, borderBottom: `1px solid ${t.cardBorder}`, color: t.textMuted }}>Qty</th>
                    <th style={{ padding: "8px 10px", textAlign: "right", fontSize: 11, fontWeight: 600, borderBottom: `1px solid ${t.cardBorder}`, color: t.textMuted }}>Unit Price</th>
                    <th style={{ padding: "8px 10px", textAlign: "right", fontSize: 11, fontWeight: 600, borderBottom: `1px solid ${t.cardBorder}`, color: t.textMuted }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedInvoice.items && selectedInvoice.items.length > 0 ? (
                    selectedInvoice.items.map((item: any, i: number) => (
                      <tr key={i}>
                        <td style={{ padding: "6px 10px", fontSize: 11, borderBottom: `1px solid ${t.cardBorder}`, color: t.textSub }}>{item.description}</td>
                        <td style={{ padding: "6px 10px", fontSize: 11, textAlign: "center", borderBottom: `1px solid ${t.cardBorder}`, color: t.textSub }}>{item.quantity}</td>
                        <td style={{ padding: "6px 10px", fontSize: 11, textAlign: "right", borderBottom: `1px solid ${t.cardBorder}`, color: t.textSub }}>PKR {item.unitPrice}</td>
                        <td style={{ padding: "6px 10px", fontSize: 11, textAlign: "right", borderBottom: `1px solid ${t.cardBorder}`, color: t.textSub }}>PKR {item.total}</td>
                      </tr>
                    ))
                  ) : (
                    <tr><td colSpan={4} style={{ padding: "16px", textAlign: "center", fontSize: 11, color: t.textMuted }}>No items listed</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr><td colSpan={3} style={{ padding: "6px 10px", textAlign: "right", fontSize: 11, color: t.textSub }}>Subtotal:</td><td style={{ padding: "6px 10px", textAlign: "right", fontSize: 11, color: t.text }}>PKR {selectedInvoice.amount}</td></tr>
                  <tr><td colSpan={3} style={{ padding: "6px 10px", textAlign: "right", fontSize: 11, color: t.textSub }}>Tax:</td><td style={{ padding: "6px 10px", textAlign: "right", fontSize: 11, color: t.text }}>PKR {selectedInvoice.tax}</td></tr>
                  <tr><td colSpan={3} style={{ padding: "6px 10px", textAlign: "right", fontSize: 11, color: t.textSub }}>Discount:</td><td style={{ padding: "6px 10px", textAlign: "right", fontSize: 11, color: t.red }}>-PKR {selectedInvoice.discount}</td></tr>
                  <tr style={{ background: d ? "var(--bg)" : "#f8fafc", fontWeight: 700 }}>
                    <td colSpan={3} style={{ padding: "8px 10px", textAlign: "right", fontSize: 12, color: t.text }}>Total:</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", fontSize: 12, fontWeight: 700, color: t.accent }}>PKR {selectedInvoice.total}</td>
                  </tr>
                  <tr><td colSpan={3} style={{ padding: "6px 10px", textAlign: "right", fontSize: 11, color: t.textSub }}>Paid:</td><td style={{ padding: "6px 10px", textAlign: "right", fontSize: 11, color: t.green }}>PKR {selectedInvoice.paidAmount}</td></tr>
                  <tr style={{ background: d ? "#422006" : "#fef3c7" }}>
                    <td colSpan={3} style={{ padding: "8px 10px", textAlign: "right", fontSize: 12, fontWeight: 700, color: t.text }}>Due:</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", fontSize: 12, fontWeight: 700, color: t.amber }}>PKR {selectedInvoice.dueAmount}</td>
                  </tr>
                </tfoot>
              </table>

              {selectedInvoice.notes && (
                <div style={{ marginTop: 16, padding: 12, background: d ? "var(--bg)" : "#f8fafc", borderRadius: 10, fontSize: 11, color: t.textSub }}>
                  <strong style={{ color: t.text }}>Notes:</strong> {selectedInvoice.notes}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                <button onClick={() => setShowDetailsModal(false)} style={{ flex: 1, background: t.accent, color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reverse Invoice Modal */}
      {showReverseModal && selectedInvoice && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setShowReverseModal(false)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 450 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>🔄 Reverse Invoice</h2>
              <button onClick={() => setShowReverseModal(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>
            <p style={{ fontSize: 11, color: t.textMuted, marginBottom: 16 }}>
              Reverse invoice <strong>{selectedInvoice.invoiceNo}</strong> — PKR {money(selectedInvoice.paidAmount)} will be refunded.
            </p>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Reason for reversal *</label>
              <textarea value={reverseReason} onChange={e => setReverseReason(e.target.value)} rows={3} placeholder="e.g. Duplicate invoice, cancelled service..."
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text, resize: "vertical" }} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setShowReverseModal(false)} style={{ flex: 1, background: t.cardBorder, color: t.text, border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => handleReverse(selectedInvoice.id)} style={{ flex: 1, background: t.red || "#ef4444", color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Reverse Invoice</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
