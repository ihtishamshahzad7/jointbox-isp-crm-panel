"use client";

/**
 * Advanced CRM on the Users screen: employee codes, titles, departments,
 * reporting managers and availability for the company's own people. HR only:
 * nothing here changes anyone's role or permissions. Shown only when the
 * company holds `crm-advanced`; the backend enforces it regardless.
 */
import React, { useEffect, useState } from "react";
import API from "../components/api";

type Person = {
  userId: number; name: string; role: string; isActive: boolean; employeeCode: string | null;
  designationId: number | null; designation: string | null; department: string | null;
  reportsToUserId: number | null; reportsTo: string | null; availability: string;
};
type Designation = { id: number; name: string; isActive: boolean };

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

const AVAIL: Record<string, { label: string; color: string }> = {
  AVAILABLE: { label: "Available", color: "#22c55e" },
  ON_DUTY: { label: "On duty", color: "#0ea5e9" },
  ON_LEAVE: { label: "On leave", color: "#f59e0b" },
};

export function StaffPanel() {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [titles, setTitles] = useState<Designation[]>([]);
  const [rev, setRev] = useState(0);
  const [newTitle, setNewTitle] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    Promise.all([call<Person[]>("/crm/staff"), call<Designation[]>("/crm/designations")])
      .then(([p, d]) => { if (live) { setPeople(p); setTitles(d); } })
      .catch((e: Error) => { if (live) setMsg({ text: e.message, ok: false }); });
    return () => { live = false; };
  }, [open, rev]);

  const save = async (p: Person, patch: Partial<Person>) => {
    setBusy(p.userId);
    setMsg(null);
    try {
      await call(`/crm/staff/${p.userId}`, "PUT", patch);
      setRev((n) => n + 1);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally { setBusy(null); }
  };

  const addTitle = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await call("/crm/designations", "POST", { name: newTitle });
      setNewTitle("");
      setRev((n) => n + 1);
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), ok: false });
    }
  };

  const input: React.CSSProperties = { fontSize: 12, padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", maxWidth: 170 };
  const cell: React.CSSProperties = { padding: "6px 8px", borderTop: "1px solid var(--border)", fontSize: 12, verticalAlign: "middle" };

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 12, marginBottom: 14 }}>
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        style={{ background: "none", border: "none", color: "var(--text)", fontWeight: 700, fontSize: 13, cursor: "pointer", padding: 0 }}>
        {open ? "▾" : "▸"} Staff records — codes, titles, reporting lines
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8 }}>HR details only — roles and permissions are not changed here. Changes save as you make them.</div>
          {msg && <div role="status" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: msg.ok ? "#22c55e" : "#ef4444" }}>{msg.text}</div>}
          <form onSubmit={addTitle} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10, fontSize: 12 }}>
            <span style={{ color: "var(--muted)" }}>Titles:</span>
            {titles.map((t) => (
              <button key={t.id} type="button" title={t.isActive ? "Switch off" : "Switch on"}
                onClick={async () => { try { await call(`/crm/designations/${t.id}`, "PATCH", { isActive: !t.isActive }); setRev((n) => n + 1); } catch (e) { setMsg({ text: e instanceof Error ? e.message : String(e), ok: false }); } }}
                style={{ ...input, cursor: "pointer", opacity: t.isActive ? 1 : 0.5, textDecoration: t.isActive ? "none" : "line-through" }}>{t.name}</button>
            ))}
            <label htmlFor="new-title" style={{ position: "absolute", left: -9999 }}>New title</label>
            <input id="new-title" style={input} placeholder="Add a title…" value={newTitle} maxLength={150} onChange={(e) => setNewTitle(e.target.value)} />
            <button type="submit" disabled={!newTitle.trim()} style={{ ...input, cursor: "pointer", fontWeight: 700 }}>Add</button>
          </form>
          {people === null ? <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading…</div> : people.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>No staff accounts yet.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
                <thead><tr>{["Code", "Name", "Title", "Department", "Reports to", "Availability"].map((h) => <th key={h} style={{ ...cell, borderTop: "none", textAlign: "left", fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase" }}>{h}</th>)}</tr></thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.userId} style={{ opacity: busy === p.userId ? 0.6 : 1 }}>
                      <td style={{ ...cell, fontFamily: "ui-monospace,monospace" }}>{p.employeeCode ?? "—"}</td>
                      <td style={cell}><b>{p.name}</b> <span style={{ color: "var(--muted)" }}>{p.role.toLowerCase()}</span></td>
                      <td style={cell}>
                        <select aria-label={`Title for ${p.name}`} style={input} value={p.designationId ?? ""} disabled={busy !== null}
                          onChange={(e) => save(p, { designationId: e.target.value ? Number(e.target.value) : null })}>
                          <option value="">—</option>
                          {titles.filter((t) => t.isActive || t.id === p.designationId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </td>
                      <td style={cell}>
                        <input aria-label={`Department for ${p.name}`} style={input} defaultValue={p.department ?? ""} maxLength={100} disabled={busy !== null}
                          onBlur={(e) => { if ((e.target.value || null) !== p.department) void save(p, { department: e.target.value || null }); }} />
                      </td>
                      <td style={cell}>
                        <select aria-label={`Manager for ${p.name}`} style={input} value={p.reportsToUserId ?? ""} disabled={busy !== null}
                          onChange={(e) => save(p, { reportsToUserId: e.target.value ? Number(e.target.value) : null })}>
                          <option value="">—</option>
                          {people.filter((x) => x.userId !== p.userId).map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}
                        </select>
                      </td>
                      <td style={cell}>
                        <select aria-label={`Availability for ${p.name}`} style={{ ...input, color: AVAIL[p.availability]?.color }} value={p.availability} disabled={busy !== null}
                          onChange={(e) => save(p, { availability: e.target.value })}>
                          {Object.entries(AVAIL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </select>
                      </td>
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
