"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icons as SIcons } from "../components/icons";
import API_BASE from "../components/api";

interface Payment {
  id: number;
  paymentNo: string;
  amount: number;
  method: string;
  paymentDate: string;
  refundedAt?: string | null;
  refundReason?: string | null;
  invoice?: { invoiceNo: string };
  subscriber?: { fullName: string };
}

const API = API_BASE;

// ─── Icons ────────────────────────────────────────────────────────────────────
const Ic = { ...SIcons };

// ✅ Complete 14 menu items (matching dashboard)
export default function PaymentsPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [time, setTime] = useState("");
  const [greeting, setGreeting] = useState("Welcome");
const [payments, setPayments] = useState<Payment[]>([]);
const [loading, setLoading] = useState(true);
const [error, setError] = useState("");
const [showRefundModal, setShowRefundModal] = useState(false);
const [refundReason, setRefundReason] = useState("");
const [refundToBalance, setRefundToBalance] = useState(true);
const [refundAmount, setRefundAmount] = useState("");
const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

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
    teal:        "#14b8a6",
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
      teal:    { background: "#134e4a", color: "#2dd4bf" },
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

  async function loadPayments() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/payments`, { headers });
      if (res.status === 401) {
        localStorage.removeItem("token");
        router.push("/login");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      let paymentsArray: Payment[] = [];
      if (Array.isArray(data)) {
        paymentsArray = data;
      } else if (data?.data && Array.isArray(data.data)) {
        paymentsArray = data.data;
      } else if (data?.items && Array.isArray(data.items)) {
        paymentsArray = data.items;
      }
      setPayments(paymentsArray);
    } catch (err) {
      console.error('Error loading payments:', err);
      setError('Failed to load payments. Please try again.');
      setPayments([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    const tk = localStorage.getItem("token");
    if (!tk) {
      router.push("/login");
      return;
    }
    fetch(`${API}/profile`, { headers })
      .then(r => r.json())
      .then(d => setUser(d.user))
      .catch(() => {
        localStorage.removeItem("token");
        router.push("/login");
      });
    loadPayments();
    const tick = () => {
      const h = new Date().getHours();
      setGreeting(h < 12 ? "Good Morning" : h < 18 ? "Good Afternoon" : "Good Evening");
      setTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Calculate stats
  const stats = {
    total: payments.length,
    totalAmount: payments.reduce((sum, p) => sum + (p.amount || 0), 0),
    cashCount: payments.filter(p => p.method === "CASH").length,
    bankCount: payments.filter(p => p.method === "BANK_TRANSFER" || p.method === "BANK").length,
    cardCount: payments.filter(p => p.method === "CARD").length,
  };

  const statCards = [
    { label: "Total Payments", value: stats.total, sub: "transactions", icon: "💰", bg: "linear-gradient(135deg,#3b82f6,#2563eb)" },
    { label: "Total Amount", value: `PKR ${stats.totalAmount.toLocaleString()}`, sub: "collected", icon: "💵", bg: "linear-gradient(135deg,#10b981,#059669)" },
    { label: "Card Payments", value: stats.cardCount, sub: "digital payments", icon: "💳", bg: "linear-gradient(135deg,#a855f7,#7c3aed)" },
    { label: "Cash Payments", value: stats.cashCount, sub: "physical payments", icon: "💵", bg: "linear-gradient(135deg,#f59e0b,#d97706)" },
  ];

  const formatCurrency = (amount: number) => `PKR ${(amount || 0).toLocaleString()}`;

  async function handleRefund(paymentId: number) {
    if (!refundReason.trim()) {
      alert("Please provide a reason for the refund.");
      return;
    }
    const amt = refundAmount.trim() ? Number(refundAmount) : undefined;
    if (amt != null && (!isFinite(amt) || amt <= 0)) {
      alert("Enter a valid refund amount, or leave it blank for a full refund.");
      return;
    }
    try {
      const res = await fetch(`${API}/accounting/payments/${paymentId}/refund`, {
        method: 'POST', headers, body: JSON.stringify({ reason: refundReason, toBalance: refundToBalance, ...(amt != null ? { amount: amt } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.message || 'Failed to refund payment');
        return;
      }
      if (data.pending) {
        alert(`This refund (PKR ${Number(data.amount).toLocaleString()}) exceeds the approval limit of PKR ${Number(data.threshold).toLocaleString()} and has been sent to the ISP owner for sign-off.`);
      }
      setShowRefundModal(false);
      setSelectedPayment(null);
      setRefundReason("");
      setRefundAmount("");
      loadPayments();
    } catch (err) {
      alert('Failed to refund payment');
    }
  }

  const getMethodStyle = (method: string) => {
    switch(method) {
      case "CARD": return { bg: '#d1fae5', color: '#059669', label: '💳 Card' };
      case "BANK_TRANSFER":
      case "BANK": return { bg: '#e0e7ff', color: '#4f46e5', label: '🏦 Bank Transfer' };
      case "CASH": return { bg: '#fef3c7', color: '#d97706', label: '💵 Cash' };
      case "CHEQUE": return { bg: '#f1f5f9', color: 'var(--muted)', label: '📝 Cheque' };
      default: return { bg: '#f1f5f9', color: 'var(--muted)', label: '💳 Other' };
    }
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: t.bg, color: t.text, fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>

      {/* ══ MAIN ══ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* ── CONTENT ── */}
        <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>

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

          {/* Payments Table */}
          {loading ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ width: 36, height: 36, border: `3px solid ${t.cardBorder}`, borderTopColor: t.accent, borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 14px" }}></div>
              <p style={{ color: t.textMuted, fontSize: 13 }}>Loading payments...</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          ) : error ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
              <h3 style={{ fontSize: 18, color: t.red, marginBottom: 8 }}>Error</h3>
              <p style={{ color: t.textMuted, fontSize: 13, marginBottom: 20 }}>{error}</p>
              <button onClick={loadPayments} style={{ background: t.accent, color: "#fff", border: "none", padding: "10px 22px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>Try Again</button>
            </div>
          ) : payments.length === 0 ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>💳</div>
              <h3 style={{ fontSize: 18, color: t.text, marginBottom: 6 }}>No Payments Yet</h3>
              <p style={{ color: t.textMuted, fontSize: 13, marginBottom: 20 }}>Payments will appear here when invoices are paid.</p>
            </div>
          ) : (
            <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
                  <thead>
                    <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Payment #</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Invoice</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Customer</th>
                      <th style={{ padding: "10px 14px", textAlign: "right", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Amount</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Method</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Date</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p, idx) => {
                      const methodStyle = getMethodStyle(p.method);
                      return (
                        <tr key={p.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: idx % 2 === 0 ? t.card : (d ? "#121d30" : "#ffffff") }}>
                          <td style={{ padding: "10px 14px" }}>
                            <code style={{ fontSize: 11, fontWeight: 600, color: t.teal }}>{p.paymentNo || `PAY-${p.id}`}</code>
                          </td>
                          <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 11, color: t.textMuted }}>{p.invoice?.invoiceNo || '-'}</td>
                          <td style={{ padding: "10px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 28, height: 28, borderRadius: 8, background: "rgba(14,165,233,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: t.accent }}>
                                {(p.subscriber?.fullName?.[0] || 'U').toUpperCase()}
                              </div>
                              <span style={{ fontSize: 12, color: t.text }}>{p.subscriber?.fullName || '-'}</span>
                            </div>
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "right", fontSize: 13, fontWeight: 700, color: t.green }}>{formatCurrency(p.amount)}</td>
                          <td style={{ padding: "10px 14px", textAlign: "center" }}>
                            <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 10, fontWeight: 500, background: methodStyle.bg, color: methodStyle.color }}>
                              {methodStyle.label}
                            </span>
                          </td>
                          <td style={{ padding: "10px 14px", fontSize: 11, color: t.textMuted }}>{new Date(p.paymentDate).toLocaleDateString()}</td>
                          <td style={{ padding: "10px 14px", textAlign: "center" }}>
                            <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                              {!p.refundedAt && (
                                <button onClick={() => { setSelectedPayment(p); setRefundReason(""); setRefundToBalance(true); setShowRefundModal(true); }}
                                  style={{ padding: "4px 10px", borderRadius: 6, border: "none", fontSize: 10, fontWeight: 600, background: "#fee2e2", color: "#dc2626", cursor: "pointer" }}>Refund</button>
                              )}
                              {p.refundedAt && (
                                <span style={{ padding: "3px 8px", borderRadius: 20, fontSize: 9, background: "#f1f5f9", color: "var(--muted)" }}>Refunded</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: "10px 14px", borderTop: `1px solid ${t.cardBorder}`, fontSize: 10, color: t.textMuted }}>
                Showing {payments.length} payments
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="page-footer" style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${t.cardBorder}`, fontSize: 11, color: t.textMuted, textAlign: "center" }}>
            © {new Date().getFullYear()} <strong style={{ color: t.accent }}>JointBox</strong> ISP CRM Platform. All rights reserved.
          </div>
        </div>
      </div>

      {/* Refund Modal */}
      {showRefundModal && selectedPayment && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setShowRefundModal(false)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 450 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>💰 Refund Payment</h2>
              <button onClick={() => setShowRefundModal(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>
            <p style={{ fontSize: 11, color: t.textMuted, marginBottom: 6 }}>
              Refund payment <strong>{selectedPayment.paymentNo}</strong> — PKR {(selectedPayment.amount || 0).toLocaleString()}
              {((selectedPayment as any).refundedAmount || 0) > 0 && (
                <> · already refunded PKR {((selectedPayment as any).refundedAmount).toLocaleString()}</>
              )}
            </p>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Amount (leave blank for full refund)</label>
              <input type="number" min={0} step="0.01" value={refundAmount} onChange={e => setRefundAmount(e.target.value)}
                placeholder={`Full: PKR ${((selectedPayment.amount || 0) - ((selectedPayment as any).refundedAmount || 0)).toLocaleString()}`}
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5 }}>Reason for refund *</label>
              <textarea value={refundReason} onChange={e => setRefundReason(e.target.value)} rows={3} placeholder="e.g. Customer requested cancellation, duplicate payment..."
                style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.card, color: t.text, resize: "vertical" }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={refundToBalance} onChange={e => setRefundToBalance(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: t.accent }} />
                <span style={{ fontSize: 12, color: t.text }}>Credit to subscriber wallet instead of cash refund</span>
              </label>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setShowRefundModal(false)} style={{ flex: 1, background: t.cardBorder, color: t.text, border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => handleRefund(selectedPayment.id)} style={{ flex: 1, background: t.red || "#ef4444", color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Refund Payment</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
