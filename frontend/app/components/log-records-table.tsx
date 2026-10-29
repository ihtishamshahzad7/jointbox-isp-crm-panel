"use client";

import React from "react";
import API from "./api";

/**
 * LogRecordsTable — server-paginated log table (WinBox style) for very large
 * datasets. Handles its own fetch, search, day-range, and page controls, and
 * shows a "Showing X to Y of N records" line like a classic ISP panel.
 */

export type Col = {
  key: string;
  label: string;
  render?: (row: any) => React.ReactNode;
  mono?: boolean;
  nowrap?: boolean;
  /** Shown in the collapsed row. If ANY column sets this, the rest move into
     the inline expanded detail grid behind a chevron. */
  primary?: boolean;
  /** In the expanded grid, span the full width (for long raw payloads). */
  wide?: boolean;
};

export function LogRecordsTable({
  endpoint, columns, days, daysOptions, searchable = true, pageSize = 50, refreshKey = 0,
  searchText, onSearchTextChange, detailPanel = false,
}: {
  endpoint: string;
  columns: Col[];
  /** Initial day range; if daysOptions given, a dropdown is shown. */
  days?: number;
  daysOptions?: { label: string; value: number }[];
  searchable?: boolean;
  pageSize?: number;
  refreshKey?: number;
  searchText?: string;
  onSearchTextChange?: (value: string) => void;
  /** Open selected records in a responsive detail panel instead of inline rows. */
  detailPanel?: boolean;
}) {
  const [rows, setRows] = React.useState<any[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(0);
  const [size, setSize] = React.useState(pageSize);
  const [q, setQ] = React.useState("");
  const [dayR, setDayR] = React.useState(days ?? 0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const [openRow, setOpenRow] = React.useState<number | null>(null);
  const query = searchText ?? q;

  // Inline expandable rows: if any column is marked primary, the collapsed row
  // shows only those and the rest appear in a detail grid under a chevron.
  const hasPrimary = columns.some((c) => c.primary);
  const collapsedCols = hasPrimary ? columns.filter((c) => c.primary) : columns;
  const detailCols = hasPrimary ? columns.filter((c) => !c.primary) : [];
  const totalCols = collapsedCols.length + (detailCols.length ? 1 : 0);
  const canOpenDetails = detailPanel || detailCols.length > 0;
  const selectedRow = openRow == null ? null : rows[openRow] ?? null;

  // Esc closes the expanded (fullscreen) view.
  React.useEffect(() => {
    if (!expanded) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [expanded]);

  React.useEffect(() => {
    if (!detailPanel || openRow == null) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenRow(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [detailPanel, openRow]);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  const load = React.useCallback(async (signal: AbortSignal) => {
    setOpenRow(null);
    setLoading(true);
    setError("");
    try {
      const p = new URLSearchParams();
      p.set("limit", String(size));
      p.set("offset", String(page * size));
      if (query) p.set("q", query);
      if (dayR) p.set("days", String(dayR));
      const r = await fetch(`${API}${endpoint}?${p}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!r.ok) throw new Error(`Unable to load records (HTTP ${r.status}).`);
      const d = await r.json();
      const list = Array.isArray(d) ? d : (d?.logs || d?.data || []);
      if (signal.aborted) return;
      setRows(list);
      setTotal(Number(d?.total ?? list.length));
    } catch (e) {
      if (!signal.aborted) {
        setError(e instanceof Error ? e.message : "Unable to load records.");
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [endpoint, size, page, query, dayR, token]);

  React.useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void load(controller.signal); }, query ? 300 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, query, refreshKey]);
  // reset to first page when the query/range changes
  const onSearch = (v: string) => {
    if (onSearchTextChange) onSearchTextChange(v);
    else setQ(v);
    setPage(0);
  };
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
            <input value={query} onChange={(e) => onSearch(e.target.value)} placeholder="Type & search…" />
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
            <tr>
              {collapsedCols.map((c) => <th key={c.key} className={c.nowrap ? "nw" : ""}>{c.label}</th>)}
              {detailCols.length > 0 && <th className="nw" aria-label="Details" />}
            </tr>
          </thead>
          <tbody>
            {error && !loading && (
              <tr className="empty"><td colSpan={totalCols} role="alert">{error}</td></tr>
            )}
            {rows.length === 0 && !loading && !error && (
              <tr className="empty"><td colSpan={totalCols}>No records.</td></tr>
            )}
            {rows.map((row, i) => {
              const isOpen = openRow === i;
              return (
                <React.Fragment key={i}>
                  <tr
                    className={`${detailCols.length ? "lrt-clickable" : ""}${isOpen ? " lrt-open" : ""}`}
                    tabIndex={canOpenDetails ? 0 : undefined}
                    onClick={canOpenDetails ? () => setOpenRow(isOpen ? null : i) : undefined}
                    onKeyDown={canOpenDetails ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenRow(isOpen ? null : i);
                      }
                    } : undefined}
                  >
                    {collapsedCols.map((c) => (
                      <td key={c.key} data-label={c.label} className={`${c.mono ? "mono" : ""} ${c.nowrap ? "nw" : ""}`}>
                        {c.render ? c.render(row) : (row[c.key] ?? "—")}
                      </td>
                    ))}
                    {detailCols.length > 0 && !detailPanel && (
                      <td className="nw lrt-chevcell">
                        <span className={`lrt-chev${isOpen ? " up" : ""}`} aria-hidden>▾</span>
                      </td>
                    )}
                  </tr>
                  {isOpen && detailCols.length > 0 && !detailPanel && (
                    <tr className="lrt-detail">
                      <td colSpan={totalCols}>
                        <div className="lrt-dgrid">
                          {detailCols.map((c) => (
                            <div key={c.key} className={`lrt-dfield${c.wide ? " wide" : ""}`}>
                              <span className="lrt-dlabel">{c.label}</span>
                              <span className={`lrt-dval${c.mono ? " mono" : ""}`}>
                                {c.render ? c.render(row) : (row[c.key] ?? "—")}
                              </span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {detailPanel && selectedRow && (
        <div className="lrt-drawer-backdrop" onClick={() => setOpenRow(null)}>
          <aside
            className="lrt-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Record details"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="lrt-drawer-head">
              <div>
                <span>LOG RECORD</span>
                <h2>Event details</h2>
              </div>
              <button type="button" onClick={() => setOpenRow(null)} aria-label="Close event details">×</button>
            </header>
            <div className="lrt-drawer-fields">
              {columns.map((column) => (
                <div key={column.key} className={column.wide ? "wide" : ""}>
                  <span>{column.label}</span>
                  <div className={column.mono ? "mono" : ""}>
                    {column.render ? column.render(selectedRow) : selectedRow[column.key] ?? "—"}
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}

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
/* Solid, theme-aware surfaces + text. --surface/--text were resolving to
   white-on-white in dark mode here, so the table showed nothing. Hard-code the
   surface and inherit text from it so both themes are always readable. */
.lrt{background:#ffffff;color:#1A1714;border:1px solid var(--border);border-radius:10px;overflow:hidden}
html[data-theme="dark"] .lrt{background:#111827;color:#e5e7eb}
@media(prefers-color-scheme:dark){html:not([data-theme]) .lrt{background:#111827;color:#e5e7eb}}

/* Full-screen "expanded" view — fills the viewport so long log rows are easy to read. */
.lrt-full{position:fixed;inset:12px;z-index:350;border-radius:12px;display:flex;flex-direction:column;
  box-shadow:0 0 0 100vmax rgba(0,0,0,.6),0 24px 80px rgba(0,0,0,.65)}
.lrt-full .lrt-scroll{max-height:none;flex:1 1 auto}

.lrt-expand{margin-left:10px;padding:4px 11px;font-size:11.5px;font-weight:700;font-family:inherit;
  cursor:pointer;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:6px}
.lrt-expand:hover{border-color:var(--accent);color:var(--accent)}
.lrt-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;
  background:#f1f5f9;border-bottom:1px solid var(--border)}
html[data-theme="dark"] .lrt-bar{background:#0f172a}
@media(prefers-color-scheme:dark){html:not([data-theme]) .lrt-bar{background:#0f172a}}
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
  background:#f1f5f9;border-bottom:1px solid var(--border);white-space:nowrap}
html[data-theme="dark"] .lrt thead th{background:#0f172a}
@media(prefers-color-scheme:dark){html:not([data-theme]) .lrt thead th{background:#0f172a}}
.lrt tbody td{padding:6px 12px;font-size:12px;color:inherit;border-bottom:1px solid var(--border);
  vertical-align:top}
.lrt tbody tr:nth-child(even){background:color-mix(in srgb,var(--surface-2) 45%,transparent)}
.lrt tbody tr:hover{background:color-mix(in srgb,var(--accent) 10%,transparent)}
.lrt td.mono{font-family:ui-monospace,'JetBrains Mono',monospace;font-size:11px}
.lrt td.nw,.lrt th.nw{white-space:nowrap}
.lrt tr.empty td{padding:26px;text-align:center;color:var(--muted)}

/* Inline expandable rows. */
.lrt tr.lrt-clickable{cursor:pointer}
.lrt tr.lrt-open td{background:color-mix(in srgb,var(--accent) 9%,transparent)}
.lrt-chevcell{width:34px;text-align:center}
.lrt-chev{display:inline-block;color:var(--muted);transition:transform .18s;font-size:12px}
.lrt-chev.up{transform:rotate(180deg)}
.lrt tr.lrt-detail td{padding:0;border-bottom:1px solid var(--border);
  background:#f8fafc}
html[data-theme="dark"] .lrt tr.lrt-detail td{background:#0d1420}
@media(prefers-color-scheme:dark){html:not([data-theme]) .lrt tr.lrt-detail td{background:#0d1420}}
.lrt-dgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px 22px;padding:14px 16px}
.lrt-dfield{display:flex;flex-direction:column;gap:3px;min-width:0}
.lrt-dfield.wide{grid-column:1/-1}
.lrt-dlabel{font-size:9.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.lrt-dval{font-size:12.5px;color:inherit;white-space:pre-wrap;word-break:break-word;line-height:1.5}
.lrt-dval.mono{font-family:ui-monospace,'JetBrains Mono',monospace;font-size:11.5px}

.lrt-drawer-backdrop{position:fixed;inset:0;z-index:360;display:flex;justify-content:flex-end;
  background:rgba(2,6,23,.52)}
.lrt-drawer{width:min(480px,100vw);height:100%;overflow:auto;background:var(--surface);
  color:var(--text);border-left:1px solid var(--border);box-shadow:-18px 0 50px rgba(0,0,0,.2)}
.lrt-drawer-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;
  padding:18px 20px;background:var(--surface);border-bottom:1px solid var(--border)}
.lrt-drawer-head span{font-size:9px;font-weight:800;letter-spacing:.1em;color:var(--muted)}
.lrt-drawer-head h2{margin:4px 0 0;font-size:18px}
.lrt-drawer-head button{width:36px;height:36px;border:1px solid var(--border);border-radius:8px;
  background:var(--surface-2);color:var(--text);font-size:22px;cursor:pointer}
.lrt-drawer-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;padding:18px 20px}
.lrt-drawer-fields>div{min-width:0}
.lrt-drawer-fields>div.wide{grid-column:1/-1}
.lrt-drawer-fields>div>span{display:block;margin-bottom:4px;font-size:9px;font-weight:800;
  letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.lrt-drawer-fields>div>div{font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.lrt-drawer-fields .mono{font-family:ui-monospace,'JetBrains Mono',monospace;font-size:11px}

.lrt-foot{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:8px 10px;border-top:1px solid var(--border)}
.lrt-foot button{min-width:30px;padding:4px 9px;font-size:12px;font-family:inherit;cursor:pointer;
  background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:6px}
.lrt-foot button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.lrt-foot button.on{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:700}
.lrt-foot button:disabled{opacity:.4;cursor:not-allowed}
.lrt-foot .ell{color:var(--muted);padding:0 4px}

@media(max-width:640px){
  .lrt-bar{gap:6px}
  .lrt-bar select{min-height:36px}
  .lrt-find{flex:1 1 100%;min-width:0}
  .lrt-find input{width:100%;min-width:0}
  .lrt-count{flex:1 1 100%}
  .lrt-expand{margin-left:auto;min-height:36px}
  .lrt-drawer{width:100%;height:min(82dvh,760px);margin-top:auto;border-left:0;border-top:1px solid var(--border);
    border-radius:16px 16px 0 0}
  .lrt-drawer-fields{grid-template-columns:minmax(0,1fr)}
  .lrt-drawer-fields>div.wide{grid-column:auto}
  .lrt-scroll{overflow:visible;max-height:none}
  .lrt table{display:block;min-width:0}
  .lrt thead{display:none}
  .lrt tbody{display:grid;gap:8px;padding:8px}
  .lrt tbody tr:not(.lrt-detail):not(.empty){position:relative;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));
    border:1px solid var(--border);border-radius:9px;padding:7px}
  .lrt tbody tr:not(.lrt-detail):not(.empty) td{display:flex;flex-direction:column;gap:2px;min-width:0;
    padding:5px 7px;border:0;white-space:normal!important;overflow-wrap:anywhere}
  .lrt tbody tr:not(.lrt-detail):not(.empty) td::before{content:attr(data-label);font-size:9px;font-weight:800;
    letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
  .lrt tbody tr:not(.lrt-detail):not(.empty) .lrt-chevcell{position:absolute;top:3px;right:3px;width:auto;padding:2px!important}
  .lrt tbody tr:not(.lrt-detail):not(.empty) .lrt-chevcell::before{content:none}
  .lrt tbody tr.lrt-detail{display:block}
  .lrt tbody tr.lrt-detail td{display:block;padding:0}
  .lrt-dgrid{grid-template-columns:minmax(0,1fr);gap:10px;padding:12px}
  .lrt tbody tr.empty td{display:block}
  .lrt-foot button{min-height:40px}
}
`;
