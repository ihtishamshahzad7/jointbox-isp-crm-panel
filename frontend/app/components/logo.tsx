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
  // Mark only — the exact Uplinko icon artwork (U + uplink arrow).
  if (!withText) {
    return (
      <img
        src="/brand/uplinko-icon.png"
        alt={BRAND.name}
        width={size}
        height={size}
        style={{ display: "block", objectFit: "contain", flexShrink: 0 }}
      />
    );
  }

  // With text — the exact full Uplinko lockup (wordmark + tagline baked in).
  // Two variants so the navy tagline stays readable on either background:
  // the original on light, a light-tagline version on dark.
  void subtitle;
  const h = size * 1.55;
  return (
    <span className="ulogo" style={{ display: "inline-block", lineHeight: 0 }}>
      <style>{`
        .ulogo .ul-dark{display:none}
        .ulogo .ul-light{display:block}
        html[data-theme="dark"] .ulogo .ul-dark{display:block}
        html[data-theme="dark"] .ulogo .ul-light{display:none}
        @media(prefers-color-scheme:dark){
          html:not([data-theme]) .ulogo .ul-dark{display:block}
          html:not([data-theme]) .ulogo .ul-light{display:none}
        }
      `}</style>
      <img className="ul-light" src="/brand/uplinko-logo.png"
        alt={`${BRAND.name} — ${BRAND.subtitle}`}
        style={{ height: h, width: "auto", objectFit: "contain" }} />
      <img className="ul-dark" src="/brand/uplinko-logo-dark.png"
        alt={`${BRAND.name} — ${BRAND.subtitle}`}
        style={{ height: h, width: "auto", objectFit: "contain" }} />
    </span>
  );
}
