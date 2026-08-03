"use client";

/**
 * Last-resort error boundary (catches errors in the root layout itself). Shows
 * the error instead of a blank/white screen.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html>
      <body style={{ margin: 0, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b1020", color: "#e7ecf6", fontFamily: "system-ui,Segoe UI,Roboto,Arial" }}>
        <div style={{ maxWidth: 640, width: "100%", background: "#121a30", border: "1px solid #26304d", borderRadius: 14, padding: 22, margin: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 10 }}>⚠️ The app failed to load</div>
          <pre style={{ background: "#0b1020", border: "1px solid #26304d", borderRadius: 10, padding: 12, fontSize: 12, color: "#ef9a9a", whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 300 }}>
{error?.message || String(error)}{error?.digest ? `\n\ndigest: ${error.digest}` : ""}{error?.stack ? `\n\n${error.stack}` : ""}
          </pre>
          <button onClick={() => reset()} style={{ marginTop: 14, background: "#378ADD", color: "#fff", border: "none", borderRadius: 9, padding: "9px 16px", cursor: "pointer", fontWeight: 700 }}>Reload</button>
        </div>
      </body>
    </html>
  );
}
