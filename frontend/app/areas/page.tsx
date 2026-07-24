"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Wizard, Field } from "../components/wizard";
import { Icons as SIcons } from "../components/icons";

const API = (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

const Icons = { ...SIcons };

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
