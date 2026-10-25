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
  tone = "auto",
}: {
  size?: number;
  withText?: boolean;
  subtitle?: string | null;
  /** "auto" = follow the app theme; "onDark" = always the white variant (for
     surfaces that are ALWAYS dark, e.g. the login hero / landing nav);
     "onLight" = always the colour variant. */
  tone?: "auto" | "onDark" | "onLight";
}) {
  void subtitle;
  const lock = withText ? { lt: "/brand/uplinko-logo.png", dk: "/brand/uplinko-logo-white.png" }
                        : { lt: "/brand/uplinko-icon.png", dk: "/brand/uplinko-icon-white.png" };
  const alt = withText ? `${BRAND.name} — ${BRAND.subtitle}` : BRAND.name;
  const imgStyle: React.CSSProperties = withText
    ? { height: size * 1.55, width: "auto", objectFit: "contain", display: "block" }
    : { width: size, height: size, objectFit: "contain", display: "block" };

  // Forced single variant for always-dark / always-light surfaces.
  if (tone !== "auto") {
    const src = tone === "onDark" ? lock.dk : lock.lt;
    return <img src={src} alt={alt} style={imgStyle} />;
  }

  // Auto: colour artwork on light backgrounds, WHITE variant on dark — so the
  // logo never blends into a dark/purple surface. One shared stylesheet.
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
  return (
    <span className="ulogo" style={{ display: "inline-block", lineHeight: 0, flexShrink: 0 }}>
      <style>{themeCss}</style>
      <img className="ul-lt" src={lock.lt} alt={alt} style={imgStyle} />
      <img className="ul-dk" src={lock.dk} alt={alt} style={imgStyle} />
    </span>
  );
}
