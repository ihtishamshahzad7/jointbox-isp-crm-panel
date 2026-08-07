"use client";

import React from "react";
import API from "./api";

/**
 * LogRecordsTable — server-paginated log table (WinBox style) for very large
 * datasets. Handles its own fetch, search, day-range, and page controls, and
 * shows a "Showing X to Y of N records" line like a classic ISP panel.
 */

export type Col = { key: string; label: string; render?: (row: any) => React.ReactNode; mono?: boolean; nowrap?: boolean };

export function LogRecordsTable({
  endpoint, columns, days, daysOptions, searchable = true, pageSize = 50,
}: {
  endpoint: string;
  columns: Col[];
  /** Initial day range; if daysOptions given, a dropdown is shown. */
  days?: number;
  daysOptions?: { label: string; value: number }[];
  searchable?: boolean;
  pageSize?: number;
}) {
  const [rows, setRows] = React.useState<any[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(0);
  const [size, setSize] = React.useState(pageSize);
  const [q, setQ] = React.useState("");
  const [dayR, setDayR] = React.useState(days ?? 0);
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);

  // Esc closes the expanded (fullscreen) view.
  React.useEffect(() => {
    if (!expanded) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [expanded]);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set("limit", String(size));
      p.set("offset", String(page * size));
      if (q) p.set("q", q);
      if (dayR) p.set("days", String(dayR));
      const r = await fetch(`${API}${endpoint}?${p}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      const list = Array.isArray(d) ? d : (d.logs || d.data || []);
      setRows(list);
      setTotal(Number(d.total ?? list.length));
    } catch { setRows([]); setTotal(0); }
    setLoading(false);
  }, [endpoint, size, page, q, dayR, token]);

  React.useEffect(() => { load(); }, [load]);
  // reset to first page when the query/range changes
  const onSearch = (v: string) => { setQ(v); setPage(0); };
  const onDays = (v: number) => { setDayR(v); setPage(0); };

  const from = total === 0 ? 0 : page * size + 1;
  const to = Math.min((page + 1) * size, total);
  const lastPage = Math.max(0, Math.ceil(total / size) - 1);

  // Compact page-number strip: 1 2 3 4 5 … last
  const pageNums = React.useMemo(() => {
    const out: (number | "…")[] = [];
    const win = 2;
    for (let i = 0; i <= lastPage; i++) {
      if (i <= 1 || i >= lastPage - 0 || Math.abs(i - page) <= win) out.push(i);
      else if (out[out.length - 1] !== "…") out.push("…");
    }
    return out;
  }, [lastPage, page]);

  return (
    <div className={`lrt ${expanded ? "lrt-full" : ""}`}>
      <style>{CSS}</style>

      <div className="lrt-bar">
        {daysOptions && (
          <select value={dayR} onChange={(e) => onDays(Number(e.target.value))} title="Time range">
            {daysOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        <select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }} title="Rows per page">
          {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {searchable && (
          <span className="lrt-find">
            <span>⌕</span>
            <input value={q} onChange={(e) => onSearch(e.target.value)} placeholder="Type & search…" />
          </span>
        )}
        <span className="lrt-spacer" />
        <span className="lrt-count">
          {loading ? "Loading…" : <>Showing <b>{from}</b> to <b>{to}</b> of <b>{total.toLocaleString()}</b> records</>}
        </span>
        <button className="lrt-expand" onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Exit full screen (Esc)" : "Expand to full screen"}>
          {expanded ? "✕ Close" : "⛶ Expand"}
        </button>
      </div>

      <div className="lrt-scroll">
        <table>
          <thead>
            <tr>{columns.map((c) => <th key={c.key} className={c.nowrap ? "nw" : ""}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr className="empty"><td colSpan={columns.length}>No records.</td></tr>
            )}
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} className={`${c.mono ? "mono" : ""} ${c.nowrap ? "nw" : ""}`}>
                    {c.render ? c.render(row) : (row[c.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="lrt-foot">
        <button disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</button>
        {pageNums.map((n, i) => n === "…"
          ? <span key={`e${i}`} className="ell">…</span>
          : <button key={n} className={n === page ? "on" : ""} onClick={() => setPage(n as number)}>{(n as number) + 1}</button>)}
        <button disabled={page >= lastPage} onClick={() => setPage((p) => Math.min(lastPage, p + 1))}>Next</button>
      </div>
    </div>
  );
}

const CSS = `
.lrt{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}

/* Full-screen "expanded" view — fills the viewport so long log rows are easy to read. */
.lrt-full{position:fixed;inset:12px;z-index:350;border-radius:12px;display:flex;flex-direction:column;
  box-shadow:0 0 0 100vmax rgba(0,0,0,.6),0 24px 80px rgba(0,0,0,.65)}
.lrt-full .lrt-scroll{max-height:none;flex:1 1 auto}

.lrt-expand{margin-left:10px;padding:4px 11px;font-size:11.5px;font-weight:700;font-family:inherit;
  cursor:pointer;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:6px}
.lrt-expand:hover{border-color:var(--accent);color:var(--accent)}
.lrt-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;
  background:var(--surface-2);border-bottom:1px solid var(--border)}
.lrt-bar select{background:var(--surface);color:var(--text);border:1px solid var(--border);
  border-radius:6px;font-size:12px;padding:4px 8px;font-family:inherit;cursor:pointer}
.lrt-find{display:inline-flex;align-items:center;gap:5px;padding:0 8px;height:30px;
  background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--muted)}
.lrt-find input{background:transparent;border:none;outline:none;color:var(--text);font-family:inherit;font-size:12px;width:180px}
.lrt-spacer{flex:1 1 auto}
.lrt-count{font-size:11.5px;color:var(--muted)}
.lrt-count b{color:var(--text)}

.lrt-scroll{overflow:auto;max-height:64vh}
.lrt table{width:100%;border-collapse:separate;border-spacing:0;min-width:720px}
.lrt thead th{position:sticky;top:0;z-index:1;text-align:left;padding:7px 12px;font-size:10.5px;
  font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);
  background:var(--surface-2);border-bottom:1px solid var(--border);white-space:nowrap}
.lrt tbody td{padding:6px 12px;font-size:12px;color:var(--text);border-bottom:1px solid var(--border);
  vertical-align:top}
.lrt tbody tr:nth-child(even){background:color-mix(in srgb,var(--surface-2) 45%,transparent)}
.lrt tbody tr:hover{background:color-mix(in srgb,var(--accent) 10%,transparent)}
.lrt td.mono{font-family:ui-monospace,'JetBrains Mono',monospace;font-size:11px}
.lrt td.nw,.lrt th.nw{white-space:nowrap}
.lrt tr.empty td{padding:26px;text-align:center;color:var(--muted)}

.lrt-foot{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:8px 10px;border-top:1px solid var(--border)}
.lrt-foot button{min-width:30px;padding:4px 9px;font-size:12px;font-family:inherit;cursor:pointer;
  background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:6px}
.lrt-foot button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.lrt-foot button.on{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:700}
.lrt-foot button:disabled{opacity:.4;cursor:not-allowed}
.lrt-foot .ell{color:var(--muted);padding:0 4px}
`;
