"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icons as SIcons } from "../components/icons";
import API_BASE from "../components/api";

interface Ticket {
  id: number;
  ticketNo: string;
  subject: string;
  description: string;
  category: string;
  priority: string;
  status: string;
  createdAt: string;
  subscriber?: {
    id: number;
    fullName: string;
    phone: string;
  };
  assignedTo?: {
    id: number;
    name: string;
  };
  messages?: Array<{
    id: number;
    message: string;
    sentBy: string;
    sentByType: string;
    createdAt: string;
  }>;
}

interface Subscriber {
  id: number;
  fullName: string;
  phone: string;
}

interface User {
  id: number;
  name: string;
  email: string;
}

const API = API_BASE;

const Icons = { ...SIcons };

// ✅ Complete 14 menu items (matching dashboard)
export default function ComplaintsPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [time, setTime] = useState("");
  const [greeting, setGreeting] = useState("Welcome");

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  const [stats, setStats] = useState({
    total: 0,
    open: 0,
    inProgress: 0,
    resolved: 0,
    closed: 0,
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [newMessage, setNewMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    subscriberId: '',
    category: 'TECHNICAL',
    priority: 'MEDIUM',
    subject: '',
    description: '',
    assignedTo: '',
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
    const t = localStorage.getItem("token");
    if (!t) {
      router.push("/login");
      return;
    }
    loadData();
  }, []);

  useEffect(() => {
    if (!token) return;

    fetch(`${API}/profile`, { headers })
      .then(res => res.json())
      .then(data => setUser(data?.user || null))
      .catch(() => router.push("/login"));

    const tick = () => {
      const now = new Date();
      const h = now.getHours();
      setGreeting(h < 12 ? "Good Morning" : h < 18 ? "Good Afternoon" : "Good Evening");
      setTime(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [token]);

  async function loadData() {
    setLoading(true);
    setError("");

    try {
      let ticketsData = [];
      let statsData = { total: 0, open: 0, inProgress: 0, resolved: 0, closed: 0 };
      
      try {
        const ticketRes = await fetch(`${API}/tickets`, { headers });
        if (ticketRes.ok) {
          const data = await ticketRes.json();
          ticketsData = Array.isArray(data) ? data : (data?.data || []);
        }
      } catch (err) {
        console.error('Tickets fetch error:', err);
      }
      
      try {
        const statRes = await fetch(`${API}/tickets/stats`, { headers });
        if (statRes.ok) {
          const data = await statRes.json();
          statsData = data || { total: 0, open: 0, inProgress: 0, resolved: 0, closed: 0 };
        }
      } catch (err) {
        console.error('Stats fetch error:', err);
      }
      
      let subscribersData = [];
      try {
        const subRes = await fetch(`${API}/subscribers`, { headers });
        if (subRes.ok) {
          const data = await subRes.json();
          subscribersData = Array.isArray(data) ? data : (data?.data || []);
        }
      } catch (err) {
        console.error('Subscribers fetch error:', err);
      }
      
      let usersData = [];
      try {
        const userRes = await fetch(`${API}/users`, { headers });
        if (userRes.ok) {
          const data = await userRes.json();
          usersData = Array.isArray(data) ? data : (data?.data || []);
        }
      } catch (err) {
        console.error('Users fetch error:', err);
      }

      setTickets(ticketsData);
      setStats(statsData);
      setSubscribers(subscribersData);
      setUsers(usersData);
    } catch (err) {
      console.error('Error loading tickets:', err);
      setError('Failed to load tickets. Please make sure the backend server is running.');
    }
    setLoading(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.subscriberId || !form.subject || !form.description) {
      setError("Please fill all required fields");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const response = await fetch(`${API}/tickets`, {
        method: 'POST',
        headers,
        body: JSON.stringify(form),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || 'Failed to create ticket');
      }

      setShowForm(false);
      resetForm();
      loadData();
    } catch (err: any) {
      console.error('Create ticket error:', err);
      setError(err.message || 'Failed to create ticket');
    }
    setSaving(false);
  }

  async function handleUpdateStatus(id: number, status: string) {
    try {
      await fetch(`${API}/tickets/${id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ status }),
      });
      loadData();
      if (selectedTicket && selectedTicket.id === id) {
        await loadTicketDetails(id);
      }
    } catch (err) {
      console.error('Status update error:', err);
      setError('Failed to update ticket status');
    }
  }

  async function handleAddMessage(ticketId: number) {
    if (!newMessage.trim()) return;

    try {
      await fetch(`${API}/tickets/${ticketId}/message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: newMessage,
          sentBy: user?.id,
          sentByType: 'STAFF',
        }),
      });
      setNewMessage("");
      await loadTicketDetails(ticketId);
      loadData();
    } catch (err) {
      console.error('Message error:', err);
      setError('Failed to send message');
    }
  }

  async function loadTicketDetails(id: number) {
    try {
      const res = await fetch(`${API}/tickets/${id}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setSelectedTicket(data || null);
        setShowDetailsModal(true);
      } else {
        setError('Failed to load ticket details');
      }
    } catch (err) {
      console.error('Load details error:', err);
      setError('Failed to load ticket details');
    }
  }

  function resetForm() {
    setForm({
      subscriberId: '',
      category: 'TECHNICAL',
      priority: 'MEDIUM',
      subject: '',
      description: '',
      assignedTo: '',
    });
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

  const categoryLabels: any = {
    TECHNICAL: { icon: "🔧", label: "Technical", color: "#2563eb", bg: "#dbeafe" },
    BILLING: { icon: "💰", label: "Billing", color: "#d97706", bg: "#fef3c7" },
    COMPLAINT: { icon: "⚠️", label: "Complaint", color: "#dc2626", bg: "#fee2e2" },
    INSTALLATION: { icon: "🔌", label: "Installation", color: "#10b981", bg: "#d1fae5" },
    DISCONNECTION: { icon: "❌", label: "Disconnection", color: "#6b7280", bg: "#f3f4f6" },
    OTHER: { icon: "📝", label: "Other", color: "#8b5cf6", bg: "#ede9fe" },
  };

  const priorityColors: any = {
    LOW: { bg: "#d1fae5", color: "#059669", label: "🟢 Low" },
    MEDIUM: { bg: "#fef3c7", color: "#d97706", label: "🟡 Medium" },
    HIGH: { bg: "#fee2e2", color: "#dc2626", label: "🔴 High" },
    URGENT: { bg: "#fecaca", color: "#991b1b", label: "🔥 Urgent" },
  };

  const statusColors: any = {
    OPEN: { bg: "#fef3c7", color: "#d97706", label: "🟡 Open" },
    IN_PROGRESS: { bg: "#dbeafe", color: "#2563eb", label: "🔵 In Progress" },
    RESOLVED: { bg: "#d1fae5", color: "#059669", label: "✅ Resolved" },
    CLOSED: { bg: "#f1f5f9", color: "var(--muted)", label: "⭕ Closed" },
    ESCALATED: { bg: "#fecaca", color: "#991b1b", label: "🔥 Escalated" },
  };

  const statCards = [
    { label: "Total Tickets", value: stats.total, sub: "all tickets", icon: "🎫", bg: "linear-gradient(135deg,#3b82f6,#2563eb)" },
    { label: "Open Tickets", value: stats.open, sub: "awaiting response", icon: "🟡", bg: "linear-gradient(135deg,#f59e0b,#d97706)" },
    { label: "In Progress", value: stats.inProgress, sub: "being handled", icon: "🔵", bg: "linear-gradient(135deg,#06b6d4,#0891b2)" },
    { label: "Resolved", value: stats.resolved, sub: "completed", icon: "✅", bg: "linear-gradient(135deg,#10b981,#059669)" },
    { label: "Closed", value: stats.closed, sub: "closed tickets", icon: "⭕", bg: "linear-gradient(135deg,var(--muted),#475569)" },
  ];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: t.bg, color: t.text, fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>

      {/* ══════════ MAIN ══════════ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* ── CONTENT ── */}
        <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>

          {/* Error Message */}
          {error && (
            <div style={{ marginBottom: 20, padding: "10px 16px", background: d ? "#450a0a" : "#fee2e2", border: `1px solid ${d ? "#7f1d1d" : "#fecaca"}`, borderRadius: 12, color: d ? "#f87171" : "#dc2626", fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>⚠️ {error}</span>
              <button onClick={() => setError("")} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: d ? "#f87171" : "#dc2626" }}>×</button>
            </div>
          )}

          {/* Stat Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 24 }}>
            {statCards.map((card, idx) => (
              <div key={idx} style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: "14px", transition: "transform .15s" }}
                onMouseEnter={e => (e.currentTarget.style.transform = "translateY(-2px)")}
                onMouseLeave={e => (e.currentTarget.style.transform = "")}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", background: card.bg, fontSize: 18 }}>{card.icon}</div>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "rgba(14,165,233,0.15)", color: t.accent }}>Live</span>
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: t.textMuted }}>{card.label}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: t.text }}>{loading ? "—" : card.value}</div>
                <div style={{ fontSize: 10, color: t.textMuted, marginTop: 4 }}>{card.sub}</div>
              </div>
            ))}
          </div>

          {/* Tickets Table */}
          {loading ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ width: 36, height: 36, border: `3px solid ${t.cardBorder}`, borderTopColor: t.accent, borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 14px" }}></div>
              <p style={{ color: t.textMuted, fontSize: 13 }}>Loading tickets...</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          ) : tickets.length === 0 ? (
            <div style={{ textAlign: "center", padding: 50, background: t.card, borderRadius: 12, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🎫</div>
              <h3 style={{ fontSize: 18, color: t.text, marginBottom: 6 }}>No Tickets Yet</h3>
              <p style={{ color: t.textMuted, fontSize: 13, marginBottom: 20 }}>Create your first support ticket to get started.</p>
              <button onClick={() => { resetForm(); setShowForm(true); }} style={{ background: t.accent, color: "#fff", border: "none", padding: "10px 22px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>+ New Ticket</button>
            </div>
          ) : (
            <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: d ? "var(--bg)" : "#f1f5f9", borderBottom: `1px solid ${t.cardBorder}` }}>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Ticket #</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Customer</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Subject</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Category</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Priority</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Status</th>
                      <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Created</th>
                      <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 10, fontWeight: 700, color: t.textMuted, textTransform: "uppercase" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.map((ticket, idx) => (
                      <tr key={ticket.id} style={{ borderBottom: `1px solid ${t.cardBorder}`, background: idx % 2 === 0 ? (d ? "var(--surface-2)" : "#f8fafc") : t.card }}>
                        <td style={{ padding: "10px 14px" }}>
                          <code style={{ fontSize: 11, fontWeight: 600, color: t.accent }}>{ticket.ticketNo}</code>
                        </td>
                        <td style={{ padding: "10px 14px" }}>
                          {ticket.subscriber ? (
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: t.text }}>{ticket.subscriber.fullName}</div>
                              <div style={{ fontSize: 10, color: t.textMuted }}>{ticket.subscriber.phone}</div>
                            </div>
                          ) : <span style={{ color: t.textMuted, fontSize: 11 }}>—</span>}
                        </td>
                        <td style={{ padding: "10px 14px" }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: t.text }}>{ticket.subject}</div>
                          <div style={{ fontSize: 10, color: t.textMuted, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ticket.description?.substring(0, 50)}</div>
                        </td>
                        <td style={{ padding: "10px 14px", textAlign: "center" }}>
                          <Badge color={categoryLabels[ticket.category]?.color || t.textMuted} bg={categoryLabels[ticket.category]?.bg || t.cardBorder}>
                            {categoryLabels[ticket.category]?.icon} {categoryLabels[ticket.category]?.label}
                          </Badge>
                        </td>
                        <td style={{ padding: "10px 14px", textAlign: "center" }}>
                          <Badge color={priorityColors[ticket.priority]?.color} bg={priorityColors[ticket.priority]?.bg}>
                            {priorityColors[ticket.priority]?.label}
                          </Badge>
                        </td>
                        <td style={{ padding: "10px 14px", textAlign: "center" }}>
                          <select
                            value={ticket.status}
                            onChange={(e) => handleUpdateStatus(ticket.id, e.target.value)}
                            style={{
                              padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                              border: `1px solid ${t.cardBorder}`, background: statusColors[ticket.status]?.bg || t.input,
                              color: statusColors[ticket.status]?.color || t.text, cursor: "pointer"
                            }}
                          >
                            {Object.entries(statusColors).map(([key, val]: [string, any]) => (
                              <option key={key} value={key} style={{ background: t.card, color: t.text }}>{val.label}</option>
                            ))}
                          </select>
                        </td>
                        <td style={{ padding: "10px 14px", fontSize: 11, color: t.textSub }}>
                          {new Date(ticket.createdAt).toLocaleDateString()}
                        </td>
                        <td style={{ padding: "10px 14px", textAlign: "center" }}>
                          <Btn onClick={() => loadTicketDetails(ticket.id)} variant="default" size="xs"><Icons.Eye /> View</Btn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: "10px 14px", borderTop: `1px solid ${t.cardBorder}`, fontSize: 10, color: t.textMuted }}>
                Showing {tickets.length} tickets
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="page-footer" style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${t.cardBorder}`, fontSize: 11, color: t.textMuted, textAlign: "center" }}>
            © {new Date().getFullYear()} <strong style={{ color: t.accent }}>JointBox</strong> ISP CRM Platform. All rights reserved.
          </div>
        </div>
      </div>

      {/* Create Ticket Modal */}
      {showForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setShowForm(false)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 500, maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>🎫 Create New Ticket</h2>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>
            <p style={{ fontSize: 11, color: t.textMuted, marginBottom: 20 }}>Log a support ticket for a customer issue.</p>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Customer *</label>
                <select
                  value={form.subscriberId}
                  onChange={e => setForm({ ...form, subscriberId: e.target.value })}
                  style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }}
                  required
                >
                  <option value="">Select Customer</option>
                  {subscribers.map(s => (
                    <option key={s.id} value={s.id}>{s.fullName} - {s.phone}</option>
                  ))}
                </select>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Category *</label>
                <select
                  value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value })}
                  style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }}
                >
                  {Object.entries(categoryLabels).map(([key, val]: [string, any]) => (
                    <option key={key} value={key}>{val.icon} {val.label}</option>
                  ))}
                </select>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Priority *</label>
                <select
                  value={form.priority}
                  onChange={e => setForm({ ...form, priority: e.target.value })}
                  style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }}
                >
                  {Object.entries(priorityColors).map(([key, val]: [string, any]) => (
                    <option key={key} value={key}>{val.label}</option>
                  ))}
                </select>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Subject *</label>
                <input
                  type="text"
                  value={form.subject}
                  onChange={e => setForm({ ...form, subject: e.target.value })}
                  placeholder="Brief summary of the issue"
                  style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }}
                  required
                />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Description *</label>
                <textarea
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  placeholder="Detailed description of the problem"
                  style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text, resize: "none" }}
                  required
                />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 5, display: "block" }}>Assign To (Optional)</label>
                <select
                  value={form.assignedTo}
                  onChange={e => setForm({ ...form, assignedTo: e.target.value })}
                  style={{ width: "100%", padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }}
                >
                  <option value="">Unassigned</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>

              <div style={{ background: d ? "#1a1200" : "#fef3c7", borderRadius: 8, padding: 10, fontSize: 11, color: d ? "#fbbf24" : "#92400e", margin: "12px 0" }}>
                💡 <strong>Tip:</strong> High priority tickets are flagged for immediate attention.
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button type="submit" disabled={saving} style={{ flex: 1, background: t.accent, color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: saving ? 0.6 : 1 }}>
                  {saving ? "Creating..." : "Create Ticket"}
                </button>
                <button type="button" onClick={() => setShowForm(false)} style={{ flex: 1, background: "transparent", border: `1px solid ${t.cardBorder}`, color: t.textSub, padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Ticket Details Modal */}
      {showDetailsModal && selectedTicket && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setShowDetailsModal(false)}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "90%", maxWidth: 600, maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: t.text, margin: 0 }}>Ticket #{selectedTicket.ticketNo}</h2>
                <p style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>{selectedTicket.subject}</p>
              </div>
              <button onClick={() => setShowDetailsModal(false)} style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: t.textSub }}>×</button>
            </div>

            <div style={{ background: d ? "var(--bg)" : "#f8fafc", borderRadius: 12, padding: 16, marginBottom: 20 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 10, color: t.textMuted }}>Customer</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{selectedTicket.subscriber?.fullName || 'N/A'}</div>
                  <div style={{ fontSize: 11, color: t.textSub }}>{selectedTicket.subscriber?.phone}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: t.textMuted }}>Assigned To</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{selectedTicket.assignedTo?.name || 'Unassigned'}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: t.textMuted }}>Category</div>
                  <Badge color={categoryLabels[selectedTicket.category]?.color} bg={categoryLabels[selectedTicket.category]?.bg}>
                    {categoryLabels[selectedTicket.category]?.icon} {categoryLabels[selectedTicket.category]?.label}
                  </Badge>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: t.textMuted }}>Priority</div>
                  <Badge color={priorityColors[selectedTicket.priority]?.color} bg={priorityColors[selectedTicket.priority]?.bg}>
                    {priorityColors[selectedTicket.priority]?.label}
                  </Badge>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 10, color: t.textMuted, marginBottom: 4 }}>Description</div>
                <p style={{ fontSize: 12, color: t.textSub, margin: 0 }}>{selectedTicket.description}</p>
              </div>
            </div>

            {/* Messages */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 12 }}>💬 Conversation</div>
              <div style={{ maxHeight: 250, overflowY: "auto", padding: "4px" }}>
                {selectedTicket.messages && selectedTicket.messages.length > 0 ? (
                  selectedTicket.messages.map((msg) => (
                    <div key={msg.id} style={{ display: "flex", justifyContent: msg.sentByType === 'CUSTOMER' ? "flex-start" : "flex-end", marginBottom: 12 }}>
                      <div style={{ maxWidth: "75%", padding: "10px 14px", borderRadius: 14, background: msg.sentByType === 'CUSTOMER' ? (d ? "var(--border)" : "#f1f5f9") : (d ? "#14532d" : "#d1fae5") }}>
                        <div style={{ fontSize: 10, color: t.textMuted, marginBottom: 3 }}>
                          {msg.sentByType === 'CUSTOMER' ? '👤 Customer' : '🛠️ Staff'} • {new Date(msg.createdAt).toLocaleString()}
                        </div>
                        <p style={{ fontSize: 12, color: t.text, margin: 0 }}>{msg.message}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p style={{ fontSize: 12, color: t.textMuted, textAlign: "center", padding: 20 }}>No messages yet.</p>
                )}
              </div>
            </div>

            {/* Add Message */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: t.textSub, marginBottom: 6, display: "block" }}>Add Response</label>
              <div style={{ display: "flex", gap: 8 }}>
                <textarea
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  placeholder="Type your response here..."
                  rows={2}
                  style={{ flex: 1, padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text, resize: "none" }}
                />
                <button
                  onClick={() => handleAddMessage(selectedTicket.id)}
                  style={{ padding: "0 16px", background: t.accent, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer" }}
                >
                  Send
                </button>
              </div>
            </div>

            {/* Status Update */}
            <div style={{ display: "flex", gap: 10 }}>
              <select
                value={selectedTicket.status}
                onChange={(e) => handleUpdateStatus(selectedTicket.id, e.target.value)}
                style={{ flex: 1, padding: "8px 12px", border: `1px solid ${t.cardBorder}`, borderRadius: 8, fontSize: 12, background: t.input, color: t.text }}
              >
                {Object.entries(statusColors).map(([key, val]: [string, any]) => (
                  <option key={key} value={key}>{val.label}</option>
                ))}
              </select>
              <button
                onClick={() => setShowDetailsModal(false)}
                style={{ padding: "8px 20px", background: "transparent", border: `1px solid ${t.cardBorder}`, color: t.textSub, borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
