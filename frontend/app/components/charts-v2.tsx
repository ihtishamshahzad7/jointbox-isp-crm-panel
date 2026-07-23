"use client";

import React from "react";

/**
 * Charts, rebuilt.
 *
 * The existing charts were decorative: bright, animated, and showing numbers
 * you could not compare. A chart earns its space only if it answers a question
 * faster than a table would — "is this going up", "which dealer is biggest",
 * "how much of the month is gone". Anything else is a table with extra steps.
 *
 * Dependency-free SVG on purpose. A charting library would be ~40kb to draw
 * four shapes, and every one of them fights the Nova palette by default.
 *
 * All of these:
 *   • scale to their container instead of a fixed pixel size
 *   • say so plainly when there is no data, rather than drawing an empty box
 *   • label the axis that matters and leave off the one that does not
 */

const GRAD = { from: "#6C3CE1", mid: "#E9408B", to: "#F27121" };
const OK = "#10B981", WARN = "#F59E0B", BAD = "#EF4444", COOL = "#38BDF8";

export type Point = { label: string; value: number };

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  : String(Math.round(n));

function Empty({ msg }: { msg: string }) {
  return <div className="cv-empty">{msg}</div>;
}

/* ═══════════════════════════════════════════════════════════════════
   TREND — "is this going up or down"
   ═══════════════════════════════════════════════════════════════════ */
export function Trend({
  data, height = 150, label, suffix = "", empty = "No activity in this period yet.",
}: {
  data: Point[]; height?: number; label?: string; suffix?: string; empty?: string;
}) {
  const id = React.useId();
  if (!data?.length || data.every((d) => !d.value)) return <Empty msg={empty} />;

  const W = 600, H = height, P = 22;
  const max = Math.max(...data.map((d) => d.value)) || 1;
  // Headroom so the peak never touches the top edge and look clipped.
  const top = max * 1.15;
  const x = (i: number) => P + (i * (W - P * 2)) / Math.max(data.length - 1, 1);
  const y = (v: number) => H - P - (v / top) * (H - P * 2);

  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.value)}`).join(" ");
  const fill = `${line} L${x(data.length - 1)},${H - P} L${x(0)},${H - P} Z`;

  const first = data[0].value, last = data[data.length - 1].value;
  const delta = first ? Math.round(((last - first) / first) * 100) : 0;

  return (
    <div className="cv">
      <style>{CSS}</style>
      {label && (
        <div className="cv-head">
          <span>{label}</span>
          {/* The direction IS the point of a trend chart, so it is stated in
              words rather than left for the reader to infer from a slope. */}
          <b className={delta > 0 ? "up" : delta < 0 ? "down" : ""}>
            {delta > 0 ? "▲" : delta < 0 ? "▼" : "="} {Math.abs(delta)}%
          </b>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="cv-svg" style={{ height }}>
        <defs>
          <linearGradient id={`f${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GRAD.mid} stopOpacity=".28" />
            <stop offset="100%" stopColor={GRAD.from} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`s${id}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={GRAD.from} />
            <stop offset="55%" stopColor={GRAD.mid} />
            <stop offset="100%" stopColor={GRAD.to} />
          </linearGradient>
        </defs>

        {/* Three reference lines only. More gridlines than that and the grid
            competes with the data it is supposed to support. */}
        {[0.5, 1].map((f) => (
          <line key={f} x1={P} x2={W - P} y1={y(top * f)} y2={y(top * f)}
            stroke="currentColor" strokeOpacity=".07" strokeDasharray="3 5" />
        ))}

        <path d={fill} fill={`url(#f${id})`} />
        <path d={line} fill="none" stroke={`url(#s${id})`} strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />

        {/* Only the last point is marked. Dots on every point turn a trend
            into a scatter and stop the eye following the line. */}
        <circle cx={x(data.length - 1)} cy={y(last)} r="4" fill={GRAD.mid}
          stroke="var(--surface)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="cv-axis">
        <span>{data[0].label}</span>
        <b>{fmt(last)}{suffix}</b>
        <span>{data[data.length - 1].label}</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   RANK — "which is biggest"
   Horizontal bars, because the labels are names. Vertical bars force names
   sideways or truncate them, and a rotated label is unreadable at a glance.
   ═══════════════════════════════════════════════════════════════════ */
export function Rank({
  data, label, max: maxRows = 8, suffix = "", empty = "Nothing to compare yet.",
}: {
  data: Point[]; label?: string; max?: number; suffix?: string; empty?: string;
}) {
  if (!data?.length) return <Empty msg={empty} />;
  const rows = [...data].sort((a, b) => b.value - a.value).slice(0, maxRows);
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  const total = data.reduce((n, d) => n + d.value, 0);

  return (
    <div className="cv">
      <style>{CSS}</style>
      {label && <div className="cv-head"><span>{label}</span><b>{fmt(total)} total</b></div>}
      <div className="cv-rank">
        {rows.map((r, i) => (
          <div key={r.label} className="cv-row">
            <span className="cv-lbl" title={r.label}>{r.label}</span>
            <span className="cv-bar">
              <i style={{
                width: `${Math.max((r.value / max) * 100, 2)}%`,
                // Leader in full gradient, the rest progressively quieter, so
                // rank is visible without reading a single number.
                opacity: 1 - i * 0.085,
              }} />
            </span>
            <b className="cv-val">{fmt(r.value)}{suffix}</b>
          </div>
        ))}
      </div>
      {data.length > maxRows && (
        <div className="cv-more">+{data.length - maxRows} more not shown</div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SPLIT — "how does the whole divide"
   ═══════════════════════════════════════════════════════════════════ */
export function Split({
  data, label, size = 132, empty = "No data to break down.",
}: {
  data: (Point & { color?: string })[]; label?: string; size?: number; empty?: string;
}) {
  if (!data?.length) return <Empty msg={empty} />;
  const total = data.reduce((n, d) => n + d.value, 0);
  if (!total) return <Empty msg={empty} />;

  const palette = [GRAD.from, GRAD.mid, GRAD.to, COOL, OK, WARN];
  const R = 54, C = 2 * Math.PI * R;
  let acc = 0;

  return (
    <div className="cv cv-split">
      <style>{CSS}</style>
      <div className="cv-ring" style={{ width: size, height: size }}>
        <svg viewBox="0 0 140 140">
          <circle cx="70" cy="70" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="15" />
          {data.map((d, i) => {
            const frac = d.value / total;
            const seg = (
              <circle key={d.label} cx="70" cy="70" r={R} fill="none"
                stroke={d.color || palette[i % palette.length]} strokeWidth="15"
                strokeDasharray={`${frac * C} ${C}`}
                strokeDashoffset={-acc * C}
                transform="rotate(-90 70 70)" strokeLinecap="butt" />
            );
            acc += frac;
            return seg;
          })}
        </svg>
        {/* The total belongs in the middle — it is the number people came for,
            and a donut without it makes you add the segments up yourself. */}
        <div className="cv-mid"><b>{fmt(total)}</b><span>{label ?? "total"}</span></div>
      </div>

      <div className="cv-key">
        {data.map((d, i) => (
          <div key={d.label}>
            <i style={{ background: d.color || palette[i % palette.length] }} />
            <span>{d.label}</span>
            <b>{fmt(d.value)}</b>
            <em>{Math.round((d.value / total) * 100)}%</em>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   GAUGE — "how far through / how full"
   ═══════════════════════════════════════════════════════════════════ */
export function Gauge({
  value, max, label, sub, invert = false,
}: {
  value: number; max: number; label: string; sub?: string;
  /** true when a HIGH value is bad — data used, pool consumed. */
  invert?: boolean;
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const hot = invert ? pct >= 85 : pct <= 15;
  const warm = invert ? pct >= 65 : pct <= 35;
  const colour = hot ? BAD : warm ? WARN : OK;

  return (
    <div className="cv cv-gauge">
      <style>{CSS}</style>
      <div className="cv-g-top">
        <span>{label}</span>
        <b style={{ color: colour }}>{Math.round(pct)}%</b>
      </div>
      <div className="cv-g-bar">
        <i style={{ width: `${pct}%`, background: colour }} />
      </div>
      <div className="cv-g-sub">
        {sub ?? `${fmt(value)} of ${fmt(max)}`}
        {hot && <b style={{ color: BAD }}> · needs attention</b>}
      </div>
    </div>
  );
}

/** Fill missing days with zeros so a gap in the data reads as a gap, not as a
    straight line between two distant points. */
export function dailySeries(
  rows: Array<{ date: string | Date; value: number }>, days = 30,
): Point[] {
  const byDay = new Map<string, number>();
  for (const r of rows ?? []) {
    const k = new Date(r.date).toISOString().slice(0, 10);
    byDay.set(k, (byDay.get(k) ?? 0) + Number(r.value || 0));
  }
  const out: Point[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    out.push({
      label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
      value: byDay.get(k) ?? 0,
    });
  }
  return out;
}

const CSS = `
.cv{width:100%}
.cv-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px}
.cv-head span{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;
  letter-spacing:.06em}
.cv-head b{font-size:12px;font-weight:800;color:var(--text);font-variant-numeric:tabular-nums}
.cv-head b.up{color:#6EE7B7}
.cv-head b.down{color:#FCA5A5}

.cv-svg{width:100%;display:block;color:var(--text);overflow:visible}
.cv-axis{display:flex;justify-content:space-between;align-items:baseline;margin-top:6px}
.cv-axis span{font-size:10px;color:var(--muted)}
.cv-axis b{font-size:13px;font-weight:800;color:var(--text);font-variant-numeric:tabular-nums}

.cv-rank{display:flex;flex-direction:column;gap:7px}
.cv-row{display:grid;grid-template-columns:minmax(64px,26%) 1fr auto;align-items:center;gap:10px}
.cv-lbl{font-size:11.5px;color:var(--text);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}
.cv-bar{height:8px;border-radius:99px;background:var(--surface-2);overflow:hidden}
.cv-bar i{display:block;height:100%;border-radius:99px;
  background:linear-gradient(90deg,#6C3CE1,#E9408B,#F27121);transition:width .5s cubic-bezier(.2,.8,.3,1)}
.cv-val{font-size:11.5px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;
  min-width:38px;text-align:right}
.cv-more{margin-top:8px;font-size:10.5px;color:var(--muted);text-align:center}

.cv-split{display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.cv-ring{position:relative;flex-shrink:0}
.cv-ring svg{width:100%;height:100%;transform:rotate(0)}
.cv-mid{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;pointer-events:none}
.cv-mid b{font-size:19px;font-weight:800;color:var(--text);line-height:1;
  font-variant-numeric:tabular-nums}
.cv-mid span{font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;
  margin-top:3px}
.cv-key{flex:1;min-width:150px;display:flex;flex-direction:column;gap:6px}
.cv-key>div{display:grid;grid-template-columns:9px 1fr auto auto;align-items:center;gap:8px}
.cv-key i{width:9px;height:9px;border-radius:3px}
.cv-key span{font-size:11.5px;color:var(--text)}
.cv-key b{font-size:11.5px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}
.cv-key em{font-style:normal;font-size:10px;color:var(--muted);min-width:30px;text-align:right}

.cv-gauge{display:flex;flex-direction:column;gap:5px}
.cv-g-top{display:flex;justify-content:space-between;align-items:baseline}
.cv-g-top span{font-size:11.5px;color:var(--text);font-weight:600}
.cv-g-top b{font-size:14px;font-weight:800;font-variant-numeric:tabular-nums}
.cv-g-bar{height:7px;border-radius:99px;background:var(--surface-2);overflow:hidden}
.cv-g-bar i{display:block;height:100%;border-radius:99px;transition:width .5s ease}
.cv-g-sub{font-size:10.5px;color:var(--muted)}

/* An empty chart must SAY it is empty. A blank box reads as broken, and the
   reader cannot tell the difference between "no data" and "failed to load". */
.cv-empty{display:grid;place-items:center;min-height:110px;padding:20px;text-align:center;
  font-size:11.5px;line-height:1.7;color:var(--muted);
  border:1px dashed var(--border);border-radius:12px}
`;
