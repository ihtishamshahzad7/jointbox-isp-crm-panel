"use client";

import React from "react";

/**
 * Jointbox brand mark — two interlocking rounded boxes ("joint" of "boxes"),
 * one woven over the other, on a Nova-gradient tile. Rendered inline as SVG so
 * it stays crisp at any size and needs no image request.
 *
 * <Logo />           → mark only
 * <Logo withText />  → mark + "Jointbox / ISP Management" wordmark
 */
export function Logo({
  size = 40,
  withText = false,
  subtitle = "ISP Management",
}: {
  size?: number;
  withText?: boolean;
  subtitle?: string | null;
}) {
  const id = React.useId();
  const mark = (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6C3CE1" />
          <stop offset="0.55" stopColor="#E9408B" />
          <stop offset="1" stopColor="#F27121" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="92" height="92" rx="24" fill={`url(#g${id})`} />
      <rect x="4" y="4" width="92" height="46" rx="24" fill="#ffffff" opacity="0.1" />
      <rect x="24" y="26" width="34" height="34" rx="11" fill="none" stroke="#fff" strokeWidth="6.5" opacity="0.9" />
      <rect x="38" y="40" width="26" height="26" rx="10" fill={`url(#g${id})`} />
      <rect x="42" y="40" width="34" height="34" rx="11" fill="none" stroke="#fff" strokeWidth="6.5" />
    </svg>
  );

  if (!withText) return mark;

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
      {mark}
      <div style={{ lineHeight: 1.15 }}>
        <div style={{ fontSize: size * 0.5, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text, #fff)" }}>
          Jointbox
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
