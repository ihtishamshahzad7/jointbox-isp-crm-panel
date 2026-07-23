"use client";
import { useEffect, useState, useCallback } from "react";
import { Wizard, Field } from "../components/wizard";
import { PoolTable } from "../components/network-tables";
import { RecordNotes } from "../components/record-notes";
import { useRouter } from "next/navigation";

// ─── Types ───────────────────────────────────────────────────────────────────
interface IpPool {
  id: number;
  name: string;
  network: string;
  subnet: string;
  nasId: number | null;
  createdAt: string;
  packages: { id: number; name: string; isActive: boolean }[];
  _count: { packages: number };
}

interface IpPoolStats {
  total: number;
  withNas: number;
  packages: number;
}

const API = (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

/** ISP-level roles bypass every reseller ownership gate. */
const isAdminRole = (role?: string) => role === "ADMIN" || role === "SUPER_ADMIN";

// ─── Icons ───────────────────────────────────────────────────────────────────
const Ic = {
  Pool: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
  Plus: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Search: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  Edit: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Trash: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
  Eye: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  X: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Info: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
  Network: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="9" y="16" width="6" height="6" rx="1"/><path d="M5 8v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="12" y1="12" x2="12" y2="16"/></svg>,
};

const EMPTY_FORM = { name: "", network: "", subnet: "24" };

const SUBNET_OPTIONS = [
  { value: "16", label: "/16  (65,534 hosts)" },
  { value: "17", label: "/17  (32,766 hosts)" },
  { value: "18", label: "/18  (16,382 hosts)" },
  { value: "19", label: "/19  (8,190 hosts)" },
  { value: "20", label: "/20  (4,094 hosts)" },
  { value: "21", label: "/21  (2,046 hosts)" },
  { value: "22", label: "/22  (1,022 hosts)" },
  { value: "23", label: "/23  (510 hosts)" },
  { value: "24", label: "/24  (254 hosts)  ← most common" },
  { value: "25", label: "/25  (126 hosts)" },
  { value: "26", label: "/26  (62 hosts)" },
  { value: "27", label: "/27  (30 hosts)" },
  { value: "28", label: "/28  (14 hosts)" },
];

function buildCidr(network: string, subnet: string): string {
  if (!network) return "—";
  return `${network}/${subnet}`;
}

function buildRangePreview(network: string, subnet: string): string {
  if (!network) return "";
  const parts = network.split(".").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return "";
  const prefix = parseInt(subnet);
  if (prefix === 24) return `${parts[0]}.${parts[1]}.${parts[2]}.1 → .254`;
  if (prefix === 23) return `${parts[0]}.${parts[1]}.${parts[2]}.1 → ${parts[0]}.${parts[1]}.${parts[2]+1}.254`;
  if (prefix === 16) return `${parts[0]}.${parts[1]}.0.1 → .255.254`;
  const hosts = Math.pow(2, 32 - prefix) - 2;
  return `~${hosts.toLocaleString()} usable hosts`;
}

function isValidIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const n = parseInt(p);
    return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

export default function IpPoolsPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [time, setTime] = useState("");
  const [greeting, setGreeting] = useState("Welcome");

  const [pools, setPools] = useState<IpPool[]>([]);
  const [stats, setStats] = useState<IpPoolStats>({ total: 0, withNas: 0, packages: 0 });
  const [loading, setLoading] = useState(true);

  const [searchQ, setSearchQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editPool, setEditPool] = useState<IpPool | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formSaving, setFormSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<IpPool | null>(null);
  /** Signed-in account — decides owned vs shared, and who may share. */
  const [me, setMe] = useState<any>(null);
  const [shareFor, setShareFor] = useState<any>(null);
  const [shareAccounts, setShareAccounts] = useState<any[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [detailPool, setDetailPool] = useState<IpPool | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "ok"|"err"|"warn" } | null>(null);
  const [networkError, setNetworkError] = useState("");

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

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

  const showToast = (msg: string, type: "ok"|"err"|"warn" = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // Result of comparing panel pools against what the routers really have.
  const [verify, setVerify] = useState<any>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [poolRes, statsRes, verifyRes] = await Promise.all([
        fetch(`${API}/ip-pools`, { headers }),
        fetch(`${API}/ip-pools/stats`, { headers }),
        // Reads the routers — a pool name that doesn't exist on the MikroTik
        // drops every session on it while looking perfectly healthy here.
        fetch(`${API}/ip-pools/verify`, { headers }),
      ]);
      if (poolRes.ok) setPools(await poolRes.json());
      if (statsRes.ok) setStats(await statsRes.json());
      if (verifyRes.ok) setVerify(await verifyRes.json());
    } catch { showToast("Failed to load IP pools", "err"); }
    setLoading(false);
  }, []);

  const savePool = async () => {
    if (!form.name.trim()) { showToast("Pool name is required", "err"); return; }
    if (!form.network.trim()) { showToast("Network address is required", "err"); return; }
    if (!isValidIPv4(form.network.trim())) {
      setNetworkError("Enter a valid IPv4 address (e.g. 192.168.10.0)");
      return;
    }
    setNetworkError("");

    if (!editPool) {
      const exists = pools.find(p => p.name.toLowerCase() === form.name.trim().toLowerCase());
      if (exists) { showToast(`A pool named "${form.name}" already exists`, "err"); return; }
    }

    setFormSaving(true);
    try {
      const url = editPool ? `${API}/ip-pools/${editPool.id}` : `${API}/ip-pools`;
      const method = editPool ? "PUT" : "POST";
      const body = {
        name: form.name.trim(),
        network: form.network.trim(),
        subnet: form.subnet,
      };
      const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const e: any = await res.json().catch(() => ({}));
        const msg = Array.isArray(e?.message) ? e.message.join(" ") : e?.message;
        showToast(msg || "Save failed", "err");
        // Throw so the wizard holds the dialog open with the values intact.
        throw new Error(msg || `Save failed (HTTP ${res.status})`);
      } else {
        showToast(editPool ? `✅ Pool "${form.name}" updated` : `✅ Pool "${form.name}" created`, "ok");
        setShowForm(false);
        setEditPool(null);
        setForm({ ...EMPTY_FORM });
        await loadAll();
      }
    } catch (e: any) {
      showToast(e.message, "err");
      setFormSaving(false);
      throw e;
    }
    setFormSaving(false);
  };

  const deletePool = async (pool: IpPool) => {
    try {
      const res = await fetch(`${API}/ip-pools/${pool.id}`, { method: "DELETE", headers });
      if (res.ok) {
        showToast(`🗑️ Pool "${pool.name}" deleted`, "ok");
        setDeleteConfirm(null);
        setDetailPool(null);
        await loadAll();
      } else {
        const e = await res.json();
        showToast(e.message || "Delete failed", "err");
        setDeleteConfirm(null);
      }
    } catch (e: any) { showToast(e.message, "err"); }
  };

  const openCreate = () => {
    setForm({ ...EMPTY_FORM });
    setEditPool(null);
    setNetworkError("");
    setShowForm(true);
  };

  const openEdit = (pool: IpPool) => {
    setForm({ name: pool.name, network: pool.network, subnet: pool.subnet });
    setEditPool(pool);
    setNetworkError("");
    setShowForm(true);
  };

  useEffect(() => {
    if (!token) return;
    fetch(`${API}/auth/profile`, { headers })
      .then(r => (r.ok ? r.json() : null))
      // /auth/profile returns { user: {...} }, not the user itself.
      .then(d => setMe(d?.user ?? d))
      .catch(() => {});
  }, [token]);

  const openShare = async (pool: any) => {
    setShareFor(pool);
    try {
      const r = await fetch(`${API}/users`, { headers });
      const rows = r.ok ? await r.json() : [];
      // /users already returns only the caller's downline.
      setShareAccounts(Array.isArray(rows) ? rows : rows?.data ?? []);
    } catch { setShareAccounts([]); }
  };

  const toggleShare = async (userId: number, on: boolean) => {
    if (!shareFor) return;
    setShareBusy(true);
    try {
      const r = await fetch(`${API}/ip-pools/${shareFor.id}/share/${userId}`, {
        method: on ? "POST" : "DELETE", headers,
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        showToast(e.message || "Could not change sharing", "err");
      } else {
        showToast(on ? "Pool shared" : "Sharing withdrawn", "ok");
        setShareFor((prev: any) => prev ? { ...prev, assignments: on
          ? [...(prev.assignments ?? []), { userId }]
          : (prev.assignments ?? []).filter((a: any) => a.userId !== userId) } : prev);
        await loadAll();
      }
    } catch (e: any) { showToast(e.message || "Network error", "err"); }
    finally { setShareBusy(false); }
  };

  const filtered = pools.filter(p =>
    !searchQ ||
    p.name.toLowerCase().includes(searchQ.toLowerCase()) ||
    p.network.includes(searchQ)
  );

  useEffect(() => {
    const tk = localStorage.getItem("token");
    if (!tk) { router.push("/login"); return; }
    fetch(`${API}/profile`, { headers })
      .then(r => r.json()).then(d => setUser(d.user))
      .catch(() => router.push("/login"));
    loadAll();
    const tick = () => {
      const h = new Date().getHours();
      setGreeting(h < 12 ? "Good Morning" : h < 18 ? "Good Afternoon" : "Good Evening");
      setTime(new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const inputSt: React.CSSProperties = {
    background: t.input, border: `1px solid ${t.inputBorder}`, borderRadius: 6,
    color: t.text, padding: "7px 10px", width: "100%", fontSize: 12,
    outline: "none", fontFamily: "inherit",
  };
  const labelSt: React.CSSProperties = {
    fontSize: 11, color: t.textSub, marginBottom: 3, display: "block", fontWeight: 600,
  };

  const Btn = ({ onClick, children, variant = "default", size = "sm", disabled = false, title = "" }: any) => {
    const vs: Record<string, React.CSSProperties> = {
      default: { background: "var(--border)", color: t.textSub },
      primary: { background: t.accent, color: "#fff" },
      success: { background: "#14532d", color: "#4ade80" },
      danger: { background: "#450a0a", color: "#f87171" },
      warning: { background: "#422006", color: "#fbbf24" },
      ghost: { background: "transparent", color: t.textSub, border: `1px solid ${t.cardBorder}` },
      teal: { background: "#134e4a", color: "#2dd4bf" },
      purple: { background: "#3b0764", color: "#c4b5fd" },
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
    <span style={{ padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:700, color, background:bg, letterSpacing:"0.04em", whiteSpace:"nowrap" }}>
      {children}
    </span>
  );

  return (
    <div style={{ display:"flex", minHeight:"100vh", background:t.bg, color:t.text, fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif", fontSize:13 }}>

      {toast && (
        <div style={{
          position:"fixed", bottom:24, right:24, zIndex:9999,
          background: toast.type==="ok" ? "#14532d" : toast.type==="err" ? "#450a0a" : "#422006",
          color: toast.type==="ok" ? "#4ade80" : toast.type==="err" ? "#f87171" : "#fbbf24",
          border: `1px solid ${toast.type==="ok"?"#166534":toast.type==="err"?"#7f1d1d":"#713f12"}`,
          borderRadius:10, padding:"12px 18px", fontSize:12, fontWeight:600, maxWidth:400,
          boxShadow:"0 4px 24px rgba(0,0,0,.5)",
        }}>
          {toast.msg}
        </div>
      )}

      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0 }}>

        {/* A pool that doesn't exist on the router is the worst kind of fault:
            RADIUS accepts the customer, then the router drops them instantly.
            Nothing in the panel would show it, so it is checked and shown here. */}
        {verify && !verify.ok && (
          <div style={{
            margin:"14px 20px 0", background:"rgba(239,68,68,.10)", border:"1px solid #ef4444",
            borderRadius:12, padding:"13px 16px",
          }}>
            <div style={{ fontSize:13.5, fontWeight:800, color:"#ef4444", marginBottom:6 }}>
              {verify.brokenCount} pool{verify.brokenCount>1?"s":""} do
              {verify.brokenCount>1?"":"es"} not exist on the router
              {verify.subscribersAtRisk>0 && ` — ${verify.subscribersAtRisk} subscriber${verify.subscribersAtRisk>1?"s":""} affected`}
            </div>
            <div style={{ fontSize:11.5, color:"var(--muted)", lineHeight:1.65, marginBottom:9 }}>
              These customers will authenticate successfully and then be dropped
              immediately, reconnecting in a loop. The pool name here must match
              the router exactly — it is case-sensitive.
            </div>
            {verify.pools.filter((p:any)=>!p.existsOnRouter).map((p:any)=>(
              <div key={p.id} style={{
                background:"rgba(0,0,0,.22)", borderRadius:8, padding:"9px 11px",
                marginTop:6, fontSize:11.5, lineHeight:1.6,
              }}>
                <code style={{ color:"#f87171", fontWeight:700 }}>{p.name}</code>
                <span style={{ color:"var(--muted)" }}> — {p.problem}</span>
                {p.suggestion && (
                  <div style={{ marginTop:4, color:"#4ade80" }}>
                    Rename this pool to <b>{p.suggestion}</b> to match the router.
                  </div>
                )}
                {!p.suggestion && p.availableOnRouter?.length > 0 && (
                  <div style={{ marginTop:4, color:"var(--muted)" }}>
                    Available on the router: {p.availableOnRouter.map((n:string)=>(
                      <code key={n} style={{ color:"#60a5fa", marginRight:7 }}>{n}</code>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {verify?.unreachableRouters?.length > 0 && (
          <div style={{
            margin:"14px 20px 0", background:"rgba(245,158,11,.10)", border:"1px solid #f59e0b",
            borderRadius:12, padding:"11px 16px", fontSize:11.5, color:"#fcd34d", lineHeight:1.6,
          }}>
            Could not check {verify.unreachableRouters.join(", ")} — no API access.
            Add the API username and password under Network → NAS / Routers so pools
            can be verified there too.
          </div>
        )}


        <div style={{ flex:1, padding:"16px 20px", overflowY:"auto" }}>

          {/* How It Works Banner */}
          <div style={{ background: d?"#0a1525":"#eff6ff", border:`1px solid ${d?"#1e3a5f":"#bfdbfe"}`, borderRadius:10, padding:"10px 16px", marginBottom:16, display:"flex", alignItems:"flex-start", gap:10 }}>
            <div style={{ color:"#60a5fa", flexShrink:0, marginTop:1 }}><Ic.Info /></div>
            <div style={{ fontSize:11, color: d?"#93c5fd":"#1e40af", lineHeight:1.7 }}>
              <b>How IP Pools work in this system:</b> Create a pool here with the <b>exact same name</b> as the pool on your MikroTik router →
              Assign the pool to a <b>Package</b> → Assign that Package to a <b>Subscriber</b> →
              FreeRADIUS sends <code style={{background:d?"#1e3a5f":"#dbeafe", padding:"1px 4px", borderRadius:3}}>Framed-Pool</code> to MikroTik →
              MikroTik assigns an IP from that pool to the subscriber automatically.
              <br/>
              <b style={{color: d?"#fbbf24":"#d97706"}}>⚠️ One pool can only be assigned to ONE package.</b>
            </div>
          </div>

          {/* Stat Cards */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:10, marginBottom:16 }}>
            {[
              { label:"Total Pools", value: stats.total, color: t.teal },
              { label:"Assigned to Pkg", value: stats.packages, color: t.accent },
              { label:"Unassigned", value: Math.max(0, stats.total - stats.packages), color: t.amber },
            ].map(c => (
              <div key={c.label} style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderRadius:10, padding:"12px 16px" }}>
                <div style={{ fontSize:26, fontWeight:800, color:c.color, lineHeight:1 }}>{c.value}</div>
                <div style={{ fontSize:10, color:t.textMuted, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.06em", marginTop:4 }}>{c.label}</div>
              </div>
            ))}
          </div>

          {/* Toolbar - WITH ADD BUTTON */}
          <div style={{ display:"flex", gap:10, marginBottom:14, flexWrap:"wrap", alignItems:"center" }}>
            <div style={{ position:"relative", flex:1, minWidth:200 }}>
              <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:t.textMuted, pointerEvents:"none" }}>
                <Ic.Search />
              </span>
              <input
                placeholder="Search by pool name or network…"
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
                style={{ ...inputSt, paddingLeft:30, width:"100%" }}
              />
            </div>
            
            {/* ADD IP POOL BUTTON - NOW VISIBLE */}
            <Btn variant="primary" onClick={openCreate} size="sm">
              <Ic.Plus /> Add IP Pool
            </Btn>
          </div>

          {/* Table */}
          <div style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderRadius:10, overflow:"hidden" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"11px 16px", borderBottom:`1px solid ${t.cardBorder}` }}>
              <span style={{ fontWeight:800, fontSize:14 }}>
                IP Pool List
                <span style={{ fontSize:11, color:t.textMuted, fontWeight:400, marginLeft:8 }}>{filtered.length} pools</span>
              </span>
              <span style={{ fontSize:11, color:t.textMuted }}>Pool name must match exactly what's on MikroTik</span>
            </div>

            {loading ? (
              <div style={{ textAlign:"center", padding:50, color:t.textMuted }}>⏳ Loading pools…</div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign:"center", padding:50, color:t.textMuted }}>
                <div style={{ fontSize:32, marginBottom:8 }}>🗄️</div>
                <div>No IP pools found.</div>
                <div style={{ fontSize:11, marginTop:6 }}>
                  Click <Btn variant="primary" size="xs" onClick={openCreate}><Ic.Plus /> Add IP Pool</Btn> to create one.
                </div>
              </div>
            ) : (
              <PoolTable
                rows={filtered}
                me={me}
                onView={(pool) => setDetailPool(pool)}
                onEdit={openEdit}
                onShare={openShare}
                onDelete={(pool) => setDeleteConfirm(pool)}
              />
            )}
          </div>
        </div>
      </div>

      {/* ══ MODAL: CREATE / EDIT FORM ══ */}
      {showForm && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.75)", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
          onClick={() => { setShowForm(false); setEditPool(null); }}>
          <div style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderRadius:14, padding:24, width:"100%", maxWidth:480, maxHeight:"90vh", overflowY:"auto" }}
            onClick={e => e.stopPropagation()}>

            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
              <div>
                <div style={{ fontWeight:800, fontSize:15, color:t.text }}>
                  {editPool ? "Edit IP Pool" : "Create IP Pool"}
                </div>
                <div style={{ fontSize:11, color:t.textMuted, marginTop:2 }}>
                  {editPool ? `Editing: ${editPool.name}` : "Add a new IP pool to assign to packages"}
                </div>
              </div>
              <button onClick={() => { setShowForm(false); setEditPool(null); }} style={{ background:"transparent", border:"none", cursor:"pointer", color:t.textSub }}>
                <Ic.X />
              </button>
            </div>


            {!editPool ? (
              <Wizard
                busy={formSaving}
                onCancel={() => { setShowForm(false); setEditPool(null); }}
                finishLabel="Create pool"
                onFinish={savePool}
                steps={[
                  {
                    id: "name",
                    title: "Name",
                    hint: "This must match the pool name on the router character for character. It is the single most common reason a customer authenticates and then gets no address.",
                    validate: () => {
                      if (!form.name.trim()) return "A pool name is required.";
                      if (/\s/.test(form.name)) return "Pool names cannot contain spaces — MikroTik will not match it. Use hyphens or underscores.";
                      return null;
                    },
                    summary: () => [["Pool name", form.name]],
                    render: () => (
                      <Field label="Pool name" required
                        hint="Case-sensitive. Check it against IP → Pool on the router.">
                        <input value={form.name} placeholder="home-pool"
                          onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                      </Field>
                    ),
                  },
                  {
                    id: "network",
                    title: "Network",
                    hint: "The address range this pool hands out.",
                    validate: () => {
                      if (!form.network.trim()) return "A network address is required.";
                      if (!isValidIPv4(form.network)) return "That is not a valid IPv4 address (e.g. 192.168.10.0).";
                      return null;
                    },
                    summary: () => [
                      ["Network", buildCidr(form.network, form.subnet)],
                      ["Usable range", buildRangePreview(form.network, form.subnet) || "—"],
                      ["RADIUS sends", `Framed-Pool = ${form.name || "<pool-name>"}`],
                    ],
                    render: () => (
                      <>
                        <Field label="Network address" required error={networkError || undefined}
                          hint="The base address of the subnet, not a host address.">
                          <input value={form.network} placeholder="192.168.10.0"
                            onChange={e => { setNetworkError(""); setForm(p => ({ ...p, network: e.target.value })); }} />
                        </Field>
                        <Field label="Subnet size">
                          <select value={form.subnet}
                            onChange={e => setForm(p => ({ ...p, subnet: e.target.value }))}>
                            {SUBNET_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </Field>
                      </>
                    ),
                  },
                ]}
              />
            ) : (
            <>
            <div style={{ display:"grid", gridTemplateColumns:"1fr", gap:12 }}>
              <div>
                <label style={labelSt}>Pool Name * <span style={{ color:t.textMuted, fontWeight:400 }}>(must match MikroTik exactly)</span></label>
                <input style={inputSt} placeholder="e.g. home-pool or dhcp_pool1" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                <div style={{ fontSize:10, color:t.textMuted, marginTop:3 }}>Tip: No spaces — use hyphens or underscores</div>
              </div>

              <div style={{ fontSize:11, fontWeight:700, color:"#38bdf8", textTransform:"uppercase", letterSpacing:"0.06em", borderBottom:`1px solid ${d?"#1e3a5f":"#bae6fd"}`, paddingBottom:4, marginTop:4, display:"flex", alignItems:"center", gap:6 }}>
                <Ic.Network /> Network Configuration
              </div>

              <div>
                <label style={labelSt}>Network Address * <span style={{ color:t.textMuted, fontWeight:400 }}>base IP of the subnet</span></label>
                <input style={{ ...inputSt, borderColor: networkError ? "#ef4444" : t.inputBorder }} placeholder="e.g. 192.168.10.0" value={form.network} onChange={e => { setNetworkError(""); setForm(p => ({ ...p, network: e.target.value })); }} />
                {networkError && <div style={{ fontSize:11, color:"#f87171", marginTop:3 }}>⚠️ {networkError}</div>}
                {!networkError && form.network && isValidIPv4(form.network) && <div style={{ fontSize:11, color:"#22c55e", marginTop:3 }}>✅ Valid IPv4</div>}
              </div>

              <div>
                <label style={labelSt}>Subnet (CIDR prefix)</label>
                <select style={{ ...inputSt, cursor:"pointer" }} value={form.subnet} onChange={e => setForm(p => ({ ...p, subnet: e.target.value }))}>
                  {SUBNET_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>

              {form.network && isValidIPv4(form.network) && (
                <div style={{ background:d?"#0a1f14":"#f0fdf4", border:`1px solid ${d?"#14532d":"#bbf7d0"}`, borderRadius:8, padding:"10px 14px" }}>
                  <div style={{ fontSize:10, color:"#34d399", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:8 }}>📡 MikroTik Config Preview</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                    <div><div style={{ fontSize:10, color:t.textMuted, fontWeight:600, textTransform:"uppercase" }}>Pool Name</div><code style={{ fontSize:12, color:"#34d399", fontWeight:700, marginTop:2, display:"block" }}>{form.name || "—"}</code></div>
                    <div><div style={{ fontSize:10, color:t.textMuted, fontWeight:600, textTransform:"uppercase" }}>CIDR</div><code style={{ fontSize:12, color:"#34d399", fontWeight:700, marginTop:2, display:"block" }}>{buildCidr(form.network, form.subnet)}</code></div>
                    <div style={{ gridColumn:"span 2" }}><div style={{ fontSize:10, color:t.textMuted, fontWeight:600, textTransform:"uppercase" }}>Usable Range</div><code style={{ fontSize:12, color:"#34d399", fontWeight:700, marginTop:2, display:"block" }}>{buildRangePreview(form.network, form.subnet) || "—"}</code></div>
                  </div>
                  <div style={{ marginTop:8, fontSize:10, color:t.textMuted, borderTop:`1px solid ${d?"#14532d":"#bbf7d0"}`, paddingTop:8 }}>
                    FreeRADIUS will send <code style={{color:"#34d399", background:d?"#0a1f14":"#dcfce7", padding:"1px 4px", borderRadius:3}}>Framed-Pool = {form.name || "<pool-name>"}</code> to MikroTik.
                  </div>
                </div>
              )}
            </div>

            <div style={{ display:"flex", gap:8, marginTop:20, justifyContent:"flex-end" }}>
              <Btn onClick={() => { setShowForm(false); setEditPool(null); }} variant="ghost">Cancel</Btn>
              <Btn onClick={savePool} variant="primary" disabled={formSaving}>
                <Ic.Pool /> {formSaving ? "Saving…" : editPool ? "Update Pool" : "Create Pool"}
              </Btn>
            </div>
            </>
            )}{/* Edit keeps the single-page form — changing one field does not
                   need steps. */}

            {/* Reference note, below the form rather than above it. */}
            <div style={{ background:d?"#1a1200":"#fffbeb", border:`1px solid ${d?"#713f12":"#fde68a"}`, borderRadius:8, padding:"9px 12px", marginTop:16, fontSize:11, color:d?"#fbbf24":"#92400e", lineHeight:1.6 }}>
              <b>The pool name must match your MikroTik exactly</b> — see
              <code style={{ margin:"0 4px", background:d?"#422006":"#fef3c7", padding:"1px 4px", borderRadius:3 }}>IP → Pool</code>
              on the router. MikroTik is case-sensitive, and a name that does not match leaves
              customers authenticated but without a usable address.
            </div>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {detailPool && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.75)", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
          onClick={() => setDetailPool(null)}>
          <div style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderRadius:14, padding:24, width:"100%", maxWidth:520, maxHeight:"90vh", overflowY:"auto" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:18 }}>
              <div>
                <div style={{ fontWeight:800, fontSize:16, color:t.text }}>{detailPool.name}</div>
                <div style={{ fontSize:11, color:t.textMuted, marginTop:2 }}>IP Pool #{detailPool.id}</div>
              </div>
              <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                {detailPool._count?.packages > 0
                  ? <Badge color="#4ade80" bg="#14532d">IN USE</Badge>
                  : <Badge color="var(--muted)" bg="var(--border)">FREE</Badge>
                }
                <Btn size="xs" variant="default" onClick={() => { setDetailPool(null); openEdit(detailPool); }}>
                  <Ic.Edit /> Edit
                </Btn>
                <button onClick={() => setDetailPool(null)} style={{ background:"transparent", border:"none", cursor:"pointer", color:t.textSub }}>
                  <Ic.X />
                </button>
              </div>
            </div>

            {/* Notes */}
            <div style={{ border:`1px solid ${t.cardBorder}`, borderRadius:10, padding:"12px 14px", marginBottom:16 }}>
              <RecordNotes entityType="IP_POOL" entityId={detailPool.id} title="Notes" />
            </div>

            <div style={{ background:d?"#0a1525":"#eff6ff", border:`1px solid ${d?"#1e3a5f":"#bfdbfe"}`, borderRadius:10, padding:"12px 14px", marginBottom:16 }}>
              <div style={{ fontWeight:700, fontSize:12, color:"#60a5fa", marginBottom:10, display:"flex", alignItems:"center", gap:6 }}>
                <Ic.Network /> FreeRADIUS → MikroTik Configuration
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {[
                  ["Framed-Pool value", detailPool.name],
                  ["CIDR", `${detailPool.network}/${detailPool.subnet}`],
                  ["Usable Range", buildRangePreview(detailPool.network, detailPool.subnet) || "—"],
                  ["Created", new Date(detailPool.createdAt).toLocaleDateString()],
                ].map(([k,v]) => (
                  <div key={k}>
                    <div style={{ fontSize:10, color:t.textMuted, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em" }}>{k}</div>
                    <code style={{ fontSize:12, color:"#60a5fa", fontWeight:700, marginTop:2, display:"block", wordBreak:"break-all" }}>{v}</code>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginBottom:16 }}>
              <div style={{ fontSize:11, color:t.textMuted, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:8 }}>Assigned Package</div>
              {detailPool.packages && detailPool.packages.length > 0 ? (
                detailPool.packages.map(pkg => (
                  <div key={pkg.id} style={{ background:d?"#1a0d2e":"#f5f3ff", border:`1px solid ${d?"#3b1a6e":"#ddd6fe"}`, borderRadius:8, padding:"9px 12px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                    <div>
                      <div style={{ fontWeight:700, fontSize:13, color:"#a78bfa" }}>📦 {pkg.name}</div>
                      <div style={{ fontSize:10, color:t.textMuted, marginTop:2 }}>Package #{pkg.id}</div>
                    </div>
                    <Badge color={pkg.isActive ? "#4ade80" : "#f87171"} bg={pkg.isActive ? "#14532d" : "#450a0a"}>
                      {pkg.isActive ? "ACTIVE" : "INACTIVE"}
                    </Badge>
                  </div>
                ))
              ) : (
                <div style={{ background:d?"var(--bg)":"#f8fafc", border:`1px solid ${t.cardBorder}`, borderRadius:8, padding:"10px 12px", fontSize:12, color:t.textMuted, textAlign:"center" }}>
                  No package assigned yet. Go to <b>Packages</b> and select this pool.
                </div>
              )}
            </div>

            <div style={{ display:"flex", gap:8, marginTop:18, justifyContent:"flex-end" }}>
              {(detailPool._count?.packages ?? 0) === 0 && (
                <Btn variant="danger" size="xs" onClick={() => { setDetailPool(null); setDeleteConfirm(detailPool); }}>
                  <Ic.Trash /> Delete
                </Btn>
              )}
              <Btn variant="ghost" onClick={() => setDetailPool(null)}>Close</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {/* Share an address range with downstream accounts */}
      {shareFor && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.8)", zIndex:120, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
          onClick={() => setShareFor(null)}>
          <div style={{ background:t.card, border:`1px solid ${t.cardBorder}`, borderRadius:12, padding:22, width:"100%", maxWidth:520, maxHeight:"85vh", overflowY:"auto" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight:800, fontSize:15, color:t.text }}>Share “{shareFor.name}”</div>
            <div style={{ fontSize:11.5, color:t.textMuted, marginTop:4, lineHeight:1.7 }}>
              <code style={{ color:"#38bdf8" }}>{shareFor.network}/{shareFor.subnet}</code> —
              ticked accounts can assign addresses from this range to their subscribers.
              You keep ownership; they cannot edit, delete or re-share it.
            </div>

            <div style={{ marginTop:14, padding:"10px 12px", borderRadius:9, background:"rgba(56,189,248,.10)", border:"1px solid rgba(56,189,248,.35)", fontSize:11.5, color:t.textSub, lineHeight:1.7 }}>
              Share this only when they use <b>your router</b>. Addresses must be routable on the NAS
              the customer dials into — a range from your network is useless on a router you do not own.
              If they run their own NAS, they should create their own pool instead.
            </div>

            <div style={{ marginTop:14, display:"flex", flexDirection:"column", gap:6 }}>
              {shareAccounts.map((u:any) => {
                const on = !!shareFor.assignments?.some((a:any) => a.userId === u.id);
                return (
                  <label key={u.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 11px",
                    borderRadius:9, cursor: shareBusy ? "wait" : "pointer",
                    background: on ? "rgba(45,212,191,.10)" : "transparent",
                    border:`1px solid ${on ? "rgba(45,212,191,.4)" : t.cardBorder}` }}>
                    <input type="checkbox" checked={on} disabled={shareBusy}
                      onChange={(e) => toggleShare(u.id, e.target.checked)} />
                    <span style={{ flex:1 }}>
                      <b style={{ fontSize:13, color:t.text }}>{u.name}</b>
                      <span style={{ display:"block", fontSize:10.5, color:t.textMuted }}>{u.role} · {u.email}</span>
                    </span>
                  </label>
                );
              })}
              {shareAccounts.length === 0 && (
                <div style={{ fontSize:12, color:t.textMuted, padding:"14px 0", lineHeight:1.7 }}>
                  No downstream accounts yet. Create one under
                  <b style={{color:t.text}}> Administration → Organization</b> first.
                </div>
              )}
            </div>

            <div style={{ marginTop:16, display:"flex", justifyContent:"flex-end" }}>
              <Btn variant="default" onClick={() => setShareFor(null)}>Done</Btn>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.8)", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
          onClick={() => setDeleteConfirm(null)}>
          <div style={{ background:t.card, border:"1px solid #7f1d1d", borderRadius:14, padding:24, width:"100%", maxWidth:400 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
              <div style={{ fontSize:24 }}>⚠️</div>
              <div style={{ fontWeight:800, fontSize:15, color:"#f87171" }}>Delete IP Pool</div>
            </div>
            <p style={{ fontSize:13, color:t.textSub, marginBottom:10, lineHeight:1.6 }}>
              This will permanently delete pool <b style={{color:t.text}}>{deleteConfirm.name}</b>.
            </p>
            {(deleteConfirm._count?.packages ?? 0) > 0 ? (
              <div style={{ fontSize:12, color:"#f87171", background:"#450a0a", borderRadius:6, padding:"8px 10px", marginBottom:16 }}>
                ❌ Cannot delete — this pool is assigned to <b>{deleteConfirm._count.packages}</b> package(s).
                Go to <b>Packages</b>, remove the pool assignment first, then delete.
              </div>
            ) : (
              <div style={{ fontSize:12, color:"#fbbf24", background:"#422006", borderRadius:6, padding:"8px 10px", marginBottom:16 }}>
                ⚠️ Once deleted, any subscriber currently using this pool will not get a new IP until the pool is recreated and reassigned.
              </div>
            )}
            <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
              <Btn onClick={() => setDeleteConfirm(null)} variant="ghost">Cancel</Btn>
              <Btn onClick={() => deletePool(deleteConfirm)} variant="danger" disabled={(deleteConfirm._count?.packages ?? 0) > 0}>
                <Ic.Trash /> Delete Permanently
              </Btn>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}