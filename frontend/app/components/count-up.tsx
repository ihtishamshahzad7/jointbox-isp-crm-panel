"use client";

import { useEffect, useRef } from "react";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { EASE_OUT, usePrefersReducedMotion } from "../../lib/motion";

/**
 * KPI count-up (Part 2, item 3).
 *
 * Animates a number from 0 to `value` on mount (~600ms) and again whenever
 * `value` changes, so a live refresh reads as a gentle recount rather than a
 * hard swap. Reduced-motion users get the final value with no animation.
 *
 *   <CountUp value={12345} />                    → "12,345"
 *   <CountUp value={8} prefix="Rs " suffix="/mo" /> → "Rs 8/mo"
 */
export default function CountUp({
  value,
  prefix = "",
  suffix = "",
  duration = 0.6,
  className,
  style,
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const reduced = usePrefersReducedMotion();
  const mv = useMotionValue(reduced ? value : 0);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    if (reduced) { mv.set(value); return; }
    const c = animate(mv, value, { duration, ease: EASE_OUT });
    return () => c.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduced]);

  // Initial mount animation from 0 (skip for reduced-motion).
  useEffect(() => {
    if (reduced) return;
    const c = animate(mv, value, { duration, ease: EASE_OUT });
    return () => c.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rounded = useTransform(mv, (v) => Math.round(v).toLocaleString());

  return (
    <span className={className} style={style}>
      {prefix}
      {reduced ? <>{value.toLocaleString()}</> : <motion.span>{rounded}</motion.span>}
      {suffix}
    </span>
  );
}
