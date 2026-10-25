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
  // Theme-aware switching: on LIGHT backgrounds the purple/navy artwork; on DARK
  // backgrounds a WHITE version (white wordmark, magenta arrow, light tagline)
  // so it never blends into a dark/purple surface. One shared stylesheet.
  const themeCss = `
    .ulogo .ul-dk{display:none}
    .ulogo .ul-lt{display:block}
    html[data-theme="dark"] .ulogo .ul-dk{display:block}
    html[data-theme="dark"] .ulogo .ul-lt{display:none}
    @media(prefers-color-scheme:dark){
      html:not([data-theme]) .ulogo .ul-dk{display:block}
      html:not([data-theme]) .ulogo .ul-lt{display:none}
    }
  `;
  void subtitle;

  // Mark only — the exact Uplinko icon (U + uplink arrow).
  if (!withText) {
    return (
      <span className="ulogo" style={{ display: "inline-block", lineHeight: 0, flexShrink: 0 }}>
        <style>{themeCss}</style>
        <img className="ul-lt" src="/brand/uplinko-icon.png" alt={BRAND.name}
          width={size} height={size} style={{ display: "block", objectFit: "contain" }} />
        <img className="ul-dk" src="/brand/uplinko-icon-white.png" alt={BRAND.name}
          width={size} height={size} style={{ display: "block", objectFit: "contain" }} />
      </span>
    );
  }

  // With text — the exact full Uplinko lockup (wordmark + tagline baked in).
  const h = size * 1.55;
  return (
    <span className="ulogo" style={{ display: "inline-block", lineHeight: 0 }}>
      <style>{themeCss}</style>
      <img className="ul-lt" src="/brand/uplinko-logo.png"
        alt={`${BRAND.name} — ${BRAND.subtitle}`}
        style={{ height: h, width: "auto", objectFit: "contain" }} />
      <img className="ul-dk" src="/brand/uplinko-logo-white.png"
        alt={`${BRAND.name} — ${BRAND.subtitle}`}
        style={{ height: h, width: "auto", objectFit: "contain" }} />
    </span>
  );
}
