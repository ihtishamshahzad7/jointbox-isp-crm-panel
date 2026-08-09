"use client";

import { useEffect, useState } from "react";
import API_BASE from "../../components/api";

const API = API_BASE;

/**
 * Live connection path for one subscriber:
 *   PPPoE → NAS → (OLT/PON if fibre) → ONT, with the latest optical signals,
 * a 24h dBm chart, and the last events. Data comes from /telemetry.
 */
export default function LinkPath({ subscriberId }: { subscriberId: number }) {
  const [data, setData] = useState<any>(null);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  useEffect(() => {
    const load = () =>
      fetch(`${API}/telemetry/subscriber/${subscriberId}/path`, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null)).then((d) => d && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [subscriberId]);

  if (!data || !data.found) return null;

  const sigColor = (s?: string) => (s === "CRITICAL" ? "#ef4444" : s === "WEAK" ? "#f59e0b" : "#22c55e");
  const rx = (data.signals || []).find((s: any) => s.kind === "ONT_RX" || s.kind === "SFP_RX");
  const series: any[] = data.signalSeries || [];
  const dbms = series.map((s) => s.dbm);
  const lo = Math.min(-35, ...dbms), hi = Math.max(-5, ...dbms);
  const span = Math.max(1, hi - lo);

  const box: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginTop: 14 };
  const hop: React.CSSProperties = { padding: "6px 10px", borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--border)", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" };
  const arrow = <span style={{ color: "var(--muted)" }}>→</span>;

  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>📡 Live connection path</span>
        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: data.online ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)", color: data.online ? "#22c55e" : "#ef4444", fontWeight: 700 }}>
          {data.online ? "ONLINE" : "OFFLINE"}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={hop}>PPPoE</span>{arrow}
        <span style={hop}>{data.nas?.nasname || "NAS"}</span>
        {data.nas?.deviceType?.startsWith("OLT") && (<>{arrow}<span style={hop}>{data.nas.deviceType.replace("OLT_", "OLT ")}</span></>)}
        {rx && (<>{arrow}<span style={{ ...hop, color: sigColor(rx.status) }}>{rx.port || "ONT"} {rx.dbm?.toFixed(1)}dBm</span></>)}
      </div>

      <div style={{ display: "flex", gap: 18, marginTop: 12, fontSize: 12, color: "var(--muted)", flexWrap: "wrap" }}>
        {data.session?.sessionTime != null && <span>⏱️ {Math.floor(data.session.sessionTime / 3600)}h {Math.floor((data.session.sessionTime % 3600) / 60)}m</span>}
        {data.session?.framedIp && <span>IP: <b style={{ color: "var(--text)" }}>{data.session.framedIp}</b></span>}
        {data.session?.callerId && <span>MAC: <b style={{ color: "var(--text)" }}>{data.session.callerId}</b></span>}
      </div>

      {series.length > 1 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Signal history · 24h (dBm)</div>
          <svg viewBox={`0 0 ${Math.max(series.length * 6, 60)} 60`} preserveAspectRatio="none" style={{ width: "100%", height: 60, background: "var(--surface-2)", borderRadius: 8 }}>
            <polyline fill="none" stroke="#38bdf8" strokeWidth="1.2"
              points={series.map((s, i) => `${i * 6},${60 - ((s.dbm - lo) / span) * 56 - 2}`).join(" ")} />
          </svg>
        </div>
      )}

      {data.events?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Last events</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {data.events.map((e: any) => (
              <div key={e.id} style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--muted)" }}>
                <span>{new Date(e.loggedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                <span style={{ color: e.severity === "critical" ? "#ef4444" : e.severity === "warning" ? "#f59e0b" : "#22c55e" }}>●</span>
                <span style={{ color: "var(--text)" }}>{e.message || e.eventType}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
