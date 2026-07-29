"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

type Msg = { role: "user" | "assistant"; content: string };

export default function AiAssistant() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "assistant", content: "Hi! I'm your Jointbox guide. I'll show you where things are, how to use each feature, and what happens before you do it.\n\nTry: \"how do I add a subscriber\", \"where do I take a payment\", \"what happens if I delete a customer\", \"what do I need before activating\"." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [mounted, setMounted] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  useEffect(() => {
    if (!token) return;
    fetch(`${API}/ai/status`, { headers }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setConfigured(d.configured); }).catch(() => {});
  }, [token]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("open-assistant", onOpen);
    return () => window.removeEventListener("open-assistant", onOpen);
  }, []);

  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, open]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: text }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch(`${API}/ai/chat`, { method: "POST", headers, body: JSON.stringify({ messages: next }) });
      const d = await r.json();
      setMsgs((m) => [...m, { role: "assistant", content: d?.reply || "Sorry, something went wrong." }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "Could not reach the assistant. Try again in a moment." }]);
    } finally { setBusy(false); }
  }

  if (!token || !mounted) return null;

  // Render into <body> so a transformed ancestor (e.g. .main's entrance
  // animation) can never become the containing block for these fixed overlays
  // — that was pinning the panel to .main and clipping it off the right edge.
  return createPortal(
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Jointbox assistant"
        aria-label="Open assistant"
        style={{
          position: "fixed", right: 22, bottom: 22, zIndex: 2000, width: 54, height: 54, borderRadius: "50%",
          border: "none", cursor: "pointer", color: "#fff", fontSize: 22,
          background: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)",
          boxShadow: "0 10px 28px rgba(140,60,225,0.45)",
        }}
      >
        {open ? "✕" : "✦"}
      </button>

      {open && (
        <div className="jb-assist-panel" style={{
          position: "fixed", right: 22, bottom: 88, zIndex: 2000, width: 400, maxWidth: "calc(100vw - 32px)", height: 560, maxHeight: "78vh",
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, display: "flex", flexDirection: "column", overflow: "hidden",
          boxShadow: "0 24px 60px rgba(0,0,0,0.4)",
        }}>
          <div style={{ padding: "12px 14px", background: "linear-gradient(135deg,#6C3CE1,#8B5CF6)", color: "#fff" }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>✦ Jointbox Assistant</div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>Guidance for anything in the panel</div>
          </div>

          <div ref={bodyRef} className="jb-assist-body" style={{ flex: 1, minWidth: 0, overflowY: "auto", overflowX: "hidden", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {!configured && (
              <div style={{ fontSize: 12, color: "#f59e0b", background: "rgba(245,158,11,.12)", border: "1px solid rgba(245,158,11,.3)", borderRadius: 10, padding: 10 }}>
                Assistant not configured. An admin should set <code>AI_API_KEY</code> in the server .env (free key at console.groq.com) and restart the backend.
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`jb-assist-row ${m.role === "user" ? "jb-assist-row-user" : ""}`}>
                <div className="jb-assist-bubble" style={{
                  background: m.role === "user" ? "var(--accent,#378ADD)" : "var(--surface-2)",
                  color: m.role === "user" ? "#fff" : "var(--text)",
                  border: m.role === "user" ? "none" : "1px solid var(--border)",
                }}>{m.content}</div>
              </div>
            ))}
            {busy && <div style={{ fontSize: 12, color: "var(--muted)", alignSelf: "flex-start" }}>Thinking…</div>}
          </div>

          <div style={{ padding: 10, borderTop: "1px solid var(--border)", display: "flex", gap: 8 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              placeholder="Ask how to do something…"
              style={{ flex: 1, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px", color: "var(--text)", fontSize: 13 }}
            />
            <button onClick={send} disabled={busy || !input.trim()}
              style={{ background: "var(--g-primary,#6C3CE1)", color: "#fff", border: "none", borderRadius: 10, padding: "0 14px", fontSize: 14, cursor: busy ? "default" : "pointer", opacity: busy || !input.trim() ? 0.5 : 1 }}>
              ➤
            </button>
          </div>
        </div>
      )}
    </>,
    document.body
  );
}
