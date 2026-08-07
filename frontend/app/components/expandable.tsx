"use client";

import React from "react";

/**
 * Expandable — wraps any block (toolbar + table) with a full-screen toggle, the
 * same "⛶ Expand" affordance used on the log tables. In expanded mode the block
 * fills the viewport over a dimmed backdrop so long lists are easy to read; the
 * toolbar (with its Find box) stays available. Esc or the ✕ button closes it.
 */
export function Expandable({ children, label = "table" }: { children: React.ReactNode; label?: string }) {
  const [full, setFull] = React.useState(false);
  React.useEffect(() => {
    if (!full) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [full]);

  return (
    <div className={`xpand ${full ? "xpand-full" : ""}`}>
      <style>{CSS}</style>
      <button className="xpand-btn" onClick={() => setFull((v) => !v)}
        title={full ? "Exit full screen (Esc)" : `Expand ${label} to full screen`}>
        {full ? "✕ Close" : "⛶ Expand"}
      </button>
      <div className="xpand-body">{children}</div>
    </div>
  );
}

const CSS = `
.xpand{position:relative}
.xpand-btn{position:absolute;top:-34px;right:0;z-index:5;padding:4px 11px;font-size:11.5px;
  font-weight:700;font-family:inherit;cursor:pointer;background:var(--surface);
  border:1px solid var(--border);color:var(--text);border-radius:6px}
.xpand-btn:hover{border-color:var(--accent);color:var(--accent)}
.xpand-full{position:fixed;inset:12px;z-index:350;background:var(--bg);border-radius:12px;
  padding:44px 14px 14px;overflow:auto;box-shadow:0 0 0 100vmax rgba(0,0,0,.6),0 24px 80px rgba(0,0,0,.65)}
.xpand-full .xpand-btn{top:12px;right:14px}
`;
