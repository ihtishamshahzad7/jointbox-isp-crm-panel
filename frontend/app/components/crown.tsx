"use client";

/**
 * The platform owner's crown — drawn on the SUPER_ADMIN's own avatar only
 * (header button, account menu, My Profile). It sits tilted on the top-left
 * of the avatar like a crown on a head; the avatar's wrapper must be
 * `position: relative` with visible overflow.
 */
import React, { useId } from "react";

export function CrownBadge({ size = 32, title = "Super admin" }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, "");
  const w = Math.round(size * 0.62);
  const h = Math.round(w * 0.78);
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      style={{
        position: "absolute",
        top: -Math.round(h * 0.62),
        left: -Math.round(w * 0.22),
        width: w,
        height: h,
        transform: "rotate(-22deg)",
        transformOrigin: "50% 100%",
        pointerEvents: "auto",
        zIndex: 2,
        filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,.35))",
        lineHeight: 0,
      }}
    >
      <svg width={w} height={h} viewBox="0 0 24 19" aria-hidden="true">
        <defs>
          <linearGradient id={`cg-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FDE68A" />
            <stop offset="0.55" stopColor="#F59E0B" />
            <stop offset="1" stopColor="#B45309" />
          </linearGradient>
        </defs>
        {/* Points and body */}
        <path d="M2.2 15.2 1 4.6l6.1 4.9L12 1.4l4.9 8.1L23 4.6l-1.2 10.6Z" fill={`url(#cg-${id})`} stroke="#92400E" strokeWidth="1" strokeLinejoin="round" />
        {/* Band */}
        <rect x="2.2" y="15" width="19.6" height="3" rx="1" fill="#D97706" stroke="#92400E" strokeWidth="1" />
        {/* Jewels */}
        <circle cx="12" cy="1.8" r="1.4" fill="#FEF3C7" stroke="#92400E" strokeWidth=".7" />
        <circle cx="1.3" cy="4.4" r="1.15" fill="#FEF3C7" stroke="#92400E" strokeWidth=".7" />
        <circle cx="22.7" cy="4.4" r="1.15" fill="#FEF3C7" stroke="#92400E" strokeWidth=".7" />
        <circle cx="12" cy="16.5" r="1" fill="#DC2626" />
        <circle cx="7" cy="16.5" r=".8" fill="#2563EB" />
        <circle cx="17" cy="16.5" r=".8" fill="#16A34A" />
      </svg>
    </span>
  );
}
