/**
 * SHARED MOTION CATALOG (framer-motion)
 *
 * One source of truth for every tween/variant in the panel. Components import
 * from here instead of hardcoding durations or easings inline, so the whole
 * product moves on the same rhythm and a single knob retunes everything.
 *
 * Design contract (from the motion catalog):
 *   • Durations are 150–400ms except one deliberate hero moment.
 *   • Ease curve is [0.16, 1, 0.3, 1] (the "expo-out" spring-feel) unless a
 *     gesture calls for a spring.
 *   • Every discrete transition uses framer; infinite loops stay in CSS.
 *   • prefers-reduced-motion falls back to instant / opacity-only.
 *
 * These are plain variant objects + tiny pure helpers — safe to import from
 * both client and server modules. They only become "client" when a motion
 * component consumes them.
 */
import { animate, useMotionValue, useReducedMotion, useTransform } from "framer-motion";

/** Cubic-bezier ease used across discrete transitions. */
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Spring config for pops / shared-element morphs. */
export const SPRING = { type: "spring", stiffness: 400, damping: 28 } as const;

/* ── Variants (`variants` prop on motion.*) ─────────────────────────── */

/** Mount: rise 12px + fade. The default "content arrived" treatment. */
export const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: EASE_OUT },
  },
};

/** Scale-in for modals / cards. */
export const scaleIn = {
  hidden: { opacity: 0, scale: 0.96 },
  show: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.2, ease: EASE_OUT },
  },
};

/** Slide from the right — drawers, toasts, fly-out panels. */
export const slideInRight = {
  hidden: { opacity: 0, x: 40 },
  show: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.28, ease: EASE_OUT },
  },
};

/** Slide from the bottom — mobile sheets. */
export const slideInUp = {
  hidden: { opacity: 0, y: 40 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, ease: EASE_OUT },
  },
};

/** Parent that staggers its `show` children by 50ms each. */
export const staggerChildren = {
  show: { transition: { staggerChildren: 0.05 } },
};

/** Per-row stagger (20ms) for tables/lists. */
export const staggerRows = {
  show: { transition: { staggerChildren: 0.02 } },
};

/* ── Exit variants (for AnimatePresence popLayout etc.) ─────────────── */

/** Collapse a row: fade + height to 0 + margin/padding to 0. */
export const rowExit = {
  exit: {
    opacity: 0,
    height: 0,
    marginTop: 0,
    marginBottom: 0,
    paddingTop: 0,
    paddingBottom: 0,
    transition: { duration: 0.2, ease: EASE_OUT },
  },
};

/** Generic quick fade (also the reduced-motion fallback). */
export const fade = {
  hidden: { opacity: 0 },
  show: { opacity: 1 },
  exit: { opacity: 0 },
};

/**
 * True if the user prefers reduced motion. Components should call this once
 * and pass `animate={reduced ? undefined : ...}` or fall back to the
 * opacity-only `fade` variants when it is true.
 */
export function usePrefersReducedMotion(): boolean {
  return !!useReducedMotion();
}

/* ── Count-up hook (Part 2, item 3) ─────────────────────────────────── */

/**
 * Animate a number from 0 to `target` over ~600ms on mount / when target
 * changes. Returns a motion value ready for useTransform formatting.
 *
 *   const count = useCountUp(total)
 *   <motion.span>{useTransform(count, v => Math.round(v).toLocaleString())}</motion.span>
 */
export function useCountUp(target: number, duration = 0.6) {
  const mv = useMotionValue(0);
  const from = (next: number) => {
    mv.set(0);
    animate(mv, next, { duration, ease: EASE_OUT });
  };
  return useTransform(mv, (v) => Math.round(v));
}
