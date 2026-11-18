"use client";

/**
 * Advanced CRM on the Complaints screen: the company's own turnaround targets
 * per category and priority, and changing one ticket's turnaround. Shown only
 * when the company holds `crm-advanced`; the backend enforces it regardless.
 */
import React, { useEffect, useState } from "react";
import API from "../components/api";

type Row = { category: string; priority: string; responseMinutes: number; resolutionMinutes: number; custom: boolean };

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && (Array.isArray(d.message) ? d.message.join(", ") : d.message)) || `Request failed (${r.status})`);
  return d as T;
}

export function useCrmAdvanced(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    call<{ features: string[] }>("/users/me/features").then((d) => { if (live) setOn(!!d?.features?.includes("crm-advanced")); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return on;
}

/** The signed-in role, read from the token for display only (the server decides). */
export function useMyRole(): string | null {
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    try {
      const t = localStorage.getItem("token") || "";
      const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from storage after mount
      setRole(typeof p?.role === "string" ? p.role : null);
    } catch { /* no token */ }
  }, []);
  return role;
}

const hrs = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);
const CATS = ["TECHNICAL", "BILLING", "COMPLAINT", "INSTALLATION", "DISCONNECTION", "OTHER"];
const PRIOS = ["URGENT", "HIGH", "MEDIUM", "LOW"];

export function TatPanel({ canEdit }: { canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [rev, setRev] = useState(0);
  const [edit, setEdit] = useState<{ category: string; priority: string; response: string; resolution: string } | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    call<Row[]>("/crm/tat").then((d) => { if (live) setRows(d); }).catch((e: Error) => { if (live) setMsg({ text: e.message, ok: false }); });
    return () => { live = false; };
  }, [open, rev]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    try {
      await call("/crm/tat", "PUT", {
        category: edit.category, priority: edit.priority,
        responseMinutes: Math.round(Number(edit.response) * 60), resolutionMinutes: Math.round(Number(edit.resolution) * 60),
      });
      setMsg({ text: "Saved. New tickets use it; existing tickets keep their deadlines.", ok: true });
      setEdit(null);
      setRev((n) => n + 1);
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), ok: false });
    }
  };

  const reset = async (category: string, priority: string) => {
    try {
      await call("/crm/tat", "DELETE", { category, priority });
      setRev((n) => n + 1);
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), ok: false });
    }
  };

  const cell: React.CSSProperties = { padding: "5px 8px", borderTop: "1px solid var(--border)", fontSize: 12, whiteSpace: "nowrap" };
  const input: React.CSSProperties = { width: 70, fontSize: 12, padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)" };

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 12, marginBottom: 14 }}>
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        style={{ background: "none", border: "none", color: "var(--text)", fontWeight: 700, fontSize: 13, cursor: "pointer", padding: 0 }}>
        {open ? "▾" : "▸"} Turnaround targets
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>
            First response / resolution, per category and priority. {canEdit ? "Click a cell to change it." : "Only the company owner can change these."}
          </div>
          {msg && <div role="status" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: msg.ok ? "#22c55e" : "#ef4444" }}>{msg.text}</div>}
          {edit && (
            <form onSubmit={save} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8, fontSize: 12 }}>
              <b>{edit.category.toLowerCase()} · {edit.priority.toLowerCase()}</b>
              <label htmlFor="tat-resp">Response (h)</label>
              <input id="tat-resp" style={input} inputMode="decimal" value={edit.response} onChange={(e) => setEdit({ ...edit, response: e.target.value })} />
              <label htmlFor="tat-res">Resolution (h)</label>
              <input id="tat-res" style={input} inputMode="decimal" value={edit.resolution} onChange={(e) => setEdit({ ...edit, resolution: e.target.value })} />
              <button type="submit" style={{ ...input, width: "auto", cursor: "pointer", fontWeight: 700 }}>Save</button>
              <button type="button" onClick={() => setEdit(null)} style={{ ...input, width: "auto", cursor: "pointer" }}>Cancel</button>
            </form>
          )}
          {rows === null ? <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading…</div> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr><th style={{ ...cell, textAlign: "left", borderTop: "none" }}>Category</th>{PRIOS.map((p) => <th key={p} style={{ ...cell, textAlign: "left", borderTop: "none" }}>{p.toLowerCase()}</th>)}</tr></thead>
                <tbody>
                  {CATS.map((c) => (
                    <tr key={c}>
                      <td style={{ ...cell, fontWeight: 600 }}>{c.toLowerCase()}</td>
                      {PRIOS.map((p) => {
                        const r = rows.find((x) => x.category === c && x.priority === p);
                        if (!r) return <td key={p} style={cell}>—</td>;
                        return (
                          <td key={p} style={{ ...cell, fontWeight: r.custom ? 700 : 400 }}>
                            {canEdit ? (
                              <button onClick={() => setEdit({ category: c, priority: p, response: String(r.responseMinutes / 60), resolution: String(r.resolutionMinutes / 60) })}
                                style={{ background: "none", border: "none", color: "inherit", font: "inherit", cursor: "pointer", padding: 0 }}>
                                {hrs(r.responseMinutes)} / {hrs(r.resolutionMinutes)}
                              </button>
                            ) : `${hrs(r.responseMinutes)} / ${hrs(r.resolutionMinutes)}`}
                            {r.custom && canEdit && (
                              <button onClick={() => reset(c, p)} title="Back to default" aria-label="Back to default"
                                style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", marginLeft: 4 }}>↺</button>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Change one open ticket's turnaround (hours from when it was opened). Not for sales staff. */
export function TicketTat({ ticketId, onDone }: { ticketId: number; onDone?: () => void }) {
  const [hours, setHours] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await call<{ resolutionDueAt: string }>(`/crm/tickets/${ticketId}/tat`, "POST", { hours: Number(hours) });
      setMsg({ text: `Due ${new Date(r.resolutionDueAt).toLocaleString()}`, ok: true });
      setHours("");
      onDone?.();
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), ok: false });
    }
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "10px 0", fontSize: 12 }}>
      <label htmlFor={`ttat-${ticketId}`} style={{ color: "var(--muted)" }}>Turnaround (hours from opening)</label>
      <input id={`ttat-${ticketId}`} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)}
        style={{ width: 70, fontSize: 12, padding: "5px 7px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)" }} />
      <button type="submit" disabled={!hours.trim()} style={{ fontSize: 12, padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text)", cursor: "pointer" }}>Set</button>
      {msg && <span role="status" style={{ color: msg.ok ? "#22c55e" : "#ef4444", fontWeight: 600 }}>{msg.text}</span>}
    </form>
  );
}
