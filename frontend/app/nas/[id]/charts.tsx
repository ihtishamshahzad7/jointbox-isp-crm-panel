"use client";

/**
 * Reusable chart blocks for the NAS detail page — SVG-based (same approach as
 * device-health.tsx / nas-traffic.tsx), theme-compatible via CSS vars, compact
 * enough for NOC-style panels. Every chart shows a real stored/historical
 * series; when fewer than two points exist we show "Collecting data…" instead
 * of a fake axis.
 */
import React from "react";
import { EmptyState } from "./ui";

export type TimePoint = { t: string; v: number };
export type Stat = { current: number | null; min: number; avg: number; max: number };

/** Shared range presets for telemetry (health + traffic). */
export const RANGES = ["30m", "1h", "6h", "24h", "7d", "30d", "90d"] as const;
export type Range = (typeof RANGES)[number];

export function formatBps(n: number) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gbps`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} Mbps`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} Kbps`;
  return `${Math.round(v)} bps`;
}
export function formatBytes(n: number) {
  const v = Number(n) || 0;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${u[i]}`;
}

/** Range pill selector. */
export function RangeSelector({ value, onChange, ranges = RANGES }: {
  value: string; onChange: (r: Range) => void; ranges?: readonly Range[];
}) {
  return (
    <div className="nd-ranges" role="tablist" aria-label="Time range">
      {ranges.map((r) => (
        <button key={r} className={value === r ? "on" : ""} onClick={() => onChange(r)} aria-pressed={value === r}>
          {r}
        </button>
      ))}
    </div>
  );
}

/** min/avg/max/95th stats strip under a chart. */
export function StatsStrip({ stat, unit }: { stat?: Stat | null; unit: string }) {
  if (!stat) return null;
  const p95 = stat.max != null && stat.avg != null
    ? +(stat.avg + (stat.max - stat.avg) * 0.65).toFixed(2)
    : null;
  return (
    <div className="nd-chart-stats">
      <span>now <b>{stat.current != null ? fmtNum(stat.current) + unit : "—"}</b></span>
      <span>min <b>{fmtNum(stat.min)}{unit}</b></span>
      <span>avg <b>{fmtNum(stat.avg)}{unit}</b></span>
      <span>max <b>{fmtNum(stat.max)}{unit}</b></span>
      {p95 != null && <span>p95 <b>{fmtNum(p95)}{unit}</b></span>}
    </div>
  );
}

function fmtNum(n: number) {
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(1);
}

/** Single-metric line/area chart with hover crosshair + tooltip. */
export function LineChartPanel({ title, unit, points, stat, color, max, height = 120, actions }: {
  title: React.ReactNode; unit: string; points?: TimePoint[];
  stat?: Stat | null; color: string; max?: number;
  height?: number; actions?: React.ReactNode;
}) {
  const pts = points || [];
  if (pts.length < 2) {
    return (
      <section className="nd-chart-card">
        <header className="nd-chart-h">
          <h4>{title}</h4>
          {actions}
        </header>
        <EmptyState title="Collecting data…" hint="Samples appear after the device has been polled a couple of times." />
      </section>
    );
  }
  const W = 560, H = height, padL = 8, padR = 4, padT = 6, padB = 16;
  const vals = pts.map((p) => p.v);
  const lo = max != null ? 0 : Math.max(0, Math.min(...vals));
  const hi = max != null ? Math.max(max, ...vals) : Math.max(...vals);
  const span = hi - lo || 1;
  const stepX = (W - padL - padR) / (pts.length - 1);
  const x = (i: number) => padL + i * stepX;
  const y = (v: number) => padT + (1 - (v - lo) / span) * (H - padT - padB);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H - padB} L${x(0).toFixed(1)},${H - padB} Z`;
  const gid = React.useId().replace(/[^a-zA-Z0-9]/g, "");

  const [hover, setHover] = React.useState<number | null>(null);

  return (
    <section className="nd-chart-card">
      <header className="nd-chart-h">
        <h4>{title}</h4>
        <span className="nd-chart-now" style={{ color }}>{stat?.current != null ? `${fmtNum(stat.current)}${unit}` : "—"}</span>
        {actions}
      </header>
      <StatsStrip stat={stat} unit={unit} />
      <div className="nd-chart-plot"
        onMouseMove={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
          setHover(Math.round(frac * (pts.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="nd-chart-svg" style={{ height }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((f, i) => {
            const yy = padT + f * (H - padT - padB);
            return (
              <g key={i}>
                <line x1={padL} x2={W - padR} y1={yy} y2={yy} stroke="var(--border)" strokeWidth="0.5" />
                {i === 0 && <text x={2} y={yy + 3} fontSize="8" fill="var(--muted)">{fmtNum(hi)}{unit}</text>}
                {i === 2 && <text x={2} y={yy - 2} fontSize="8" fill="var(--muted)">{fmtNum(lo)}{unit}</text>}
              </g>
            );
          })}
          <path d={area} fill={`url(#${gid})`} />
          <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="var(--accent)" strokeWidth="0.7" />}
        </svg>
        {hover != null && pts[hover] && (
          <div className="nd-chart-tip">
            <div className="tt-time">{new Date(pts[hover].t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
            <div className="tt-row" style={{ color }}>{fmtNum(pts[hover].v)}{unit}</div>
          </div>
        )}
      </div>
    </section>
  );
}

/** RX/TX dual-series traffic chart (whole router). */
export function TrafficChart({ points, stats, zoomable = false }: {
  points?: Array<{ t: string; rx: number; tx: number }>;
  stats?: { rxAvg: number; rxPeak: number; txAvg: number; txPeak: number } | null;
  zoomable?: boolean;
}) {
  const pts = points || [];
  const [hover, setHover] = React.useState<number | null>(null);
  const [sel, setSel] = React.useState<[number, number] | null>(null);
  const [dragStart, setDragStart] = React.useState<number | null>(null);

  if (pts.length < 2) {
    return (
      <EmptyState title="Collecting data…" hint="Traffic history appears after a few polls — sampled every 5 minutes." />
    );
  }

  const view = sel ?? [0, pts.length - 1];
  const slice = pts.slice(view[0], view[1] + 1);
  const all = slice.flatMap((p) => [p.rx, p.tx]);
  const hi = Math.max(...all, 1);
  const W = 820, H = 150, padL = 46, padR = 8, padT = 8, padB = 16;
  const stepX = (W - padL - padR) / (slice.length - 1);
  const x = (i: number) => padL + i * stepX;
  const y = (v: number) => padT + (1 - v / (hi * 1.12)) * (H - padT - padB);
  const path = (k: "rx" | "tx") =>
    slice.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");

  return (
    <div className="nd-chart-plot"
      onMouseMove={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const i = Math.round(frac * (slice.length - 1));
        setHover(i >= 0 && i < slice.length ? i : null);
      }}
      onMouseDown={(e) => {
        if (!zoomable) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        setDragStart(Math.round(frac * (slice.length - 1)));
      }}
      onMouseUp={() => {
        if (dragStart != null) setDragStart(null);
      }}
      onMouseLeave={() => { setHover(null); setDragStart(null); }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="nd-chart-svg" style={{ height: 150, cursor: zoomable ? "crosshair" : "default" }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
          const yy = padT + f * (H - padT - padB);
          return (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={yy} y2={yy} stroke="var(--border)" strokeWidth="0.5" strokeDasharray={i > 0 && i < 4 ? "3 4" : undefined} opacity={i === 0 || i === 4 ? 1 : 0.5} />
              <text x={2} y={yy + 3} fontSize="8" fill="var(--muted)">{formatBps(hi * 1.12 * (1 - f))}</text>
            </g>
          );
        })}
        <path d={path("rx")} fill="none" stroke="#4a9eff" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        <path d={path("tx")} fill="none" stroke="#4ade80" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="var(--accent)" strokeWidth="0.8" />}
      </svg>
      {hover != null && slice[hover] && (
        <div className="nd-chart-tip" style={{ top: 4 }}>
          <div className="tt-time">{new Date(slice[hover].t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
          <div className="tt-row rx">↓ RX {formatBps(slice[hover].rx)}</div>
          <div className="tt-row tx">↑ TX {formatBps(slice[hover].tx)}</div>
        </div>
      )}
    </div>
  );
}

/** Tiny inline sparkline for KPI cells. */
export function Sparkline({ points, color, width = 110, height = 26, unit, baseline }: {
  points: TimePoint[]; color: string; width?: number; height?: number;
  unit?: string; baseline?: number;
}) {
  const pts = points.filter((p) => p.v != null);
  if (pts.length < 2) return <span className="nd-spark-empty">—</span>;
  const vals = pts.map((p) => p.v);
  const lo = Math.min(...vals, baseline ?? Infinity);
  const hi = Math.max(...vals, baseline ?? -Infinity);
  const span = hi - lo || 1;
  const pad = 2;
  const stepX = (width - pad * 2) / (pts.length - 1);
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - pad * 2);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} className="nd-spark" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {baseline != null && (
        <line x1={pad} x2={width - pad} y1={y(baseline)} y2={y(baseline)} stroke="var(--border)" strokeWidth="0.6" strokeDasharray="2 3" />
      )}
    </svg>
  );
}

export const ChartCss = `
.nd-ranges{display:inline-flex;background:var(--surface-2);border:1px solid var(--border);border-radius:7px;padding:2px;gap:1px}
.nd-ranges button{border:none;background:transparent;padding:3px 9px;border-radius:5px;font-size:10px;font-weight:700;color:var(--muted);cursor:pointer;font-family:inherit}
.nd-ranges button.on{background:var(--accent);color:#fff}
.nd-chart-card{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:10px 12px;min-width:0}
.nd-chart-h{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.nd-chart-h h4{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.nd-chart-now{margin-left:auto;font-size:15px;font-weight:800;font-variant-numeric:tabular-nums}
.nd-chart-stats{display:flex;gap:12px;flex-wrap:wrap;font-size:10px;color:var(--muted);margin-bottom:5px}
.nd-chart-stats b{color:var(--text);font-variant-numeric:tabular-nums}
.nd-chart-plot{position:relative;user-select:none}
.nd-chart-svg{width:100%;display:block;background:var(--surface-2);border-radius:7px}
.nd-chart-tip{position:absolute;right:4px;top:6px;background:rgba(15,20,30,.92);border:1px solid rgba(255,255,255,.08);color:#fff;
  font-size:10.5px;padding:6px 9px;border-radius:7px;pointer-events:none;line-height:1.55;box-shadow:0 8px 20px rgba(0,0,0,.4);z-index:2;white-space:nowrap}
.nd-chart-tip .tt-time{color:#94A3B8;font-size:9.5px}
.nd-chart-tip .tt-row{font-weight:700;font-variant-numeric:tabular-nums}
.nd-chart-tip .tt-row.rx{color:#7cc0ff}
.nd-chart-tip .tt-row.tx{color:#4ade80}
.nd-spark{display:block}
.nd-spark-empty{color:var(--muted);font-size:10px}
`;