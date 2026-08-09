"use client";

import React from "react";

/**
 * useColResize — drag-to-resize table columns, remembered per browser.
 *
 * Different jobs need different columns wide: chasing renewals wants Expiry
 * roomy, auditing dealers wants Owner. Rather than guess a layout, let the
 * operator drag — and persist it under `storageKey` so tomorrow's session
 * starts where they left off.
 *
 * Usage:
 *   const col = useColResize("jb_nascols");
 *   <th style={col.style("router")}>Router {col.handle("router")}</th>
 */
export function useColResize(storageKey: string) {
  const [widths, setWidths] = React.useState<Record<string, number>>({});

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setWidths(JSON.parse(raw));
    } catch { /* ignore malformed saved state */ }
  }, [storageKey]);

  const persist = React.useCallback((w: Record<string, number>) => {
    try { localStorage.setItem(storageKey, JSON.stringify(w)); } catch { /* quota */ }
  }, [storageKey]);

  const start = (key: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // never trigger the header's sort while dragging
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;

    const move = (ev: MouseEvent) =>
      setWidths((w) => ({ ...w, [key]: Math.max(70, Math.round(startW + (ev.clientX - startX))) }));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
      setWidths((w) => { persist(w); return w; });
    };
    document.body.style.userSelect = "none"; // stop text selection mid-drag
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  const reset = (key: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setWidths((w) => { const n = { ...w }; delete n[key]; persist(n); return n; });
  };

  return {
    widths,
    style: (key: string) => (widths[key] ? { width: widths[key] } : undefined),
    /** Render inside a <th>; the th must be position:relative. */
    handle: (key: string) => (
      <span className="rsz" onMouseDown={start(key)} onDoubleClick={reset(key)}
        title="Drag to resize · double-click to reset" />
    ),
  };
}

/** Shared handle styling — include once per table stylesheet. */
export const COL_RESIZE_CSS = `
th{position:relative}
.rsz{position:absolute;top:0;right:-3px;width:7px;height:100%;cursor:col-resize;z-index:3;background:transparent}
.rsz::after{content:"";position:absolute;top:22%;right:3px;width:2px;height:56%;border-radius:2px;
  background:var(--border);opacity:0;transition:opacity .12s ease}
th:hover .rsz::after{opacity:1}
.rsz:hover::after{background:var(--accent);opacity:1}
`;
