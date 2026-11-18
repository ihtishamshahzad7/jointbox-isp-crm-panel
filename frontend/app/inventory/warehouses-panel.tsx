"use client";

/**
 * Advanced CRM on the Inventory screen: warehouses, label codes, transfers and
 * stock counts. Shown only when the company holds `crm-advanced` — the backend
 * refuses these routes otherwise, so this is presentation, not security.
 */
import React, { useEffect, useState } from "react";
import API from "../components/api";

type Item = { id: number; serialNumber: string; type: string; status: string; brand?: string | null; model?: string | null };
type Warehouse = { id: number; name: string; address: string | null; isActive: boolean; inStock: number; total: number };
type Recovery = {
  id: number; issuedAt: string; charge: number;
  item: { serialNumber: string; type: string; model: string | null } | null;
  customer: { id: number; fullName: string; username: string; status: string } | null;
};
type Report = {
  id: number; status: string; counts: { expected: number; found: number; missing: number; unexpected: number };
  missing: Array<{ id: number; serialNumber?: string; qrCode?: string | null }>;
  unexpected: Array<{ id: number; serialNumber?: string; qrCode?: string | null }>;
};

const C = { card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)", text: "var(--text)", muted: "var(--muted)", accent: "#0ea5e9", green: "#22c55e", red: "#ef4444" };

function headers(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && (Array.isArray(d.message) ? d.message.join(", ") : d.message)) || `Request failed (${r.status})`);
  return d as T;
}

/** Does the caller's company hold Advanced CRM? (false while loading or on error) */
export function useCrmAdvanced(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    call<{ features: string[] }>("/users/me/features")
      .then((d) => { if (live) setOn(!!d?.features?.includes("crm-advanced")); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return on;
}

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export function WarehousesPanel({ items, onChanged }: { items: Item[]; onChanged: () => void }) {
  const [tab, setTab] = useState<"warehouses" | "move" | "count" | "recover">("warehouses");
  const [list, setList] = useState<Warehouse[]>([]);
  const [rev, setRev] = useState(0);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [toWh, setToWh] = useState("");
  const [countWh, setCountWh] = useState("");
  const [countId, setCountId] = useState<number | null>(null);
  const [code, setCode] = useState("");
  const [scans, setScans] = useState<Array<{ code: string; note: string; ok: boolean }>>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [queue, setQueue] = useState<Recovery[] | null>(null);

  useEffect(() => {
    if (tab !== "recover") return;
    let live = true;
    call<Recovery[]>("/crm/inventory/recoveries")
      .then((d) => { if (live) setQueue(d); })
      .catch((e: Error) => { if (live) setMsg({ text: e.message, ok: false }); });
    return () => { live = false; };
  }, [tab, rev]);

  useEffect(() => {
    let live = true;
    call<Warehouse[]>("/crm/inventory/warehouses")
      .then((d) => { if (live) setList(d); })
      .catch((e: Error) => { if (live) setMsg({ text: e.message, ok: false }); });
    return () => { live = false; };
  }, [rev]);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const ok = await fn();
      if (ok) setMsg({ text: ok, ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally { setBusy(false); }
  };

  const inStock = items.filter((i) => i.status === "IN_STOCK");
  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const printLabels = () => run(async () => {
    const w = window.open("", "_blank", "width=720,height=800");
    const rows = await call<Array<{ id: number; qrCode: string; serialNumber: string; type: string; brand?: string; model?: string }>>(
      "/crm/inventory/qr", "POST", { itemIds: [...picked] });
    if (w) {
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Stock labels</title><style>
body{font:12px system-ui,sans-serif;margin:16px;color:#000;background:#fff}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.l{border:1px dashed #999;padding:10px;break-inside:avoid}.c{font:700 15px ui-monospace,monospace;letter-spacing:.06em}small{color:#444}
@media print{button{display:none}}</style></head><body><button onclick="window.print()">Print</button><div class="g">${rows
        .map((r) => `<div class="l"><div class="c">${esc(r.qrCode)}</div><small>${esc(r.type)} · ${esc(r.serialNumber)}${r.model ? ` · ${esc(r.model)}` : ""}</small></div>`)
        .join("")}</div></body></html>`);
      w.document.close();
    }
    onChanged();
    return `${rows.length} label${rows.length === 1 ? "" : "s"} ready. Existing codes were kept.`;
  });

  const transfer = () => run(async () => {
    const r = await call<{ moved: number }>("/crm/inventory/transfers", "POST", { itemIds: [...picked], toWarehouseId: Number(toWh) });
    setPicked(new Set());
    setRev((n) => n + 1);
    onChanged();
    return `Moved ${r.moved} unit${r.moved === 1 ? "" : "s"}.`;
  });

  const startCount = () => run(async () => {
    const st = await call<{ id: number; expected: number }>("/crm/inventory/stocktakes", "POST", { warehouseId: Number(countWh) });
    setCountId(st.id);
    setScans([]);
    setReport(null);
    return `Count started: ${st.expected} unit${st.expected === 1 ? "" : "s"} expected. Scan labels now.`;
  });

  const scan = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (!c || countId == null) return;
    setCode("");
    try {
      const r = await call<{ expected: boolean; note: string }>(`/crm/inventory/stocktakes/${countId}/scan`, "POST", { code: c });
      setScans((s) => [{ code: c, note: r.note, ok: r.expected }, ...s].slice(0, 200));
    } catch (err) {
      setScans((s) => [{ code: c, note: err instanceof Error ? err.message : "Not recognised", ok: false }, ...s].slice(0, 200));
    }
  };

  const closeCount = () => run(async () => {
    if (countId == null) return;
    const r = await call<Report>(`/crm/inventory/stocktakes/${countId}/close`, "POST");
    setReport(r);
    setCountId(null);
    return "Count closed.";
  });

  const card: React.CSSProperties = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 };
  const input: React.CSSProperties = { background: C.row, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 9px", color: C.text, fontSize: 12 };
  const btn = (bg: string, off = false): React.CSSProperties => ({ background: bg, color: "#fff", border: "none", borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, cursor: off ? "not-allowed" : "pointer", opacity: off ? 0.5 : 1 });
  const active = list.filter((w) => w.isActive);

  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginRight: 8 }}>Warehouses &amp; counts</div>
        {([["warehouses", "Warehouses"], ["move", "Labels & transfers"], ["count", "Stock count"], ["recover", "Recovery queue"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...input, cursor: "pointer", fontWeight: tab === k ? 700 : 400, borderColor: tab === k ? C.accent : C.border }}>{l}</button>
        ))}
      </div>
      {msg && <div role="status" style={{ fontSize: 12, fontWeight: 600, color: msg.ok ? C.green : C.red, marginBottom: 8 }}>{msg.text}</div>}

      {tab === "warehouses" && (
        <div>
          <form onSubmit={(e) => { e.preventDefault(); run(async () => { await call("/crm/inventory/warehouses", "POST", { name }); setName(""); setRev((n) => n + 1); return "Warehouse added."; }); }}
            style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <label htmlFor="wh-name" style={{ position: "absolute", left: -9999 }}>Warehouse name</label>
            <input id="wh-name" style={{ ...input, flex: "1 1 200px" }} placeholder="New warehouse name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            <button type="submit" style={btn(C.accent, busy || !name.trim())} disabled={busy || !name.trim()}>Add warehouse</button>
          </form>
          {list.length === 0 ? <div style={{ fontSize: 12, color: C.muted }}>No warehouses yet.</div> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
              {list.map((w) => (
                <div key={w.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, opacity: w.isActive ? 1 : 0.55 }}>
                  <div style={{ fontWeight: 700 }}>{w.name}</div>
                  <div style={{ fontSize: 11.5, color: C.muted }}>{w.inStock} in stock · {w.total} total</div>
                  <button style={{ ...input, marginTop: 6, cursor: "pointer", fontSize: 11 }} disabled={busy}
                    onClick={() => run(async () => { await call(`/crm/inventory/warehouses/${w.id}`, "PATCH", { isActive: !w.isActive }); setRev((n) => n + 1); return w.isActive ? `${w.name} switched off.` : `${w.name} switched on.`; })}>
                    {w.isActive ? "Switch off" : "Switch on"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "move" && (
        <div>
          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 8 }}>Tick in-stock units, then print their labels or move them. A unit keeps its label code for life.</div>
          <div style={{ maxHeight: 220, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8 }}>
            {inStock.length === 0 ? <div style={{ padding: 10, fontSize: 12, color: C.muted }}>No units in stock on this list.</div> : inStock.map((i) => (
              <label key={i.id} htmlFor={`pick-${i.id}`} style={{ display: "flex", gap: 8, padding: "5px 10px", fontSize: 12, borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
                <input id={`pick-${i.id}`} type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
                <span style={{ fontFamily: "ui-monospace,monospace" }}>{i.serialNumber}</span>
                <span style={{ color: C.muted }}>{i.type}{i.model ? ` · ${i.model}` : ""}</span>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: C.muted }}>{picked.size} selected</span>
            <button style={btn("#6366f1", busy || !picked.size)} disabled={busy || !picked.size} onClick={printLabels}>Print labels</button>
            <label htmlFor="to-wh" style={{ fontSize: 12, color: C.muted }}>Move to</label>
            <select id="to-wh" style={input} value={toWh} onChange={(e) => setToWh(e.target.value)}>
              <option value="">Choose warehouse…</option>
              {active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <button style={btn(C.green, busy || !picked.size || !toWh)} disabled={busy || !picked.size || !toWh} onClick={transfer}>Move</button>
          </div>
        </div>
      )}

      {tab === "recover" && (
        <div>
          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 8 }}>Units still at customers whose service has ended (expired, suspended or inactive), oldest first.</div>
          {queue === null ? <div style={{ fontSize: 12, color: C.muted }}>Loading…</div> : queue.length === 0 ? (
            <div style={{ fontSize: 12, color: C.muted }}>Nothing to recover.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>{["Unit", "Customer", "Service", "Issued", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "5px 8px", color: C.muted, fontSize: 10.5, textTransform: "uppercase" }}>{h}</th>)}</tr></thead>
                <tbody>
                  {queue.map((r) => (
                    <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={{ padding: "5px 8px", fontFamily: "ui-monospace,monospace" }}>{r.item ? `${r.item.type} · ${r.item.serialNumber}` : `#${r.id}`}</td>
                      <td style={{ padding: "5px 8px" }}>{r.customer ? `${r.customer.fullName} (${r.customer.username})` : "—"}</td>
                      <td style={{ padding: "5px 8px" }}>{r.customer?.status.toLowerCase() ?? "—"}</td>
                      <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{r.issuedAt.slice(0, 10)}</td>
                      <td style={{ padding: "5px 8px", whiteSpace: "nowrap", textAlign: "right" }}>
                        {(["IN_STOCK", "FAULTY", "LOST"] as const).map((c) => (
                          <button key={c} disabled={busy} style={{ ...input, cursor: "pointer", fontSize: 11, marginLeft: 4 }}
                            onClick={() => {
                              if (c === "LOST" && !window.confirm("Write this unit off as lost?")) return;
                              void run(async () => { await call(`/crm/inventory/issues/${r.id}/recover`, "POST", { condition: c }); setRev((n) => n + 1); onChanged(); return c === "LOST" ? "Written off." : "Recovered."; });
                            }}>{c === "IN_STOCK" ? "Recovered" : c === "FAULTY" ? "Faulty" : "Lost"}</button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "count" && (
        <div>
          {countId == null ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label htmlFor="count-wh" style={{ fontSize: 12, color: C.muted }}>Count</label>
              <select id="count-wh" style={input} value={countWh} onChange={(e) => setCountWh(e.target.value)}>
                <option value="">Choose warehouse…</option>
                {active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              <button style={btn(C.accent, busy || !countWh)} disabled={busy || !countWh} onClick={startCount}>Start count</button>
            </div>
          ) : (
            <div>
              <form onSubmit={scan} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <label htmlFor="scan-code" style={{ position: "absolute", left: -9999 }}>Label code</label>
                <input id="scan-code" autoFocus style={{ ...input, flex: "1 1 240px", fontFamily: "ui-monospace,monospace" }} placeholder="Scan or type a label code (UPL-…)" value={code} onChange={(e) => setCode(e.target.value)} />
                <button type="submit" style={btn(C.accent)}>Record</button>
                <button type="button" style={btn(C.red, busy)} disabled={busy} onClick={closeCount}>Close count</button>
              </form>
              <div style={{ maxHeight: 200, overflowY: "auto", fontSize: 12 }}>
                {scans.map((s, i) => (
                  <div key={`${s.code}-${i}`} style={{ display: "flex", gap: 10, padding: "3px 0" }}>
                    <span style={{ fontFamily: "ui-monospace,monospace", minWidth: 0, overflowWrap: "anywhere" }}>{s.code}</span>
                    <span style={{ color: s.ok ? C.green : "#f59e0b" }}>{s.note}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {report && (
            <div style={{ marginTop: 10, fontSize: 12 }}>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontWeight: 700 }}>
                <span>Expected {report.counts.expected}</span>
                <span style={{ color: C.green }}>Found {report.counts.found}</span>
                <span style={{ color: C.red }}>Missing {report.counts.missing}</span>
                <span style={{ color: "#f59e0b" }}>Unexpected {report.counts.unexpected}</span>
              </div>
              {report.missing.length > 0 && <div style={{ marginTop: 6 }}><b>Missing:</b> {report.missing.map((m) => m.serialNumber ?? `#${m.id}`).join(", ")}</div>}
              {report.unexpected.length > 0 && <div style={{ marginTop: 4 }}><b>Unexpected:</b> {report.unexpected.map((m) => m.serialNumber ?? `#${m.id}`).join(", ")}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
