"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { money } from "../../components/currency";
import { RecordNotes } from "../../components/record-notes";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Subscriber {
  id: number; fullName: string; phone: string | null; email: string | null;
  address: string | null; username: string | null; password: string | null;
  identity: string | null; connectionType: string; status: string;
  packageId: number | null; areaId: number | null; nasId: number | null;
  salespersonId: number | null; installationDate: string | null;
  latitude: number | null; longitude: number | null;
  createdAt: string; updatedAt: string;
  package?: { id:number; name:string; downloadSpeed:number; uploadSpeed:number; price:number; duration:number; };
  area?: { id:number; name:string; };
  nas?: { id:number; nasname:string; nasIp:string|null; };
  salesperson?: { id:number; name:string; role:string; };
  serviceSettings?: any;
}
interface RadiusSession {
  username: string; nasipaddress: string; framedipaddress: string|null;
  callingstationid: string|null; acctstarttime: string|null;
  acctupdatetime?: string|null; acctstoptime: string|null;
  duration_seconds: number|null; upload_bytes: number|null;
  download_bytes: number|null; nasportid?: string|null;
  nasporttype?: string|null; framedprotocol?: string|null;
  servicetype?: string|null; acctterminatecause?: string|null;
  acctinterval?: number|null;
}
interface RadiusAuth {
  username: string; reply: string; authdate: string;
}
interface RadiusCheck {
  id:number; username:string; attribute:string; op:string; value:string;
}

const API = (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:"http://localhost:3001");

// ─── Icons ────────────────────────────────────────────────────────────────────
const Ic = {
  Back:        ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>,
  User:        ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Shield:      ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Wifi:        ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>,
  Server:      ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>,
  Package:     ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>,
  Invoice:     ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
  Activity:    ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  Clock:       ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Upload:      ()=><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>,
  Download:    ()=><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>,
  IP:          ()=><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  MAC:         ()=><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>,
  Refresh:     ()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  Disconnect:  ()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Edit:        ()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Sun:         ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>,
  Moon:        ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
  Check:       ()=><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>,
  Lock:        ()=><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
/** Bytes → human size. Accepts strings because BIGINT columns serialise as
 *  strings, and guards against nonsense so a bad value shows as "—" rather
 *  than an impossible figure like 7.7e+251 GB. */
const fmtBytes = (b: number | string | null | undefined) => {
  const n = Number(b);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  // A single subscriber cannot plausibly have moved a petabyte; anything past
  // that is a data fault, and saying so is better than printing it.
  if (n > 1e15) return "—";
  const tb = n / 1099511627776;
  if (tb >= 1) return tb.toFixed(2) + " TB";
  const gb = n / 1073741824;
  if (gb >= 1) return gb.toFixed(2) + " GB";
  const mb = n / 1048576;
  if (mb >= 1) return mb.toFixed(2) + " MB";
  return (n / 1024).toFixed(1) + " KB";
};
const fmtDuration = (secs: number|null) => {
  if (!secs) return "—";
  const d = Math.floor(secs/86400), h = Math.floor((secs%86400)/3600), m = Math.floor((secs%3600)/60);
  return `${d>0?d+"d ":""}${h>0?h+"h ":""}${m}m`;
};
const fmtDate = (s: string|null, full=false) => {
  if (!s) return "—";
  const dt = new Date(s);
  if (full) return dt.toLocaleString("en-US",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"});
  return dt.toLocaleDateString("en-US",{day:"2-digit",month:"short",year:"numeric"});
};

// ─── Tab types ────────────────────────────────────────────────────────────────
const TABS = ["Profile","Service Settings","Invoices","Payments","Tickets","Connection","Router Log","Session Log","RADIUS","Login Log","Activities"] as const;
type Tab = typeof TABS[number];

// ══════════════════════════════════════════════════════════════════════════════
// PAGE COMPONENT
// ══════════════════════════════════════════════════════════════════════════════
export default function SubscriberProfilePage() {
  const router  = useRouter();
  const params  = useParams();
  const id      = params?.id as string;

  const [darkMode, setDarkMode] = useState(true);
  const [user,     setUser]     = useState<any>(null);
  const [sub,      setSub]      = useState<Subscriber|null>(null);
  const [loading,  setLoading]  = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("Profile");
  const [toast,    setToast]    = useState<{msg:string;type:"ok"|"err"|"warn"}|null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // ── RADIUS live data ──────────────────────────────────────────────────
  const [liveSession,  setLiveSession]  = useState<RadiusSession|null>(null);
  const [sessionLogs,  setSessionLogs]  = useState<RadiusSession[]>([]);
  const [authLogs,     setAuthLogs]     = useState<RadiusAuth[]>([]);
  const [radiusChecks, setRadiusChecks] = useState<RadiusCheck[]>([]);
  const [radiusOnline, setRadiusOnline] = useState<boolean|null>(null);
  const [loadingLive,  setLoadingLive]  = useState(false);
  const [serviceSettings, setServiceSettings] = useState<any>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [tickets, setTickets] = useState<any[]>([]);
  // Static public IP sold as a monthly add-on. Routing lives on the MikroTik;
  // this is the record, the price and the renewal.
  const [staticIp, setStaticIp] = useState<any>(null);
  const [ipForm, setIpForm] = useState({ ipAddress: "", monthlyPrice: "", gateway: "" });
  const [ipBusy, setIpBusy] = useState(false);
  // What the router itself said, plus the panel's reading of it.
  const [routerLog, setRouterLog] = useState<any>(null);
  const [routerBusy, setRouterBusy] = useState(false);
  /** Live data allowance — used, quota and throttle state from RADIUS. */
  const [usage, setUsage] = useState<any>(null);
  const liveRef = useRef<NodeJS.Timeout|null>(null);

  const token   = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type":"application/json", Authorization:`Bearer ${token}` };

  // ── Theme ─────────────────────────────────────────────────────────────
  const d = darkMode;
  const t = {
    bg:         d?"var(--bg)":"#f0f4fa", sidebar:d?"var(--surface)":"var(--border)",
    card:       d?"var(--surface)":"#ffffff", cardBorder:d?"var(--border)":"var(--text)",
    header:     d?"var(--surface)":"var(--border)", text:d?"var(--text)":"var(--surface)",
    textMuted:  d?"var(--muted)":"var(--muted)", textSub:d?"var(--muted)":"#475569",
    input:      d?"var(--bg)":"#f8fafc", inputBorder:d?"var(--border)":"#cbd5e1",
    tableRow:   d?"var(--surface-2)":"#f8fafc", tableRow2:d?"#121d30":"#ffffff",
    accent:"#0ea5e9", green:"#22c55e", red:"#ef4444", amber:"#f59e0b", purple:"#8b5cf6",
  };

  const showToast = (msg:string, type:"ok"|"err"|"warn"="ok") => {
    setToast({msg,type}); setTimeout(()=>setToast(null),3500);
  };

  // ── Load subscriber from backend ──────────────────────────────────────
  const loadSub = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`${API}/subscribers/${id}/profile-bundle`, { headers });
      if (res.ok) {
        const data = await res.json();
        setSub(data.subscriber || null);
        setServiceSettings(data.serviceSettings || null);
        setInvoices(data.invoices || []);
        setPayments(data.payments || []);
        setTickets(data.tickets || []);
      } else {
        showToast("Subscriber not found","err");
      }
    } catch { showToast("Network error","err"); }
    try {
      const r = await fetch(`${API}/static-ips/subscriber/${id}`, { headers });
      const ip = r.ok ? await r.json() : null;
      setStaticIp(ip);
      setIpForm({
        ipAddress: ip?.ipAddress || "",
        monthlyPrice: ip?.monthlyPrice != null ? String(ip.monthlyPrice) : "",
        gateway: ip?.gateway || "",
      });
    } catch { /* the panel just shows empty */ }
    setLoading(false);
  }, [id]);

  // ── Router log ────────────────────────────────────────────────────────
  // Fetched on demand: the backend pulls fresh from the MikroTik when asked,
  // because two-minute-old data is no use while a line is actually down.
  const loadRouterLog = useCallback(async () => {
    if (!id) return;
    setRouterBusy(true);
    try {
      const r = await fetch(`${API}/logs/router/subscriber/${id}?limit=250`, { headers });
      if (r.ok) setRouterLog(await r.json());
    } catch { /* leave whatever we had */ }
    setRouterBusy(false);
  }, [id]);

  // Only load once the tab is actually opened — this hits the router.
  useEffect(() => {
    if (activeTab === "Router Log" && !routerLog) loadRouterLog();
  }, [activeTab]);

  // ── Static public IP ──────────────────────────────────────────────────
  async function saveStaticIp() {
    if (!ipForm.ipAddress.trim()) return showToast("Enter an IP address","err");
    setIpBusy(true);
    try {
      const r = await fetch(`${API}/static-ips/subscriber/${id}`, {
        method: "POST", headers,
        body: JSON.stringify({
          ipAddress: ipForm.ipAddress.trim(),
          monthlyPrice: ipForm.monthlyPrice ? Number(ipForm.monthlyPrice) : undefined,
          gateway: ipForm.gateway.trim() || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || "Could not set the address");
      // Say plainly whether it is live yet — an online customer is reconnected,
      // an offline one picks it up on their next dial-in.
      showToast(
        data.reconnected
          ? `${data.ipAddress} is live — session reconnected`
          : `${data.ipAddress} saved — applies on their next connection`,
        "ok",
      );
      loadSub();
    } catch (e:any) { showToast(e.message,"err"); } finally { setIpBusy(false); }
  }

  async function removeStaticIp() {
    if (!staticIp) return;
    setIpBusy(true);
    try {
      const r = await fetch(`${API}/static-ips/${staticIp.id}/release`, {
        method: "PATCH", headers,
        body: JSON.stringify({ reason: "Removed from the subscriber page" }),
      });
      if (!r.ok) throw new Error("Could not remove the address");
      showToast("Address returned to the pool — monthly charge stopped","ok");
      setStaticIp(null);
      setIpForm({ ipAddress: "", monthlyPrice: "", gateway: "" });
      loadSub();
    } catch (e:any) { showToast(e.message,"err"); } finally { setIpBusy(false); }
  }

  // ── Load live RADIUS data ─────────────────────────────────────────────
  const loadLiveData = useCallback(async (username: string) => {
    if (!username) return;
    setLoadingLive(true);
    try {
      // 1. Active session + history from radacct
      const sesRes = await fetch(`${API}/subscribers/radius-session/${username}`, { headers });
      if (sesRes.ok) {
        const data = await sesRes.json();
        setLiveSession(data.session || null);
        setRadiusOnline(!!data.session);
        setSessionLogs(data.history || []);
      }

      // 2. Auth logs from radpostauth
      const authRes = await fetch(`${API}/subscribers/radius-auth-log/${username}`, { headers });
      if (authRes.ok) { const d2 = await authRes.json(); setAuthLogs(d2 || []); }

      // 3. radcheck entries
      const checkRes = await fetch(`${API}/subscribers/radius-checks/${username}`, { headers });
      if (checkRes.ok) { const d3 = await checkRes.json(); setRadiusChecks(d3 || []); }

    } catch (error) {
      console.error("Failed to load RADIUS data", error);
    }
    setLoadingLive(false);
  }, []);

  /**
   * Live data allowance from RADIUS accounting.
   *
   * Read from the FUP endpoint rather than summing sessions in the browser:
   * the server measures usage over the customer's OWN billing period, so a
   * renewal correctly resets it. Summing every session client-side would keep
   * counting last month's traffic against this month's allowance.
   */
  const loadUsage = useCallback(async () => {
    if (!id) return;
    try {
      const r = await fetch(`${API}/compliance/fup/${id}`, { headers });
      if (r.ok) setUsage(await r.json());
    } catch { /* header simply omits the allowance */ }
  }, [id]);

  const refreshLive = async () => {
    if (!sub?.username) return;
    setRefreshing(true);
    await Promise.all([loadLiveData(sub.username), loadUsage()]);
    setRefreshing(false);
    showToast("Live data refreshed","ok");
  };

  // ── Lifecycle ─────────────────────────────────────────────────────────
  useEffect(() => {
    const tk = localStorage.getItem("token");
    if (!tk) { router.push("/login"); return; }
    fetch(`${API}/profile`,{headers}).then(r=>r.json()).then(d=>setUser(d.user)).catch(()=>router.push("/login"));
    loadSub();
  }, [id]);

  useEffect(() => {
    if (!sub?.username) return;
    loadLiveData(sub.username);
    loadUsage();
    // 30s rather than 60s: the header now carries live usage against the data
    // allowance, and a minute-old figure is not "real time" for a customer
    // sitting on the phone asking how much they have left.
    liveRef.current = setInterval(()=>{ loadLiveData(sub.username!); loadUsage(); }, 30000);
    return ()=>{ if(liveRef.current) clearInterval(liveRef.current); };
  }, [sub?.username]);

  // ── Shared style helpers ──────────────────────────────────────────────
  const Card = ({children, style={}}:any) => (
    <div style={{background:t.card,border:`1px solid ${t.cardBorder}`,borderRadius:10,padding:"14px 16px",...style}}>
      {children}
    </div>
  );
  const SectionTitle = ({icon, label, color="var(--muted)"}:any) => (
    <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:12,paddingBottom:8,borderBottom:`1px solid ${t.cardBorder}`}}>
      <span style={{color}}>{icon}</span>
      <span style={{fontSize:11,fontWeight:700,textTransform:"uppercase" as const,letterSpacing:"0.07em",color}}>{label}</span>
    </div>
  );
  const InfoRow = ({label, value, mono=false, badge=false, badgeColor="", badgeBg=""}:any) => (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"6px 0",borderBottom:`1px solid ${d?"#1a2535":"#f1f5f9"}`}}>
      <span style={{fontSize:11,color:t.textMuted,flexShrink:0,minWidth:140}}>{label}</span>
      {badge ? (
        <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,color:badgeColor,background:badgeBg}}>{value}</span>
      ) : (
        <span style={{fontSize:12,color:t.text,fontWeight:600,textAlign:"right" as const,wordBreak:"break-all" as const,
          ...(mono?{fontFamily:"monospace",color:"#34d399"}:{})}}>{value||"—"}</span>
      )}
    </div>
  );
  const StatBox = ({label, value, sub2="", color=t.text, icon}:any) => (
    <div style={{background:d?"var(--surface)":"#f8fafc",border:`1px solid ${t.cardBorder}`,borderRadius:8,padding:"10px 12px",flex:1,minWidth:100}}>
      <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:4,color:t.textMuted}}>{icon}<span style={{fontSize:10,fontWeight:600,textTransform:"uppercase" as const,letterSpacing:"0.05em"}}>{label}</span></div>
      <div style={{fontSize:18,fontWeight:700,color,lineHeight:1}}>{value}</div>
      {sub2 && <div style={{fontSize:10,color:t.textMuted,marginTop:2}}>{sub2}</div>}
    </div>
  );
  const Btn = ({onClick,children,variant="ghost",size="sm",disabled=false}:any) => {
    const vs:Record<string,React.CSSProperties> = {
      ghost:{background:"transparent",color:t.textSub,border:`1px solid ${t.cardBorder}`},
      primary:{background:t.accent,color:"#fff",border:"none"},
      danger:{background:"#450a0a",color:"#f87171",border:"none"},
      warning:{background:"#422006",color:"#fbbf24",border:"none"},
      success:{background:"#14532d",color:"#4ade80",border:"none"},
      teal:{background:"#134e4a",color:"#2dd4bf",border:"none"},
    };
    return <button onClick={onClick} disabled={disabled} style={{display:"inline-flex",alignItems:"center",gap:5,padding:size==="xs"?"3px 8px":"6px 13px",borderRadius:7,cursor:disabled?"not-allowed":"pointer",fontSize:size==="xs"?10:12,fontWeight:600,opacity:disabled?.6:1,transition:"all .15s",...vs[variant]}}>{children}</button>;
  };

  const statusColor = (s:string) => ({
    ACTIVE:   {color:"#4ade80",bg:"#14532d"},
    EXPIRED:  {color:"#f87171",bg:"#450a0a"},
    SUSPENDED:{color:"#fbbf24",bg:"#422006"},
    INACTIVE: {color:"var(--muted)",bg:"var(--border)"},
  }[s]||{color:"var(--muted)",bg:"var(--border)"});

  if (loading) return (
    <div style={{minHeight:"100vh",background:t.bg,display:"flex",alignItems:"center",justifyContent:"center",color:t.textMuted,fontSize:13}}>
      Loading subscriber…
    </div>
  );
  if (!sub) return (
    <div style={{minHeight:"100vh",background:t.bg,display:"flex",alignItems:"center",justifyContent:"center",color:"#f87171",fontSize:13}}>
      Subscriber not found. <button onClick={()=>router.back()} style={{marginLeft:10,color:t.accent,background:"none",border:"none",cursor:"pointer"}}>← Go back</button>
    </div>
  );

  const sc = statusColor(sub.status);
  const isOnline = radiusOnline === true;
  // Postgres BIGINT arrives over JSON as a STRING, so `a + s.upload_bytes`
  // concatenates instead of adding — "195" + "243" becomes "195243", and over
  // many sessions that grows into the absurd 7.7e+251 figure that was on
  // screen. Every value is coerced with Number() before it touches the sum.
  const num = (v: any) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const totalUpload   = sessionLogs.reduce((a,s)=>a+num(s.upload_bytes),0)   + num(liveSession?.upload_bytes);
  const totalDownload = sessionLogs.reduce((a,s)=>a+num(s.download_bytes),0) + num(liveSession?.download_bytes);

  // ══════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════
  return (
    <div style={{minHeight:"100vh",background:t.bg,color:t.text,fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif",fontSize:13}}>

      {/* Toast */}
      {toast&&<div style={{position:"fixed",bottom:24,right:24,zIndex:9999,background:toast.type==="ok"?"#14532d":toast.type==="err"?"#450a0a":"#422006",color:toast.type==="ok"?"#4ade80":toast.type==="err"?"#f87171":"#fbbf24",border:`1px solid ${toast.type==="ok"?"#166534":toast.type==="err"?"#7f1d1d":"#713f12"}`,borderRadius:10,padding:"12px 18px",fontSize:12,fontWeight:600,boxShadow:"0 4px 24px rgba(0,0,0,.5)"}}>{toast.msg}</div>}

      {/* ── TOP BAR ── */}
      <div style={{background:t.header,borderBottom:`1px solid ${d?"var(--border)":"#334155"}`,padding:"0 24px",height:56,display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:50}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <button onClick={()=>router.push("/subscribers")} style={{display:"flex",alignItems:"center",gap:5,background:"transparent",border:"none",cursor:"pointer",color:t.textMuted,fontSize:12,padding:"5px 8px",borderRadius:6}}>
            <Ic.Back /> Subscribers
          </button>
          <span style={{color:t.textMuted,fontSize:12}}>/</span>
          <span style={{fontWeight:700,fontSize:13,color:t.text}}>{sub.fullName}</span>
          <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,color:sc.color,background:sc.bg}}>{sub.status}</span>
          {/* Online indicator */}
          {loadingLive ? (
            <span style={{fontSize:11,color:t.amber}}>⏳ Checking…</span>
          ) : radiusOnline !== null ? (
            <span style={{display:"flex",alignItems:"center",gap:5,fontSize:11,padding:"2px 8px",borderRadius:4,background:isOnline?"#14532d":"#450a0a",color:isOnline?"#4ade80":"#f87171"}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:isOnline?"#4ade80":"#f87171",display:"inline-block",boxShadow:isOnline?"0 0 6px #4ade80":undefined}}/>
              {isOnline ? "Online" : "Offline"}
            </span>
          ) : null}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button onClick={()=>setDarkMode(p=>!p)} style={{display:"flex",alignItems:"center",gap:5,padding:"5px 11px",background:d?"var(--border)":"var(--text)",border:"none",borderRadius:20,cursor:"pointer",color:d?"#fbbf24":"#475569",fontSize:11,fontWeight:600}}>
            {d?<Ic.Sun/>:<Ic.Moon/>}{d?"Light":"Dark"}
          </button>
          <Btn onClick={refreshLive} variant="teal" disabled={refreshing}>
            <Ic.Refresh/>{refreshing?"Refreshing…":"Refresh Live Data"}
          </Btn>
          <Btn onClick={()=>router.push(`/subscribers?edit=${sub.id}`)} variant="warning">
            <Ic.Edit/> Edit
          </Btn>
        </div>
      </div>

      <div style={{padding:"20px 24px",maxWidth:1400,margin:"0 auto"}}>

        {/* ── HERO CARD ── */}
        <div style={{background:t.card,border:`1px solid ${t.cardBorder}`,borderRadius:12,padding:"20px 24px",marginBottom:16,display:"flex",gap:20,alignItems:"flex-start",flexWrap:"wrap" as const}}>
          {/* Avatar */}
          <div style={{width:64,height:64,borderRadius:16,background:"linear-gradient(135deg,#0ea5e9,#6366f1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,fontWeight:700,color:"#fff",flexShrink:0}}>
            {sub.fullName.split(" ").map(n=>n[0]).join("").toUpperCase().slice(0,2)}
          </div>
          {/* Name + meta */}
          <div style={{flex:1,minWidth:200}}>
            <div style={{fontSize:20,fontWeight:800,color:t.text,letterSpacing:"-0.02em"}}>{sub.fullName}</div>
            <code style={{fontSize:13,color:"#38bdf8"}}>{sub.username}</code>
            <div style={{display:"flex",gap:10,marginTop:6,flexWrap:"wrap" as const}}>
              {sub.phone&&<span style={{fontSize:11,color:t.textMuted}}>📞 {sub.phone}</span>}
              {sub.email&&<span style={{fontSize:11,color:t.textMuted}}>✉ {sub.email}</span>}
              {sub.identity&&<span style={{fontSize:11,color:t.textMuted}}>🪪 {sub.identity}</span>}
            </div>
          </div>
          {/* Quick stats */}
          <div style={{display:"flex",gap:10,flexWrap:"wrap" as const}}>
            <StatBox label="Uptime" value={isOnline&&liveSession?fmtDuration(liveSession.duration_seconds):"—"} color={isOnline?"#4ade80":t.textMuted} icon={<Ic.Clock/>}/>
            <StatBox label="Upload" value={fmtBytes(isOnline?liveSession?.upload_bytes:null)} color="#4ade80" icon={<Ic.Upload/>}/>
            <StatBox label="Download" value={fmtBytes(isOnline?liveSession?.download_bytes:null)} color="#60a5fa" icon={<Ic.Download/>}/>
            <StatBox label="Total Used" value={fmtBytes(totalDownload+totalUpload)} sub2="all sessions" color="#c4b5fd" icon={<Ic.Activity/>}/>
            <StatBox label="Leased IP" value={liveSession?.framedipaddress||"—"} color="#34d399" icon={<Ic.IP/>}/>
          </div>

          {/* ── Data allowance ──
              The quota was previously a raw text row buried in Service
              Settings, which made it impossible to answer "how much do I have
              left?" at a glance. Usage comes from the server, measured over
              this customer's own billing period, so a renewal resets it. */}
          {usage?.quotaGb ? (
            <div style={{
              marginTop: 12, padding: "12px 16px", borderRadius: 12,
              background: "var(--surface-2)", border: `1px solid ${
                usage.percentUsed >= 100 ? "#EF4444" : usage.percentUsed >= 85 ? "#F59E0B" : t.cardBorder}`,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between",
                alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
                <span style={{ fontSize: 11.5, color: t.textMuted, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: ".06em" }}>Data allowance</span>
                <span style={{ fontSize: 12.5 }}>
                  <b style={{ fontSize: 15, color:
                    usage.percentUsed >= 100 ? "#EF4444" : usage.percentUsed >= 85 ? "#F59E0B" : "#10B981" }}>
                    {usage.usedGb} GB
                  </b>
                  <span style={{ color: t.textMuted }}> of {usage.quotaGb} GB used</span>
                  {usage.remainingGb !== null && (
                    <span style={{ color: t.textMuted }}> · {usage.remainingGb} GB left</span>
                  )}
                </span>
              </div>
              <div style={{ height: 7, borderRadius: 99, background: "rgba(255,255,255,.07)", overflow: "hidden" }}>
                <div style={{
                  width: `${Math.min(100, usage.percentUsed || 0)}%`, height: "100%", borderRadius: 99,
                  background: usage.percentUsed >= 100 ? "#EF4444"
                    : usage.percentUsed >= 85 ? "#F59E0B"
                    : "linear-gradient(90deg,#00C9FF,#92FE9D)",
                  transition: "width .5s cubic-bezier(.2,.8,.2,1)",
                }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between",
                marginTop: 6, fontSize: 11, color: t.textMuted, flexWrap: "wrap", gap: 8 }}>
                <span>
                  {usage.percentUsed}% used · cycle began {new Date(usage.cycleStart).toLocaleDateString()}
                  {usage.bonusGb ? ` · incl. ${usage.bonusGb} GB bonus` : ""}
                </span>
                {usage.fupApplied && (
                  <span style={{ color: "#EF4444", fontWeight: 600 }}>
                    {usage.state === "BLOCKED"
                      ? "Net stopped — data limit reached"
                      : `Throttled to ${usage.throttledTo} — resets on renewal`}
                  </span>
                )}
              </div>

              {/* Quota top-up + restore. Extend adds GB to this cycle; if that
                  puts them back under the cap, service is restored automatically. */}
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <button
                  onClick={async () => {
                    const gb = Number(prompt("Add how many GB to this cycle?", "50"));
                    if (!gb || gb <= 0) return;
                    const r = await fetch(`${API}/compliance/fup/${sub.id}/extend`, { method: "POST", headers, body: JSON.stringify({ gb }) });
                    if (r.ok) { showToast(`Added ${gb} GB`, "ok"); loadUsage(); } else { showToast("Failed to extend quota", "err"); }
                  }}
                  style={{ border: "none", cursor: "pointer", borderRadius: 8, padding: "7px 13px", fontSize: 11.5, fontWeight: 700, color: "#fff", background: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)" }}>
                  + Extend quota
                </button>
                {usage.fupApplied && (
                  <button
                    onClick={async () => {
                      const r = await fetch(`${API}/compliance/fup/${sub.id}/release`, { method: "PATCH", headers });
                      if (r.ok) { showToast("Service restored", "ok"); loadUsage(); refreshLive(); } else { showToast("Failed to restore", "err"); }
                    }}
                    style={{ border: `1px solid ${t.cardBorder}`, cursor: "pointer", borderRadius: 8, padding: "7px 13px", fontSize: 11.5, fontWeight: 700, color: "#6EE7B7", background: "transparent" }}>
                    Restore {usage.state === "BLOCKED" ? "net" : "full speed"}
                  </button>
                )}
              </div>
            </div>
          ) : usage ? (
            <div style={{ marginTop: 12, fontSize: 11.5, color: t.textMuted }}>
              No data limit on this connection — unlimited usage.
              Set an allowance on the package under Plans &amp; Stock, or per customer in Service Settings.
            </div>
          ) : null}
        </div>

        {/* ── NOTES — transmission / install / anything staff must remember ── */}
        <div style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: "14px 16px", marginBottom: 16 }}>
          <RecordNotes entityType="SUBSCRIBER" entityId={sub.id} title="Notes — transmission, install, device" />
        </div>

        {/* ── TABS ── */}
        <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:`1px solid ${t.cardBorder}`,paddingBottom:0}}>
          {TABS.map(tab=>(
            <button key={tab} onClick={()=>setActiveTab(tab)} style={{
              padding:"8px 16px",borderRadius:"8px 8px 0 0",border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
              background:activeTab===tab?(d?"var(--surface)":"#fff"):"transparent",
              color:activeTab===tab?t.accent:t.textMuted,
              borderBottom:activeTab===tab?`2px solid ${t.accent}`:"2px solid transparent",
              transition:"all .15s",
            }}>{tab}</button>
          ))}
        </div>

        {/* ════════════════════════════════════
            TAB: PROFILE
        ════════════════════════════════════ */}
        {activeTab==="Profile" && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            {/* Personal */}
            <Card>
              <SectionTitle icon={<Ic.User/>} label="Personal Information" color="#60a5fa"/>
              <InfoRow label="Full Name"        value={sub.fullName}/>
              <InfoRow label="Identity / CNIC"  value={sub.identity}/>
              <InfoRow label="Phone"            value={sub.phone}/>
              <InfoRow label="Email"            value={sub.email}/>
              <InfoRow label="Address"          value={sub.address}/>
              <InfoRow label="Status"           value={sub.status} badge badgeColor={sc.color} badgeBg={sc.bg}/>
              <InfoRow label="Join Date"        value={fmtDate(sub.installationDate)}/>
              <InfoRow label="Created At"       value={fmtDate(sub.createdAt,true)}/>
            </Card>

            {/* Package + NAS */}
            <div style={{display:"flex",flexDirection:"column" as const,gap:14}}>
              <Card>
                <SectionTitle icon={<Ic.Package/>} label="Package Information" color="#a78bfa"/>
                <InfoRow label="Package"         value={sub.package?.name}/>
                <InfoRow label="Download Speed"  value={sub.package?`${sub.package.downloadSpeed} Mbps`:null}/>
                <InfoRow label="Upload Speed"    value={sub.package?`${sub.package.uploadSpeed} Mbps`:null}/>
                <InfoRow label="Price"           value={sub.package?`PKR ${sub.package.price}`:null}/>
                <InfoRow label="Duration"        value={sub.package?`${sub.package.duration} Days`:null}/>
                <InfoRow label="Area"            value={sub.area?.name}/>
              </Card>
              <Card>
                <SectionTitle icon={<Ic.Server/>} label="NAS / Router" color="#2dd4bf"/>
                <InfoRow label="NAS Name"        value={sub.nas?.nasname}/>
                <InfoRow label="NAS IP"          value={sub.nas?.nasIp} mono/>
                <InfoRow label="Connection Type" value={sub.connectionType}/>
                <InfoRow label="Salesperson"     value={sub.salesperson?.name}/>
              </Card>
            </div>
          </div>
        )}

        {activeTab==="Service Settings" && (
          <Card>
            <SectionTitle icon={<Ic.Shield/>} label="Service Settings" color="#2dd4bf"/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <InfoRow label="Profile Status" value={sub.status}/>
              <InfoRow label="Connection Type" value={sub.connectionType}/>
              <InfoRow label="NAS" value={sub.nas?.nasname}/>
              <InfoRow label="Salesperson" value={sub.salesperson?.name}/>
              <InfoRow label="Expiry Date" value={fmtDate(serviceSettings?.expiryDate || null, true)}/>
              <InfoRow label="IP Address" value={serviceSettings?.ipAddress}/>
              <InfoRow label="IP Type" value={serviceSettings?.ipType}/>
              <InfoRow label="MAC" value={serviceSettings?.macAddress} mono/>
              {/* Live figures from RADIUS, not the stored counter — quotaUsed
                  in the database only updates when a job runs, so it drifts. */}
              <InfoRow label="Data Allowance" value={usage?.quotaGb ? `${usage.quotaGb} GB` : (serviceSettings?.quota || "Unlimited")}/>
              <InfoRow label="Used This Cycle" value={usage?.usedGb != null ? `${usage.usedGb} GB` : "—"}/>
              <InfoRow label="Discount Type" value={serviceSettings?.discountType}/>
              <InfoRow label="Discount" value={serviceSettings?.discountValue?.toString()}/>
              <InfoRow label="Box/POP Number" value={serviceSettings?.ontSerial}/>
              <InfoRow label="Box/POP Address" value={serviceSettings?.ontModel}/>
              <InfoRow label="Uplink Port" value={serviceSettings?.uploadSpeed}/>
              <InfoRow label="Fiber Code/ID" value={serviceSettings?.downloadSpeed}/>
            </div>
          </Card>
        )}

        {activeTab==="Service Settings" && (
          <Card>
            <SectionTitle icon={<Ic.Server/>} label="Static Public IP" color="#0ea5e9"/>

            {staticIp ? (
              <div style={{
                background: d?"rgba(14,165,233,.08)":"#eff6ff",
                border:`1px solid ${t.accent}`, borderRadius:10, padding:14, marginBottom:14,
              }}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                  <div>
                    <div style={{fontSize:20,fontWeight:800,fontFamily:"ui-monospace,monospace",color:t.accent}}>
                      {staticIp.ipAddress}
                    </div>
                    <div style={{fontSize:11,color:t.textMuted,marginTop:2}}>
                      Assigned {fmtDate(staticIp.assignedAt, true)}
                      {staticIp.nas?.nasname ? ` · via ${staticIp.nas.nasname}` : ""}
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:17,fontWeight:800,color:t.green}}>
                      {staticIp.monthlyPrice ? money(staticIp.monthlyPrice) : "No charge"}
                    </div>
                    <div style={{fontSize:11,color:t.textMuted}}>per month</div>
                  </div>
                </div>

                {staticIp.nextBillingDate && (() => {
                  const days = Math.ceil(
                    (new Date(staticIp.nextBillingDate).getTime() - Date.now()) / 86400000,
                  );
                  const c = days < 0 ? t.red : days <= 7 ? t.amber : t.textMuted;
                  return (
                    <div style={{
                      marginTop:12, paddingTop:12, borderTop:`1px solid ${t.cardBorder}`,
                      display:"flex", justifyContent:"space-between", fontSize:12, color:c,
                    }}>
                      <span>Next monthly charge</span>
                      <b>
                        {fmtDate(staticIp.nextBillingDate)}
                        {days < 0 ? ` · ${-days}d overdue` : days === 0 ? " · due today" : ` · in ${days}d`}
                      </b>
                    </div>
                  );
                })()}
              </div>
            ) : (
              <div style={{fontSize:12,color:t.textMuted,marginBottom:12}}>
                No static address on this connection — the customer takes one from
                the package pool.
              </div>
            )}

            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:10}}>
              <div>
                <label style={{fontSize:10.5,color:t.textMuted,fontWeight:600}}>IP ADDRESS</label>
                <input value={ipForm.ipAddress} placeholder="119.73.14.50"
                  onChange={(e)=>setIpForm({...ipForm, ipAddress:e.target.value})}
                  style={{width:"100%",marginTop:4,background:t.input,border:`1px solid ${t.inputBorder}`,
                    borderRadius:8,padding:"8px 10px",color:t.text,fontSize:13,
                    fontFamily:"ui-monospace,monospace"}}/>
              </div>
              <div>
                <label style={{fontSize:10.5,color:t.textMuted,fontWeight:600}}>MONTHLY PRICE</label>
                <input type="number" value={ipForm.monthlyPrice} placeholder="0"
                  onChange={(e)=>setIpForm({...ipForm, monthlyPrice:e.target.value})}
                  style={{width:"100%",marginTop:4,background:t.input,border:`1px solid ${t.inputBorder}`,
                    borderRadius:8,padding:"8px 10px",color:t.text,fontSize:13}}/>
              </div>
              <div>
                <label style={{fontSize:10.5,color:t.textMuted,fontWeight:600}}>GATEWAY (OPTIONAL)</label>
                <input value={ipForm.gateway} placeholder="—"
                  onChange={(e)=>setIpForm({...ipForm, gateway:e.target.value})}
                  style={{width:"100%",marginTop:4,background:t.input,border:`1px solid ${t.inputBorder}`,
                    borderRadius:8,padding:"8px 10px",color:t.text,fontSize:13,
                    fontFamily:"ui-monospace,monospace"}}/>
              </div>
            </div>

            <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
              <button onClick={saveStaticIp} disabled={ipBusy}
                style={{background:t.accent,color:"#fff",border:"none",borderRadius:8,
                  padding:"8px 18px",fontSize:12.5,fontWeight:600,cursor:"pointer",opacity:ipBusy?.6:1}}>
                {staticIp ? "Update address" : "Set static IP"}
              </button>
              {staticIp && (
                <button onClick={removeStaticIp} disabled={ipBusy}
                  style={{background:"transparent",color:t.red,border:`1px solid ${t.red}`,borderRadius:8,
                    padding:"8px 18px",fontSize:12.5,fontWeight:600,cursor:"pointer",opacity:ipBusy?.6:1}}>
                  Remove &amp; stop billing
                </button>
              )}
            </div>

            <div style={{fontSize:11,color:t.textMuted,marginTop:10,lineHeight:1.6}}>
              Setting an address stops the pool being requested — the customer gets
              exactly this IP. If they are online now the session is reconnected so
              it applies immediately. The address and its price are kept on the
              Static IPs page with full assignment history.
            </div>
          </Card>
        )}

        {activeTab==="Router Log" && (
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
              <SectionTitle icon={<Ic.Server/>} label="What the router says" color="#f59e0b"/>
              <button onClick={loadRouterLog} disabled={routerBusy}
                style={{background:t.accent,color:"#fff",border:"none",borderRadius:8,
                  padding:"7px 15px",fontSize:12,fontWeight:600,cursor:"pointer",opacity:routerBusy?.6:1}}>
                {routerBusy ? "Reading router…" : "Refresh from router"}
              </button>
            </div>

            {/* The diagnosis is the point of this screen. Reading raw PPPoE
                lines to work out what is wrong is exactly what the panel
                should be doing for you. */}
            {routerLog?.diagnosis ? (() => {
              const dg = routerLog.diagnosis;
              const c = dg.severity === "critical" ? t.red : t.amber;
              return (
                <div style={{
                  background: dg.severity === "critical" ? "rgba(239,68,68,.10)" : "rgba(245,158,11,.10)",
                  border:`1px solid ${c}`, borderRadius:12, padding:16, marginBottom:16,
                }}>
                  <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:8}}>
                    <span style={{width:9,height:9,borderRadius:"50%",background:c,flexShrink:0}}/>
                    <span style={{fontSize:14,fontWeight:800,color:c}}>{dg.title}</span>
                    {dg.occurrences > 0 && (
                      <span style={{marginLeft:"auto",fontSize:11,color:t.textMuted}}>
                        {dg.occurrences}× in the last 30 minutes
                      </span>
                    )}
                  </div>
                  <div style={{fontSize:12.5,color:t.text,lineHeight:1.65,marginBottom:10}}>{dg.detail}</div>
                  <div style={{display:"grid",gap:8}}>
                    <div style={{fontSize:12,color:t.textMuted,lineHeight:1.6}}>
                      <b style={{color:t.text}}>Why: </b>{dg.cause}
                    </div>
                    <div style={{fontSize:12,color:t.textMuted,lineHeight:1.6}}>
                      <b style={{color:t.green}}>Fix: </b>{dg.fix}
                    </div>
                  </div>
                </div>
              );
            })() : routerLog ? (
              <div style={{background:"rgba(34,197,94,.08)",border:`1px solid ${t.green}`,
                borderRadius:12,padding:14,marginBottom:16,fontSize:12.5,color:t.green,fontWeight:600}}>
                No fault detected — the router reports nothing unusual for this connection.
              </div>
            ) : null}

            {!routerLog && !routerBusy && (
              <div style={{fontSize:12.5,color:t.textMuted}}>Loading the router log…</div>
            )}

            {routerLog?.lines?.length === 0 && (
              <div style={{fontSize:12.5,color:t.textMuted,lineHeight:1.7}}>
                Nothing recorded for this user yet. The panel reads each router
                every two minutes; if this stays empty, the router may be missing
                its API username and password under Network → NAS / Routers.
              </div>
            )}

            {routerLog?.lines?.length > 0 && (
              <div style={{
                background: "var(--bg)", border: "1px solid var(--border)", borderRadius:10, padding:12,
                maxHeight:460, overflowY:"auto", fontFamily:"ui-monospace, monospace", fontSize:11.5,
              }}>
                {routerLog.lines.map((l:any) => {
                  const bad = /terminating|failed|error|reject|no more addresses/i.test(l.message);
                  const up  = /logged in|authenticated|connected/i.test(l.message) && !bad;
                  return (
                    <div key={l.id} style={{display:"flex",gap:10,padding:"3px 0",
                      borderBottom:"1px solid rgba(255,255,255,.04)"}}>
                      <span style={{color:"#64748b",flexShrink:0,minWidth:132}}>
                        {new Date(l.loggedAt).toLocaleString([], {month:"short",day:"numeric",
                          hour:"2-digit",minute:"2-digit",second:"2-digit"})}
                      </span>
                      <span style={{color:"#475569",flexShrink:0,minWidth:96}}>{l.nas?.nasname || "—"}</span>
                      <span style={{color: bad ? "#f87171" : up ? "#4ade80" : "#94a3b8", wordBreak:"break-word"}}>
                        {l.message}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        {activeTab==="Invoices" && (
          <Card>
            <SectionTitle icon={<Ic.Invoice/>} label={`Invoices (${invoices.length})`} color="#a78bfa"/>
            {invoices.length === 0 ? (
              <div style={{fontSize:12,color:t.textMuted}}>No invoices found.</div>
            ) : (
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{background:d?"var(--surface)":"#f1f5f9"}}>
                      {["Invoice","Status","Amount","Paid","Due","Date"].map((h)=><th key={h} style={{padding:"8px 10px",textAlign:"left",fontSize:10,color:t.textMuted}}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv:any)=>(
                      <tr key={inv.id} style={{borderTop:`1px solid ${t.cardBorder}`}}>
                        <td style={{padding:"8px 10px",fontSize:11}}>{inv.invoiceNo}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{inv.status}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{inv.total}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{inv.paidAmount}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{inv.dueAmount}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{fmtDate(inv.createdAt, true)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {activeTab==="Payments" && (
          <Card>
            <SectionTitle icon={<Ic.Activity/>} label={`Payments (${payments.length})`} color="#4ade80"/>
            {payments.length === 0 ? (
              <div style={{fontSize:12,color:t.textMuted}}>No payments found.</div>
            ) : (
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{background:d?"var(--surface)":"#f1f5f9"}}>
                      {["Payment","Method","Amount","Reference","Date"].map((h)=><th key={h} style={{padding:"8px 10px",textAlign:"left",fontSize:10,color:t.textMuted}}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((pay:any)=>(
                      <tr key={pay.id} style={{borderTop:`1px solid ${t.cardBorder}`}}>
                        <td style={{padding:"8px 10px",fontSize:11}}>{pay.paymentNo}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{pay.method}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{pay.amount}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{pay.referenceNo || "—"}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{fmtDate(pay.createdAt, true)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {activeTab==="Tickets" && (
          <Card>
            <SectionTitle icon={<Ic.Activity/>} label={`Tickets / Complaints (${tickets.length})`} color="#f0a500"/>
            {tickets.length === 0 ? (
              <div style={{fontSize:12,color:t.textMuted}}>No tickets found.</div>
            ) : (
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{background:d?"var(--surface)":"#f1f5f9"}}>
                      {["Ticket","Status","Priority","Category","Subject","Created"].map((h)=><th key={h} style={{padding:"8px 10px",textAlign:"left",fontSize:10,color:t.textMuted}}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.map((tkt:any)=>(
                      <tr key={tkt.id} style={{borderTop:`1px solid ${t.cardBorder}`}}>
                        <td style={{padding:"8px 10px",fontSize:11}}>{tkt.ticketNo}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{tkt.status}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{tkt.priority}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{tkt.category}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{tkt.subject}</td>
                        <td style={{padding:"8px 10px",fontSize:11}}>{fmtDate(tkt.createdAt, true)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {/* ════════════════════════════════════
            TAB: CONNECTION (live from RADIUS)
        ════════════════════════════════════ */}
        {activeTab==="Connection" && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            {/* Connection Status */}
            <Card>
              <SectionTitle icon={<Ic.Wifi/>} label="Connection Status" color="#4ade80"/>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,padding:"10px 14px",background:isOnline?"rgba(34,197,94,0.1)":"rgba(239,68,68,0.1)",borderRadius:8,border:`1px solid ${isOnline?"rgba(34,197,94,0.3)":"rgba(239,68,68,0.3)"}`}}>
                <span style={{width:10,height:10,borderRadius:"50%",background:isOnline?"#22c55e":"#ef4444",boxShadow:isOnline?"0 0 10px #22c55e":undefined,flexShrink:0}}/>
                <div>
                  <div style={{fontWeight:700,fontSize:14,color:isOnline?"#4ade80":"#f87171"}}>{isOnline?"Online":"Offline"}</div>
                  {isOnline&&liveSession&&<div style={{fontSize:11,color:t.textMuted}}>Online Uptime: {fmtDuration(liveSession.duration_seconds)}</div>}
                </div>
              </div>
              {liveSession ? (
                <>
                  <InfoRow label="Leased IP"       value={liveSession.framedipaddress} mono/>
                  <InfoRow label="MAC Address"     value={liveSession.callingstationid} mono/>
                  <InfoRow label="NAS IP"          value={liveSession.nasipaddress} mono/>
                  <InfoRow label="NAS Port"        value={liveSession.nasportid}/>
                  <InfoRow label="NAS Port Type"   value={liveSession.nasporttype}/>
                  <InfoRow label="Framed Protocol" value={liveSession.framedprotocol}/>
                  <InfoRow label="Service Type"    value={liveSession.servicetype}/>
                  <InfoRow label="Update Interval" value={liveSession.acctinterval?`${liveSession.acctinterval/60} Min`:null}/>
                </>
              ) : (
                <div style={{textAlign:"center",padding:"24px",color:t.textMuted,fontSize:12}}>
                  No active session found in RADIUS
                </div>
              )}
            </Card>

            {/* Session Stats */}
            <div style={{display:"flex",flexDirection:"column" as const,gap:14}}>
              <Card>
                <SectionTitle icon={<Ic.Activity/>} label="Session Statistics" color="#60a5fa"/>
                {liveSession ? (
                  <>
                    <InfoRow label="Session Started"  value={fmtDate(liveSession.acctstarttime,true)}/>
                    <InfoRow label="Session Updated"  value={fmtDate(liveSession.acctupdatetime||null,true)}/>
                    <InfoRow label="Session Time"     value={fmtDuration(liveSession.duration_seconds)}/>
                    <div style={{display:"flex",gap:8,marginTop:10}}>
                      <div style={{flex:1,background:"rgba(74,222,128,0.1)",border:"1px solid rgba(74,222,128,0.2)",borderRadius:8,padding:"10px 12px",textAlign:"center" as const}}>
                        <div style={{fontSize:10,color:t.textMuted,marginBottom:3}}>UPLOAD</div>
                        <div style={{fontSize:16,fontWeight:700,color:"#4ade80"}}>{fmtBytes(liveSession.upload_bytes)}</div>
                      </div>
                      <div style={{flex:1,background:"rgba(96,165,250,0.1)",border:"1px solid rgba(96,165,250,0.2)",borderRadius:8,padding:"10px 12px",textAlign:"center" as const}}>
                        <div style={{fontSize:10,color:t.textMuted,marginBottom:3}}>DOWNLOAD</div>
                        <div style={{fontSize:16,fontWeight:700,color:"#60a5fa"}}>{fmtBytes(liveSession.download_bytes)}</div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{color:t.textMuted,fontSize:12,padding:"10px 0"}}>No active session</div>
                )}
              </Card>

              <Card>
                <SectionTitle icon={<Ic.Activity/>} label="All-time Usage" color="#c4b5fd"/>
                <div style={{display:"flex",gap:8}}>
                  <div style={{flex:1,background:d?"var(--surface)":"#f8fafc",border:`1px solid ${t.cardBorder}`,borderRadius:8,padding:"10px 12px",textAlign:"center" as const}}>
                    <div style={{fontSize:10,color:t.textMuted,marginBottom:3}}>TOTAL UPLOAD</div>
                    <div style={{fontSize:14,fontWeight:700,color:"#4ade80"}}>{fmtBytes(totalUpload)}</div>
                  </div>
                  <div style={{flex:1,background:d?"var(--surface)":"#f8fafc",border:`1px solid ${t.cardBorder}`,borderRadius:8,padding:"10px 12px",textAlign:"center" as const}}>
                    <div style={{fontSize:10,color:t.textMuted,marginBottom:3}}>TOTAL DOWNLOAD</div>
                    <div style={{fontSize:14,fontWeight:700,color:"#60a5fa"}}>{fmtBytes(totalDownload)}</div>
                  </div>
                </div>
                <div style={{marginTop:8,padding:"8px 12px",background:d?"var(--surface)":"#f8fafc",border:`1px solid ${t.cardBorder}`,borderRadius:8,textAlign:"center" as const}}>
                  <div style={{fontSize:10,color:t.textMuted,marginBottom:2}}>TOTAL SESSIONS</div>
                  <div style={{fontSize:18,fontWeight:700,color:"#c4b5fd"}}>{sessionLogs.length + (liveSession?1:0)}</div>
                </div>
              </Card>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════
            TAB: SESSION LOG (from radacct)
        ════════════════════════════════════ */}
        {activeTab==="Session Log" && (
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <SectionTitle icon={<Ic.Clock/>} label={`Session History (${sessionLogs.length + (liveSession?1:0)} sessions)`} color="#60a5fa"/>
              <Btn onClick={refreshLive} variant="teal" size="xs" disabled={refreshing}><Ic.Refresh/> Refresh</Btn>
            </div>
            {loadingLive ? (
              <div style={{textAlign:"center",padding:30,color:t.textMuted}}>Loading…</div>
            ) : sessionLogs.length === 0 && !liveSession ? (
              <div style={{textAlign:"center",padding:30,color:t.textMuted}}>No session history found</div>
            ) : (
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{background:d?"var(--surface)":"#f1f5f9"}}>
                      {["Status","Leased IP","MAC Address","NAS IP","Started","Duration","Upload","Download","Terminated"].map(h=>(
                        <th key={h} style={{padding:"8px 12px",textAlign:"left",fontSize:10,fontWeight:700,color:t.textMuted,letterSpacing:"0.05em",whiteSpace:"nowrap" as const}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...(liveSession?[liveSession]:[]), ...sessionLogs].map((sess,i)=>{
                      const active = !sess.acctstoptime && i===0 && liveSession;
                      return (
                        <tr key={i} style={{background:i%2===0?t.tableRow:t.tableRow2,borderTop:`1px solid ${t.cardBorder}`}}>
                          <td style={{padding:"8px 12px"}}>
                            {active ? (
                              <span style={{display:"flex",alignItems:"center",gap:4,fontSize:10,fontWeight:700,color:"#4ade80"}}>
                                <span style={{width:6,height:6,borderRadius:"50%",background:"#4ade80",boxShadow:"0 0 6px #4ade80"}}/>Online
                              </span>
                            ) : <span style={{fontSize:10,color:t.textMuted}}>Ended</span>}
                          </td>
                          <td style={{padding:"8px 12px"}}><code style={{fontSize:11,color:"#34d399"}}>{sess.framedipaddress||"—"}</code></td>
                          <td style={{padding:"8px 12px"}}><code style={{fontSize:10,color:t.textMuted}}>{sess.callingstationid||"—"}</code></td>
                          <td style={{padding:"8px 12px"}}><code style={{fontSize:10,color:"#60a5fa"}}>{sess.nasipaddress||"—"}</code></td>
                          <td style={{padding:"8px 12px",fontSize:11,color:t.textSub,whiteSpace:"nowrap" as const}}>{fmtDate(sess.acctstarttime,true)}</td>
                          <td style={{padding:"8px 12px",fontSize:11,color:t.text,fontWeight:600}}>{fmtDuration(sess.duration_seconds)}</td>
                          <td style={{padding:"8px 12px",fontSize:11,color:"#4ade80",fontWeight:600}}>{fmtBytes(sess.upload_bytes)}</td>
                          <td style={{padding:"8px 12px",fontSize:11,color:"#60a5fa",fontWeight:600}}>{fmtBytes(sess.download_bytes)}</td>
                          <td style={{padding:"8px 12px",fontSize:10,color:t.textMuted}}>{sess.acctterminatecause||"—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {/* ════════════════════════════════════
            TAB: RADIUS
        ════════════════════════════════════ */}
        {activeTab==="RADIUS" && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            {/* radcheck entries */}
            <Card>
              <SectionTitle icon={<Ic.Shield/>} label="RADIUS radcheck (Credentials)" color="#a78bfa"/>
              {radiusChecks.length === 0 ? (
                <div style={{textAlign:"center",padding:24,color:t.textMuted,fontSize:12}}>
                  No entries in radcheck. User not synced to RADIUS.
                  <div style={{marginTop:10}}>
                    <Btn onClick={async()=>{
                      const r=await fetch(`${API}/subscribers/${sub.id}/sync-to-radius`,{method:"POST",headers});
                      if(r.ok){showToast("Synced to RADIUS","ok");loadLiveData(sub.username!);}
                      else showToast("Sync failed","err");
                    }} variant="primary" size="xs">Sync to RADIUS now</Btn>
                  </div>
                </div>
              ) : (
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr style={{background:d?"var(--surface)":"#f1f5f9"}}>
                    {["Attribute","Op","Value"].map(h=><th key={h} style={{padding:"7px 10px",textAlign:"left",fontSize:10,fontWeight:700,color:t.textMuted}}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {radiusChecks.map((rc,i)=>(
                      <tr key={i} style={{borderTop:`1px solid ${t.cardBorder}`}}>
                        <td style={{padding:"7px 10px",fontSize:11,color:"#60a5fa",fontWeight:600}}>{rc.attribute}</td>
                        <td style={{padding:"7px 10px"}}><code style={{fontSize:11,color:"#fbbf24"}}>{rc.op}</code></td>
                        <td style={{padding:"7px 10px"}}><code style={{fontSize:11,color:"#4ade80"}}>{rc.attribute.toLowerCase().includes("password")?"••••••••":rc.value}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            {/* RADIUS Server Info */}
            <Card>
              <SectionTitle icon={<Ic.Server/>} label="RADIUS Server Info" color="#2dd4bf"/>
              <InfoRow label="RADIUS Server"    value="127.0.0.1" mono/>
              <InfoRow label="Auth Port"        value="1812 UDP" mono/>
              <InfoRow label="Accounting Port"  value="1813 UDP" mono/>
              <InfoRow label="CoA Port"         value="3799 UDP" mono/>
              <InfoRow label="Database"         value="radius (PostgreSQL)" mono/>
              <InfoRow label="NAS Secret"       value={sub.nas?"Configured":"Not linked"}/>
              <InfoRow label="Sync Status"      value={radiusChecks.length>0?"In RADIUS ✓":"Not synced"} badge
                badgeColor={radiusChecks.length>0?"#4ade80":"#f87171"} badgeBg={radiusChecks.length>0?"#14532d":"#450a0a"}/>
              <div style={{marginTop:12,display:"flex",gap:8,flexWrap:"wrap" as const}}>
                <Btn onClick={async()=>{
                  const r=await fetch(`${API}/subscribers/${sub.id}/sync-to-radius`,{method:"POST",headers});
                  if(r.ok){showToast("Force-synced to RADIUS","ok");loadLiveData(sub.username!);}
                  else showToast("Sync failed","err");
                }} variant="success" size="xs"><Ic.Check/> Force Sync</Btn>
                <Btn onClick={async()=>{
                  const r=await fetch(`${API}/subscribers/${sub.id}/fix-radius-password`,{method:"POST",headers});
                  if(r.ok){showToast("Password fixed in RADIUS","ok");loadLiveData(sub.username!);}
                  else showToast("Failed","err");
                }} variant="warning" size="xs"><Ic.Lock/> Fix Password</Btn>
              </div>
            </Card>
          </div>
        )}

        {/* ════════════════════════════════════
            TAB: LOGIN LOG (radpostauth)
        ════════════════════════════════════ */}
        {activeTab==="Login Log" && (
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <SectionTitle icon={<Ic.Shield/>} label={`Auth Log — radpostauth (${authLogs.length} entries)`} color="#60a5fa"/>
              <Btn onClick={refreshLive} variant="teal" size="xs" disabled={refreshing}><Ic.Refresh/> Refresh</Btn>
            </div>
            {loadingLive ? (
              <div style={{textAlign:"center",padding:30,color:t.textMuted}}>Loading…</div>
            ) : authLogs.length === 0 ? (
              <div style={{textAlign:"center",padding:30,color:t.textMuted}}>No auth log entries found</div>
            ) : (
              <div style={{overflowX:"auto",maxHeight:500,overflowY:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{background:d?"var(--surface)":"#f1f5f9"}}>
                      {["Result","Username","Date / Time"].map(h=>(
                        <th key={h} style={{padding:"8px 12px",textAlign:"left",fontSize:10,fontWeight:700,color:t.textMuted,letterSpacing:"0.05em",position:"sticky",top:0,background:d?"var(--surface)":"#f1f5f9"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {authLogs.map((log,i)=>{
                      const ok = log.reply==="Access-Accept";
                      return (
                        <tr key={i} style={{background:i%2===0?t.tableRow:t.tableRow2,borderTop:`1px solid ${t.cardBorder}`}}>
                          <td style={{padding:"7px 12px"}}>
                            <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,color:ok?"#4ade80":"#f87171",background:ok?"#14532d":"#450a0a"}}>
                              {ok?"✓ Accept":"✗ Reject"}
                            </span>
                          </td>
                          <td style={{padding:"7px 12px"}}><code style={{fontSize:11,color:"#38bdf8"}}>{log.username}</code></td>
                          <td style={{padding:"7px 12px",fontSize:11,color:t.textSub,whiteSpace:"nowrap" as const}}>{fmtDate(log.authdate,true)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {/* ════════════════════════════════════
            TAB: ACTIVITIES
        ════════════════════════════════════ */}
        {activeTab==="Activities" && (
          <Card>
            <SectionTitle icon={<Ic.Activity/>} label="Activity Summary" color="#a78bfa"/>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10,marginBottom:16}}>
              {[
                {label:"Total Sessions",    value:sessionLogs.length+(liveSession?1:0), color:"#c4b5fd"},
                {label:"Total Upload",      value:fmtBytes(totalUpload),               color:"#4ade80"},
                {label:"Total Download",    value:fmtBytes(totalDownload),             color:"#60a5fa"},
                {label:"Auth Accepts",      value:authLogs.filter(a=>a.reply==="Access-Accept").length, color:"#4ade80"},
                {label:"Auth Rejects",      value:authLogs.filter(a=>a.reply!=="Access-Accept").length, color:"#f87171"},
                {label:"RADIUS Records",    value:radiusChecks.length,                 color:"#fbbf24"},
              ].map((item,i)=>(
                <div key={i} style={{background:d?"var(--surface)":"#f8fafc",border:`1px solid ${t.cardBorder}`,borderRadius:8,padding:"12px 14px"}}>
                  <div style={{fontSize:10,color:t.textMuted,marginBottom:4,fontWeight:600,textTransform:"uppercase" as const,letterSpacing:"0.05em"}}>{item.label}</div>
                  <div style={{fontSize:20,fontWeight:800,color:item.color}}>{item.value}</div>
                </div>
              ))}
            </div>
            <div style={{fontSize:11,color:t.textMuted,padding:"10px 14px",background:d?"var(--surface)":"#f8fafc",borderRadius:8,border:`1px solid ${t.cardBorder}`}}>
              <div style={{fontWeight:700,color:t.textSub,marginBottom:6}}>Data Sources</div>
              <div style={{lineHeight:1.8}}>
                • <b style={{color:t.text}}>Session data</b> — fetched live from <code style={{color:"#38bdf8"}}>radacct</code> table (PostgreSQL radius DB)<br/>
                • <b style={{color:t.text}}>Auth logs</b> — fetched from <code style={{color:"#38bdf8"}}>radpostauth</code> table<br/>
                • <b style={{color:t.text}}>RADIUS credentials</b> — fetched from <code style={{color:"#38bdf8"}}>radcheck</code> table<br/>
                • <b style={{color:t.text}}>Online status</b> — based on active session in radacct (acctstoptime IS NULL)<br/>
                • <b style={{color:t.text}}>Auto-refreshes</b> every 60 seconds
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}