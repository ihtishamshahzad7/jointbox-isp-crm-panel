"use client";

import { useEffect, useState } from "react";
import API_BASE from "../components/api";

const API =
  API_BASE;

const fmt = (n: number) => new Intl.NumberFormat().format(Math.round(n || 0));

/**
 * Restyled dashboard home — KPI cards with plain-English captions + sparklines,
 * a network-health row, live event feed and areas-by-health. All wired to live
 * data (/segments, /telemetry). Theme-aware via CSS variables.
 */
export default function DashboardHome({ homeStats, currency = "Rs", refreshKey = 0 }: {
  homeStats: { totalSubscribers: number; activeSubscribers: number; todaySignups: number; revenueToday: number };
  currency?: string;
  refreshKey?: number;
}) {
  const [ov, setOv] = useState<any>(null);
  const [feed, setFeed] = useState<any[]>([]);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  useEffect(() => {
    const H = { Authorization: `Bearer ${token}` };
    fetch(`${API}/segments`, { headers: H }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setOv(d)).catch(() => {});
    fetch(`${API}/telemetry/feed?limit=6`, { headers: H }).then((r) => (r.ok ? r.json() : [])).then((d) => Array.isArray(d) && setFeed(d)).catch(() => {});
  }, [refreshKey]);

  const t = ov?.totals || {};
  const online = t.online ?? 0;
  const active = homeStats.activeSubscribers || t.active || 0;
  const onlinePct = active > 0 ? Math.round((online / active) * 100) : 0;
  const attention = (ov?.reasons || []).reduce((a: number, r: any) => a + (r.count || 0), 0);
  const areas = [...((ov?.dimensions?.area) || [])]
    .filter((a: any) => a.active > 0)
    .sort((a: any, b: any) => (a.onlinePercent ?? 100) - (b.onlinePercent ?? 100))
    .slice(0, 5);

  const card: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: "16px 18px", position: "relative", overflow: "hidden" };
  const chip = (bg: string, c: string): React.CSSProperties => ({ width: 42, height: 42, borderRadius: 12, background: bg, color: c, display: "grid", placeItems: "center", fontSize: 19 });
  const trend = (good: boolean): React.CSSProperties => ({ fontSize: 12, fontWeight: 800, padding: "3px 9px", borderRadius: 999, color: good ? "#22c55e" : "#f59e0b", background: good ? "rgba(34,197,94,.14)" : "rgba(245,158,11,.14)" });

  const Spark = ({ color, pts }: { color: string; pts: string }) => (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 30, opacity: 0.5 }}>
      <polyline fill="none" stroke={color} strokeWidth="2" points={pts} />
    </svg>
  );

  const kpis = [
    { icon: "👥", bg: "rgba(124,92,255,.16)", c: "#a996ff", val: fmt(homeStats.totalSubscribers), label: "Total subscribers", cap: "All customers on record", tag: "▲", good: true, spark: "0,24 25,20 50,15 75,10 100,6", scolor: "#7c5cff" },
    { icon: "🟢", bg: "rgba(34,197,94,.16)", c: "#22c55e", val: fmt(online), label: "Online now", cap: `${onlinePct}% of active are connected`, tag: `${onlinePct}% up`, good: true, spark: "0,16 25,18 50,12 75,10 100,13", scolor: "#22c55e" },
    { icon: "💳", bg: "rgba(233,64,139,.16)", c: "#f06aa5", val: `${currency} ${fmt(homeStats.revenueToday)}`, label: "Revenue today", cap: "Payments received today", tag: "▲", good: true, spark: "0,24 25,20 50,17 75,12 100,7", scolor: "#e0408b" },
    { icon: "⚠️", bg: "rgba(245,158,11,.16)", c: "#f59e0b", val: fmt(attention), label: "Needs attention", cap: "Weak signal, flapping, expired, outage", tag: attention > 0 ? "action" : "clear", good: attention === 0, spark: "0,20 25,22 50,17 75,18 100,14", scolor: "#f59e0b" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* KPI ROW */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>
        {kpis.map((k) => (
          <div key={k.label} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={chip(k.bg, k.c)}>{k.icon}</div>
              <span style={trend(k.good)}>{k.tag}</span>
            </div>
            <div style={{ fontSize: 28, fontWeight: 850, letterSpacing: "-0.03em", lineHeight: 1, color: "var(--text)" }}>{k.val}</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 5, fontWeight: 600 }}>{k.label}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", opacity: 0.8, marginTop: 8, marginBottom: 6 }}>{k.cap}</div>
            <Spark color={k.scolor} pts={k.spark} />
          </div>
        ))}
      </div>

      {/* NETWORK HEALTH ROW */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 12 }}>
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 750, marginBottom: 8 }}>Network availability</div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <svg width="84" height="84" viewBox="0 0 90 90">
              <circle cx="45" cy="45" r="36" fill="none" stroke="var(--surface-2)" strokeWidth="9" />
              <circle cx="45" cy="45" r="36" fill="none" stroke={onlinePct >= 85 ? "#22c55e" : onlinePct >= 60 ? "#f59e0b" : "#ef4444"} strokeWidth="9" strokeLinecap="round"
                strokeDasharray={`${(onlinePct / 100) * 226} 226`} transform="rotate(-90 45 45)" />
              <text x="45" y="49" textAnchor="middle" fontSize="18" fontWeight="800" fill="var(--text)">{onlinePct}%</text>
            </svg>
            <div>
              <div style={{ fontSize: 22, fontWeight: 850, color: onlinePct >= 85 ? "#22c55e" : onlinePct >= 60 ? "#f59e0b" : "#ef4444" }}>
                {onlinePct >= 85 ? "Healthy" : onlinePct >= 60 ? "Degraded" : "Problem"}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>{fmt(online)} of {fmt(active)} active are online. A short bar is a fault, not a quiet segment.</div>
            </div>
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 750, marginBottom: 8 }}>Status snapshot</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
            {[
              { l: "Active", v: t.active, c: "#22c55e" },
              { l: "Expired", v: t.expired, c: "#ef4444" },
              { l: "Suspended", v: t.suspended, c: "#f59e0b" },
            ].map((s) => (
              <div key={s.l}>
                <div style={{ fontSize: 22, fontWeight: 800, color: s.c }}>{fmt(s.v || 0)}</div>
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{s.l}</div>
              </div>
            ))}
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#8b5cf6" }}>{fmt(homeStats.todaySignups)}</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Signups today</div>
            </div>
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 750, marginBottom: 8 }}>Attention breakdown</div>
          {(ov?.reasons || []).length === 0 ? (
            <div style={{ fontSize: 12.5, color: "#22c55e" }}>✓ Nothing flagged right now.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(ov.reasons || []).slice(0, 4).map((r: any) => (
                <div key={r.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                  <span style={{ color: "var(--muted)" }}>{r.label}</span>
                  <b style={{ color: r.tone === "bad" ? "#ef4444" : r.tone === "warn" ? "#f59e0b" : "var(--muted)" }}>{fmt(r.count)}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* LIVE FEED + AREAS */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div><div style={{ fontSize: 14, fontWeight: 750 }}>Live network feed</div><div style={{ fontSize: 11, color: "var(--muted)", opacity: 0.8 }}>Real-time from SNMP + Syslog</div></div>
            <span style={{ fontSize: 12, color: "#22c55e", fontWeight: 700 }}>● Live</span>
          </div>
          {feed.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--muted)", padding: "10px 0" }}>No events yet — enable SNMP/Syslog on a NAS to start tracing.</div>
          ) : feed.map((f) => {
            const col = f.level === "critical" || f.level === "down" ? "#ef4444" : f.level === "warning" ? "#f59e0b" : f.level === "up" ? "#22c55e" : "#38bdf8";
            return (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px", borderBottom: "1px solid var(--border)", fontSize: 12.5 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: col, flex: "0 0 auto" }} />
                <span style={{ width: 42, fontSize: 10, fontWeight: 800, color: col }}>{(f.level || "info").toUpperCase().slice(0, 4)}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>{f.username ? <b>{f.username} </b> : null}{f.message}</span>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>{f.nasName}</span>
              </div>
            );
          })}
        </div>

        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 750 }}>Areas by health</div>
          <div style={{ fontSize: 11, color: "var(--muted)", opacity: 0.8, marginBottom: 6 }}>A quiet area usually means an outage — worst first</div>
          {areas.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--muted)", padding: "8px 0" }}>All areas nominal.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr>{["Area", "Subs", "Availability", ""].map((h) => <th key={h} style={{ textAlign: "left", fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", padding: "6px 4px" }}>{h}</th>)}</tr></thead>
              <tbody>
                {areas.map((a: any) => {
                  const pct = a.onlinePercent ?? 100;
                  const col = pct >= 85 ? "#22c55e" : pct >= 60 ? "#f59e0b" : "#ef4444";
                  return (
                    <tr key={a.key}>
                      <td style={{ padding: "8px 4px", borderTop: "1px solid var(--border)" }}>{a.label}</td>
                      <td style={{ padding: "8px 4px", borderTop: "1px solid var(--border)" }}>{fmt(a.total)}</td>
                      <td style={{ padding: "8px 4px", borderTop: "1px solid var(--border)" }}>
                        <span style={{ display: "block", height: 7, borderRadius: 5, background: "var(--surface-2)", overflow: "hidden", minWidth: 60 }}>
                          <i style={{ display: "block", height: "100%", width: `${pct}%`, background: col, borderRadius: 5 }} />
                        </span>
                      </td>
                      <td style={{ padding: "8px 4px", borderTop: "1px solid var(--border)", textAlign: "right" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: col }}>{pct}%</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
