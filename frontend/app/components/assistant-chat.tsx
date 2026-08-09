"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
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

/** Fallback starters when we have no page-specific guidance. */
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

  /**
   * PAGE-AWARE HELP.
   *
   * Someone on the NAS screen usually wants "what is this screen and what do I
   * do here", not generic guidance. We fetch help for the current route and
   * default the scope to "This page"; they can switch to "Everything" whenever
   * the question is broader.
   */
  const pathname = usePathname() || "/";
  const [scope, setScope] = useState<"page" | "all">("page");
  const [help, setHelp] = useState<any>(null);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
    if (!token) return;
    fetch(`${API}/ai/page-help?route=${encodeURIComponent(pathname)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setHelp(d))
      .catch(() => setHelp(null));
  }, [pathname]);

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
      // Send the current route so a question like "how do I add one?" can be
      // answered in the context of the screen they are actually looking at.
      const r = await fetch(`${API}/ai/chat`, {
        method: "POST", headers,
        body: JSON.stringify({ messages: next, route: scope === "page" ? pathname : undefined }),
      });
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
          <div style={{ marginTop: 4 }}>
            {/* Scope: guidance for THIS screen, or the whole panel. */}
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {([["page", `📍 This page`], ["all", "🌐 Everything"]] as const).map(([id, label]) => (
                <button key={id} onClick={() => setScope(id)}
                  style={{
                    background: scope === id ? "var(--surface-2)" : "transparent",
                    border: `1px solid ${scope === id ? "var(--accent)" : "var(--border)"}`,
                    color: scope === id ? "var(--accent)" : "var(--muted)",
                    borderRadius: 999, padding: "5px 11px", fontSize: 11.5, fontWeight: 700,
                    cursor: "pointer", fontFamily: "inherit",
                  }}>{label}</button>
              ))}
            </div>

            {/* What this screen is for — shown before they even ask. */}
            {scope === "page" && help?.scoped && (
              <div style={{
                background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12,
                padding: "11px 13px", marginBottom: 10,
              }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 4 }}>{help.title}</div>
                <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.65 }}>{help.intro}</div>
                {help.topics?.length > 0 && (
                  <div style={{ marginTop: 9, display: "grid", gap: 5 }}>
                    {help.topics.slice(0, 4).map((t: any) => (
                      <button key={t.title}
                        onClick={() => setMsgs((m) => [...m, { role: "user", content: t.title }, { role: "assistant", content: t.answer }])}
                        style={{
                          textAlign: "left", background: "var(--surface)", border: "1px solid var(--border)",
                          color: "var(--text)", borderRadius: 8, padding: "7px 10px", fontSize: 12,
                          cursor: "pointer", fontFamily: "inherit",
                        }}>› {t.title}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {(scope === "page" && help?.questions?.length ? help.questions : SUGGESTIONS).map((s: string) => (
                <button key={s} onClick={() => ask(s)}
                  style={{
                    background: "var(--surface)", border: "1px solid var(--border)", color: "var(--muted)",
                    borderRadius: 999, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
                  }}>{s}</button>
              ))}
            </div>
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
