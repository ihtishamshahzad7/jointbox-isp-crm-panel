"use client";

import { useEffect, useRef, useState } from "react";
import API from "./api";

/**
 * AssistantChat — the conversation itself, with no chrome around it.
 *
 * Shared by the floating popup and the full-page /assistant view so both stay
 * identical: one place to fix a bug, one place to change the greeting. The
 * caller supplies the frame (bubble panel vs full page); this owns the
 * messages, sending, and the wrapping that keeps long replies readable.
 */

export type Msg = { role: "user" | "assistant"; content: string };

export const GREETING: Msg = {
  role: "assistant",
  content:
    "Hi! I'm your Jointbox guide. I'll show you where things are, how to use each feature, and what happens before you do it.\n\n" +
    'Try: "how do I add a subscriber", "where do I take a payment", "what happens if I delete a customer", "what do I need before activating".',
};

/** Starter questions — new users rarely know what to ask first. */
const SUGGESTIONS = [
  "How do I add a subscriber?",
  "Where do I take a payment?",
  "How do I renew an expired customer?",
  "Where do I see NAS traffic?",
  "How do I set up Discord alerts?",
];

export function AssistantChat({ big = false }: { big?: boolean }) {
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: q }];
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

  // Wrapping is set INLINE, never via a stylesheet: external CSS can be
  // overridden or arrive late, and when that happened replies ran off the
  // right edge unreadable.
  const bubble = (mine: boolean): React.CSSProperties => ({
    background: mine ? "var(--accent,#378ADD)" : "var(--surface-2)",
    color: mine ? "#fff" : "var(--text)",
    border: mine ? "none" : "1px solid var(--border)",
    display: "inline-block",
    maxWidth: big ? "min(100%, 74ch)" : "100%",
    boxSizing: "border-box",
    textAlign: "left",
    fontSize: big ? 14 : 13,
    lineHeight: 1.65,
    padding: big ? "12px 15px" : "9px 12px",
    borderRadius: 12,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  });

  return (
    <>
      {/* width:100% + maxWidth:100% + border-box: the scroll area takes its
          width FROM the panel and can never be pushed wider by its content,
          which is what let long replies spill past the right edge. */}
      <div ref={bodyRef}
        style={{
          flex: 1, minWidth: 0, width: "100%", maxWidth: "100%", boxSizing: "border-box",
          overflowY: "auto", overflowX: "hidden", padding: big ? "18px 4px" : 12,
        }}>
        {msgs.map((m, i) => (
          <div key={i} style={{
            display: "block", width: "100%", boxSizing: "border-box",
            textAlign: m.role === "user" ? "right" : "left", marginBottom: big ? 14 : 10,
          }}>
            <div style={bubble(m.role === "user")}>{m.content}</div>
          </div>
        ))}

        {msgs.length === 1 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 4 }}>
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => ask(s)}
                style={{
                  background: "var(--surface)", border: "1px solid var(--border)", color: "var(--muted)",
                  borderRadius: 999, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
                }}>{s}</button>
            ))}
          </div>
        )}

        {busy && <div style={{ fontSize: 12, color: "var(--muted)" }}>Thinking…</div>}
      </div>

      <div style={{ padding: big ? "12px 0 0" : 10, borderTop: "1px solid var(--border)", display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") ask(input); }}
          placeholder="Ask how to do something…"
          style={{
            flex: 1, minWidth: 0, background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 10, padding: big ? "12px 14px" : "9px 12px", color: "var(--text)", fontSize: big ? 14 : 13,
            fontFamily: "inherit",
          }} />
        <button onClick={() => ask(input)} disabled={busy || !input.trim()}
          style={{
            background: "linear-gradient(135deg,#6C3CE1,#8B5CF6)", color: "#fff", border: "none",
            borderRadius: 10, padding: big ? "0 20px" : "0 14px", fontWeight: 700, cursor: "pointer",
            fontSize: big ? 14 : 13, opacity: busy || !input.trim() ? 0.6 : 1,
          }}>Ask</button>
      </div>
    </>
  );
}
