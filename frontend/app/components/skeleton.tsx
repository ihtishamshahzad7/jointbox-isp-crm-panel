"use client";

import React from "react";

/**
 * Skeleton — shape-of-the-content placeholders shown while data loads.
 *
 * A centred "Loading…" tells the user nothing and makes the page feel like it
 * restarted. A skeleton keeps the layout stable and reads as "this is almost
 * here", which measurably feels faster even when the request takes the same
 * time. Shapes mirror the real content so nothing jumps when data arrives.
 */

export function SkeletonStyles() {
  return <style>{CSS}</style>;
}

/** A single shimmering bar. `w`/`h` accept any CSS length. */
export function SkeletonLine({ w = "100%", h = 12, r = 6, style }: { w?: string | number; h?: number; r?: number; style?: React.CSSProperties }) {
  return <span className="skl" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

/** Placeholder for a KPI/metric card grid. */
export function SkeletonCards({ count = 4, min = 170 }: { count?: number; min?: number }) {
  return (
    <div className="skl-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
      <SkeletonStyles />
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skl-card">
          <SkeletonLine w="55%" h={10} />
          <SkeletonLine w="42%" h={24} style={{ marginTop: 10 }} />
          <SkeletonLine w="70%" h={9} style={{ marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}

/** Placeholder for a data table: header strip + rows. */
export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="skl-table">
      <SkeletonStyles />
      <div className="skl-head">
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonLine key={i} w={i === 0 ? "22%" : `${Math.round(60 / cols)}%`} h={9} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="skl-row" style={{ animationDelay: `${r * 45}ms` }}>
          <span className="skl-av" />
          <span className="skl-col">
            <SkeletonLine w="58%" h={11} />
            <SkeletonLine w="34%" h={9} style={{ marginTop: 6 }} />
          </span>
          {Array.from({ length: Math.max(0, cols - 2) }).map((_, c) => (
            <SkeletonLine key={c} w={`${40 + ((r + c) % 3) * 15}px`} h={10} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Placeholder for a chart/graph panel. */
export function SkeletonChart({ height = 150 }: { height?: number }) {
  const bars = 24;
  return (
    <div className="skl-chart" style={{ height }}>
      <SkeletonStyles />
      {Array.from({ length: bars }).map((_, i) => (
        <span key={i} className="skl-bar"
          style={{ height: `${25 + Math.abs(Math.sin(i * 1.7)) * 65}%`, animationDelay: `${i * 30}ms` }} />
      ))}
    </div>
  );
}

const CSS = `
@keyframes sklShimmer { 0% { background-position: -420px 0 } 100% { background-position: 420px 0 } }
@keyframes sklIn { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }

.skl {
  display: block;
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--surface-2) 88%, transparent) 0%,
    color-mix(in srgb, var(--border) 70%, transparent) 50%,
    color-mix(in srgb, var(--surface-2) 88%, transparent) 100%);
  background-size: 420px 100%;
  animation: sklShimmer 1.25s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) { .skl, .skl-bar { animation: none } }

.skl-grid { display: grid; gap: 12px; }
.skl-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 14px 15px; animation: sklIn .25s ease both;
}

.skl-table { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.skl-head { display: flex; align-items: center; gap: 14px; padding: 11px 14px;
  background: var(--surface-2); border-bottom: 1px solid var(--border); }
.skl-row { display: flex; align-items: center; gap: 14px; padding: 12px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  animation: sklIn .3s ease both; }
.skl-row:last-child { border-bottom: none }
.skl-av { width: 34px; height: 34px; border-radius: 10px; flex: none;
  background: color-mix(in srgb, var(--surface-2) 85%, transparent); }
.skl-col { flex: 1; min-width: 0 }

.skl-chart { display: flex; align-items: flex-end; gap: 4px; padding: 10px 12px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.skl-bar { flex: 1; border-radius: 3px 3px 0 0;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  animation: sklIn .35s ease both; }
`;
