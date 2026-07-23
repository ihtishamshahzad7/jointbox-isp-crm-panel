"use client";

import { useState, useMemo } from "react";

/**
 * Charts built for comparison, not decoration.
 *
 * The rule applied throughout: a chart must let you answer "compared to
 * what?". A bar on its own is a quantity; a bar next to last period's bar is
 * information. So every component here takes a baseline or a second dimension
 * and encodes it visually rather than leaving it in a tooltip.
 *
 * Plain SVG — no chart library. These are simple shapes, and a dependency
 * would cost more in bundle size than it saves in code.
 */

const fmt = (n: number) =>
  Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : Math.abs(n) >= 1_000 ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  : String(Math.round(n));

/* ── Revenue: current bars with the previous period behind them ──────────
   The comparison sits *behind* the bar as a ghost rather than beside it, so
   the eye reads one series with a reference line instead of two competing
   series. Where the solid bar is shorter than the ghost, that period got
   worse — which is the thing you want visible without reading numbers.     */
export function ComparisonBars({
  data, height = 200, color = "#3b82f6", prefix = "",
}: {
  data: Array<{ label: string; value: number; previous: number }>;
  height?: number; color?: string; prefix?: string;
}) {
  const [hi, setHi] = useState<number | null>(null);
  const max = Math.max(1, ...data.flatMap((d) => [d.value, d.previous]));
  const bw = 100 / Math.max(data.length, 1);

  if (!data.length) return <Empty />;
  const d = hi !== null ? data[hi] : null;
  const delta = d ? d.value - d.previous : 0;

  return (
    <div>
      <div style={{ height: 22, fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>
        {d ? (
          <>
            <b style={{ color: "var(--text)" }}>{d.label}</b>
            {" · "}{prefix}{fmt(d.value)}
            <span style={{ color: delta >= 0 ? "#10b981" : "#ef4444", marginLeft: 6, fontWeight: 600 }}>
              {delta >= 0 ? "▲" : "▼"} {prefix}{fmt(Math.abs(delta))}
            </span>
            <span style={{ marginLeft: 6 }}>vs {prefix}{fmt(d.previous)} previously</span>
          </>
        ) : "Hover a bar to compare it with the same point in the previous period"}
      </div>

      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none"
        style={{ width: "100%", height, display: "block", overflow: "visible" }}>
        {[0.25, 0.5, 0.75, 1].map((g) => (
          <line key={g} x1="0" x2="100" y1={height - g * height} y2={height - g * height}
            stroke="var(--border)" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
        ))}
        {data.map((p, i) => {
          const h = (p.value / max) * height;
          const ph = (p.previous / max) * height;
          const x = i * bw;
          return (
            <g key={i} onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}>
              <rect x={x} y={0} width={bw} height={height} fill="transparent" />
              {/* previous period — a ghost reference */}
              <rect x={x + bw * 0.18} y={height - ph} width={bw * 0.64} height={ph}
                fill="var(--muted)" opacity={0.22} rx="0.6" />
              {/* current period */}
              <rect x={x + bw * 0.28} y={height - h} width={bw * 0.44} height={h}
                fill={color} opacity={hi === null || hi === i ? 1 : 0.4} rx="0.6"
                style={{ transition: "opacity .15s" }} />
            </g>
          );
        })}
      </svg>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7,
        fontSize: 10, color: "var(--muted)" }}>
        <span>{data[0]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/* ── Growth: joiners up, leavers down ────────────────────────────────────
   Drawn as a diverging chart around a zero line, with net as a line on top.
   A cumulative total would always slope upward and always look healthy; this
   makes churn impossible to hide.                                          */
export function DivergingBars({
  data, height = 190,
}: {
  data: Array<{ label: string; joined: number; left: number; net: number }>;
  height?: number;
}) {
  const [hi, setHi] = useState<number | null>(null);
  if (!data.length) return <Empty />;

  const max = Math.max(1, ...data.flatMap((d) => [d.joined, d.left]));
  const mid = height / 2;
  const bw = 100 / data.length;
  const d = hi !== null ? data[hi] : null;

  const netPath = data.map((p, i) => {
    const x = i * bw + bw / 2;
    const y = mid - (p.net / max) * (mid * 0.85);
    return `${i === 0 ? "M" : "L"} ${x} ${y}`;
  }).join(" ");

  return (
    <div>
      <div style={{ height: 22, fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>
        {d ? (
          <>
            <b style={{ color: "var(--text)" }}>{d.label}</b>
            <span style={{ color: "#10b981", marginLeft: 8 }}>+{d.joined} joined</span>
            <span style={{ color: "#ef4444", marginLeft: 8 }}>−{d.left} left</span>
            <span style={{ marginLeft: 8, color: d.net >= 0 ? "#10b981" : "#ef4444", fontWeight: 600 }}>
              net {d.net >= 0 ? "+" : ""}{d.net}
            </span>
          </>
        ) : "Bars above the line are new customers, below the line are losses"}
      </div>

      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none"
        style={{ width: "100%", height, display: "block", overflow: "visible" }}>
        <line x1="0" x2="100" y1={mid} y2={mid} stroke="var(--border)" strokeWidth="1"
          vectorEffect="non-scaling-stroke" />
        {data.map((p, i) => {
          const jh = (p.joined / max) * (mid * 0.85);
          const lh = (p.left / max) * (mid * 0.85);
          const x = i * bw;
          const on = hi === null || hi === i;
          return (
            <g key={i} onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}>
              <rect x={x} y={0} width={bw} height={height} fill="transparent" />
              <rect x={x + bw * 0.24} y={mid - jh} width={bw * 0.52} height={jh}
                fill="#10b981" opacity={on ? 0.9 : 0.35} rx="0.6" style={{ transition: "opacity .15s" }} />
              <rect x={x + bw * 0.24} y={mid} width={bw * 0.52} height={lh}
                fill="#ef4444" opacity={on ? 0.9 : 0.35} rx="0.6" style={{ transition: "opacity .15s" }} />
            </g>
          );
        })}
        <path d={netPath} fill="none" stroke="#f59e0b" strokeWidth="1.6"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" opacity={0.95} />
      </svg>

      <div style={{ display: "flex", gap: 16, marginTop: 9, fontSize: 10.5, color: "var(--muted)" }}>
        <Key c="#10b981" label="Joined" />
        <Key c="#ef4444" label="Left" />
        <Key c="#f59e0b" label="Net" />
        <span style={{ marginLeft: "auto" }}>{data[0]?.label} → {data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/* ── Two-measure ranking ─────────────────────────────────────────────────
   Each row shows the same item measured two ways — customers and revenue.
   Where the two bars disagree is the point: the plan with the most customers
   is often not the one paying the bills, which a single pie cannot show.    */
export function DualBars({
  rows, aLabel, bLabel, aColor = "#3b82f6", bColor = "#10b981", bPrefix = "",
}: {
  rows: Array<{ name: string; a: number; b: number; aShare: number; bShare: number }>;
  aLabel: string; bLabel: string; aColor?: string; bColor?: string; bPrefix?: string;
}) {
  const maxA = Math.max(1, ...rows.map((r) => r.a));
  const maxB = Math.max(1, ...rows.map((r) => r.b));
  if (!rows.length) return <Empty />;

  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 10.5, color: "var(--muted)" }}>
        <Key c={aColor} label={aLabel} />
        <Key c={bColor} label={bLabel} />
      </div>

      <div style={{ display: "grid", gap: 13 }}>
        {rows.map((r) => {
          // A wide gap between the two shares means this plan is over- or
          // under-earning relative to how many customers it holds.
          const skew = Math.round(r.bShare - r.aShare);
          return (
            <div key={r.name}>
              <div style={{ display: "flex", justifyContent: "space-between",
                alignItems: "baseline", marginBottom: 5, gap: 10 }}>
                <span style={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <span style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>
                  {r.a} · {bPrefix}{fmt(r.b)}
                  {Math.abs(skew) >= 8 && (
                    <b style={{ color: skew > 0 ? "#10b981" : "#f59e0b", marginLeft: 7 }}>
                      {skew > 0 ? "over-earns" : "under-earns"}
                    </b>
                  )}
                </span>
              </div>
              <div style={{ display: "grid", gap: 3 }}>
                <Track w={(r.a / maxA) * 100} c={aColor} />
                <Track w={(r.b / maxB) * 100} c={bColor} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Aging: one stacked bar, oldest debt on the right ────────────────── */
export function StackedBar({
  segments, total, prefix = "",
}: {
  segments: Array<{ label: string; amount: number; count: number; color: string }>;
  total: number; prefix?: string;
}) {
  const [hi, setHi] = useState<number | null>(null);
  const shown = segments.filter((s) => s.amount > 0);
  if (!total || !shown.length) {
    return <div style={{ fontSize: 12, color: "#10b981", padding: "12px 0" }}>Nothing outstanding.</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", height: 30, borderRadius: 8, overflow: "hidden", gap: 2 }}>
        {shown.map((s, i) => (
          <div key={s.label}
            onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}
            style={{
              width: `${(s.amount / total) * 100}%`, background: s.color,
              opacity: hi === null || hi === i ? 1 : 0.4,
              transition: "opacity .15s", cursor: "default",
            }} />
        ))}
      </div>
      <div style={{ height: 20, marginTop: 8, fontSize: 11.5, color: "var(--muted)" }}>
        {hi !== null ? (
          <><b style={{ color: shown[hi].color }}>{shown[hi].label}</b>
            {" · "}{prefix}{fmt(shown[hi].amount)} across {shown[hi].count} invoice
            {shown[hi].count === 1 ? "" : "s"}
            {" · "}{Math.round((shown[hi].amount / total) * 100)}% of what is owed</>
        ) : "Hover a band to see how much is owed at that age"}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6, fontSize: 10.5, color: "var(--muted)" }}>
        {shown.map((s) => <Key key={s.label} c={s.color} label={`${s.label} · ${prefix}${fmt(s.amount)}`} />)}
      </div>
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────── */
function Track({ w, c }: { w: number; c: string }) {
  return (
    <div style={{ height: 7, background: "var(--surface-2)", borderRadius: 99, overflow: "hidden" }}>
      <div style={{ width: `${w}%`, height: "100%", background: c, borderRadius: 99,
        transition: "width .5s cubic-bezier(.4,0,.2,1)" }} />
    </div>
  );
}

function Key({ c, label }: { c: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: c }} />{label}
    </span>
  );
}

function Empty() {
  return <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
    Not enough data yet.
  </div>;
}

/** Big number with its change against the baseline. */
export function Delta({
  value, previous, prefix = "", percent,
}: { value: number; previous: number; prefix?: string; percent: number | null }) {
  const up = value >= previous;
  const c = up ? "#10b981" : "#ef4444";
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-.02em" }}>
        {prefix}{new Intl.NumberFormat().format(Math.round(value))}
      </span>
      <span style={{ fontSize: 12, color: c, fontWeight: 600 }}>
        {up ? "▲" : "▼"}{" "}
        {/* Percentage from a zero baseline is meaningless, so show the
            absolute movement instead of "+100%" or "∞". */}
        {percent === null
          ? `${prefix}${fmt(Math.abs(value - previous))}`
          : `${Math.abs(percent)}%`}
      </span>
      <span style={{ fontSize: 11, color: "var(--muted)" }}>
        vs {prefix}{new Intl.NumberFormat().format(Math.round(previous))} previous period
      </span>
    </div>
  );
}
