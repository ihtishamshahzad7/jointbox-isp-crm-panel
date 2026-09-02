"use client";

import { useState, useId } from "react";
import {
  AnimatedLine, AnimatedArea, AnimatedBar, barDelay,
  useSeriesCursor, pointerIndex, ChartData, LivePulse, useCalm, motion,
} from "./chart-motion";

/**
 * NOVA CHART SYSTEM
 *
 * Built after the dashboard charts were reported as "not showing any data".
 * They were in fact rendering — but from a data shape that made them useless,
 * and with no scaffolding to read them by. Three faults, all fixed here:
 *
 *  1. GAPS COLLAPSED. The old series only created a bucket for days that had
 *     activity, so two payments in a month produced a two-bar chart with no
 *     dates. Every series is now laid on a continuous axis and zero-filled, so
 *     a quiet day reads as a quiet day rather than vanishing.
 *
 *  2. NO SCAFFOLDING. No axis, no gridlines, no value labels — nothing to
 *     tell you what you were looking at. All charts now carry axes, ticks and
 *     hover tooltips.
 *
 *  3. NO EMPTY STATE. With nothing to draw they drew nothing, which looks
 *     identical to a broken component. Every chart now says plainly that
 *     there is no data yet and what would fill it.
 *
 * Styling follows the Nova language: gradient fills for series, glass
 * tooltips, soft glows. Plain SVG — these are simple shapes and a chart
 * library would cost more in bundle size than it saves.
 */

export const NOVA = {
  primary: ["#6C3CE1", "#E9408B", "#F27121"],
  secondary: ["#00C9FF", "#92FE9D"],
  accent: ["#F7971E", "#FFD200"],
  pink: ["#E9408B", "#F27121"],
  slices: [
    ["#6C3CE1", "#E9408B"],
    ["#00C9FF", "#92FE9D"],
    ["#F7971E", "#FFD200"],
    ["#E9408B", "#F27121"],
    ["#8E2DE2", "#4A00E0"],
    ["#11998e", "#38ef7d"],
  ] as [string, string][],
};

const fmt = (n: number) =>
  Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : Math.abs(n) >= 1_000 ? `${(n / 1_000).toFixed(Math.abs(n) >= 10_000 ? 0 : 1)}k`
  : String(Math.round(n));

/** Shown instead of an empty canvas, so "no data" never looks like "broken". */
export function NoData({ title, hint, height = 180 }: { title: string; hint?: string; height?: number }) {
  return (
    <div style={{
      height, display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", gap: 8, textAlign: "center", padding: 20,
      borderRadius: 14, border: "1px dashed var(--border)",
      background: "rgba(255,255,255,.015)",
    }}>
      <div style={{
        width: 42, height: 42, borderRadius: 14, display: "grid", placeItems: "center",
        background: "linear-gradient(135deg,rgba(108,60,225,.22),rgba(233,64,139,.22))",
      }}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2" strokeLinecap="round">
          <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{title}</div>
      {hint && <div style={{ fontSize: 11.5, color: "var(--muted)", maxWidth: 280, lineHeight: 1.55 }}>{hint}</div>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   AREA / LINE — trend over a continuous axis
   ══════════════════════════════════════════════════════════════════ */
export function NovaArea({
  data, height = 200, gradient = NOVA.primary, prefix = "", emptyHint, live = false, caption,
}: {
  data: Array<{ label: string; value: number }>;
  height?: number; gradient?: string[]; prefix?: string; emptyHint?: string;
  /** Pulses the newest point, for a series that is still updating. */
  live?: boolean;
  /** Screen-reader caption for the data table. Defaults to a generic one. */
  caption?: string;
}) {
  /**
   * useId, NOT Math.random.
   *
   * These ids are referenced by url(#…) from fill and stroke. Generated
   * randomly they differ between the server render and the client hydration,
   * so React discards the markup and — in the window before it does — the
   * gradients point at ids that do not exist and the chart paints black or
   * blank. useId is stable across both, which is exactly what it is for.
   */
  const uid = useId().replace(/[:]/g, "");
  const id = `na${uid}`;

  const { active: hi, setActive: setHi, interactionProps } = useSeriesCursor(data.length);

  if (!data.length || data.every((d) => d.value === 0)) {
    return <NoData title="No activity in this period" hint={emptyHint} height={height} />;
  }

  const W = 600, H = height, PAD_L = 44, PAD_R = 12, PAD_B = 26, PAD_T = 12;
  const max = Math.max(1, ...data.map((d) => d.value));
  const niceMax = Math.ceil(max / 4) * 4 || 4;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_B - PAD_T;
  const x = (i: number) => PAD_L + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => PAD_T + plotH - (v / niceMax) * plotH;

  const line = data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.value)}`).join(" ");
  const area = `${line} L ${x(data.length - 1)} ${PAD_T + plotH} L ${x(0)} ${PAD_T + plotH} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));
  const step = Math.max(1, Math.ceil(data.length / 7));

  /**
   * Tooltip x, clamped away from both edges.
   *
   * It is translateX(-50%) centred, so at the first and last point half of it
   * used to sit outside the panel and get clipped — the two values people most
   * often want (now, and the start of the range) were the two hardest to read.
   */
  const tipPct = Math.min(88, Math.max(12, (x(hi ?? 0) / W) * 100));

  const track = (clientX: number, el: SVGSVGElement) =>
    setHi(pointerIndex(clientX, el, data.length, PAD_L, PAD_R, W));

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        aria-label={caption ?? "Trend over the selected period. Use arrow keys to read values."}
        {...interactionProps}
        style={{ width: "100%", height, display: "block", touchAction: "pan-y", ...interactionProps.style }}
        onMouseMove={(e) => track(e.clientX, e.currentTarget)}
        // Pointer events cover touch and pen as well as mouse. Without this the
        // chart was unreadable on a phone: onMouseEnter never fires there.
        onPointerDown={(e) => track(e.clientX, e.currentTarget)}
        onPointerMove={(e) => { if (e.pressure > 0 || e.pointerType === "mouse") track(e.clientX, e.currentTarget); }}
      >
        <defs>
          <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="0">
            {gradient.map((c, i) => <stop key={i} offset={`${(i / (gradient.length - 1)) * 100}%`} stopColor={c} />)}
          </linearGradient>
          <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gradient[0]} stopOpacity="0.32" />
            <stop offset="100%" stopColor={gradient[0]} stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((t, i) => {
          const yy = y(t);
          return (
            <g key={i}>
              <line x1={PAD_L} x2={W - PAD_R} y1={yy} y2={yy} stroke="var(--border)" strokeWidth="1" opacity="0.55" />
              <text x={PAD_L - 8} y={yy + 3.5} textAnchor="end"
                style={{ fill: "var(--muted)", fontSize: 9.5 }}>{prefix}{fmt(t)}</text>
            </g>
          );
        })}

        <AnimatedArea d={area} fill={`url(#${id}f)`} />
        <AnimatedLine d={line} stroke={`url(#${id}s)`} />

        {/* Labels only — the hit testing is done against the pointer, not
            against per-point rectangles, so edge points are full width. */}
        {data.map((d, i) => (
          i % step === 0 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" style={{ fill: "var(--muted)", fontSize: 9.5 }}>
              {d.label}
            </text>
          ) : null
        ))}

        {/* Only the active point gets a marker. Drawing all of them turned a
            90-day series into a bead necklace that hid the trend line. */}
        {hi !== null && (
          <>
            <line x1={x(hi)} x2={x(hi)} y1={PAD_T} y2={PAD_T + plotH}
              stroke={gradient[1] ?? gradient[0]} strokeWidth="1" strokeDasharray="3 3" opacity=".65" />
            <motion.circle
              cx={x(hi)} cy={y(data[hi].value)} r={5}
              fill={gradient[1] ?? gradient[0]} stroke="rgba(255,255,255,.9)" strokeWidth="1.4"
              initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.14 }}
              style={{ transformOrigin: `${x(hi)}px ${y(data[hi].value)}px` }}
            />
          </>
        )}

        {live && (
          <LivePulse cx={x(data.length - 1)} cy={y(data[data.length - 1].value)}
            color={gradient[1] ?? gradient[0]} />
        )}
      </svg>

      {hi !== null && (
        <div
          role="status"
          style={{
            position: "absolute", left: `${tipPct}%`, top: 4, transform: "translateX(-50%)",
            padding: "7px 12px", borderRadius: 12, pointerEvents: "none", whiteSpace: "nowrap",
            background: "rgba(20,24,45,.86)", border: "1px solid rgba(140,90,255,.45)",
            backdropFilter: "blur(14px)", boxShadow: "0 10px 30px rgba(0,0,0,.5)", fontSize: 11.5,
          }}
        >
          <span style={{ color: "rgba(255,255,255,.7)" }}>{data[hi].label}</span>{" \u00b7 "}
          <b style={{ color: "#fff" }}>{prefix}{new Intl.NumberFormat().format(data[hi].value)}</b>
        </div>
      )}

      <ChartData caption={caption ?? "Trend data"} data={data}
        format={(n) => `${prefix}${new Intl.NumberFormat().format(n)}`} />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   BARS — categorical, with axis and value on hover
   ══════════════════════════════════════════════════════════════════ */
export function NovaBars({
  data, height = 200, prefix = "", emptyHint, caption,
}: {
  data: Array<{ label: string; value: number }>;
  height?: number; prefix?: string; emptyHint?: string; caption?: string;
}) {
  const [hi, setHi] = useState<number | null>(null);
  const calm = useCalm();

  if (!data.length || data.every((d) => d.value === 0)) {
    return <NoData title="Nothing recorded yet" hint={emptyHint} height={height} />;
  }

  const max = Math.max(1, ...data.map((d) => d.value));
  const niceMax = Math.ceil(max / 4) * 4 || 4;
  const step = Math.max(1, Math.ceil(data.length / 12));

  return (
    <div>
      {/*
        The readout is a fixed-height row that is ALWAYS present, holding a
        hint when nothing is selected. Rendering it conditionally made the
        whole chart jump 20px up and down as the pointer crossed it — the
        chart moving away from the cursor that is trying to read it.
      */}
      <div style={{ height: 20, marginBottom: 6, fontSize: 11.5, color: "var(--muted)" }} role="status">
        {hi !== null
          ? <><b style={{ color: "var(--text)" }}>{data[hi].label}</b> {"\u00b7"} {prefix}{new Intl.NumberFormat().format(data[hi].value)}</>
          : "Hover, tap or use arrow keys for exact values"}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between",
          height, fontSize: 9.5, color: "var(--muted)", textAlign: "right", minWidth: 30 }}>
          {[1, 0.75, 0.5, 0.25, 0].map((f) => <span key={f}>{prefix}{fmt(niceMax * f)}</span>)}
        </div>

        <div style={{ flex: 1 }}>
          <div
            role="application"
            tabIndex={0}
            aria-label={caption ?? "Bar chart. Use arrow keys to read each value."}
            onKeyDown={(e) => {
              const cur = hi ?? -1;
              let next: number | null = null;
              if (e.key === "ArrowRight") next = Math.min(data.length - 1, cur + 1);
              else if (e.key === "ArrowLeft") next = Math.max(0, cur <= 0 ? 0 : cur - 1);
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = data.length - 1;
              else if (e.key === "Escape") next = null;
              else return;
              e.preventDefault();
              setHi(next);
            }}
            onBlur={() => setHi(null)}
            onMouseLeave={() => setHi(null)}
            style={{ position: "relative", height, display: "flex", alignItems: "flex-end",
              gap: `${Math.max(2, 30 / data.length)}%`, outlineOffset: 2 }}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <div key={f} style={{ position: "absolute", left: 0, right: 0, bottom: `${f * 100}%`,
                borderTop: "1px solid var(--border)", opacity: 0.55 }} />
            ))}
            {data.map((d, i) => (
              <AnimatedBar
                key={i}
                delay={barDelay(i, data.length)}
                onMouseEnter={() => setHi(i)}
                // Pointer, so a tap on a phone selects the bar. Previously the
                // values were simply unreachable on touch.
                onPointerDown={() => setHi(i)}
                style={{
                  flex: 1, position: "relative", zIndex: 1,
                  height: `${Math.max(1.5, (d.value / niceMax) * 100)}%`,
                  borderRadius: "8px 8px 3px 3px",
                  background: i % 2 === 0
                    ? "linear-gradient(180deg,#6C3CE1,#00C9FF)"
                    : "linear-gradient(180deg,#E9408B,#6C3CE1)",
                  opacity: hi === null || hi === i ? 1 : 0.42,
                  filter: hi === i ? "brightness(1.25)" : "none",
                  transition: calm ? "none" : "opacity .15s, filter .15s",
                  cursor: "default",
                }}
              />
            ))}
          </div>
          <div style={{ display: "flex", gap: `${Math.max(2, 30 / data.length)}%`, marginTop: 7 }}>
            {/*
              Every bar gets a cell so the labels stay aligned to the bars, but
              only every `step`-th cell carries text — which means the label
              must be allowed to OVERFLOW into its empty neighbours.

              Clipping each cell (overflow:hidden + ellipsis) was the bug: with
              thirty bars a cell is about eighteen pixels wide, so "1 Aug"
              rendered as "1.." and the axis became unreadable. The width limit
              was never real — the space either side is blank.
            */}
            {data.map((d, i) => (
              <span
                key={i}
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: "center",
                  fontSize: 9.5,
                  color: "var(--muted)",
                  whiteSpace: "nowrap",
                  overflow: "visible",
                }}
              >
                {i % step === 0 ? d.label : ""}
              </span>
            ))}
          </div>
        </div>
      </div>

      <ChartData caption={caption ?? "Chart data"} data={data}
        format={(n) => `${prefix}${new Intl.NumberFormat().format(n)}`} />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   DONUT — composition, with a legend that actually explains it
   ══════════════════════════════════════════════════════════════════ */
export function NovaDonut({
  data, size = 176, emptyHint, unit = "total",
}: {
  data: Array<{ label: string; value: number }>;
  size?: number; emptyHint?: string; unit?: string;
}) {
  const [hi, setHi] = useState<number | null>(null);
  // useId, not Math.random — see the note in NovaArea: a random id differs
  // between server and client, so url(#…) references break during hydration.
  const id = `nd${useId().replace(/[:]/g, "")}`;
  const rows = data.filter((d) => d.value > 0);
  const total = rows.reduce((s, d) => s + d.value, 0);

  if (!total) {
    return <NoData title="Nothing to break down yet" hint={emptyHint} height={size} />;
  }

  const R = size / 2 - 14, C = 2 * Math.PI * R;
  /**
   * Running offsets via reduce rather than a mutated closure variable.
   *
   * The `let acc` version worked, but React's compiler cannot prove a callback
   * that writes to an outer binding is pure, so it opts the component out of
   * memoisation — and on a dashboard that re-renders on every poll, that is a
   * real cost. Same maths, same output, no mutation.
   */
  const segs = rows.reduce<Array<(typeof rows)[number] & { len: number; offset: number; i: number }>>(
    (out, d, i) => {
      const len = (d.value / total) * C;
      const acc = out.length ? -out[out.length - 1].offset + out[out.length - 1].len : 0;
      out.push({ ...d, len, offset: -acc, i });
      return out;
    },
    [],
  );

  const shown = hi !== null ? rows[hi] : null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: "visible" }}>
          <defs>
            {NOVA.slices.map((g, i) => (
              <linearGradient key={i} id={`${id}${i}`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor={g[0]} /><stop offset="100%" stopColor={g[1]} />
              </linearGradient>
            ))}
          </defs>
          <g transform={`translate(${size / 2},${size / 2}) rotate(-90)`}>
            <circle r={R} fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="18" />
            {segs.map((s) => (
              <circle key={s.i} r={R} fill="none"
                stroke={`url(#${id}${s.i % NOVA.slices.length})`}
                strokeWidth={hi === s.i ? 23 : 18}
                strokeDasharray={`${s.len} ${C - s.len}`}
                strokeDashoffset={s.offset}
                onMouseEnter={() => setHi(s.i)} onMouseLeave={() => setHi(null)}
                style={{ transition: "stroke-width .2s", cursor: "default" }} />
            ))}
          </g>
          <text x={size / 2} y={size / 2 - 2} textAnchor="middle"
            style={{ fill: "var(--text)", fontSize: 26, fontWeight: 800, letterSpacing: "-.02em" }}>
            {new Intl.NumberFormat().format(shown ? shown.value : total)}
          </text>
          <text x={size / 2} y={size / 2 + 15} textAnchor="middle"
            style={{ fill: "var(--muted)", fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase" }}>
            {shown ? `${Math.round((shown.value / total) * 100)}% share` : unit}
          </text>
        </svg>
      </div>

      <div style={{ display: "grid", gap: 6, minWidth: 170, flex: 1 }}>
        {rows.map((d, i) => (
          <div key={d.label}
            onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}
            style={{
              display: "flex", alignItems: "center", gap: 9, fontSize: 12, padding: "5px 8px",
              margin: "0 -8px", borderRadius: 8, cursor: "default",
              background: hi === i ? "rgba(255,255,255,.05)" : "transparent",
              opacity: hi === null || hi === i ? 1 : 0.45,
              transition: "background .15s, opacity .15s",
            }}>
            <span style={{
              width: 10, height: 10, borderRadius: 3, flexShrink: 0,
              background: `linear-gradient(135deg,${NOVA.slices[i % NOVA.slices.length][0]},${NOVA.slices[i % NOVA.slices.length][1]})`,
            }} />
            <span style={{ flex: 1, color: "var(--muted)", overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label}</span>
            <b style={{ color: "var(--text)" }}>{new Intl.NumberFormat().format(d.value)}</b>
            <span style={{ color: "var(--muted)", fontSize: 10.5, minWidth: 32, textAlign: "right" }}>
              {Math.round((d.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   RADIAL — concentric rings, one per measure.
   Reads faster than four separate donuts when the measures belong to the
   same whole: the rings are directly comparable because they share a centre
   and a scale.
   ══════════════════════════════════════════════════════════════════ */
export function NovaRadial({
  rings, size = 200, centreValue, centreLabel,
}: {
  rings: Array<{ label: string; value: number; total: number; color: [string, string] }>;
  size?: number; centreValue?: React.ReactNode; centreLabel?: string;
}) {
  const [hi, setHi] = useState<number | null>(null);
  // useId, not Math.random — see the note in NovaArea: a random id differs
  // between server and client, so url(#…) references break during hydration.
  const id = `nr${useId().replace(/[:]/g, "")}`;

  if (!rings.length || rings.every((r) => r.total === 0)) {
    return <NoData title="No data to chart yet" height={size} />;
  }

  const stroke = 13, gap = 5;
  const cx = size / 2, cy = size / 2;
  const shown = hi !== null ? rings[hi] : null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap", justifyContent: "center" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: "visible", flexShrink: 0 }}>
        <defs>
          {rings.map((r, i) => (
            <linearGradient key={i} id={`${id}${i}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={r.color[0]} /><stop offset="100%" stopColor={r.color[1]} />
            </linearGradient>
          ))}
        </defs>
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          {rings.map((r, i) => {
            const rad = size / 2 - 10 - i * (stroke + gap);
            if (rad < 14) return null;
            const circ = 2 * Math.PI * rad;
            const pct = r.total > 0 ? Math.min(1, r.value / r.total) : 0;
            return (
              <g key={i}>
                <circle cx={cx} cy={cy} r={rad} fill="none" stroke="rgba(255,255,255,.055)" strokeWidth={stroke} />
                <circle
                  cx={cx} cy={cy} r={rad} fill="none"
                  stroke={`url(#${id}${i})`} strokeWidth={hi === i ? stroke + 3 : stroke}
                  strokeLinecap="round"
                  strokeDasharray={`${circ * pct} ${circ}`}
                  onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}
                  style={{
                    transition: "stroke-width .2s",
                    opacity: hi === null || hi === i ? 1 : 0.3,
                    cursor: "default",
                    animation: `nvRing 1s ${i * 0.1}s cubic-bezier(.2,.8,.2,1) both`,
                  }}
                />
              </g>
            );
          })}
        </g>
        <style>{`@keyframes nvRing { from { stroke-dasharray: 0 9999; } }`}</style>
        <text x={cx} y={cy - 4} textAnchor="middle"
          style={{ fill: "var(--text)", fontSize: 27, fontWeight: 800, letterSpacing: "-.03em" }}>
          {shown ? shown.value.toLocaleString() : centreValue}
        </text>
        <text x={cx} y={cy + 15} textAnchor="middle"
          style={{ fill: "var(--muted)", fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase" }}>
          {shown ? shown.label : centreLabel}
        </text>
      </svg>

      <div style={{ display: "grid", gap: 9, minWidth: 160 }}>
        {rings.map((r, i) => {
          const pct = r.total > 0 ? Math.round((r.value / r.total) * 100) : 0;
          return (
            <div key={r.label}
              onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}
              style={{
                display: "flex", alignItems: "center", gap: 9, fontSize: 12,
                padding: "5px 8px", margin: "0 -8px", borderRadius: 8, cursor: "default",
                background: hi === i ? "rgba(255,255,255,.05)" : "transparent",
                opacity: hi === null || hi === i ? 1 : 0.45,
                transition: "background .15s, opacity .15s",
              }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, flexShrink: 0,
                background: `linear-gradient(135deg,${r.color[0]},${r.color[1]})` }} />
              <span style={{ flex: 1, color: "var(--muted)" }}>{r.label}</span>
              <b style={{ color: "var(--text)" }}>{r.value.toLocaleString()}</b>
              <span style={{ color: "var(--muted)", fontSize: 10.5, minWidth: 32, textAlign: "right" }}>{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Zero-filled daily series.
   THE fix for "charts show no data": bucketing only days that had activity
   collapses a month into two points. This lays every day on the axis.
   ══════════════════════════════════════════════════════════════════ */
export function dailySeries<T>(
  rows: T[],
  getDate: (r: T) => string | Date | null | undefined,
  getValue: (r: T) => number,
  days = 14,
): Array<{ label: string; value: number }> {
  const buckets = new Map<string, number>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }

  for (const r of rows) {
    const raw = getDate(r);
    if (!raw) continue;
    const key = new Date(raw).toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) || 0) + getValue(r));
  }

  return [...buckets.entries()].map(([k, v]) => ({
    label: new Date(k).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    value: v,
  }));
}
