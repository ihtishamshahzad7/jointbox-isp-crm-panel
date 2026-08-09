"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Icons as SIcons } from "../components/icons";
import API_BASE from "../components/api";

interface GatewayTransaction {
  id: number; gateway: string; invoiceId: number; subscriberId: number;
  amount: number; currency: string; status: string;
  gatewayRef: string | null; idempotencyKey: string; createdAt: string; updatedAt: string;
  invoice?: { invoiceNo: string };
  subscriber?: { fullName: string };
}

const API = API_BASE;
const Ic = { ...SIcons };

const GATEWAY_INFO: Record<string, { label: string; icon: string; color: string }> = {
  SANDBOX:    { label: "Sandbox (Test)",   icon: "🧪", color: "#f59e0b" },
  STRIPE:     { label: "Stripe",           icon: "💳", color: "#6366f1" },
  BKASH:      { label: "bKash",            icon: "📱", color: "#e2136e" },
  SSLCOMMERZ: { label: "SSLCommerz",       icon: "🔒", color: "#ed6a20" },
  JAZZCASH:   { label: "JazzCash",         icon: "📱", color: "#e0004d" },
  EASYPAISA:  { label: "Easypaisa",        icon: "💚", color: "#10b981" },
};

export default function GatewaysPage() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [availableGateways, setAvailableGateways] = useState<string[]>([]);
  const [transactions, setTransactions] = useState<GatewayTransaction[]>([]);
  const [reconcileResult, setReconcileResult] = useState<any>(null);
  const [showReconcileModal, setShowReconcileModal] = useState(false);
  const [activeTab, setActiveTab] = useState<"gateways"|"transactions">("gateways");

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
    loadData();
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [availRes, txRes] = await Promise.all([
        fetch(`${API}/gateway/available`,{headers}),
        fetch(`${API}/gateway/transactions`,{headers}),
      ]);
      if (availRes.ok) {
        const d = await availRes.json();
        setAvailableGateways(Array.isArray(d)?d:d.gateways||d.data||[]);
      }
      if (txRes.ok) {
        const d = await txRes.json();
        setTransactions(Array.isArray(d)?d:d.data||d.items||[]);
      }
    } catch {}
    setLoading(false);
  }, []);

  const handleReconcile = async () => {
    try {
      const res = await fetch(`${API}/gateway/reconcile`,{headers});
      if (res.ok) {
        const d = await res.json();
        setReconcileResult(d);
        setShowReconcileModal(true);
      } else alert("Reconcile failed");
    } catch { alert("Network error"); }
  };

  const statCards = [
    { label: "Available Gateways", value: availableGateways.length, sub: "payment providers configured", icon: "💳", bg: "linear-gradient(135deg,#6366f1,#4f46e5)" },
    { label: "Total Transactions", value: transactions.length, sub: "all gateway payments", icon: "🔄", bg: "linear-gradient(135deg,#0ea5e9,#0284c7)" },
    { label: "Pending/Initiated", value: transactions.filter(t=>t.status==="INITIATED").length, sub: "awaiting completion", icon: "⏳", bg: "linear-gradient(135deg,#f59e0b,#d97706)" },
    { label: "Successful", value: transactions.filter(t=>t.status==="SUCCESS").length, sub: "completed payments", icon: "✅", bg: "linear-gradient(135deg,#10b981,#059669)" },
  ];

  const statusBadge = (status: string) => {
    const m: Record<string,{color:string;bg:string;label:string}> = {
      INITIATED: {color:"#fbbf24",bg:"#422006",label:"Initiated"},
      SUCCESS:   {color:"#4ade80",bg:"#14532d",label:"Success"},
      FAILED:    {color:"#f87171",bg:"#450a0a",label:"Failed"},
      CANCELLED: {color:"var(--muted)",bg:"var(--border)",label:"Cancelled"},
    };
    const s = m[status]||{color:"var(--muted)",bg:"var(--border)",label:status};
    return <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,color:s.color,background:s.bg,letterSpacing:"0.04em"}}>{s.label}</span>;
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

  return (
    <div style={{display:"flex",minHeight:"100vh",background:t.bg,color:t.text,fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif",fontSize:13}}>
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
        <div style={{flex:1,padding:"16px 20px",overflowY:"auto"}}>

          {/* ── Header ── */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
            <div>
              <h1 style={{fontSize:20,fontWeight:800,margin:0,letterSpacing:"-0.02em"}}>Payment Gateways</h1>
              <p style={{fontSize:11,color:t.textMuted,margin:"4px 0 0"}}>Configured providers: {availableGateways.join(", ") || "None configured"}</p>
            </div>
            <Btn onClick={handleReconcile} variant="warning"><Ic.Database width={14} height={14}/> Reconcile</Btn>
          </div>

          {/* ── Stat Cards ── */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:16}}>
            {statCards.map((c,i)=>(
              <div key={i} style={{background:t.card,border:`1px solid ${t.cardBorder}`,borderRadius:10,padding:"12px 14px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div style={{width:32,height:32,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",background:c.bg,fontSize:16}}>{c.icon}</div>
                </div>
                <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",color:t.textMuted,marginBottom:2}}>{c.label}</div>
                <div style={{fontSize:20,fontWeight:800,color:t.text}}>{c.value}</div>
                <div style={{fontSize:10,color:t.textMuted,marginTop:2}}>{c.sub}</div>
              </div>
            ))}
          </div>

          {/* ── Tab Bar ── */}
          <div style={{display:"flex",gap:4,marginBottom:12,borderBottom:`1px solid ${t.cardBorder}`,paddingBottom:0}}>
            {([{id:"gateways",label:"Gateways"},{id:"transactions",label:"Transactions"}]).map(tab=>(
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
              <p style={{color:t.textMuted,fontSize:13}}>Loading gateway data...</p>
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
          ) : (
            <>
              {/* ═══ GATEWAYS TAB ═══ */}
              {activeTab==="gateways" && (
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
                  {Object.entries(GATEWAY_INFO).map(([key,info])=>{
                    const enabled = availableGateways.includes(key);
                    return (
                      <div key={key} style={{
                        background:t.card,border:`1px solid ${enabled?info.color:t.cardBorder}`,
                        borderRadius:12,padding:"16px 18px",
                        borderLeft:enabled?`4px solid ${info.color}`:`1px solid ${t.cardBorder}`,
                        opacity:enabled?1:.5,transition:"all .15s",
                      }}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                          <span style={{fontSize:28}}>{info.icon}</span>
                          <span style={{
                            padding:"3px 10px",borderRadius:20,fontSize:10,fontWeight:700,
                            background:enabled?"#14532d":"var(--border)",color:enabled?"#4ade80":t.textMuted,
                          }}>
                            {enabled?"Connected":"Not Configured"}
                          </span>
                        </div>
                        <div style={{fontSize:14,fontWeight:700,color:t.text,marginBottom:4}}>{info.label}</div>
                        <div style={{fontSize:11,color:t.textMuted}}>
                          {enabled
                            ? "This gateway is active and ready to accept payments."
                            : "Add API credentials in your .env file to enable this gateway."}
                        </div>
                        {enabled && (
                          <div style={{marginTop:12,padding:"8px 12px",background:"var(--surface-2)",borderRadius:8,fontSize:10,color:t.textMuted,fontFamily:"monospace"}}>
                            ✓ {key}_* environment variables detected
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ═══ TRANSACTIONS TAB ═══ */}
              {activeTab==="transactions" && (
                transactions.length===0 ? (
                  <div style={{textAlign:"center",padding:50,background:t.card,borderRadius:12,border:`1px solid ${t.cardBorder}`}}>
                    <div style={{fontSize:48,marginBottom:12}}>🔄</div>
                    <h3 style={{fontSize:18,color:t.text,marginBottom:6}}>No Gateway Transactions</h3>
                    <p style={{color:t.textMuted,fontSize:13}}>Transactions will appear here when subscribers pay via online gateways.</p>
                  </div>
                ) : (
                  <div style={{background:t.card,border:`1px solid ${t.cardBorder}`,borderRadius:12,overflow:"hidden"}}>
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",minWidth:900}}>
                        <thead>
                          <tr style={{background:d?"var(--bg)":"#f1f5f9",borderBottom:`1px solid ${t.cardBorder}`}}>
                            {["Gateway","Transaction / Ref","Invoice","Subscriber","Amount","Status","Date"].map(h=>(
                              <th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:10,fontWeight:700,color:t.textMuted,textTransform:"uppercase"}}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {transactions.map((tx,i)=>(
                            <tr key={tx.id} style={{borderBottom:`1px solid ${t.cardBorder}`,background:i%2===0?t.card:(d?"#121d30":"#ffffff")}}>
                              <td style={{padding:"10px 14px"}}>
                                <div style={{display:"flex",alignItems:"center",gap:6}}>
                                  <span style={{fontSize:16}}>{GATEWAY_INFO[tx.gateway]?.icon||"💳"}</span>
                                  <span style={{fontSize:11,fontWeight:600,color:t.text}}>{GATEWAY_INFO[tx.gateway]?.label||tx.gateway}</span>
                                </div>
                              </td>
                              <td style={{padding:"10px 14px"}}>
                                <code style={{fontSize:10,color:t.textMuted}}>{tx.idempotencyKey?.slice(0,16)||`#${tx.id}`}</code>
                                {tx.gatewayRef && <div style={{fontSize:9,color:t.textMuted}}>ref: {tx.gatewayRef}</div>}
                              </td>
                              <td style={{padding:"10px 14px",fontSize:11,color:t.accent,fontFamily:"monospace"}}>{tx.invoice?.invoiceNo||`#${tx.invoiceId}`}</td>
                              <td style={{padding:"10px 14px",fontSize:11,color:t.text}}>{tx.subscriber?.fullName||`#${tx.subscriberId}`}</td>
                              <td style={{padding:"10px 14px",fontSize:12,fontWeight:700,color:t.green}}>{tx.currency} {tx.amount.toLocaleString()}</td>
                              <td style={{padding:"10px 14px"}}>{statusBadge(tx.status)}</td>
                              <td style={{padding:"10px 14px",fontSize:10,color:t.textMuted}}>{new Date(tx.createdAt).toLocaleDateString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{padding:"10px 14px",borderTop:`1px solid ${t.cardBorder}`,fontSize:10,color:t.textMuted}}>
                      Showing {transactions.length} transactions
                    </div>
                  </div>
                )
              )}
            </>
          )}

          {/* Footer */}
          <div style={{marginTop:24,paddingTop:16,borderTop:`1px solid ${t.cardBorder}`,fontSize:11,color:t.textMuted,textAlign:"center"}}>
            © {new Date().getFullYear()} <strong style={{color:t.accent}}>JointBox</strong> ISP CRM Platform. All rights reserved.
          </div>
        </div>
      </div>

      {/* ── Reconcile Modal ── */}
      {showReconcileModal && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>{setShowReconcileModal(false);setReconcileResult(null);}}>
          <div style={{background:t.card,borderRadius:16,padding:24,width:"90%",maxWidth:500}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <h2 style={{fontSize:18,fontWeight:700,color:t.text,margin:0}}>🔄 Reconciliation Result</h2>
              <button onClick={()=>{setShowReconcileModal(false);setReconcileResult(null);}} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:t.textSub}}>×</button>
            </div>
            {Array.isArray(reconcileResult) && reconcileResult.length>0 ? (
              <div>
                <p style={{fontSize:12,color:t.amber,marginBottom:12}}>Found {reconcileResult.length} successful transactions without matching payments:</p>
                {reconcileResult.map((r:any,i:number)=>(
                  <div key={i} style={{padding:"8px 12px",background:"var(--surface-2)",borderRadius:8,marginBottom:6,fontSize:11,display:"flex",justifyContent:"space-between"}}>
                    <span style={{color:t.text}}>{r.gateway} — {r.idempotencyKey?.slice(0,12)}</span>
                    <span style={{color:t.green,fontWeight:700}}>+{r.amount}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{textAlign:"center",padding:20}}>
                <div style={{fontSize:40,marginBottom:10}}>✅</div>
                <p style={{fontSize:13,color:t.green,fontWeight:600}}>All transactions are reconciled — no unmatched payments found.</p>
              </div>
            )}
            <button onClick={()=>{setShowReconcileModal(false);setReconcileResult(null);}} style={{marginTop:16,width:"100%",background:t.accent,color:"#fff",border:"none",padding:"10px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer"}}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
