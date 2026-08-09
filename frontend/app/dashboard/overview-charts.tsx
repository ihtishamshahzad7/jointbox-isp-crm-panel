"use client";

import { useEffect, useState } from "react";
import API_BASE from "../components/api";

const API =
  API_BASE;

/** A single progress ring ("goal circle"). */
function Ring({ value, total, color, label, sub }: { value: number; total: number; color: string; label: string; sub?: string }) {
  const R = 34, C = 2 * Math.PI * R;
  const pct = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <svg width="88" height="88" viewBox="0 0 88 88">
        <circle cx="44" cy="44" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="9" />
        <circle cx="44" cy="44" r={R} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={`${C * pct} ${C}`} transform="rotate(-90 44 44)"
          style={{ transition: "stroke-dasharray .7s ease" }} />
        <text x="44" y="41" textAnchor="middle" style={{ fontSize: 19, fontWeight: 800, fill: "var(--text)" }}>{value}</text>
        <text x="44" y="57" textAnchor="middle" style={{ fontSize: 10, fill: "var(--muted)" }}>
          {total > 0 ? `${Math.round(pct * 100)}%` : "—"}
        </text>
      </svg>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{label}</div>
        {sub && <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{sub}</div>}
      </div>
    </div>
  );
}

/** SVG donut pie for the status split. */
function Pie({ data }: { data: Array<{ label: string; value: number; color: string }> }) {
  const R = 52, C = 2 * Math.PI * R;
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  let offset = 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="18" />
        {data.map((d, i) => {
          const len = (d.value / total) * C;
          const rot = (offset / C) * 360 - 90;
          offset += len;
          return (
            <circle key={i} cx="70" cy="70" r={R} fill="none" stroke={d.color} strokeWidth="18"
              strokeDasharray={`${len} ${C - len}`} transform={`rotate(${rot} 70 70)`}
              style={{ transition: "stroke-dasharray .7s ease" }} />
          );
        })}
        <text x="70" y="66" textAnchor="middle" style={{ fontSize: 26, fontWeight: 800, fill: "var(--text)" }}>{total}</text>
        <text x="70" y="84" textAnchor="middle" style={{ fontSize: 11, fill: "var(--muted)" }}>subscribers</text>
      </svg>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, minWidth: 150 }}>
        {data.map((d) => (
          <li key={d.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: d.color }} />
            <span style={{ color: "var(--text)", flex: 1 }}>{d.label}</span>
            <b style={{ color: "var(--text)" }}>{d.value}</b>
            <span style={{ color: "var(--muted)", width: 38, textAlign: "right" }}>{Math.round((d.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function OverviewCharts({ refreshKey = 0 }: { refreshKey?: number }) {
  const [d, setD] = useState<any>(null);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  useEffect(() => {
    fetch(`${API}/segments/command`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null)).then((j) => j && setD(j)).catch(() => {});
  }, [refreshKey]);

  if (!d) return null;
  const t = d.totals || {};
  const tiers = d.tiers || {};
  const card: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 16 };

  const pie = [
    { label: "Active", value: t.active || 0, color: "#10b981" },
    { label: "Expired", value: t.expired || 0, color: "#ef4444" },
    { label: "Suspended", value: t.suspended || 0, color: "#f59e0b" },
    { label: "Inactive", value: t.inactive || 0, color: "#64748b" },
  ].filter((x) => x.value > 0);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(280px,1fr) minmax(320px,1.3fr)", gap: 12 }}>
      <div style={card}>
        <div style={{ fontWeight: 800, marginBottom: 12 }}>Subscriber status</div>
        {pie.length ? <Pie data={pie} /> : <div style={{ fontSize: 12, color: "var(--muted)" }}>No subscribers yet.</div>}
      </div>

      <div style={card}>
        <div style={{ fontWeight: 800, marginBottom: 12 }}>At a glance</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(96px,1fr))", gap: 14 }}>
          <Ring value={t.active || 0} total={t.subscribers || 0} color="#10b981" label="Active" sub={`of ${t.subscribers || 0}`} />
          <Ring value={t.online || 0} total={t.active || 0} color="#38bdf8" label="Online" sub="of active" />
          <Ring value={t.offline || 0} total={t.subscribers || 0} color="#f97316" label="Offline" sub="of total" />
          <Ring value={t.expired || 0} total={t.subscribers || 0} color="#ef4444" label="Expired" />
          <Ring value={t.inactive || 0} total={t.subscribers || 0} color="#64748b" label="Inactive" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginTop: 16 }}>
          {[
            { label: "Total base", value: t.subscribers || 0, color: "#8b5cf6" },
            { label: "Franchise", value: tiers.franchise || 0, color: "#6366f1" },
            { label: "Dealer", value: tiers.dealer || 0, color: "#0ea5e9" },
            { label: "Sub-dealer", value: tiers.subDealer || 0, color: "#14b8a6" },
          ].map((x) => (
            <div key={x.label} style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: x.color, lineHeight: 1 }}>{x.value}</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{x.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
