"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

const verdictColor = (v: string) =>
  /Mass outage/i.test(v) ? "#ef4444" : /Elevated/i.test(v) ? "#f59e0b" : /Load-shedding/i.test(v) ? "#8b5cf6" : "#22c55e";

const card: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 16 };
const fdate = (d: string) => new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export default function NocPage() {
  const router = useRouter();
  const [status, setStatus] = useState<any[]>([]);
  const [uptime, setUptime] = useState<any>(null);
  const [outages, setOutages] = useState<any[]>([]);
  const [days, setDays] = useState(30);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    if (!token) { router.push("/login"); return; }
    try {
      const [s, u, o] = await Promise.all([
        fetch(`${API}/outages/status`, { headers }).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API}/outages/uptime?days=${days}`, { headers }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API}/outages?limit=40`, { headers }).then((r) => (r.ok ? r.json() : [])),
      ]);
      setStatus(Array.isArray(s) ? s : []);
      setUptime(u);
      setOutages(Array.isArray(o) ? o : (o?.data ?? []));
    } catch { /* keep last view */ }
  }, [token, days]);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  const totals = status.reduce((a, s) => ({ total: a.total + s.total, online: a.online + s.online }), { total: 0, online: 0 });
  const problemAreas = status.filter((s) => /Mass outage|Elevated/i.test(s.verdict)).length;

  const metric = (label: string, value: string, color?: string) => (
    <div style={card}>
      <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, marginTop: 4, color: color || "var(--text)" }}>{value}</div>
    </div>
  );

  return (
    <div style={{ padding: 20, color: "var(--text)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Network Operations Center</h1>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Live segment health, uptime and outage timeline · auto-refreshes every 30s</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)}
              style={{ background: days === d ? "#0ea5e9" : "var(--surface)", color: days === d ? "#fff" : "var(--muted)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* SLA + live totals */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 18 }}>
        {metric("Online now", `${totals.online}/${totals.total}`, "#22c55e")}
        {metric("Problem areas", String(problemAreas), problemAreas ? "#ef4444" : "#22c55e")}
        {uptime && metric("ISP uptime", `${uptime.ispUptimePercent}%`, uptime.ispUptimePercent >= 99 ? "#22c55e" : "#f59e0b")}
        {uptime && metric("Customer-experienced", `${uptime.customerExperiencedUptimePercent}%`)}
        {uptime && metric("Network downtime", `${uptime.networkMinutes} min`, uptime.networkMinutes ? "#ef4444" : "#22c55e")}
      </div>

      {/* Segment health */}
      <div style={{ ...card, marginBottom: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Segment health by area</div>
        {!status.length && <div style={{ color: "var(--muted)", fontSize: 13 }}>All areas nominal, or no active subscribers with sessions.</div>}
        {status.map((s) => (
          <div key={s.areaId} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 90px 1fr", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
            <div>
              <div style={{ fontWeight: 600 }}>{s.name}{s.city ? <span style={{ color: "var(--muted)" }}> · {s.city}</span> : null}</div>
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{s.online}/{s.total} online</div>
            <div style={{ background: "var(--surface-2)", borderRadius: 6, height: 8, overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, s.offlinePercent)}%`, height: 8, background: verdictColor(s.verdict) }} />
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: verdictColor(s.verdict), textAlign: "right" }}>
              {s.offlinePercent}% off · {s.verdict}
            </div>
          </div>
        ))}
      </div>

      {/* Outage timeline */}
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Outage timeline (last {days} days)</div>
        {!outages.length && <div style={{ color: "var(--muted)", fontSize: 13 }}>No outages recorded in this period.</div>}
        {outages.map((o: any) => (
          <div key={o.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 13, flexWrap: "wrap" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: o.endedAt ? "#22c55e" : "#ef4444", flexShrink: 0 }} />
            <span style={{ minWidth: 150 }}>{o.area?.name || o.areaName || `Area #${o.areaId}`}</span>
            <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "rgba(139,92,246,.15)", color: "#a78bfa" }}>{o.type}</span>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{fdate(o.startedAt)}{o.endedAt ? ` → ${fdate(o.endedAt)}` : " → ongoing"}</span>
            {o.affected != null && <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>{o.affected} affected</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
