"use client";

import React from "react";

/**
 * LogoAssemble — the Uplinko lockup that "assembles" on page load: the single
 * logo image is shown as vertical slices (all from the SAME asset, so they line
 * up seamlessly) that fly in from scattered positions and snap together, then
 * idle-float with a pink/purple glow. One image asset — never text or CSS
 * shapes. The reveal runs once per mount (i.e. on every page refresh).
 */
const SLICES = 7;
// Scatter offsets per slice (dx, dy, rotateDeg) — alternating so pieces come
// from different directions before snapping into place.
const SCATTER: Array<[number, number, number]> = [
  [-60, -40, -14], [48, 36, 10], [-40, 44, -8], [34, -48, 12],
  [-52, 30, -10], [44, -34, 9], [-30, 46, -12],
];

export function LogoAssemble({
  src, height = 80, ratio = 2.0, alt = "",
}: { src: string; height?: number; ratio?: number; alt?: string }) {
  const width = Math.round(height * ratio);
  return (
    <div className="ul-float" style={{ display: "inline-block" }} role="img" aria-label={alt}>
      <div className="ul-glow logoAsm" style={{ position: "relative", width, height }}>
        {Array.from({ length: SLICES }).map((_, i) => {
          const [dx, dy, rot] = SCATTER[i % SCATTER.length];
          return (
            <span
              key={i}
              className="logoAsm-slice"
              style={{
                position: "absolute", top: 0, height: "100%",
                left: `${(i * 100) / SLICES}%`, width: `${100 / SLICES}%`,
                backgroundImage: `url(${src})`,
                backgroundSize: `${SLICES * 100}% 100%`,
                backgroundPosition: `${(i * 100) / (SLICES - 1)}% center`,
                backgroundRepeat: "no-repeat",
                // scatter start → assembled, staggered.
                ["--dx" as any]: `${dx}px`,
                ["--dy" as any]: `${dy}px`,
                ["--rot" as any]: `${rot}deg`,
                animation: "logoAsmIn .7s cubic-bezier(.2,.85,.25,1) both",
                animationDelay: `${i * 0.07}s`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
