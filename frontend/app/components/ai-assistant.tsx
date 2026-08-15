"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AssistantChat } from "./assistant-chat";
import API_BASE from "./api";
import { BRAND } from "../../lib/brand";

const API = API_BASE;

export default function AiAssistant() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [mounted, setMounted] = useState(false);

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


  if (!token || !mounted) return null;

  // Render into <body> so a transformed ancestor (e.g. .main's entrance
  // animation) can never become the containing block for these fixed overlays
  // — that was pinning the panel to .main and clipping it off the right edge.
  return createPortal(
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        title={`${BRAND.name} assistant`}
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
          /**
           * Anchored by BOTH insets instead of a computed width.
           *
           * `width: min(400px, calc(100vw - 32px))` still overflowed, because
           * 100vw counts the scrollbar and ignores browser zoom — so on a narrow
           * window the panel hung off the right edge and `overflow: hidden`
           * chopped the text AND the Expand button clean off.
           *
           * left+right+auto width means the browser derives the width from the
           * actual viewport: it can never exceed it. maxWidth caps it at 400px
           * on a big screen and marginLeft:auto keeps it right-aligned.
           */
          position: "fixed", left: 16, right: 16, bottom: 88, zIndex: 2000,
          width: "auto", maxWidth: 400, marginLeft: "auto",
          height: 560, maxHeight: "78vh",
          boxSizing: "border-box",
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, display: "flex", flexDirection: "column", overflow: "hidden",
          boxShadow: "0 24px 60px rgba(0,0,0,0.4)",
        }}>
          <div style={{ padding: "12px 14px", background: "linear-gradient(135deg,#6C3CE1,#8B5CF6)", color: "#fff",
            display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>✦ {BRAND.name} Assistant</div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>Guidance for anything in the panel · build v7</div>
            </div>
            {/* Expand — a long answer is far easier to read on a full page than
                in a 400px bubble, so hand the conversation over to /assistant. */}
            <button
              onClick={() => { setOpen(false); router.push("/assistant"); }}
              title="Open in full page"
              aria-label="Open assistant in full page"
              style={{ background: "rgba(255,255,255,.18)", border: "1px solid rgba(255,255,255,.28)",
                color: "#fff", borderRadius: 8, padding: "6px 11px", fontSize: 12, fontWeight: 700,
                cursor: "pointer", lineHeight: 1, flex: "none", whiteSpace: "nowrap",
                display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "inherit" }}>
              ⛶ Expand
            </button>
          </div>

          {!configured && (
            <div style={{ fontSize: 12, color: "#f59e0b", background: "rgba(245,158,11,.12)", border: "1px solid rgba(245,158,11,.3)", borderRadius: 10, padding: 10, margin: 12 }}>
              Assistant not configured. An admin should set <code>AI_API_KEY</code> in the server .env (free key at console.groq.com) and restart the backend.
            </div>
          )}
          {/* Same conversation component as the full page — one implementation,
              so the popup and /assistant can never answer differently. */}
          <AssistantChat />
        </div>
      )}
    </>,
    document.body
  );
}
