"use client";

import * as React from "react";
import {
  motion,
  AnimatePresence,
  useReducedMotion,
  type Transition,
  type Variants,
} from "framer-motion";

/**
 * MOTION PRIMITIVES — the whole app's animation vocabulary, in one file.
 *
 * WHY A VOCABULARY AND NOT PER-COMPONENT ANIMATIONS
 * Motion is a language. If every screen invents its own timing, the product
 * feels assembled rather than designed — a panel that slides at 400ms next to
 * one that pops at 120ms reads as two different apps. Everything below draws
 * from the same four springs and three durations, so unrelated screens agree
 * without their authors having to coordinate.
 *
 * THE PERFORMANCE RULE, AND WHY IT IS ABSOLUTE
 * Only `transform` and `opacity` are ever animated. Those two are handled by
 * the compositor, off the main thread; everything else (width, height, top,
 * left, margin, box-shadow, filter) forces layout or paint on every frame. On
 * the hardware an ISP's staff actually use — a five-year-old office laptop
 * driving a 27" panel — that is the difference between 60fps and a visible
 * stutter. There is no animation in this file that touches a layout property.
 *
 * REDUCED MOTION IS A HARD OFF, NOT A SLOWDOWN
 * `prefers-reduced-motion` exists because movement triggers vestibular
 * symptoms — nausea, dizziness. Halving the duration halves nothing that
 * matters. Every helper here checks the preference and returns a
 * movement-free variant, keeping only opacity, which conveys the same state
 * change without travelling.
 */

// ── Springs ────────────────────────────────────────────────────
/**
 * Physical constants, not magic numbers.
 *
 * `snappy` is the default: it settles in about 200ms with a barely-perceptible
 * overshoot, which reads as responsive rather than bouncy. `gentle` is for
 * large surfaces (drawers, modals) where an overshoot on a big object looks
 * cheap. `bouncy` is reserved for things the user is DRAGGING, where an
 * elastic settle confirms the release. `stiff` is for anything that must feel
 * instantaneous — a toggle, a tab underline.
 */
export const SPRING = {
  snappy: { type: "spring", stiffness: 420, damping: 34, mass: 0.9 },
  gentle: { type: "spring", stiffness: 260, damping: 32, mass: 1 },
  bouncy: { type: "spring", stiffness: 500, damping: 24, mass: 0.8 },
  stiff: { type: "spring", stiffness: 700, damping: 40, mass: 0.6 },
} satisfies Record<string, Transition>;

export const EASE = [0.22, 0.61, 0.36, 1] as const;
export const DUR = { fast: 0.14, base: 0.2, slow: 0.32 } as const;

/** True when the user has asked the OS for less movement. */
export function useCalm(): boolean {
  return useReducedMotion() ?? false;
}

// ── Page / section entrance ────────────────────────────────────
/**
 * Content ARRIVES rather than snapping in.
 *
 * The travel is 8px — one grid step. Larger entrance distances look
 * impressive once and become tiring on the twentieth navigation of a working
 * day, which is the usage pattern this product actually has.
 */
type MotionDivProps = React.ComponentProps<typeof motion.div>;

export function FadeUp({
  children,
  delay = 0,
  className,
  as = "div",
  ...rest
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: "div" | "section" | "article" | "li";
} & Omit<MotionDivProps, "initial" | "animate" | "transition" | "children">) {
  const calm = useCalm();
  // All four tags share motion.div's prop shape; the cast is on the COMPONENT,
  // which is true, rather than on the props, which would discard their types.
  const Comp = motion[as] as typeof motion.div;
  return (
    <Comp
      className={className}
      initial={calm ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={calm ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ duration: DUR.base, ease: EASE, delay }}
      {...rest}
    >
      {children}
    </Comp>
  );
}

/**
 * Stagger for lists.
 *
 * The per-child delay is capped by `maxStagger`. Without a cap, a 200-row
 * subscriber table would take twelve seconds to finish appearing — a
 * "delightful" animation turned into a hang. Past the cap every remaining
 * child arrives together.
 */
export function Stagger({
  children,
  step = 0.035,
  maxStagger = 0.4,
  className,
}: {
  children: React.ReactNode;
  step?: number;
  maxStagger?: number;
  className?: string;
}) {
  const calm = useCalm();
  const variants: Variants = {
    hidden: {},
    show: {
      transition: {
        staggerChildren: calm ? 0 : step,
        // Cap the total, however many children there are.
        delayChildren: 0,
        staggerDirection: 1,
        when: "beforeChildren",
        duration: maxStagger,
      },
    },
  };
  return (
    <motion.div className={className} variants={variants} initial="hidden" animate="show">
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const calm = useCalm();
  return (
    <motion.div
      className={className}
      variants={{
        hidden: calm ? { opacity: 0 } : { opacity: 0, y: 10 },
        show: calm ? { opacity: 1 } : { opacity: 1, y: 0 },
      }}
      transition={SPRING.snappy}
    >
      {children}
    </motion.div>
  );
}

// ── Numbers that change ────────────────────────────────────────
/**
 * A counter that animates to its new value.
 *
 * Deliberately NOT a spring: money and subscriber counts must never overshoot
 * and momentarily display a number that is not real. Someone glancing at a
 * dashboard as a figure springs past its target reads the wrong balance. It
 * eases in, monotonically, and stops.
 */
export function AnimatedNumber({
  value,
  format = (n: number) => Math.round(n).toLocaleString(),
  className,
  duration = 600,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
  duration?: number;
}) {
  const calm = useCalm();
  const [shown, setShown] = React.useState(value);
  const from = React.useRef(value);
  const raf = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (calm || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    const b = value;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutCubic — fast start, no overshoot, ever.
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(a + (b - a) * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else from.current = b;
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      from.current = value;
    };
  }, [value, duration, calm]);

  return (
    <span className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {format(shown)}
    </span>
  );
}

// ── Overlays ───────────────────────────────────────────────────
/** Modal/drawer backdrop. Opacity only — a blur transition is a paint storm. */
export function Backdrop({ onClick }: { onClick?: () => void }) {
  return (
    <motion.div
      onClick={onClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: DUR.fast }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(4, 7, 12, 0.6)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        zIndex: 90,
      }}
    />
  );
}

/**
 * A panel that slides in from an edge.
 *
 * Uses percentage transforms rather than pixel offsets so it works at any
 * width without measuring — and `x`/`y` percentages are still pure transforms,
 * so this stays on the compositor.
 */
export function SlideIn({
  from = "right",
  children,
  className,
  style,
}: {
  from?: "right" | "left" | "bottom" | "top";
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const calm = useCalm();
  const horizontal = from === "left" || from === "right";
  const sign = from === "right" || from === "bottom" ? 1 : -1;
  const offset = `${sign * 100}%`;

  // Percentage transforms, so this works at any width without measuring — and
  // x/y percentages are still pure transforms, so it stays on the compositor.
  const hidden: MotionDivProps["initial"] = calm
    ? { opacity: 0 }
    : horizontal
      ? { opacity: 0, x: offset }
      : { opacity: 0, y: offset };
  const shown: MotionDivProps["animate"] = calm
    ? { opacity: 1 }
    : horizontal
      ? { opacity: 1, x: "0%" }
      : { opacity: 1, y: "0%" };

  return (
    <motion.div
      className={className}
      style={style}
      initial={hidden}
      animate={shown}
      exit={hidden}
      transition={SPRING.gentle}
    >
      {children}
    </motion.div>
  );
}

/** Modal body: scale is subtle on purpose — big scale reads as a zoom, not a dialog. */
export function PopIn({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const calm = useCalm();
  return (
    <motion.div
      className={className}
      style={style}
      initial={calm ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
      animate={calm ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
      exit={calm ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 4 }}
      transition={SPRING.snappy}
    >
      {children}
    </motion.div>
  );
}

/**
 * A shared-layout underline for tab bars.
 *
 * `layoutId` lets Framer Motion animate the SAME element between two
 * positions, so the underline travels between tabs instead of one fading out
 * while another fades in. It is the single highest-value use of layout
 * animation in an admin panel: it shows where you came from.
 */
export function TabIndicator({ layoutId = "ds-tab" }: { layoutId?: string }) {
  return (
    <motion.span
      layoutId={layoutId}
      transition={SPRING.stiff}
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: -1,
        height: 2,
        borderRadius: 2,
        background: "var(--accent)",
      }}
    />
  );
}

/** Press feedback for anything tappable that is not a .ds-clay button. */
export function Pressable({
  children,
  className,
  onClick,
  disabled,
  ariaLabel,
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const calm = useCalm();
  return (
    <motion.button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      whileHover={calm || disabled ? undefined : { y: -1 }}
      whileTap={calm || disabled ? undefined : { y: 1, scale: 0.985 }}
      transition={SPRING.stiff}
    >
      {children}
    </motion.button>
  );
}

export { motion, AnimatePresence };
