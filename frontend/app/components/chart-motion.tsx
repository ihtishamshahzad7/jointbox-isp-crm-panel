"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";

/**
 * CHART MOTION + INTERACTION PRIMITIVES.
 *
 * Shared by the Nova charts so every graph in the product animates and
 * responds the same way. Deliberately carries NO colour of its own — the
 * palette stays exactly where it already lives, in NOVA and the CSS tokens.
 * This file only handles movement, input and accessibility.
 *
 * WHY ANIMATE A CHART AT ALL
 * Not for decoration. Two specific jobs:
 *
 *   1. ENTRANCE tells you the chart is live rather than a static image, and
 *      draws the eye along the time axis in the direction the data reads.
 *   2. TRANSITION between datasets is the one that actually matters. When
 *      someone switches a range from 1h to 24h, a snap-replace gives no clue
 *      whether the shape genuinely changed or they are looking at different
 *      data. Tweening the same path between the two states makes the change
 *      itself legible.
 *
 * Everything moves with `transform`, `opacity` or SVG geometry attributes —
 * never layout properties — so a dashboard with six charts on a five-year-old
 * office laptop stays smooth.
 */

/** True when the operating system asks for less movement. */
export function useCalm(): boolean {
  return useReducedMotion() ?? false;
}

export const CHART_SPRING = { type: "spring", stiffness: 210, damping: 28, mass: 0.9 } as const;
export const CHART_EASE = [0.22, 0.61, 0.36, 1] as const;

/**
 * A line that draws itself on first render and morphs when the data changes.
 *
 * The draw-on uses stroke-dasharray/offset — the standard trick, and the only
 * one that animates a stroke without re-laying-out the path. `pathLength={1}`
 * normalises the dash units so the same numbers work for any path length,
 * which matters because these charts are redrawn at every container width.
 */
export function AnimatedLine({
  d,
  stroke,
  strokeWidth = 2.5,
  duration = 0.9,
}: {
  d: string;
  stroke: string;
  strokeWidth?: number;
  duration?: number;
}) {
  const calm = useCalm();
  return (
    <motion.path
      d={d}
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
      strokeLinecap="round"
      pathLength={1}
      initial={calm ? false : { pathLength: 0, opacity: 0 }}
      animate={{ pathLength: 1, opacity: 1 }}
      // `d` is animated on change so switching range morphs rather than snaps.
      transition={{
        pathLength: { duration: calm ? 0 : duration, ease: CHART_EASE },
        opacity: { duration: calm ? 0 : 0.2 },
        d: { duration: calm ? 0 : 0.45, ease: CHART_EASE },
      }}
    />
  );
}

/**
 * The filled area under a line.
 *
 * Fades in AFTER the line has mostly drawn, so the eye follows the line first
 * and the fill arrives as context. Reversing that order makes the chart look
 * like it is loading rather than drawing.
 */
export function AnimatedArea({ d, fill, delay = 0.35 }: { d: string; fill: string; delay?: number }) {
  const calm = useCalm();
  return (
    <motion.path
      d={d}
      fill={fill}
      initial={calm ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        opacity: { duration: calm ? 0 : 0.5, delay: calm ? 0 : delay, ease: CHART_EASE },
        d: { duration: calm ? 0 : 0.45, ease: CHART_EASE },
      }}
    />
  );
}

/**
 * A bar that grows from its baseline.
 *
 * `transformOrigin: bottom` + scaleY, not an animated height: scale is a
 * compositor transform, height is a layout change on every frame. With twenty
 * bars that is the difference between smooth and janky.
 *
 * The stagger is capped in the caller — see `barDelay`.
 */
export function AnimatedBar({
  children,
  delay = 0,
  style,
  ...rest
}: {
  children?: React.ReactNode;
  delay?: number;
  style?: React.CSSProperties;
} & Omit<React.ComponentProps<typeof motion.div>, "style" | "children">) {
  const calm = useCalm();
  return (
    <motion.div
      initial={calm ? false : { scaleY: 0, opacity: 0 }}
      animate={{ scaleY: 1, opacity: 1 }}
      transition={{
        scaleY: { ...CHART_SPRING, delay: calm ? 0 : delay },
        opacity: { duration: calm ? 0 : 0.18, delay: calm ? 0 : delay },
      }}
      style={{ transformOrigin: "bottom", ...style }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/**
 * Per-bar entrance delay, capped.
 *
 * Without the cap a 90-day chart takes nine seconds to finish appearing —
 * a "delightful" animation turned into a hang. Past the cap every remaining
 * bar arrives together, which nobody notices and everybody benefits from.
 */
export function barDelay(index: number, count: number, total = 0.45): number {
  if (count <= 1) return 0;
  return (Math.min(index, count - 1) / (count - 1)) * total;
}

/**
 * Keyboard + pointer navigation for a series.
 *
 * WHY THIS EXISTS
 * The charts were mouse-only. `onMouseEnter` does not fire on a touchscreen,
 * so on the phones field staff actually use, no value could be read at all —
 * the tooltip was unreachable, not merely awkward. And with no keyboard path,
 * the data was invisible to anyone not using a mouse.
 *
 * Returns props for the SVG plus the active index. Arrow keys move along the
 * series, Home/End jump to the ends, Escape clears — the same conventions as
 * a listbox, because that is what a series of readable points is.
 */
export function useSeriesCursor(count: number) {
  const [active, setActive] = React.useState<number | null>(null);

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (!count) return;
      const cur = active ?? -1;
      let next: number | null = null;
      if (e.key === "ArrowRight") next = Math.min(count - 1, cur + 1);
      else if (e.key === "ArrowLeft") next = Math.max(0, cur <= 0 ? 0 : cur - 1);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = count - 1;
      else if (e.key === "Escape") next = null;
      else return;
      // Only swallow the event once we know we handled it, so Tab and every
      // other key still behave normally.
      e.preventDefault();
      setActive(next);
    },
    [active, count],
  );

  return {
    active,
    setActive,
    /** Spread onto the <svg>. */
    interactionProps: {
      tabIndex: 0,
      role: "application" as const,
      onKeyDown,
      onBlur: () => setActive(null),
      onMouseLeave: () => setActive(null),
      style: { outlineOffset: 2 },
    },
  };
}

/**
 * Maps a pointer position to the nearest data index.
 *
 * Used for touch as well as mouse. Per-point invisible hit rectangles were the
 * previous approach and they have two faults: the first and last are half
 * width (the rect starts at a negative x), and on a 90-point series each is
 * about 6px wide — an impossible target on a phone. Measuring the pointer
 * against the plot once solves both.
 */
export function pointerIndex(
  clientX: number,
  el: SVGSVGElement | HTMLElement,
  count: number,
  padLeft: number,
  padRight: number,
  viewWidth: number,
): number | null {
  if (!count) return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width) return null;
  // The SVG is scaled by viewBox, so convert the screen x into view units.
  const scale = viewWidth / rect.width;
  const xv = (clientX - rect.left) * scale;
  const plotW = viewWidth - padLeft - padRight;
  if (plotW <= 0) return null;
  const t = (xv - padLeft) / plotW;
  const i = Math.round(t * (count - 1));
  return Math.max(0, Math.min(count - 1, i));
}

/**
 * The same numbers as a real table, for screen readers.
 *
 * An SVG chart is a picture: without this it announces as nothing at all. A
 * `role="img"` with a summary label would say "revenue chart" and stop, which
 * tells a blind operator that data exists and withholds it. The table is the
 * data, visually hidden, properly structured.
 */
export function ChartData({
  caption,
  data,
  format = (n: number) => new Intl.NumberFormat().format(n),
}: {
  caption: string;
  data: Array<{ label: string; value: number }>;
  format?: (n: number) => string;
}) {
  return (
    <table className="nv-chart-sr">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d, i) => (
          <tr key={`${d.label}-${i}`}>
            <th scope="row">{d.label}</th>
            <td>{format(d.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A gently pulsing ring on the most recent point.
 *
 * Only for live series. It answers "is this still updating, or did it freeze?"
 * — a question an operator watching a bandwidth graph asks constantly, and
 * which a static dot cannot answer.
 */
export function LivePulse({ cx, cy, color }: { cx: number; cy: number; color: string }) {
  const calm = useCalm();
  if (calm) return null;
  return (
    <motion.circle
      cx={cx}
      cy={cy}
      r={4}
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      initial={{ opacity: 0.7, scale: 0.6 }}
      animate={{ opacity: 0, scale: 2.6 }}
      transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
      style={{ transformOrigin: `${cx}px ${cy}px` }}
    />
  );
}

export { motion };
