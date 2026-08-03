"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. Instead of a silent hang / blank screen, any
 * runtime error rendering a page is caught here and shown on screen with its
 * message and stack, plus a reload button — so problems are visible and
 * debuggable in the field.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("Route error:", error); }, [error]);
  return (
    <div style={{ minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "var(--bg,#0b1020)", color: "var(--text,#e7ecf6)", fontFamily: "system-ui,Segoe UI,Roboto,Arial" }}>
      <div style={{ maxWidth: 640, width: "100%", background: "var(--surface,#121a30)", border: "1px solid var(--border,#26304d)", borderRadius: 14, padding: 22 }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>⚠️ This page hit an error</div>
        <div style={{ fontSize: 13, color: "var(--muted,#93a0bd)", marginBottom: 14 }}>The rest of the panel still works. Details below — send these to support if it persists.</div>
        <pre style={{ background: "var(--bg,#0b1020)", border: "1px solid var(--border,#26304d)", borderRadius: 10, padding: 12, fontSize: 12, color: "#ef9a9a", whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 260 }}>
{error?.message || String(error)}{error?.digest ? `\n\ndigest: ${error.digest}` : ""}{error?.stack ? `\n\n${error.stack}` : ""}
        </pre>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button onClick={() => reset()} style={{ background: "var(--accent,#378ADD)", color: "#fff", border: "none", borderRadius: 9, padding: "9px 16px", cursor: "pointer", fontWeight: 700 }}>Try again</button>
          <button onClick={() => (window.location.href = "/dashboard")} style={{ background: "var(--surface-2,#1a2340)", color: "var(--text,#e7ecf6)", border: "1px solid var(--border,#26304d)", borderRadius: 9, padding: "9px 16px", cursor: "pointer" }}>Reload</button>
        </div>
      </div>
    </div>
  );
}
