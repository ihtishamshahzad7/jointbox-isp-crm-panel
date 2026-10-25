"use client";

import React from "react";
import { BRAND } from "../../lib/brand";

/**
 * Brand mark — Uplinko: a bold "U" that rises into an up-arrow (an "uplink").
 * Indigo U, magenta arrowhead accent, drawn inline as SVG so it stays crisp at
 * any size (favicon → app header) with no image request, and reads on both
 * light and dark backgrounds.
 *
 * <Logo />           → mark only
 * <Logo withText />  → mark + brand name / subtitle wordmark
 *
 * The name and subtitle come from lib/brand.ts (env-driven), so a white-label
 * deployment shows its own identity here.
 */
export function Logo({
  size = 40,
  withText = false,
  subtitle = BRAND.subtitle,
}: {
  size?: number;
  withText?: boolean;
  subtitle?: string | null;
}) {
  const id = React.useId();
  const mark = (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <defs>
        <linearGradient id={`u${id}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#6C3CE1" />
          <stop offset="1" stopColor="#7C4DFF" />
        </linearGradient>
      </defs>
      {/* The "U" — thick rounded stroke, open at the top. */}
      <path d="M28 20 L28 52 A22 22 0 0 0 72 52 L72 36"
        fill="none" stroke={`url(#u${id})`} strokeWidth="15" strokeLinecap="round" strokeLinejoin="round" />
      {/* The uplink arrow rising from the right arm (magenta accent). */}
      <path d="M72 40 L72 12" fill="none" stroke="#E9408B" strokeWidth="15" strokeLinecap="round" />
      <path d="M58 24 L72 9 L86 24" fill="none" stroke="#E9408B" strokeWidth="15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  if (!withText) return mark;

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
      {mark}
      <div style={{ lineHeight: 1.15 }}>
        <div style={{ fontSize: size * 0.5, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text, #fff)" }}>
          {BRAND.name}
        </div>
        {subtitle && (
          <div
            style={{
              fontSize: Math.max(9, size * 0.24),
              fontWeight: 600,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              background: "linear-gradient(90deg,#C4B5FD,#F9A8D4)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              marginTop: 2,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
