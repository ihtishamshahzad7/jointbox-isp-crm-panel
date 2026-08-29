"use client";

import * as React from "react";
import { motion, SPRING, useCalm, AnimatedNumber, FadeUp } from "./motion";

/**
 * DESIGN SYSTEM v2 COMPONENTS.
 *
 * Deliberately a NEW file rather than a rewrite of ui.tsx. That file exports
 * 23 components used across 165 screens; replacing it in place would mean one
 * enormous, unreviewable change to every page at once, in a product that
 * bills people. These live alongside it, screens adopt them as they are
 * touched, and both read the same tokens — so the two never look like
 * different apps even mid-migration.
 */

// ── Surfaces ───────────────────────────────────────────────────
/**
 * The default panel. Glass, because that is the dominant language.
 *
 * `interactive` adds a hover lift, and is opt-in on purpose: a card that
 * lifts but does nothing when clicked is a lie about what is clickable.
 */
export function GlassCard({
  children,
  className = "",
  interactive = false,
  lit = true,
  padding = "var(--s-5)",
  style,
  onClick,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;
  lit?: boolean;
  padding?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
} & Omit<
  React.ComponentProps<typeof motion.div>,
  "style" | "onClick" | "children" | "className" | "transition" | "whileHover"
>) {
  const calm = useCalm();
  return (
    <motion.div
      className={`ds-glass ${lit ? "ds-lit" : ""} ${className}`}
      onClick={onClick}
      whileHover={interactive && !calm ? { y: -2 } : undefined}
      transition={SPRING.snappy}
      style={{ padding, ...style }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/**
 * An interruption. Sharp, hard-shadowed, unmissable.
 *
 * The `role` is chosen by tone, not passed in: a danger banner is an `alert`
 * (announced immediately, because an outage is happening now), while an
 * informational one is a `status` (announced when the reader is free). Getting
 * that backwards either interrupts constantly or stays silent when it matters.
 */
export function BrutalBanner({
  tone = "warn",
  title,
  children,
  action,
}: {
  tone?: "warn" | "danger" | "neutral";
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const cls = tone === "danger" ? "ds-brut ds-brut-danger" : tone === "warn" ? "ds-brut ds-brut-warn" : "ds-brut";
  return (
    <FadeUp
      className={cls}
      role={tone === "danger" ? "alert" : "status"}
      style={{ display: "flex", gap: "var(--s-4)", alignItems: "flex-start" }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ display: "block", fontSize: "var(--t-base)", fontWeight: 800, letterSpacing: "var(--ls-tight)" }}>
          {title}
        </strong>
        {children && (
          <div style={{ marginTop: 4, fontSize: "var(--t-sm)", color: "var(--text-2)", lineHeight: "var(--lh-body)" }}>
            {children}
          </div>
        )}
      </div>
      {action}
    </FadeUp>
  );
}

// ── Actions ────────────────────────────────────────────────────
/**
 * Clay for primary, glass-ghost for everything else.
 *
 * `busy` renders a spinner AND sets aria-busy AND disables — all three,
 * because a button that merely looks busy is still clickable, and a
 * double-submitted payment is a real cost in this product.
 */
export function ClayButton({
  children,
  variant = "primary",
  busy = false,
  disabled,
  onClick,
  type = "button",
  className = "",
  style,
  ...rest
}: {
  children: React.ReactNode;
  variant?: "primary" | "ghost";
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
  style?: React.CSSProperties;
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "style" | "onClick" | "type" | "children" | "className" | "disabled"
>) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${variant === "primary" ? "ds-clay" : "ds-clay-ghost"} ${className}`}
      style={{ display: "inline-flex", alignItems: "center", gap: "var(--s-2)", ...style }}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <motion.span
      aria-hidden
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.7, ease: "linear" }}
      style={{
        width: 13,
        height: 13,
        borderRadius: "50%",
        border: "2px solid currentColor",
        borderTopColor: "transparent",
        display: "inline-block",
        flex: "none",
      }}
    />
  );
}

// ── Stat tile ──────────────────────────────────────────────────
/**
 * A headline number.
 *
 * `loading` renders a skeleton THE SIZE OF THE REAL VALUE, not a generic bar.
 * A skeleton that resolves into a differently-shaped element makes the page
 * jump after the reader has already started reading it — which is a worse
 * experience than an empty space, and the most common way skeletons are got
 * wrong.
 */
export function StatTile({
  label,
  value,
  unit,
  delta,
  loading = false,
  tone = "accent",
  format,
}: {
  label: string;
  value: number | string;
  unit?: string;
  /** Percentage change; sign decides colour and arrow. */
  delta?: number | null;
  loading?: boolean;
  tone?: "accent" | "online" | "warning" | "danger";
  format?: (n: number) => string;
}) {
  const toneVar = `var(--${tone === "accent" ? "accent" : tone})`;

  return (
    <GlassCard padding="var(--s-4) var(--s-5)" style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: "var(--t-xs)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "var(--ls-wide)",
          color: "var(--muted)",
        }}
      >
        {label}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: "var(--s-2)" }}>
        {loading ? (
          <span className="ds-skel" style={{ display: "inline-block", width: "3.5ch", height: "var(--t-2xl)" }} />
        ) : typeof value === "number" ? (
          <span style={{ fontSize: "var(--t-2xl)", fontWeight: 800, letterSpacing: "var(--ls-tight)", color: "var(--text)" }}>
            <AnimatedNumber value={value} format={format} />
          </span>
        ) : (
          <span style={{ fontSize: "var(--t-2xl)", fontWeight: 800, letterSpacing: "var(--ls-tight)", color: "var(--text)" }}>
            {value}
          </span>
        )}
        {unit && !loading && <span style={{ fontSize: "var(--t-sm)", color: "var(--muted)", fontWeight: 600 }}>{unit}</span>}
      </div>

      {delta != null && !loading && (
        <div
          style={{
            marginTop: 6,
            fontSize: "var(--t-xs)",
            fontWeight: 700,
            color: delta >= 0 ? "var(--online)" : "var(--danger)",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
          }}
        >
          {/* The arrow is aria-hidden and the direction is stated in text,
              because colour alone must never be the only carrier of meaning. */}
          <span aria-hidden>{delta >= 0 ? "▲" : "▼"}</span>
          <span>
            {Math.abs(delta).toFixed(1)}% {delta >= 0 ? "up" : "down"}
          </span>
        </div>
      )}

      <span aria-hidden style={{ display: "block", height: 2, marginTop: "var(--s-3)", borderRadius: 2, background: toneVar, opacity: 0.45 }} />
    </GlassCard>
  );
}

// ── Backlit chart frame ────────────────────────────────────────
/**
 * Wraps an existing Recharts chart in the backlit treatment.
 *
 * The glow is on the FRAME, never on the data. A glowing line is a thicker,
 * fuzzier line — a direct loss of the precision a chart exists to deliver, and
 * on a bandwidth graph that precision is the entire point. Framing gives the
 * same lit look and costs nothing in readability.
 */
export function BacklitPanel({
  title,
  subtitle,
  action,
  children,
  loading = false,
  height = 260,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  loading?: boolean;
  height?: number;
}) {
  return (
    <GlassCard className="ds-backlit ds-backlit-glow" padding="var(--s-5)">
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--s-4)", marginBottom: "var(--s-4)" }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: "var(--t-lg)", fontWeight: 700, letterSpacing: "var(--ls-tight)", color: "var(--text)" }}>
            {title}
          </h3>
          {subtitle && (
            <p style={{ margin: "2px 0 0", fontSize: "var(--t-xs)", color: "var(--muted)" }}>{subtitle}</p>
          )}
        </div>
        {action}
      </header>

      <div style={{ height }}>
        {loading ? (
          <div className="ds-skel" style={{ width: "100%", height: "100%", borderRadius: "var(--r-md)" }} />
        ) : (
          children
        )}
      </div>
    </GlassCard>
  );
}

/**
 * Gradient fill defs for Recharts areas.
 *
 * Render once inside a chart's <defs> and reference by id. Kept here so every
 * chart in the product fades at the same rate — inconsistent fills are the
 * fastest way to make a dashboard look assembled from parts.
 */
export function BacklitDefs({ id = "ds", color = "var(--accent)" }: { id?: string; color?: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity={0.38} />
        <stop offset="60%" stopColor={color} stopOpacity={0.08} />
        <stop offset="100%" stopColor={color} stopOpacity={0} />
      </linearGradient>
    </defs>
  );
}

// ── Skeletons ──────────────────────────────────────────────────
/** Shaped placeholders. Always pass real dimensions — see StatTile. */
export function Skel({
  w = "100%",
  h = 14,
  radius = "var(--r-sm)",
  style,
}: {
  w?: number | string;
  h?: number | string;
  radius?: string;
  style?: React.CSSProperties;
}) {
  return <span className="ds-skel" aria-hidden style={{ display: "block", width: w, height: h, borderRadius: radius, ...style }} />;
}

/** Table placeholder that matches the real row height, so nothing jumps. */
export function SkelRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading" style={{ display: "grid", gap: "var(--s-2)" }}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: "var(--s-3)", alignItems: "center" }}>
          {Array.from({ length: cols }).map((__, c) => (
            <Skel key={c} h={13} w={c === 0 ? "70%" : "45%"} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Misc ───────────────────────────────────────────────────────
export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "online" | "warning" | "danger";
}) {
  const bg =
    tone === "neutral" ? "var(--glass-3)" : `color-mix(in srgb, var(--${tone === "accent" ? "accent" : tone}) 18%, transparent)`;
  const fg = tone === "neutral" ? "var(--muted)" : `var(--${tone === "accent" ? "accent" : tone})`;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 10px",
        borderRadius: "var(--r-pill)",
        background: bg,
        color: fg,
        fontSize: "var(--t-xs)",
        fontWeight: 700,
        lineHeight: 1.5,
      }}
    >
      {children}
    </span>
  );
}

/** Section heading with consistent rhythm on the 8px grid. */
export function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: "var(--s-4)" }}>
      <h2 style={{ margin: 0, fontSize: "var(--t-xl)", fontWeight: 750, letterSpacing: "var(--ls-tight)", color: "var(--text)" }}>
        {children}
      </h2>
      {hint && <p style={{ margin: "3px 0 0", fontSize: "var(--t-sm)", color: "var(--muted)" }}>{hint}</p>}
    </div>
  );
}
