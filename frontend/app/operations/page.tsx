"use client";

import React from "react";
import { useRouter } from "next/navigation";
import API from "../components/api";

/**
 * Operations — the ISP owner's single "what needs my attention now" screen:
 * live alerts, NAS/router health, active outages and the numbers that matter,
 * all in one place with jump-offs to act.
 */
export default function OperationsPage() {
  const router = useRouter();
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { Authorization: `Bearer ${token}` };

  const [nas, setNas] = React.useState<any[]>([]);
  const [alerts, setAlerts] = React.useState<any[]>([]);
  const [outages, setOutages] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    const g = (p: string) => fetch(`${API}${p}`, { headers }).then((r) => r.ok ? r.json() : null).catch(() => null);
    const [h, a, o] = await Promise.all([g("/telemetry/nas-health"), g("/telemetry/ops-alerts"), g("/outages/status")]);
    setNas(h?.nas || []);
    setAlerts(Array.isArray(a) ? a : []);
    setOutages(Array.isArray(o) ? o : []);
    setLoading(false);
  }, [token]);

  React.useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load(); const t = setInterval(load, 30000); return () => clearInterval(t);
  }, [token, load]);

  const bps = (v: number) => { const u = ["bps","Kbps","Mbps","Gbps"]; let i=0,x=v||0; while(x>=1000&&i<3){x/=1000;i++;} return `${x.toFixed(x<10?1:0)} ${u[i]}`; };
  const nasDown = nas.filter((n) => !n.reporting);
  const totalOnline = nas.reduce((a, n) => a + (n.online || 0), 0);
  const problemAreas = outages.filter((o: any) => /Mass outage|Elevated/i.test(o.verdict || ""));

  const ago = (d: string) => {
    const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
    return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m/60)}h ago` : `${Math.floor(m/1440)}d ago`;
  };

  return (
    <div className="op">
      <style>{CSS}</style>
      <div className="op-head">
        <div><h1>Operations</h1><span>Live network status &amp; what needs attention · refreshes every 30s</span></div>
        <button onClick={load}>↻</button>
      </div>

      {/* Top metrics */}
      <div className="op-metrics">
        <M label="Online now" value={totalOnline.toLocaleString()} tone="ok" />
        <M label="NAS reporting" value={`${nas.length - nasDown.length}/${nas.length}`} tone={nasDown.length ? "bad" : "ok"} onClick={() => router.push("/network-center?tab=noc")} />
        <M label="Active outages" value={String(outages.filter((o:any)=>o.outageId).length)} tone={outages.some((o:any)=>o.outageId) ? "bad" : "ok"} onClick={() => router.push("/network-center?tab=outages")} />
        <M label="Problem areas" value={String(problemAreas.length)} tone={problemAreas.length ? "warn" : "ok"} onClick={() => router.push("/network-center?tab=noc")} />
        <M label="Open alerts" value={String(alerts.length)} tone={alerts.length ? "warn" : "ok"} />
      </div>

      {loading ? <div className="op-load">Loading…</div> : (
        <div className="op-cols">
          {/* Alerts */}
          <div className="op-panel">
            <div className="op-t">⚠ Alerts</div>
            {alerts.length === 0 ? <div className="op-empty">No alerts. All quiet.</div> : alerts.map((a) => (
              <div key={a.id} className={`op-alert lv-${(a.level||"WARN").toLowerCase()}`}>
                <div className="al-top"><span className="al-src">{a.source || "system"}</span><span className="al-ago">{ago(a.createdAt)}</span></div>
                <div className="al-msg">{a.message}</div>
              </div>
            ))}
          </div>

          {/* NAS health + outages */}
          <div className="op-panel">
            <div className="op-t">📡 NAS not reporting</div>
            {nasDown.length === 0 ? <div className="op-empty">Every router is reporting.</div> : nasDown.map((n) => (
              <button key={n.id} className="op-nas bad" onClick={() => router.push("/network-center?tab=nas")}>
                <span className="dn" /> <b>{n.name}</b> <span className="ip">{n.ip}</span>
              </button>
            ))}
            <div className="op-t" style={{ marginTop: 14 }}>🟢 Busiest routers</div>
            {[...nas].filter((n)=>n.reporting).sort((a,b)=>b.online-a.online).slice(0,6).map((n) => (
              <button key={n.id} className="op-nas" onClick={() => router.push("/network-center?tab=nas")}>
                <span className="up" /> <b>{n.name}</b>
                <span className="thr">{n.online} on · ↓{bps(n.inBps)} ↑{bps(n.outBps)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="op-jump">
        <button onClick={() => router.push("/network-center?tab=noc")}>Open NOC</button>
        <button onClick={() => router.push("/network-center?tab=outages")}>Manage outages</button>
        <button onClick={() => router.push("/network-center?tab=nas")}>NAS / Routers</button>
        <button onClick={() => router.push("/logs")}>Full logs</button>
      </div>
    </div>
  );
}

function M({ label, value, tone, onClick }: any) {
  return (
    <button className={`op-m t-${tone} ${onClick ? "clk" : ""}`} onClick={onClick}>
      <div className="ml">{label}</div><div className="mv">{value}</div>
    </button>
  );
}

const CSS = `
.op{padding:20px;max-width:1120px;margin:0 auto;color:var(--text)}
.op-head{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.op-head h1{font-size:22px;font-weight:800;margin:0}
.op-head span{font-size:12px;color:var(--muted)}
.op-head button{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:8px 12px;cursor:pointer;font-size:14px}
.op-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.op-m{text-align:left;background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--border);border-radius:12px;padding:13px 15px;font-family:inherit}
.op-m.clk{cursor:pointer}.op-m.clk:hover{border-color:var(--accent)}
.op-m .ml{font-size:11.5px;color:var(--muted)}
.op-m .mv{font-size:26px;font-weight:800;margin-top:3px}
.op-m.t-ok{border-left-color:#4ade80}.op-m.t-warn{border-left-color:#f59e0b}.op-m.t-bad{border-left-color:#ef4444}
.op-load{padding:40px;text-align:center;color:var(--muted)}
.op-cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:800px){.op-cols{grid-template-columns:1fr}}
.op-panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.op-t{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:10px}
.op-empty{font-size:12px;color:var(--muted);padding:8px 0}
.op-alert{border-left:3px solid var(--border);padding:7px 10px;margin-bottom:7px;background:var(--surface-2);border-radius:6px}
.op-alert.lv-error,.op-alert.lv-critical{border-left-color:#ef4444}
.op-alert.lv-warn{border-left-color:#f59e0b}
.al-top{display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted)}
.al-src{font-family:ui-monospace,monospace;color:#7cc0ff}
.al-msg{font-size:12px;margin-top:3px;color:var(--text)}
.op-nas{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:8px 11px;margin-bottom:6px;font-size:12.5px;cursor:pointer;color:var(--text);font-family:inherit}
.op-nas.bad{border-color:#7f1d1d}
.op-nas .up{width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px #4ade80}
.op-nas .dn{width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 6px #ef4444}
.op-nas .ip{color:var(--muted);font-size:11px}
.op-nas .thr{margin-left:auto;color:var(--muted);font-size:11px}
.op-jump{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.op-jump button{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:9px 14px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
.op-jump button:hover{border-color:var(--accent);color:var(--accent)}
`;
