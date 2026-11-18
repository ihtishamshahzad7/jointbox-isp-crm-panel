"use client";

/**
 * Advanced CRM reports on the Reports screen. Uplinko's existing reports stay
 * above; these add staff collection, daily sales, collections by method,
 * stock transfers, stock-count reconciliation, equipment, terminations and
 * turnaround compliance. Shown only when the company holds `crm-advanced`.
 */
import React, { useEffect, useState } from "react";
import API from "../components/api";

const NAMES: Record<string, string> = {
  "staff-collection": "Staff collection",
  "daily-sales": "Daily sales",
  transactions: "Collections by method",
  "stock-transfers": "Stock transfers",
  "inventory-reconciliation": "Stock count reconciliation",
  equipment: "Equipment issued / lost",
  terminations: "Terminations & revenue lost",
  "tat-compliance": "Turnaround compliance",
};

type Result = { report: string; from: string; to: string; timeZone: string; rows: Array<Record<string, unknown>> };

function token() {
  return typeof window !== "undefined" ? localStorage.getItem("token") || "" : "";
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token()}` } });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && (Array.isArray(d.message) ? d.message.join(", ") : d.message)) || `Request failed (${r.status})`);
  return d as T;
}

export function useCrmAdvanced(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    get<{ features: string[] }>("/users/me/features").then((d) => { if (live) setOn(!!d?.features?.includes("crm-advanced")); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return on;
}

const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const label = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const show = (v: unknown) =>
  v === null || v === undefined ? "—" : typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) :
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v).toLocaleString() : String(v);

export function CrmReports() {
  const [name, setName] = useState("staff-collection");
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState("");
  const key = `/crm/reports/${name}?from=${from}&to=${to}`;
  const loading = !err && res !== null && `/crm/reports/${res.report}?from=${res.from}&to=${res.to}` !== key;

  useEffect(() => {
    let live = true;
    get<Result>(key).then((d) => { if (live) { setRes(d); setErr(""); } }).catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [key]);

  const cols = res?.rows.length ? Object.keys(res.rows[0]).filter((c) => c !== "id" && c !== "userId") : [];
  const csv = () => {
    if (!res) return;
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const text = [cols.map(label).map(q).join(","), ...res.rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}-${res.from}-to-${res.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const input: React.CSSProperties = { fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", color: "var(--text)" };
  const cell: React.CSSProperties = { padding: "6px 10px", borderTop: "1px solid var(--border)", fontSize: 12, whiteSpace: "nowrap" };

  return (
    <section style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 14, marginTop: 16 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ fontSize: 14, fontWeight: 800, margin: "0 8px 0 0" }}>Advanced CRM reports</h2>
        <label htmlFor="crm-rep" style={{ position: "absolute", left: -9999 }}>Report</label>
        <select id="crm-rep" style={input} value={name} onChange={(e) => setName(e.target.value)}>
          {Object.entries(NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label htmlFor="crm-from" style={{ fontSize: 12, color: "var(--muted)" }}>From</label>
        <input id="crm-from" type="date" style={input} value={from} onChange={(e) => setFrom(e.target.value)} />
        <label htmlFor="crm-to" style={{ fontSize: 12, color: "var(--muted)" }}>To</label>
        <input id="crm-to" type="date" style={input} value={to} onChange={(e) => setTo(e.target.value)} />
        <button onClick={csv} disabled={!res?.rows.length} style={{ ...input, cursor: "pointer" }}>⤓ CSV</button>
      </div>
      {err && <div role="alert" style={{ fontSize: 12, color: "#ef4444", fontWeight: 600 }}>{err}</div>}
      {!err && (res === null || loading) && <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading…</div>}
      {!err && res && !loading && (res.rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--muted)" }}>Nothing in this period.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>{cols.map((c) => <th key={c} style={{ ...cell, borderTop: "none", textAlign: "left", fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase" }}>{label(c)}</th>)}</tr></thead>
            <tbody>
              {res.rows.map((r, i) => (
                <tr key={i}>{cols.map((c) => <td key={c} style={{ ...cell, textAlign: typeof r[c] === "number" ? "right" : "left", fontVariantNumeric: "tabular-nums" }}>{show(r[c])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {res && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>Days in {res.timeZone}. Amounts are per currency and never added across currencies.</div>}
    </section>
  );
}
