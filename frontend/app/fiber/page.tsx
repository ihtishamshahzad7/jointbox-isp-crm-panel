"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Icons as SIcons } from "../components/icons";
import API_BASE from "../components/api";

// ─── Types ────────────────────────────────────────────────────────────────────
interface FiberSummary {
  totalOlts: number; totalPorts: number; totalOnus: number;
  assignedOnus: number; activeOnus: number; utilizationPercent: number;
}
interface Olt {
  id: number; name: string; vendor: string | null; model: string | null;
  mgmtIp: string | null; location: string | null; nasId: number | null;
  areaId: number | null; isActive: boolean;
  _count?: { ports: number; onus: number };
}
interface PonPort {
  id: number; oltId: number; portName: string; slot: string | null;
  port: string | null; splitRatio: number | null; splitterLocation: string | null;
  olt?: { name: string };
  _count?: { onus: number };
}
interface Onu {
  id: number; oltId: number; ponPortId: number | null; subscriberId: number | null;
  onuIndex: string | null; serialNumber: string | null; macAddress: string | null;
  model: string | null; rxPower: number | null; txPower: number | null;
  circuitId: string | null; isActive: boolean;
  olt?: { id: number; name: string; vendor: string | null };
  ponPort?: { id: number; portName: string } | null;
  subscriber?: { id: number; fullName: string; username: string; phone: string; status: string } | null;
}
interface OltTree {
  olt: { id: number; name: string; vendor: string | null; model: string | null; location: string | null };
  ports: Array<{
    id: number; portName: string; splitRatio: number | null; splitterLocation: string | null;
    subscriberCount: number;
    onus: Array<{ id: number; onuIndex: string | null; serialNumber: string | null; subscriber: { id: number; fullName: string } | null }>;
  }>;
}

const API = API_BASE;

const Ic = { ...SIcons };

export default function FiberPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<"olts"|"ports"|"onus">("olts");
  const [loading, setLoading] = useState(true);

  // Data
  const [summary, setSummary] = useState<FiberSummary | null>(null);
  const [olts, setOlts] = useState<Olt[]>([]);
  const [ports, setPorts] = useState<PonPort[]>([]);
  const [onus, setOnus] = useState<Onu[]>([]);
  const [onuPage, setOnuPage] = useState(1);
  const [onuTotal, setOnuTotal] = useState(0);
  const [onuPages, setOnuPages] = useState(0);
  const [subscribers, setSubscribers] = useState<any[]>([]);
  const [oltTree, setOltTree] = useState<OltTree | null>(null);

  // Filters
  const [onuFilter, setOnuFilter] = useState({ oltId: "", portId: "", unassigned: "", search: "" });

  // Modals
  const [showOltForm, setShowOltForm] = useState(false);
  const [showPortForm, setShowPortForm] = useState(false);
  const [showOnuDetail, setShowOnuDetail] = useState<Onu | null>(null);
  const [showAssignModal, setShowAssignModal] = useState<Onu | null>(null);
  const [showTreeModal, setShowTreeModal] = useState<Olt | null>(null);
  const [showProvisionModal, setShowProvisionModal] = useState<any>(null);
  const [provisionCommands, setProvisionCommands] = useState<string[]>([]);

  // Forms
  const [oltForm, setOltForm] = useState({ name: "", vendor: "", model: "", mgmtIp: "", location: "" });
  const [portForm, setPortForm] = useState({ oltId: "", portName: "", slot: "", port: "", splitRatio: "", splitterLocation: "" });
  const [assignSubId, setAssignSubId] = useState("");
  const [editingOlt, setEditingOlt] = useState<Olt | null>(null);
  const [editingPort, setEditingPort] = useState<PonPort | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : '';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const d = darkMode;
  const t = {
    bg: d?"var(--bg)":"#f0f4fa", card:d?"var(--surface)":"#ffffff",
    cardBorder:d?"var(--border)":"var(--text)", text:d?"var(--text)":"var(--surface)",
    textMuted:d?"var(--muted)":"var(--muted)", textSub:d?"var(--muted)":"#475569",
    input:d?"var(--bg)":"#f8fafc", inputBorder:d?"var(--border)":"#cbd5e1",
    tableRow:d?"var(--surface-2)":"#f8fafc", tableRow2:d?"#121d30":"#ffffff",
    accent:"#0ea5e9", green:"#22c55e", red:"#ef4444", amber:"#f59e0b", purple:"#8b5cf6", teal:"#14b8a6",
  };

  useEffect(() => {
    const tk = localStorage.getItem("token");
    if (!tk) { router.push("/login"); return; }
    fetch(`${API}/profile`,{headers}).then(r=>r.json()).then(d=>setUser(d.user)).catch(()=>router.push("/login"));
    loadAll();
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [sumRes, oltRes, portRes, subRes] = await Promise.all([
        fetch(`${API}/fiber/summary`,{headers}),
        fetch(`${API}/fiber/olts`,{headers}),
        fetch(`${API}/fiber/ports`,{headers}),
        fetch(`${API}/subscribers`,{headers}),
      ]);
      if (sumRes.ok) setSummary(await sumRes.json());
      if (oltRes.ok) {
        const d = await oltRes.json();
        setOlts(Array.isArray(d)?d:d.data||d.items||[]);
      }
      if (portRes.ok) {
        const d = await portRes.json();
        setPorts(Array.isArray(d)?d:d.data||d.items||[]);
      }
      if (subRes.ok) {
        const d = await subRes.json();
        setSubscribers(Array.isArray(d)?d:d.data||d.items||[]);
      }
    } catch (e) { console.error("Fiber load error", e); }
    setLoading(false);
  }, []);

  const loadOnus = useCallback(async (page=1) => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (onuFilter.oltId) params.set("oltId", onuFilter.oltId);
      if (onuFilter.portId) params.set("portId", onuFilter.portId);
      if (onuFilter.unassigned) params.set("unassigned", onuFilter.unassigned);
      const res = await fetch(`${API}/fiber/onus?${params}`,{headers});
      if (res.ok) {
        const d = await res.json();
        setOnus(d.items||[]);
        setOnuTotal(d.total||0);
        setOnuPages(d.pages||0);
        setOnuPage(d.page||1);
      }
    } catch {}
  }, [onuFilter]);

  useEffect(() => {
    if (activeTab === "onus") loadOnus(1);
  }, [activeTab, onuFilter.oltId, onuFilter.portId, onuFilter.unassigned]);

  const loadTree = async (olt: Olt) => {
    try {
      const res = await fetch(`${API}/fiber/olts/${olt.id}/tree`,{headers});
      if (res.ok) setOltTree(await res.json());
    } catch {}
    setShowTreeModal(olt);
  };

  const handleCreateOlt = async (e: any) => {
    e.preventDefault();
    try {
      await fetch(`${API}/fiber/olts`,{method:"POST",headers,body:JSON.stringify(oltForm)});
      setShowOltForm(false); resetOltForm(); loadAll();
    } catch { alert("Failed to create OLT"); }
  };

  const handleUpdateOlt = async (e: any) => {
    e.preventDefault();
    if (!editingOlt) return;
    try {
      await fetch(`${API}/fiber/olts/${editingOlt.id}`,{method:"PUT",headers,body:JSON.stringify(oltForm)});
      setShowOltForm(false); setEditingOlt(null); resetOltForm(); loadAll();
    } catch { alert("Failed to update OLT"); }
  };

  const handleDeleteOlt = async (id: number) => {
    if (!confirm("Delete this OLT? This cannot be undone if it has active ONUs.")) return;
    try {
      const res = await fetch(`${API}/fiber/olts/${id}`,{method:"DELETE",headers});
      if (!res.ok) { const e = await res.json().catch(()=>({})); alert(e.message||"Cannot delete OLT"); return; }
      loadAll();
    } catch { alert("Failed to delete OLT"); }
  };

  const handleCreatePort = async (e: any) => {
    e.preventDefault();
    try {
      await fetch(`${API}/fiber/ports`,{method:"POST",headers,body:JSON.stringify({
        oltId: Number(portForm.oltId), portName: portForm.portName,
        slot: portForm.slot||undefined, port: portForm.port||undefined,
        splitRatio: portForm.splitRatio?Number(portForm.splitRatio):undefined,
        splitterLocation: portForm.splitterLocation||undefined,
      })});
      setShowPortForm(false); resetPortForm(); loadAll();
    } catch { alert("Failed to create PON port"); }
  };

  const handleUpdatePort = async (e: any) => {
    e.preventDefault();
    if (!editingPort) return;
    try {
      await fetch(`${API}/fiber/ports/${editingPort.id}`,{method:"PUT",headers,body:JSON.stringify({
        portName: portForm.portName,
        slot: portForm.slot||undefined, port: portForm.port||undefined,
        splitRatio: portForm.splitRatio?Number(portForm.splitRatio):undefined,
        splitterLocation: portForm.splitterLocation||undefined,
      })});
      setShowPortForm(false); setEditingPort(null); resetPortForm(); loadAll();
    } catch { alert("Failed to update port"); }
  };

  const handleDeletePort = async (id: number) => {
    if (!confirm("Delete this PON port? This cannot be undone if it has active ONUs.")) return;
    try {
      const res = await fetch(`${API}/fiber/ports/${id}`,{method:"DELETE",headers});
      if (!res.ok) { const e = await res.json().catch(()=>({})); alert(e.message||"Cannot delete port"); return; }
      loadAll();
    } catch { alert("Failed to delete port"); }
  };

  const handleAssignOnu = async () => {
    if (!showAssignModal || !assignSubId) { alert("Select a subscriber"); return; }
    try {
      const res = await fetch(`${API}/fiber/onus/${showAssignModal.id}/assign/${assignSubId}`,{method:"POST",headers});
      if (!res.ok) { const e = await res.json().catch(()=>({})); alert(e.message||"Failed to assign"); return; }
      setShowAssignModal(null); setAssignSubId(""); loadOnus(onuPage); loadAll();
    } catch { alert("Failed to assign ONU"); }
  };

  const handleUnassignOnu = async (onuId: number) => {
    if (!confirm("Unassign this ONU from its subscriber?")) return;
    try {
      await fetch(`${API}/fiber/onus/${onuId}/unassign`,{method:"POST",headers});
      loadOnus(onuPage);
    } catch { alert("Failed to unassign ONU"); }
  };

  const handleDeleteOnu = async (id: number) => {
    if (!confirm("Delete this ONU? Must be unassigned first.")) return;
    try {
      const res = await fetch(`${API}/fiber/onus/${id}`,{method:"DELETE",headers});
      if (!res.ok) { const e = await res.json().catch(()=>({})); alert(e.message||"Cannot delete"); return; }
      loadOnus(onuPage);
    } catch { alert("Failed to delete ONU"); }
  };

  const loadProvisionCommands = async (onu: Onu) => {
    try {
      const res = await fetch(`${API}/fiber/onus/${onu.id}/provision-commands`,{headers});
      if (res.ok) setProvisionCommands(await res.json());
      else setProvisionCommands(["No provisioning commands available"]);
    } catch { setProvisionCommands(["Error fetching commands"]); }
    setShowProvisionModal(onu);
  };

  const resetOltForm = () => setOltForm({ name: "", vendor: "", model: "", mgmtIp: "", location: "" });
  const resetPortForm = () => setPortForm({ oltId: "", portName: "", slot: "", port: "", splitRatio: "", splitterLocation: "" });

  const openEditOlt = (olt: Olt) => {
    setEditingOlt(olt);
    setOltForm({ name: olt.name, vendor: olt.vendor||"", model: olt.model||"", mgmtIp: olt.mgmtIp||"", location: olt.location||"" });
    setShowOltForm(true);
  };

  const openEditPort = (port: PonPort) => {
    setEditingPort(port);
    setPortForm({ oltId: String(port.oltId), portName: port.portName, slot: port.slot||"", port: port.port||"", splitRatio: port.splitRatio?String(port.splitRatio):"", splitterLocation: port.splitterLocation||"" });
    setShowPortForm(true);
  };

  const Btn = ({onClick,children,variant="default",size="sm",disabled=false,title=""}:any) => {
    const vs:Record<string,React.CSSProperties> = {
      default:{background:"var(--border)",color:t.textSub}, primary:{background:t.accent,color:"#fff"},
      success:{background:"#14532d",color:"#4ade80"}, danger:{background:"#450a0a",color:"#f87171"},
      warning:{background:"#422006",color:"#fbbf24"}, ghost:{background:"transparent",color:t.textSub,border:`1px solid ${t.cardBorder}`},
      teal:{background:"#134e4a",color:"#2dd4bf"},
    };
    return <button onClick={onClick} disabled={disabled} title={title} style={{display:"inline-flex",alignItems:"center",gap:5,padding:size==="xs"?"3px 8px":"5px 12px",borderRadius:6,border:"none",cursor:disabled?"not-allowed":"pointer",fontSize:size==="xs"?10:12,fontWeight:600,opacity:disabled?.5:1,transition:"all .15s",...vs[variant]}}>{children}</button>;
  };

  const Badge = ({children,color,bg}:{children:React.ReactNode;color:string;bg:string}) => (
    <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,color,background:bg,letterSpacing:"0.04em",whiteSpace:"nowrap"}}>{children}</span>
  );

  return (
    <div style={{display:"flex",minHeight:"100vh",background:t.bg,color:t.text,fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif",fontSize:13}}>
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
        <div style={{flex:1,padding:"16px 20px",overflowY:"auto"}}>

          {/* ── Header ── */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
            <div>
              <h1 style={{fontSize:20,fontWeight:800,margin:0,letterSpacing:"-0.02em"}}>FTTH / Fiber Management</h1>
              {summary && <p style={{fontSize:11,color:t.textMuted,margin:"4px 0 0"}}>{summary.totalOlts} OLTs · {summary.totalPorts} ports · {summary.totalOnus} ONUs ({summary.assignedOnus} assigned) · {summary.utilizationPercent}% utilization</p>}
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={()=>{setEditingOlt(null);resetOltForm();setShowOltForm(true);}} variant="primary">+ New OLT</Btn>
              <Btn onClick={()=>{setEditingPort(null);resetPortForm();setShowPortForm(true);}} variant="teal">+ New Port</Btn>
            </div>
          </div>

          {/* ── Summary Cards ── */}
          {summary && (
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:16}}>
              {[
                {label:"Total OLTs",value:summary.totalOlts,icon:"🏛️",bg:"linear-gradient(135deg,#3b82f6,#2563eb)"},
                {label:"PON Ports",value:summary.totalPorts,icon:"🔌",bg:"linear-gradient(135deg,#8b5cf6,#7c3aed)"},
                {label:"Total ONUs",value:summary.totalOnus,icon:"📡",bg:"linear-gradient(135deg,#10b981,#059669)"},
                {label:"Assigned",value:summary.assignedOnus,icon:"🔗",bg:"linear-gradient(135deg,#0ea5e9,#0284c7)"},
                {label:"Active",value:summary.activeOnus,icon:"⚡",bg:"linear-gradient(135deg,#22c55e,#16a34a)"},
                {label:"Utilization",value:`${summary.utilizationPercent}%`,icon:"📊",bg:"linear-gradient(135deg,#f59e0b,#d97706)"},
              ].map((c,i)=>(
                <div key={i} style={{background:t.card,border:`1px solid ${t.cardBorder}`,borderRadius:10,padding:"12px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{width:32,height:32,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",background:c.bg,fontSize:16}}>{c.icon}</div>
                  </div>
                  <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",color:t.textMuted,marginBottom:2}}>{c.label}</div>
                  <div style={{fontSize:20,fontWeight:800,color:t.text}}>{c.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* ── Tab Bar ── */}
          <div style={{display:"flex",gap:4,marginBottom:12,borderBottom:`1px solid ${t.cardBorder}`,paddingBottom:0}}>
            {([{id:"olts",label:"OLTs"},{id:"ports",label:"PON Ports"},{id:"onus",label:"ONUs"}]).map(tab=>(
              <button key={tab.id} onClick={()=>setActiveTab(tab.id as any)} style={{
                padding:"8px 16px",borderRadius:"8px 8px 0 0",border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
                background:activeTab===tab.id?t.card:"transparent",
                color:activeTab===tab.id?t.accent:t.textMuted,
                borderBottom:activeTab===tab.id?`2px solid ${t.accent}`:"2px solid transparent",
                transition:"all .15s",
              }}>{tab.label}</button>
            ))}
          </div>

          {loading ? (
            <div style={{textAlign:"center",padding:50,background:t.card,borderRadius:12,border:`1px solid ${t.cardBorder}`}}>
              <div style={{width:36,height:36,border:`3px solid ${t.cardBorder}`,borderTopColor:t.accent,borderRadius:"50%",animation:"spin 1s linear infinite",margin:"0 auto 14px"}}></div>
              <p style={{color:t.textMuted,fontSize:13}}>Loading fiber inventory...</p>
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
          ) : (
            <>
              {/* ═══ OLTs TAB ═══ */}
              {activeTab==="olts" && (
                olts.length===0 ? (
                  <div style={{textAlign:"center",padding:50,background:t.card,borderRadius:12,border:`1px solid ${t.cardBorder}`}}>
                    <div style={{fontSize:48,marginBottom:12}}>🏛️</div>
                    <h3 style={{fontSize:18,color:t.text,marginBottom:6}}>No OLTs Configured</h3>
                    <p style={{color:t.textMuted,fontSize:13,marginBottom:20}}>Add your first OLT to start managing fiber devices.</p>
                    <Btn onClick={()=>{setEditingOlt(null);resetOltForm();setShowOltForm(true);}} variant="primary">+ Add OLT</Btn>
                  </div>
                ) : (
                  <div style={{background:t.card,border:`1px solid ${t.cardBorder}`,borderRadius:12,overflow:"hidden"}}>
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",minWidth:800}}>
                        <thead>
                          <tr style={{background:d?"var(--bg)":"#f1f5f9",borderBottom:`1px solid ${t.cardBorder}`}}>
                            {["OLT Name","Vendor / Model","Mgmt IP","Location","Ports","ONUs","Status","Actions"].map(h=>(
                              <th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:10,fontWeight:700,color:t.textMuted,textTransform:"uppercase"}}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {olts.map((olt,i)=>(
                            <tr key={olt.id} style={{borderBottom:`1px solid ${t.cardBorder}`,background:i%2===0?t.card:(d?"#121d30":"#ffffff")}}>
                              <td style={{padding:"10px 14px"}}>
                                <div style={{display:"flex",alignItems:"center",gap:7}}>
                                  <span style={{fontSize:16}}>🏛️</span>
                                  <div>
                                    <div style={{fontSize:12,fontWeight:600,color:t.text}}>{olt.name}</div>
                                    {(olt.vendor||olt.model) && <div style={{fontSize:10,color:t.textMuted}}>{[olt.vendor,olt.model].filter(Boolean).join(" / ")}</div>}
                                  </div>
                                </div>
                              </td>
                              <td style={{padding:"10px 14px",fontSize:11,color:t.textSub}}>{[olt.vendor,olt.model].filter(Boolean).join(" ")||"—"}</td>
                              <td style={{padding:"10px 14px"}}><code style={{fontSize:11,color:t.accent}}>{olt.mgmtIp||"—"}</code></td>
                              <td style={{padding:"10px 14px",fontSize:11,color:t.textMuted}}>{olt.location||"—"}</td>
                              <td style={{padding:"10px 14px",fontSize:13,fontWeight:700,color:t.accent,textAlign:"center"}}>{olt._count?.ports??"—"}</td>
                              <td style={{padding:"10px 14px",fontSize:13,fontWeight:700,color:t.purple,textAlign:"center"}}>{olt._count?.onus??"—"}</td>
                              <td style={{padding:"10px 14px",textAlign:"center"}}>
                                <Badge color={olt.isActive?"#4ade80":"#f87171"} bg={olt.isActive?"#14532d":"#450a0a"}>{olt.isActive?"Active":"Inactive"}</Badge>
                              </td>
                              <td style={{padding:"10px 14px"}}>
                                <div style={{display:"flex",gap:5}}>
                                  <Btn size="xs" variant="ghost" onClick={()=>loadTree(olt)} title="Topology tree"><SIcons.Network width={12} height={12}/></Btn>
                                  <Btn size="xs" variant="ghost" onClick={()=>openEditOlt(olt)} title="Edit"><SIcons.Edit width={12} height={12}/></Btn>
                                  <Btn size="xs" variant="danger" onClick={()=>handleDeleteOlt(olt.id)} title="Delete"><SIcons.Trash width={12} height={12}/></Btn>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{padding:"10px 14px",borderTop:`1px solid ${t.cardBorder}`,fontSize:10,color:t.textMuted}}>
                      Showing {olts.length} OLTs
                    </div>
                  </div>
                )
              )}

              {/* ═══ PORTS TAB ═══ */}
              {activeTab==="ports" && (
                ports.length===0 ? (
                  <div style={{textAlign:"center",padding:50,background:t.card,borderRadius:12,border:`1px solid ${t.cardBorder}`}}>
                    <div style={{fontSize:48,marginBottom:12}}>🔌</div>
                    <h3 style={{fontSize:18,color:t.text,marginBottom:6}}>No PON Ports</h3>
                    <p style={{color:t.textMuted,fontSize:13,marginBottom:20}}>Create PON ports on your OLTs to start connecting ONUs.</p>
                    <Btn onClick={()=>{setEditingPort(null);resetPortForm();setShowPortForm(true);}} variant="teal">+ New Port</Btn>
                  </div>
                ) : (
                  <div style={{background:t.card,border:`1px solid ${t.cardBorder}`,borderRadius:12,overflow:"hidden"}}>
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",minWidth:700}}>
                        <thead>
                          <tr style={{background:d?"var(--bg)":"#f1f5f9",borderBottom:`1px solid ${t.cardBorder}`}}>
                            {["Port Name","OLT","Slot / Port","Split Ratio","Splitter Location","ONUs","Actions"].map(h=>(
                              <th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:10,fontWeight:700,color:t.textMuted,textTransform:"uppercase"}}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {ports.map((p,i)=>(
                            <tr key={p.id} style={{borderBottom:`1px solid ${t.cardBorder}`,background:i%2===0?t.card:(d?"#121d30":"#ffffff")}}>
                              <td style={{padding:"10px 14px",fontWeight:600,fontSize:12,color:t.text}}>{p.portName}</td>
                              <td style={{padding:"10px 14px",fontSize:11,color:t.textSub}}>{p.olt?.name||`OLT #${p.oltId}`}</td>
                              <td style={{padding:"10px 14px",fontSize:11,color:t.textMuted}}>{[p.slot,p.port].filter(Boolean).join("/")||"—"}</td>
                              <td style={{padding:"10px 14px",fontSize:11,color:t.textSub}}>{p.splitRatio?`1:${p.splitRatio}`:"—"}</td>
                              <td style={{padding:"10px 14px",fontSize:11,color:t.textMuted}}>{p.splitterLocation||"—"}</td>
                              <td style={{padding:"10px 14px",fontSize:13,fontWeight:700,color:t.purple,textAlign:"center"}}>{p._count?.onus??"—"}</td>
                              <td style={{padding:"10px 14px"}}>
                                <div style={{display:"flex",gap:5}}>
                                  <Btn size="xs" variant="ghost" onClick={()=>openEditPort(p)} title="Edit"><SIcons.Edit width={12} height={12}/></Btn>
                                  <Btn size="xs" variant="danger" onClick={()=>handleDeletePort(p.id)} title="Delete"><SIcons.Trash width={12} height={12}/></Btn>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{padding:"10px 14px",borderTop:`1px solid ${t.cardBorder}`,fontSize:10,color:t.textMuted}}>
                      Showing {ports.length} PON ports
                    </div>
                  </div>
                )
              )}

              {/* ═══ ONUs TAB ═══ */}
              {activeTab==="onus" && (
                <div>
                  {/* Filters */}
                  <div style={{display:"flex",gap:10,marginBottom:12,flexWrap:"wrap",alignItems:"end"}}>
                    <div>
                      <label style={{display:"block",fontSize:10,fontWeight:600,color:t.textMuted,marginBottom:3}}>OLT</label>
                      <select value={onuFilter.oltId} onChange={e=>setOnuFilter(p=>({...p,oltId:e.target.value}))}
                        style={{padding:"6px 10px",border:`1px solid ${t.cardBorder}`,borderRadius:6,fontSize:11,background:t.card,color:t.text}}>
                        <option value="">All OLTs</option>
                        {olts.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{display:"block",fontSize:10,fontWeight:600,color:t.textMuted,marginBottom:3}}>Port</label>
                      <select value={onuFilter.portId} onChange={e=>setOnuFilter(p=>({...p,portId:e.target.value}))}
                        style={{padding:"6px 10px",border:`1px solid ${t.cardBorder}`,borderRadius:6,fontSize:11,background:t.card,color:t.text}}>
                        <option value="">All Ports</option>
                        {ports.filter(p=>!onuFilter.oltId||p.oltId===Number(onuFilter.oltId)).map(p=><option key={p.id} value={p.id}>{p.portName}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{display:"block",fontSize:10,fontWeight:600,color:t.textMuted,marginBottom:3}}>Status</label>
                      <select value={onuFilter.unassigned} onChange={e=>setOnuFilter(p=>({...p,unassigned:e.target.value}))}
                        style={{padding:"6px 10px",border:`1px solid ${t.cardBorder}`,borderRadius:6,fontSize:11,background:t.card,color:t.text}}>
                        <option value="">All ONUs</option>
                        <option value="true">Unassigned Only</option>
                        <option value="false">Assigned Only</option>
                      </select>
                    </div>
                    <Btn onClick={()=>loadOnus(1)} variant="primary" size="sm"><SIcons.Search width={12} height={12}/> Refresh</Btn>
                  </div>

                  {onus.length===0 ? (
                    <div style={{textAlign:"center",padding:50,background:t.card,borderRadius:12,border:`1px solid ${t.cardBorder}`}}>
                      <div style={{fontSize:48,marginBottom:12}}>📡</div>
                      <h3 style={{fontSize:18,color:t.text,marginBottom:6}}>No ONUs Found</h3>
                      <p style={{color:t.textMuted,fontSize:13}}>ONUs will appear here once they are added to your OLTs.</p>
                    </div>
                  ) : (
                    <div style={{background:t.card,border:`1px solid ${t.cardBorder}`,borderRadius:12,overflow:"hidden"}}>
                      <div style={{overflowX:"auto"}}>
                        <table style={{width:"100%",borderCollapse:"collapse",minWidth:1000}}>
                          <thead>
                            <tr style={{background:d?"var(--bg)":"#f1f5f9",borderBottom:`1px solid ${t.cardBorder}`}}>
                              {["Serial / MAC","Model","OLT","PON Port","Subscriber","Signal (Rx/Tx)","Status","Actions"].map(h=>(
                                <th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:10,fontWeight:700,color:t.textMuted,textTransform:"uppercase"}}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {onus.map((onu,i)=>(
                              <tr key={onu.id} style={{borderBottom:`1px solid ${t.cardBorder}`,background:i%2===0?t.card:(d?"#121d30":"#ffffff")}}>
                                <td style={{padding:"10px 14px"}}>
                                  <div>
                                    <div style={{fontSize:11,fontWeight:600,color:t.text,fontFamily:"monospace"}}>{onu.serialNumber||onu.macAddress||`ONU #${onu.id}`}</div>
                                    {onu.circuitId && <div style={{fontSize:10,color:t.textMuted}}>CID: {onu.circuitId}</div>}
                                  </div>
                                </td>
                                <td style={{padding:"10px 14px",fontSize:11,color:t.textSub}}>{onu.model||"—"}</td>
                                <td style={{padding:"10px 14px",fontSize:11,color:t.accent}}>{onu.olt?.name||`OLT #${onu.oltId}`}</td>
                                <td style={{padding:"10px 14px",fontSize:11,color:t.textMuted}}>{onu.ponPort?.portName||"—"}</td>
                                <td style={{padding:"10px 14px"}}>
                                  {onu.subscriber ? (
                                    <div>
                                      <div style={{fontSize:11,fontWeight:600,color:t.text}}>{onu.subscriber.fullName}</div>
                                      <div style={{fontSize:10,color:t.textMuted}}>{onu.subscriber.phone}</div>
                                    </div>
                                  ) : (
                                    <span style={{fontSize:10,color:t.amber,fontStyle:"italic"}}>Unassigned</span>
                                  )}
                                </td>
                                <td style={{padding:"10px 14px",fontSize:11,color:t.textMuted}}>
                                  {onu.rxPower!=null ? `${onu.rxPower}dBm` : "—"} / {onu.txPower!=null ? `${onu.txPower}dBm` : "—"}
                                </td>
                                <td style={{padding:"10px 14px"}}>
                                  <Badge color={onu.isActive?"#4ade80":"#f87171"} bg={onu.isActive?"#14532d":"#450a0a"}>{onu.isActive?"Active":"Inactive"}</Badge>
                                </td>
                                <td style={{padding:"10px 14px"}}>
                                  <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                                    {!onu.subscriberId && (
                                      <Btn size="xs" variant="success" onClick={()=>setShowAssignModal(onu)} title="Assign to subscriber"><SIcons.Key width={11} height={11}/> Assign</Btn>
                                    )}
                                    {onu.subscriberId && (
                                      <Btn size="xs" variant="warning" onClick={()=>handleUnassignOnu(onu.id)} title="Unassign"><SIcons.X width={11} height={11}/> Free</Btn>
                                    )}
                                    <Btn size="xs" variant="ghost" onClick={()=>loadProvisionCommands(onu)} title="Provision commands"><SIcons.Database width={11} height={11}/></Btn>
                                    <Btn size="xs" variant="danger" onClick={()=>handleDeleteOnu(onu.id)} title="Delete"><SIcons.Trash width={11} height={11}/></Btn>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div style={{padding:"10px 14px",borderTop:`1px solid ${t.cardBorder}`,display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,color:t.textMuted}}>
                        <span>Showing {onus.length} of {onuTotal} ONUs</span>
                        {onuPages>1 && (
                          <div style={{display:"flex",gap:4}}>
                            {Array.from({length:onuPages},(_,i)=>i+1).map(p=>(
                              <button key={p} onClick={()=>loadOnus(p)} style={{
                                padding:"3px 8px",borderRadius:4,border:"none",cursor:"pointer",fontSize:10,fontWeight:600,
                                background:p===onuPage?t.accent:"var(--border)",color:p===onuPage?"#fff":t.textSub,
                              }}>{p}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Footer */}
          <div style={{marginTop:24,paddingTop:16,borderTop:`1px solid ${t.cardBorder}`,fontSize:11,color:t.textMuted,textAlign:"center"}}>
            © {new Date().getFullYear()} <strong style={{color:t.accent}}>JointBox</strong> ISP CRM Platform. All rights reserved.
          </div>
        </div>
      </div>

      {/* ── OLT Form Modal ── */}
      {showOltForm && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>{setShowOltForm(false);setEditingOlt(null);}}>
          <div style={{background:t.card,borderRadius:16,padding:24,width:"90%",maxWidth:500}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <h2 style={{fontSize:18,fontWeight:700,color:t.text,margin:0}}>{editingOlt?"Edit OLT":"Add New OLT"}</h2>
              <button onClick={()=>{setShowOltForm(false);setEditingOlt(null);}} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:t.textSub}}>×</button>
            </div>
            <p style={{fontSize:11,color:t.textMuted,marginBottom:20}}>{editingOlt?"Update OLT details":"Register a new Optical Line Terminal in the network."}</p>
            <form onSubmit={editingOlt?handleUpdateOlt:handleCreateOlt}>
              <div style={{marginBottom:14}}>
                <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>OLT Name *</label>
                <input value={oltForm.name} onChange={e=>setOltForm(p=>({...p,name:e.target.value}))} required placeholder="e.g. HQ-MK-OLT-01" style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
                <div>
                  <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>Vendor</label>
                  <input value={oltForm.vendor} onChange={e=>setOltForm(p=>({...p,vendor:e.target.value}))} placeholder="e.g. Huawei" style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}/>
                </div>
                <div>
                  <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>Model</label>
                  <input value={oltForm.model} onChange={e=>setOltForm(p=>({...p,model:e.target.value}))} placeholder="e.g. MA5680T" style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}/>
                </div>
              </div>
              <div style={{marginBottom:14}}>
                <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>Management IP</label>
                <input value={oltForm.mgmtIp} onChange={e=>setOltForm(p=>({...p,mgmtIp:e.target.value}))} placeholder="10.0.0.1" style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}/>
              </div>
              <div style={{marginBottom:16}}>
                <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>Location</label>
                <input value={oltForm.location} onChange={e=>setOltForm(p=>({...p,location:e.target.value}))} placeholder="e.g. HQ Server Room" style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}/>
              </div>
              <div style={{display:"flex",gap:10}}>
                <button type="submit" style={{flex:1,background:t.accent,color:"#fff",border:"none",padding:"10px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer"}}>{editingOlt?"Update OLT":"Add OLT"}</button>
                <button type="button" onClick={()=>{setShowOltForm(false);setEditingOlt(null);}} style={{flex:1,background:"transparent",border:`1px solid ${t.cardBorder}`,color:t.textSub,padding:"10px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer"}}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Port Form Modal ── */}
      {showPortForm && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>{setShowPortForm(false);setEditingPort(null);}}>
          <div style={{background:t.card,borderRadius:16,padding:24,width:"90%",maxWidth:500}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <h2 style={{fontSize:18,fontWeight:700,color:t.text,margin:0}}>{editingPort?"Edit PON Port":"Add PON Port"}</h2>
              <button onClick={()=>{setShowPortForm(false);setEditingPort(null);}} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:t.textSub}}>×</button>
            </div>
            <p style={{fontSize:11,color:t.textMuted,marginBottom:20}}>{editingPort?"Update port details":"Create a new PON port on an OLT."}</p>
            <form onSubmit={editingPort?handleUpdatePort:handleCreatePort}>
              <div style={{marginBottom:14}}>
                <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>Port Name *</label>
                <input value={portForm.portName} onChange={e=>setPortForm(p=>({...p,portName:e.target.value}))} required placeholder="e.g. 0/1/1" style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}/>
              </div>
              {!editingPort && (
                <div style={{marginBottom:14}}>
                  <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>OLT *</label>
                  <select value={portForm.oltId} onChange={e=>setPortForm(p=>({...p,oltId:e.target.value}))} required style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}>
                    <option value="">Select OLT</option>
                    {olts.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </div>
              )}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
                <div>
                  <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>Slot</label>
                  <input value={portForm.slot} onChange={e=>setPortForm(p=>({...p,slot:e.target.value}))} placeholder="0" style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}/>
                </div>
                <div>
                  <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>Port</label>
                  <input value={portForm.port} onChange={e=>setPortForm(p=>({...p,port:e.target.value}))} placeholder="1" style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}/>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
                <div>
                  <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>Split Ratio</label>
                  <input type="number" value={portForm.splitRatio} onChange={e=>setPortForm(p=>({...p,splitRatio:e.target.value}))} placeholder="e.g. 64" style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}/>
                </div>
                <div>
                  <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>Splitter Location</label>
                  <input value={portForm.splitterLocation} onChange={e=>setPortForm(p=>({...p,splitterLocation:e.target.value}))} placeholder="e.g. BTS Tower" style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}/>
                </div>
              </div>
              <div style={{display:"flex",gap:10}}>
                <button type="submit" style={{flex:1,background:t.accent,color:"#fff",border:"none",padding:"10px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer"}}>{editingPort?"Update Port":"Add Port"}</button>
                <button type="button" onClick={()=>{setShowPortForm(false);setEditingPort(null);}} style={{flex:1,background:"transparent",border:`1px solid ${t.cardBorder}`,color:t.textSub,padding:"10px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer"}}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Assign ONU Modal ── */}
      {showAssignModal && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>{setShowAssignModal(null);setAssignSubId("");}}>
          <div style={{background:t.card,borderRadius:16,padding:24,width:"90%",maxWidth:450}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <h2 style={{fontSize:18,fontWeight:700,color:t.text,margin:0}}>🔗 Assign ONU</h2>
              <button onClick={()=>{setShowAssignModal(null);setAssignSubId("");}} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:t.textSub}}>×</button>
            </div>
            <p style={{fontSize:11,color:t.textMuted,marginBottom:16}}>Assign ONU <strong>{showAssignModal.serialNumber||`#${showAssignModal.id}`}</strong> to a subscriber.</p>
            <div style={{marginBottom:16}}>
              <label style={{display:"block",fontSize:11,fontWeight:600,color:t.textSub,marginBottom:5}}>Select Subscriber *</label>
              <select value={assignSubId} onChange={e=>setAssignSubId(e.target.value)} style={{width:"100%",padding:"8px 12px",border:`1px solid ${t.cardBorder}`,borderRadius:8,fontSize:12,background:t.card,color:t.text}}>
                <option value="">Choose subscriber...</option>
                {subscribers.map((s:any)=><option key={s.id} value={s.id}>{s.fullName} — {s.phone||s.username}</option>)}
              </select>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={handleAssignOnu} style={{flex:1,background:t.accent,color:"#fff",border:"none",padding:"10px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer"}}>Assign ONU</button>
              <button onClick={()=>{setShowAssignModal(null);setAssignSubId("");}} style={{flex:1,background:"transparent",border:`1px solid ${t.cardBorder}`,color:t.textSub,padding:"10px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── OLT Tree Modal ── */}
      {showTreeModal && oltTree && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>{setShowTreeModal(null);setOltTree(null);}}>
          <div style={{background:t.card,borderRadius:16,padding:24,width:"90%",maxWidth:700,maxHeight:"85vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <h2 style={{fontSize:18,fontWeight:700,color:t.text,margin:0}}>🌳 Topology Tree — {oltTree.olt.name}</h2>
              <button onClick={()=>{setShowTreeModal(null);setOltTree(null);}} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:t.textSub}}>×</button>
            </div>
            <div style={{marginBottom:16,padding:12,background:d?"var(--surface)":"#f8fafc",borderRadius:8,fontSize:11,color:t.textMuted}}>
              {[oltTree.olt.vendor,oltTree.olt.model].filter(Boolean).join(" ")} — {oltTree.olt.location||"No location"}
            </div>
            {oltTree.ports.length===0 ? (
              <div style={{textAlign:"center",padding:30,color:t.textMuted,fontSize:12}}>No ports configured on this OLT</div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {oltTree.ports.map(port=>(
                  <div key={port.id} style={{border:`1px solid ${t.cardBorder}`,borderRadius:10,overflow:"hidden"}}>
                    <div style={{padding:"10px 14px",background:d?"var(--surface)":"#f8fafc",borderBottom:`1px solid ${t.cardBorder}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontWeight:700,fontSize:12,color:t.text}}>🔌 {port.portName}</span>
                      <span style={{fontSize:10,color:t.textMuted}}>{port.splitRatio?`1:${port.splitRatio}`:""} {port.splitterLocation?`· ${port.splitterLocation}`:""} · {port.subscriberCount} subscriber{port.subscriberCount!==1?"s":""}</span>
                    </div>
                    {port.onus.length===0 ? (
                      <div style={{padding:"8px 14px",fontSize:11,color:t.textMuted,fontStyle:"italic"}}>No ONUs on this port</div>
                    ) : (
                      port.onus.map((onu,j)=>(
                        <div key={onu.id} style={{padding:"6px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",borderTop:`1px solid ${d?"#1a2535":"#f1f5f9"}`,background:j%2===0?"transparent":(d?"#0d1a2b":"#fafafa")}}>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{fontSize:10,color:t.textMuted}}>📡</span>
                            <code style={{fontSize:11,color:t.accent}}>{onu.serialNumber||onu.onuIndex||`#${onu.id}`}</code>
                          </div>
                          <span style={{fontSize:11,color:onu.subscriber?t.text:t.amber}}>
                            {onu.subscriber?onu.subscriber.fullName:"Unassigned"}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                ))}
              </div>
            )}
            <div style={{marginTop:16,display:"flex",gap:10}}>
              <button onClick={()=>{setShowTreeModal(null);setOltTree(null);}} style={{flex:1,background:t.accent,color:"#fff",border:"none",padding:"10px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer"}}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Provision Commands Modal ── */}
      {showProvisionModal && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>{setShowProvisionModal(null);setProvisionCommands([]);}}>
          <div style={{background:t.card,borderRadius:16,padding:24,width:"90%",maxWidth:600,maxHeight:"85vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <h2 style={{fontSize:18,fontWeight:700,color:t.text,margin:0}}>📋 Provisioning Commands</h2>
              <button onClick={()=>{setShowProvisionModal(null);setProvisionCommands([]);}} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:t.textSub}}>×</button>
            </div>
            <p style={{fontSize:11,color:t.textMuted,marginBottom:16}}>
              ONU: {showProvisionModal.serialNumber||showProvisionModal.macAddress||`#${showProvisionModal.id}`} — {showProvisionModal.olt?.name}
            </p>
            <div style={{background:"#0d1117",borderRadius:8,padding:12,fontFamily:"'JetBrains Mono','Fira Code',monospace",fontSize:11,lineHeight:1.6,color:"#7ee787",whiteSpace:"pre-wrap",wordBreak:"break-all"}}>
              {provisionCommands.length===0 ? "No commands generated for this ONU." : provisionCommands.join("\n")}
            </div>
            {provisionCommands.length>0 && (
              <button onClick={()=>{
                const text=provisionCommands.join("\n");
                // navigator.clipboard is undefined on plain HTTP (secure-context
                // only), so fall back to a hidden textarea + execCommand.
                const done=()=>alert("Commands copied!");
                if(navigator.clipboard?.writeText){navigator.clipboard.writeText(text).then(done).catch(()=>{});}
                else{try{const ta=document.createElement("textarea");ta.value=text;ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);done();}catch{alert("Copy not supported here — select the text manually.");}}
              }} style={{marginTop:12,padding:"8px 16px",background:t.accent,color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer"}}>
                📋 Copy All
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
