"use client";

import { useMemo, useRef, useState } from "react";
import API_BASE from "./api";
import Portal from "../components/portal";

const API =
  API_BASE;

export type ImportField = { label: string; field: string };
export type RefOption = { id: number | string; label: string; match: string[] };
export type ImportReference = { field: string; label: string; options: RefOption[] };

export type ImportConfig = {
  title: string;
  endpoint: string;                 // e.g. "/packages/import"
  required: ImportField[];          // block import if blank
  optional?: ImportField[];         // shown, never blocks
  alias?: Record<string, string>;   // foreign header → canonical field
  drop?: string[];                  // foreign columns to ignore
  references?: ImportReference[];   // foreign-id fields to remap to this panel
  sample?: string;                  // sample CSV for the template button
  extraPayload?: Record<string, any>;
};

const norm = (v: any) => String(v ?? "").trim().toLowerCase();

/** Quote-aware CSV parser. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Reusable file-import dialog: upload/paste → normalize headers → check the
 * required fields → remap any foreign ids to THIS panel → import. Used for
 * subscribers, packages, IP pools and NAS so every importer behaves the same.
 */
export default function ImportWizard({ config, onClose, onDone }: {
  config: ImportConfig;
  onClose: () => void;
  onDone?: (result: any) => void;
}) {
  const [raw, setRaw] = useState("");
  const [fileName, setFileName] = useState("");
  const [maps, setMaps] = useState<Record<string, Record<string, string>>>({}); // field → value → localId
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  const canon = (r: Record<string, any>) => {
    const alias = config.alias || {};
    const drop = new Set((config.drop || []).map((d) => d.toLowerCase()));
    const o: Record<string, any> = {};
    for (const k of Object.keys(r)) {
      const key = k.trim().toLowerCase();
      if (drop.has(key)) continue;
      const dest = alias[key] || k.trim();
      const v = typeof r[k] === "string" ? r[k].trim() : r[k];
      if (o[dest] === undefined || o[dest] === "") o[dest] = v;
    }
    return o;
  };

  const rows = useMemo<any[] | null>(() => {
    const s = raw.trim();
    if (!s) return [];
    try {
      if (s.startsWith("[")) return (JSON.parse(s) as any[]).map(canon);
      const grid = parseCsv(s).filter((r) => r.some((c) => c.trim() !== ""));
      if (grid.length < 2) return [];
      const headers = grid[0].map((h) => h.trim());
      return grid.slice(1).map((cols) => {
        const o: Record<string, string> = {};
        headers.forEach((h, i) => { o[h] = (cols[i] ?? "").trim(); });
        return canon(o);
      });
    } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  const onFile = async (file?: File | null) => {
    if (!file) return;
    const n = file.name.toLowerCase();
    try {
      if (n.endsWith(".xlsx") || n.endsWith(".xls")) {
        const XLSX: any = await import("xlsx");
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        setRaw(XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]));
      } else setRaw(await file.text());
      setFileName(file.name);
      setMsg(null);
    } catch (e: any) { setMsg({ ok: false, text: `Could not read file: ${e?.message || e}` }); }
  };

  const resolveRef = (ref: ImportReference, val: string): string | null => {
    const manual = maps[ref.field]?.[val];
    if (manual) return manual;
    const v = norm(val);
    const hit = ref.options.find((o) => String(o.id) === v || o.match.map(norm).includes(v));
    return hit ? String(hit.id) : null;
  };

  const setMap = (field: string, val: string, id: string) =>
    setMaps((m) => ({ ...m, [field]: { ...(m[field] || {}), [val]: id } }));

  const doImport = async () => {
    if (rows === null) { setMsg({ ok: false, text: "Could not parse — check the CSV/JSON format." }); return; }
    if (rows.length === 0) { setMsg({ ok: false, text: "No rows found." }); return; }

    // required fields
    const miss = rows.map((r, i) => ({ i, bad: config.required.filter((f) => !String(r[f.field] ?? "").trim()).map((f) => f.label) })).filter((x) => x.bad.length);
    if (miss.length) { setMsg({ ok: false, text: `${miss.length} row(s) missing required fields — e.g. row ${miss[0].i + 2}: ${miss[0].bad.join(", ")}` }); return; }

    // resolve references
    const out = rows.map((r) => ({ ...r }));
    const unresolved: string[] = [];
    for (const ref of config.references || []) {
      out.forEach((r, i) => {
        const val = String(r[ref.field] ?? "").trim();
        if (!val) return;
        const id = resolveRef(ref, val);
        if (id) r[ref.field] = isNaN(Number(id)) ? id : Number(id);
        else unresolved.push(`row ${i + 2}: ${ref.label} "${val}"`);
      });
    }
    if (unresolved.length) { setMsg({ ok: false, text: `Map these first: ${unresolved.slice(0, 4).join("; ")}${unresolved.length > 4 ? "…" : ""}` }); return; }

    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`${API}${config.endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ rows: out, ...(config.extraPayload || {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ ok: false, text: data.message || `Import failed (HTTP ${res.status})` }); setBusy(false); return; }
      setMsg({ ok: true, text: `Imported ${data.success ?? 0}/${data.total ?? out.length}${data.failed ? ` · ${data.failed} failed` : ""}` });
      onDone?.(data);
    } catch (e: any) { setMsg({ ok: false, text: e?.message || "Import failed" }); }
    setBusy(false);
  };

  const cols = rows && rows[0] ? Object.keys(rows[0]) : [];
  const blanks = (f: string) => (rows || []).filter((r) => !String(r[f] ?? "").trim()).length;

  return (
    <Portal><div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 18, width: "100%", maxWidth: 760, maxHeight: "90vh", overflowY: "auto", color: "var(--text)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>{config.title}</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 12 }}>Upload CSV / Excel / JSON, or paste below. Headers from other panels are matched automatically.</div>

        <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.json,.xlsx,.xls" style={{ display: "none" }}
          onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
        <div onClick={() => fileRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}
          style={{ border: "2px dashed var(--border)", borderRadius: 10, padding: "16px 14px", textAlign: "center", cursor: "pointer", background: "var(--surface-2)" }}>
          <div style={{ fontSize: 20 }}>📄⬆️</div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{fileName ? `Selected: ${fileName}` : "Click to upload, or drag a file here"}</div>
        </div>

        <textarea value={raw} onChange={(e) => { setRaw(e.target.value); setFileName(""); }} placeholder="…or paste CSV / JSON"
          style={{ width: "100%", marginTop: 10, minHeight: 110, resize: "vertical", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: 10, fontSize: 12, fontFamily: "monospace" }} />
        {config.sample && (
          <div style={{ textAlign: "right", marginTop: 6 }}>
            <button onClick={() => setRaw(config.sample!)} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 6, color: "var(--muted)", fontSize: 11, padding: "4px 8px", cursor: "pointer" }}>Load sample template</button>
          </div>
        )}

        {rows === null && <div style={{ marginTop: 10, color: "#ef4444", fontSize: 12 }}>⚠ Could not parse — check the format.</div>}

        {rows && rows.length > 0 && (
          <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Check &amp; map before import ({rows.length} rows)</div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 700 }}>REQUIRED:</span>
              {config.required.map((f) => (
                <span key={f.field} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 999, background: blanks(f.field) === 0 ? "rgba(34,197,94,.14)" : "rgba(239,68,68,.14)", color: blanks(f.field) === 0 ? "#16a34a" : "#ef4444", fontWeight: 600 }}>
                  {blanks(f.field) === 0 ? "✓" : "✕"} {f.label}{blanks(f.field) ? ` (${blanks(f.field)} blank)` : ""}
                </span>
              ))}
              {(config.optional || []).length > 0 && <span style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 700, marginLeft: 6 }}>OPTIONAL:</span>}
              {(config.optional || []).map((f) => (
                <span key={f.field} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 999, background: blanks(f.field) === 0 ? "rgba(34,197,94,.14)" : "rgba(245,158,11,.14)", color: blanks(f.field) === 0 ? "#16a34a" : "#f59e0b", fontWeight: 600 }}>
                  {blanks(f.field) === 0 ? "✓" : "◦"} {f.label}{blanks(f.field) ? ` (${blanks(f.field)} blank)` : ""}
                </span>
              ))}
            </div>

            {(config.references || []).map((ref) => {
              const vals = [...new Set((rows || []).map((r) => String(r[ref.field] ?? "").trim()).filter(Boolean))];
              if (vals.length === 0) return null;
              const bad = vals.filter((v) => !resolveRef(ref, v));
              return (
                <div key={ref.field} style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>
                    {ref.label}: {vals.length - bad.length}/{vals.length} already match this panel
                    {bad.length > 0 && <span style={{ color: "#f59e0b" }}> · {bad.length} need you to pick below</span>}
                  </div>
                  {bad.length > 0 && (
                    <div style={{ fontSize: 11, color: "var(--muted)", margin: "4px 0 2px" }}>
                      These id/names came from another panel. Pick the matching {ref.label} here (or set them in the file before upload).
                    </div>
                  )}
                  {bad.map((v) => {
                    const count = (rows || []).filter((r) => String(r[ref.field] ?? "").trim() === v).length;
                    return (
                      <div key={v} style={{ display: "grid", gridTemplateColumns: "220px 1fr", alignItems: "center", gap: 8, marginTop: 6 }}>
                        <span style={{ fontSize: 12 }}>File&apos;s {ref.label} <b style={{ color: "#f59e0b" }}>{v}</b> <span style={{ color: "var(--muted)" }}>({count}) →</span></span>
                        <select value={maps[ref.field]?.[v] || ""} onChange={(e) => setMap(ref.field, v, e.target.value)}
                          style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 9px", cursor: "pointer" }}>
                          <option value="">— choose the matching {ref.label} in this panel —</option>
                          {ref.options.map((o) => <option key={o.id} value={o.id}>{o.label} — id {o.id}</option>)}
                        </select>
                      </div>
                    );
                  })}
                </div>
              );
            })}

            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead><tr>{cols.slice(0, 6).map((c) => <th key={c} style={{ textAlign: "left", padding: "4px 6px", color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>{c}</th>)}</tr></thead>
                <tbody>{(rows || []).slice(0, 3).map((r, i) => <tr key={i}>{cols.slice(0, 6).map((c) => <td key={c} style={{ padding: "4px 6px", borderBottom: "1px solid var(--border)" }}>{String(r[c] ?? "")}</td>)}</tr>)}</tbody>
              </table>
              {rows.length > 3 && <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 4 }}>…and {rows.length - 3} more</div>}
            </div>
          </div>
        )}

        {msg && <div style={{ marginTop: 10, fontSize: 12.5, color: msg.ok ? "#16a34a" : "#ef4444" }}>{msg.text}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", padding: "8px 14px", cursor: "pointer" }}>Close</button>
          <button onClick={doImport} disabled={busy || !rows || rows.length === 0}
            style={{ background: "var(--accent,#378ADD)", border: "none", borderRadius: 8, color: "#fff", padding: "8px 16px", cursor: busy ? "default" : "pointer", opacity: busy || !rows || rows.length === 0 ? 0.6 : 1, fontWeight: 700 }}>
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
