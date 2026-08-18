"use client";

/**
 * Charts for the Subscriber 360 page.
 *
 * BandwidthHistoryChart — live upload/download rate over a selectable window
 * (1H / 6H / 24H). Data is the backend's rate-series from radacct interim
 * updates; a subscriber with no sessions shows "no data", NOT a fake zero line.
 *
 * UsageBars — daily usage totals for the last N days (server computed).
 *
 * Both are dependency-free SVG (mirrors the app's existing bandwidth-chart).
 */
import { useEffect, useRef, useState } from "react";
import { apiGet, fmtBits, BwPoint, DailyUsage, num, u } from "./lib";

const UP = "#4ade80";
const DOWN = "#60a5fa";
const MUTED = "var(--muted)";
const BORDER = "var(--border)";
const SURFACE = "var(--surface)";
const SURFACE2 = "var(--surface-2)";

interface BwChartProps {
  username: string;
  /** Default window in minutes */
  minutes?: number;
  autoPoll?: boolean;
}

const RANGES = [
  { label: "1H", minutes: 60 },
  { label: "6H", minutes: 360 },
  { label: "24H", minutes: 1440 },
];

export function BandwidthHistoryChart({ username, minutes = 60, autoPoll = true }: BwChartProps) {
  const [range, setRange] = useState(minutes);
  const [samples, setSamples] = useState<BwPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      setErr(false);
      const d = await apiGet<{ samples?: BwPoint[] }>(
        `/subscribers/bandwidth-history/${encodeURIComponent(username)}?minutes=${range}`,
      );
      if (!alive) return;
      if (d) setSamples(d.samples ?? []);
      else setErr(true);
      setLoading(false);
    };
    load();
    if (autoPoll) {
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(load, 30000);
    }
    return () => { alive = false; if (timer.current) clearInterval(timer.current); };
  }, [username, range, autoPoll]);

  const W = 600, H = 190, PAD = { top: 16, right: 14, bottom: 26, left: 50 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const maxRate = samples.reduce((m, s) => Math.max(m, s.uploadBps, s.downloadBps), 1);
  const yMax = Math.max(maxRate * 1.15, 1000); // at least 1 Kbps scale so a quiet line is honest

  const linePath = (acc: (p: BwPoint) => number) => {
    if (samples.length < 2) return "";
    const x = (i: number) => PAD.left + (innerW * i) / (samples.length - 1);
    const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
    return samples.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(acc(p)).toFixed(1)}`).join(" ");
  };
  const areaPath = (acc: (p: BwPoint) => number) => {
    if (samples.length < 2) return "";
    const x = (i: number) => PAD.left + (innerW * i) / (samples.length - 1);
    const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
    const bottom = PAD.top + innerH;
    const d = samples.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(acc(p)).toFixed(1)}`).join(" ");
    return `${d} L${x(samples.length - 1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`;
  };

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));
  const fmtX = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const current = samples.length ? samples[samples.length - 1] : null;

  return (
    <div className="sd-bw">
      <div className="sd-bw-head">
        <div className="sd-bw-legends">
          <span style={{ color: DOWN }}><i style={{ background: DOWN }} /> Download</span>
          <span style={{ color: UP }}><i style={{ background: UP }} /> Upload</span>
          {current && (
            <span className="sd-bw-now" style={{ color: MUTED }}>
              now: <b style={{ color: "var(--text)" }}>↓{fmtBits(current.downloadBps)}</b> / <b style={{ color: "var(--text)" }}>↑{fmtBits(current.uploadBps)}</b>
            </span>
          )}
        </div>
        <div className="sd-bw-ranges" role="tablist" aria-label="Bandwidth window">
          {RANGES.map((r) => (
            <button
              key={r.minutes}
              className={range === r.minutes ? "on" : ""}
              onClick={() => { setRange(r.minutes); setLoading(true); }}
              aria-pressed={range === r.minutes}
            >{r.label}</button>
          ))}
        </div>
      </div>

      {err ? (
        <div className="sd-bw-empty">Bandwidth data unavailable — RADIUS accounting not reachable.</div>
      ) : loading ? (
        <div className="sd-bw-empty">Loading bandwidth data…</div>
      ) : samples.length < 2 ? (
        <div className="sd-bw-empty">
          {samples.length === 1
            ? "Session just started — one accounting sample so far. More appear on the next interim update."
            : "No bandwidth data yet — nothing to plot until the subscriber runs a session."}
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", overflow: "visible" }}>
          {yTicks.map((tick, i) => (
            <g key={i}>
              <line x1={PAD.left} y1={PAD.top + innerH - (tick / yMax) * innerH}
                x2={W - PAD.right} y2={PAD.top + innerH - (tick / yMax) * innerH}
                stroke="var(--border)" strokeWidth={1} strokeDasharray={i === 0 ? "" : "2 3"} />
              <text x={PAD.left - 6} y={PAD.top + innerH - (tick / yMax) * innerH + 4}
                textAnchor="end" fontSize={9} fill={MUTED}>{fmtBits(tick)}</text>
            </g>
          ))}
          {samples.length > 1 && [0, 0.25, 0.5, 0.75, 1].map((f, i) => {
            const idx = Math.floor(f * (samples.length - 1));
            return (
              <text key={i} x={PAD.left + (innerW * idx) / (samples.length - 1)}
                y={H - 5} textAnchor="middle" fontSize={9} fill={MUTED}>
                {fmtX(samples[idx].timestamp)}
              </text>
            );
          })}
          <path d={areaPath((p) => p.downloadBps)} fill="rgba(96,165,250,0.12)" />
          <path d={linePath((p) => p.downloadBps)} fill="none" stroke={DOWN} strokeWidth={2} strokeLinejoin="round" />
          <path d={areaPath((p) => p.uploadBps)} fill="rgba(74,222,128,0.12)" />
          <path d={linePath((p) => p.uploadBps)} fill="none" stroke={UP} strokeWidth={2} strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}

/** Daily usage bars for the last N days. */
export function UsageBars({ username, days = 14 }: { username: string; days?: number }) {
  const [daily, setDaily] = useState<DailyUsage["days"]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const d = await apiGet<DailyUsage>(`/subscribers/usage-daily/${encodeURIComponent(username)}?days=${days}`);
      if (alive && d) setDaily(d.days ?? []);
      if (alive) setLoading(false);
    };
    load();
    return () => { alive = false; };
  }, [username, days]);

  const dayMax = Math.max(...daily.map((d) => d.downloadGb + d.uploadGb), 0.001);

  return (
    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Daily usage · last {days} days</div>
        <div style={{ display: "flex", gap: 12, fontSize: 10.5, color: MUTED }}>
          <span><i style={{ display: "inline-block", width: 9, height: 9, background: DOWN, borderRadius: 2, marginRight: 4 }} />Download (GB)</span>
          <span><i style={{ display: "inline-block", width: 9, height: 9, background: UP, borderRadius: 2, marginRight: 4 }} />Upload (GB)</span>
        </div>
      </div>
      {loading ? (
        <div style={{ fontSize: 11.5, color: MUTED, padding: "18px 0", textAlign: "center" }}>Loading usage…</div>
      ) : daily.length === 0 ? (
        <div style={{ fontSize: 11.5, color: MUTED, padding: "18px 0", textAlign: "center" }}>
          No usage recorded yet — nothing is fabricated until the first session.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 92 }}>
            {daily.map((d) => {
              const tot = d.downloadGb + d.uploadGb;
              return (
                <div key={d.day} title={`${d.day}: ↓${d.downloadGb} GB / ↑${d.uploadGb} GB`}
                  style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                  <span style={{ fontSize: 8.5, color: "var(--text)" }}>
                    {tot >= 0.01 ? (tot >= 10 ? Math.round(tot) : tot.toFixed(1)) : ""}
                  </span>
                  <div style={{ width: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", height: 58 }}>
                    <div style={{ height: `${(d.uploadGb / dayMax) * 56}px`, background: UP, borderRadius: "2px 2px 0 0" }} />
                    <div style={{ height: `${(d.downloadGb / dayMax) * 56}px`, background: DOWN }} />
                  </div>
                  <span style={{ fontSize: 8.5, color: MUTED }}>{d.day.slice(5)}</span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 8, fontSize: 10.5, color: MUTED, lineHeight: 1.6 }}>
            Bytes are attributed to the day each session started — a good-enough MRTG-style view for support and upsell. A day with no bar truly had no traffic.
          </div>
        </>
      )}
    </div>
  );
}

/** Tiny inline sparkline for session duration / signal trends. */
export function Sparkline({ values, color = "#38bdf8", height = 34 }: {
  values: number[]; color?: string; height?: number;
}) {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (clean.length < 2) return <span style={{ fontSize: 10.5, color: MUTED }}>—</span>;
  const lo = Math.min(...clean), hi = Math.max(...clean);
  const span = Math.max(1, hi - lo);
  const W = Math.max(clean.length * 5, 60);
  const pts = clean.map((v, i) => `${i * 5},${height - 2 - ((v - lo) / span) * (height - 6)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ width: "100%", height, background: SURFACE2, borderRadius: 6, display: "block" }}>
      <polyline fill="none" stroke={color} strokeWidth="1.3" points={pts} />
    </svg>
  );
}

/** Usage meter (data allowance) — distinguishes real zero from no data. */
export function UsageMeter({ quotaGb, usedGb, percentUsed, state, throttledTo }: {
  quotaGb: number; usedGb: number; percentUsed: number | null;
  state: string; throttledTo: string | null;
}) {
  const pct = percentUsed ?? (quotaGb > 0 ? Math.min(100, (usedGb / quotaGb) * 100) : 0);
  const color = state === "BLOCKED" ? "#EF4444" : state === "THROTTLED" || pct >= 85 ? "#F59E0B" : "#10B981";
  return (
    <div>
      <div className="sd-usage-track">
        <div className="sd-usage-fill" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10.5, color: MUTED, flexWrap: "wrap", gap: 6 }}>
        <span>{pct}% of {quotaGb} GB cycle</span>
        {state === "BLOCKED"
          ? <span style={{ color: "#EF4444", fontWeight: 700 }}>Net stopped — data limit reached</span>
          : state === "THROTTLED"
            ? <span style={{ color: "#F59E0B", fontWeight: 700 }}>Throttled to {throttledTo || "FUP speed"} — resets on renewal</span>
            : pct >= 85
              ? <span style={{ color: "#F59E0B", fontWeight: 700 }}>Near the cap</span>
              : <span>Within allowance</span>}
      </div>
    </div>
  );
}