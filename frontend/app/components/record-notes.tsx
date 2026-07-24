"use client";

import React from "react";
import { silent } from "./silent";

/**
 * RecordNotes — a notes/comments panel for ANY record.
 *
 * Drop it on any detail view with the entity type and id:
 *   <RecordNotes entityType="SUBSCRIBER" entityId={sub.id} />
 *   <RecordNotes entityType="NAS" entityId={nas.id} />
 *
 * Used for operational memos — transmission details, install notes, "which
 * device this runs on", follow-ups. Scoped on the server: you see your own and
 * your downline's notes; the ISP sees all.
 */

const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

type Note = { id: number; body: string; pinned: boolean; createdByName?: string | null; createdAt: string };

export function RecordNotes({
  entityType,
  entityId,
  title = "Notes",
  compact = false,
}: {
  entityType: string;
  entityId: number | string;
  title?: string;
  compact?: boolean;
}) {
  const [notes, setNotes] = React.useState<Note[]>([]);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = React.useMemo(() => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }), [token]);

  const load = React.useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    try {
      const r = await fetch(`${API}/notes?entityType=${encodeURIComponent(entityType)}&entityId=${entityId}`, { headers });
      setNotes(r.ok ? await r.json() : []);
    } catch { setNotes([]); }
    setLoading(false);
  }, [entityType, entityId, headers]);

  React.useEffect(() => { load(); }, [load]);

  const add = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/notes`, { method: "POST", headers, body: JSON.stringify({ entityType, entityId: Number(entityId), body }) });
      if (r.ok) { setDraft(""); await load(); }
    } catch {}
    setBusy(false);
  };

  const togglePin = async (n: Note) => {
    await fetch(`${API}/notes/${n.id}`, { method: "PUT", headers, body: JSON.stringify({ pinned: !n.pinned }) }).catch(silent("toggleNotePin"));
    load();
  };
  const remove = async (n: Note) => {
    if (!confirm("Delete this note?")) return;
    await fetch(`${API}/notes/${n.id}`, { method: "DELETE", headers }).catch(silent("deleteNote"));
    load();
  };

  const C = {
    text: "var(--text,#e9edf5)", muted: "var(--muted,#94a3b8)", border: "var(--border,#252a3c)",
    surface: "var(--surface,#151823)", surface2: "var(--surface-2,#1b1f2e)", accent: "#6C3CE1",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {!compact && <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{title}</div>}

      {/* Composer */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) add(); }}
          placeholder="Add a note… e.g. transmission: rooftop dish → MikroTik SXT, fed from Tower-3 (Ctrl+Enter to save)"
          rows={compact ? 2 : 3}
          style={{ flex: 1, resize: "vertical", background: "var(--bg,#0b0e1a)", border: `1px solid ${C.border}`, borderRadius: 9, padding: "9px 11px", color: C.text, fontSize: 12.5, fontFamily: "inherit", outline: "none", lineHeight: 1.6 }}
        />
        <button onClick={add} disabled={busy || !draft.trim()}
          style={{ border: "none", cursor: draft.trim() ? "pointer" : "not-allowed", borderRadius: 9, padding: "10px 16px", fontSize: 12.5, fontWeight: 700, color: "#fff", background: draft.trim() ? "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)" : C.surface2, fontFamily: "inherit", whiteSpace: "nowrap", opacity: busy ? 0.6 : 1 }}>
          {busy ? "…" : "Add"}
        </button>
      </div>

      {/* List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {loading ? (
          <div style={{ fontSize: 12, color: C.muted, padding: "8px 0" }}>Loading notes…</div>
        ) : notes.length === 0 ? (
          <div style={{ fontSize: 12, color: C.muted, padding: "8px 0" }}>No notes yet. Add the first one above.</div>
        ) : (
          notes.map((n) => (
            <div key={n.id} style={{ border: `1px solid ${n.pinned ? "rgba(233,64,139,0.4)" : C.border}`, background: n.pinned ? "rgba(233,64,139,0.06)" : C.surface, borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontSize: 12.5, color: C.text, whiteSpace: "pre-wrap", lineHeight: 1.6, wordBreak: "break-word" }}>{n.body}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 7, fontSize: 10.5, color: C.muted }}>
                <span>{n.createdByName || "—"}</span>
                <span>·</span>
                <span>{new Date(n.createdAt).toLocaleString()}</span>
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 10 }}>
                  <button onClick={() => togglePin(n)} title={n.pinned ? "Unpin" : "Pin to top"}
                    style={{ border: "none", background: "transparent", color: n.pinned ? "#F9A8D4" : C.muted, cursor: "pointer", fontSize: 10.5, fontWeight: 700, fontFamily: "inherit" }}>
                    {n.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button onClick={() => remove(n)} title="Delete"
                    style={{ border: "none", background: "transparent", color: "#FCA5A5", cursor: "pointer", fontSize: 10.5, fontWeight: 700, fontFamily: "inherit" }}>
                    Delete
                  </button>
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
