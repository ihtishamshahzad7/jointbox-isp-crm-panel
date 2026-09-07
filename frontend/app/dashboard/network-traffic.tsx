"use client";

/**
 * NetworkTraffic — whole-network MRTG bandwidth chart + Top-N subscribers for
 * the dashboard home tab.
 *
 *  • Left: aggregate download/upload throughput across EVERY NAS over a
 *    selectable window (1H / 6H / 24H / 7D / 30D), drawn from
 *    /telemetry/network-traffic (server buckets + rate-derivation).
 *  • Right: Top-N subscribers by live throughput (10-min average) from
 *    /telemetry/top-subscribers — "who's pulling bandwidth now".
 *
 * Dependency-free SVG area chart, styled with the dashboard's card recipe.
 * "No data" shows honestly (no fake zero line).
 */
import { useEffect, useMemo, useRef, useState } from "react";

const CARD: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 16,
  padding: 18,
  boxShadow: "0 1px 2px rgba(15,23,42,.04)",
};

const DOWN = "#60a5fa"; // download
const UP = "#4ade80";   // upload
const MUTED = "var(--muted)";

const RANGES = [
  { label: "1H", range: "1h" },
  { label: "6H", range: "6h" },
  { label: "24H", range: "1d" },
  { label: "7D", range: "7d" },
  { label: "30D", range: "30d" },
];

interface NtPoint { ts: string; inBps: number; outBps: number; online: number }
interface TopRow { subscriberId: number; name: string; username: string; downloadBps: number; uploadBps: number }

function bps(v: number): string {
  if (!v || v <= 0) return "0";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gbps`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 2)} Mbps`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} Kbps`;
  return `${Math.round(v)} bps`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = Date.now();
  const cutoff = now - 6 * 3600_000; // < 6h → time-of-day; older → date+time
  return d.getTime() >= cutoff
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function NetworkTraffic({ API }: { API: string }) {
  const [range, setRange] = useState("1h");
  const [points, setPoints] = useState<NtPoint[]>([]);
  const [top, setTop] = useState<TopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const token = ((): string => (typeof window !== "undefined" ? localStorage.getItem("token") || "" : ""))();
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    const load = async () => {
      setErr(false);
      try {
        const [t, tp] = await Promise.all([
          fetch(`${API}/telemetry/network-traffic?range=${range}`, { headers }).then((r) => (r.ok ? r.json() : null)),
          fetch(`${API}/telemetry/top-subscribers?limit=8`, { headers }).then((r) => (r.ok ? r.json() : null)),
        ]);
        if (!alive) return;
        setPoints(t?.points ?? []);
        setTop(tp ?? []);
      } catch {
        if (alive) setErr(true);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    if (timer.current) clearInterval(timer.current);
    // 60s live refresh for the chart + list — traffic is a live number.
    timer.current = setInterval(load, 60_000);
    return () => { alive = false; if (timer.current) clearInterval(timer.current); };
  }, [API, range]);

  const { dl, ul, yMax } = useMemo(() => {
    const dl = points.map((p) => p.outBps);
    const ul = points.map((p) => p.inBps);
    const peak = Math.max(1, ...dl, ...ul);
    return { dl, ul, yMax: Math.max(peak * 1.15, 2000) };
  }, [points]);

  const W = 640, H = 220, PAD = { top: 16, right: 14, bottom: 26, left: 56 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const line = (vals: number[]) => {
    if (vals.length < 2) return "";
    const x = (i: number) => PAD.left + (innerW * i) / (vals.length - 1);
    const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
    return vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(Math.max(0, v)).toFixed(1)}`).join(" ");
  };
  const area = (vals: number[]) => {
    if (vals.length < 2) return "";
    const x = (i: number) => PAD.left + (innerW * i) / (vals.length - 1);
    const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
    const bottom = PAD.top + innerH;
    const d = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(Math.max(0, v)).toFixed(1)}`).join(" ");
    return `${d} L${x(vals.length - 1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`;
  };

  const dlP = line(dl), ulP = line(ul), dlA = area(dl), ulA = area(ul);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));
  const peakDl = Math.max(0, ...dl);
  const peakUl = Math.max(0, ...ul);
  const cur = points.length ? points[points.length - 1] : null;
  const topTotal = top.reduce((a, r) => a + r.downloadBps + r.uploadBps, 0);
  const topMax = Math.max(0, ...top.map((r) => r.downloadBps + r.uploadBps), 1);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) minmax(280px,.9fr)", gap: 12 }}>
      {/* ── Whole-network bandwidth chart ── */}
      <div style={CARD}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 14 }}>Network traffic</div>
            <div style={{ fontSize: 11, color: MUTED }}>Aggregate upload/download across all routers</div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {RANGES.map((r) => (
              <button key={r.range} type="button"
                onClick={() => { setRange(r.range); setLoading(true); }}
                style={{
                  border: "1px solid var(--border)", background: range === r.range ? "var(--g-primary)" : "transparent",
                  color: range === r.range ? "#fff" : "var(--text)", borderRadius: 8, padding: "4px 9px",
                  fontSize: 10.5, fontWeight: 700, cursor: "pointer",
                }}>{r.label}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 14, fontSize: 11, color: MUTED, marginBottom: 8 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <i style={{ width: 9, height: 9, background: DOWN, borderRadius: 2, display: "inline-block" }} /> Download
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <i style={{ width: 9, height: 9, background: UP, borderRadius: 2, display: "inline-block" }} /> Upload
          </span>
          {cur && (
            <span style={{ marginLeft: "auto", color: MUTED }}>
              now: <b style={{ color: "var(--text)" }}>↓{bps(cur.outBps)}</b> / <b style={{ color: "var(--text)" }}>↑{bps(cur.inBps)}</b>
            </span>
          )}
        </div>

        {err ? (
          <div style={{ fontSize: 12, color: "var(--muted)", padding: "40px 0", textAlign: "center" }}>Network traffic unavailable.</div>
        ) : loading && points.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)", padding: "40px 0", textAlign: "center" }}>Loading traffic…</div>
        ) : points.length < 2 ? (
          <div style={{ fontSize: 12, color: "var(--muted)", padding: "40px 0", textAlign: "center", lineHeight: 1.6 }}>
            No aggregate traffic sampled yet — points appear once the 5-minute NAS sampler has recorded a couple of windows
            ({points.length === 0 ? "the sample table is still empty" : "only one sample so far"}).
          </div>
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", overflow: "visible" }}>
              {yTicks.map((tick, i) => {
                const y = PAD.top + innerH - (tick / yMax) * innerH;
                return (
                  <g key={i}>
                    <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y}
                      stroke="var(--border)" strokeWidth={1} strokeDasharray={i === 0 ? "" : "2 3"} />
                    <text x={PAD.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill={MUTED}>{bps(tick)}</text>
                  </g>
                );
              })}
              {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
                const idx = Math.min(points.length - 1, Math.floor(f * (points.length - 1)));
                return (
                  <text key={i} x={PAD.left + (innerW * idx) / (points.length - 1)}
                    y={H - 5} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"} fontSize={9} fill={MUTED}>
                    {fmtTime(points[idx].ts)}
                  </text>
                );
              })}
              <path d={dlA} fill="rgba(96,165,250,0.12)" />
              <path d={dlP} fill="none" stroke={DOWN} strokeWidth={2} strokeLinejoin="round" />
              <path d={ulA} fill="rgba(74,222,128,0.12)" />
              <path d={ulP} fill="none" stroke={UP} strokeWidth={2} strokeLinejoin="round" />
            </svg>
            <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 11, color: MUTED, flexWrap: "wrap" }}>
              <span>Peak ↓ <b style={{ color: "var(--text)" }}>{bps(peakDl)}</b></span>
              <span>Peak ↑ <b style={{ color: "var(--text)" }}>{bps(peakUl)}</b></span>
              <span style={{ marginLeft: "auto" }}><b style={{ color: "var(--text)" }}>{points.length}</b> samples</span>
            </div>
          </>
        )}
      </div>

      {/* ── Top-N subscribers ── */}
      <div style={CARD}>
        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 2 }}>Top subscribers</div>
        <div style={{ fontSize: 11, color: MUTED, marginBottom: 10 }}>
          Highest live throughput (10-min avg)
          {topTotal > 0 ? ` · combined ${bps(topTotal)}` : ""}
        </div>
        {top.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)", padding: "30px 0", textAlign: "center" }}>
            No active subscriber traffic yet.
          </div>
        ) : (
          top.map((r, i) => {
            const total = r.downloadBps + r.uploadBps;
            return (
              <div key={r.subscriberId} style={{ marginBottom: 9 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 18, fontSize: 11, fontWeight: 800, color: i === 0 ? "#f59e0b" : MUTED }}>#{i + 1}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {r.name}
                    </div>
                    <div style={{ fontSize: 10, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.username}</div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 10.5, color: "var(--text)", whiteSpace: "nowrap" }}>
                    <div><span style={{ color: DOWN }}>↓</span> {bps(r.downloadBps)}</div>
                    <div><span style={{ color: UP }}>↑</span> {bps(r.uploadBps)}</div>
                  </div>
                </div>
                <div style={{ height: 4, background: "var(--surface-2)", borderRadius: 3, marginTop: 5, marginLeft: 26, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${topMax ? (total / topMax) * 100 : 0}%`, background: "linear-gradient(90deg,#60a5fa,#4ade80)", borderRadius: 3 }} />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
