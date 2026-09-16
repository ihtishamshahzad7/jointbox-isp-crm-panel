"use client";

import * as React from "react";
import { csvSafe } from "./csv-safe";

/**
 * Jointbox DataTable — the shared enterprise table engine.
 *
 * One component, two feeding modes:
 *
 *   • CLIENT MODE  (`rows`)     — you already hold the (filtered) rows; the
 *     table sorts, pages, filters and exports them locally. Use for already
 *     bounded datasets and for page-local slices.
 *
 *   • SERVER MODE  (`fetchPage`) — the table owns the paging/search/sort state
 *     and asks the backend for exactly one page at a time. NEVER hand a
 *     million rows to a browser: this mode is the one that scales.
 *
 * Enterprise surface, in one place:
 *   toolbar (search · columns · density · export · refresh · page actions)
 *   column visibility, persisted
 *   column resizing, persisted
 *   sorting (asc → desc → off, numeric-aware), per-column sortValue
 *   page size selector + Prev/Next with totals ("X–Y of Z")
 *   row selection + header select-all (indeterminate) + bulk action bar
 *   loading skeleton, empty state, error state with retry (server mode)
 *   sticky header, sticky selection column, horizontal scroll
 *   density: compact / default / comfortable
 *   CSV export (cells sanitised via csvSafe — formula-injection safe)
 *   keyboard-accessible sort headers and toggles, live region for status
 *   mobile card layout (max-width 760px)
 *
 * Row identity: `rowKey` (usually `r => r.id`). Selection is CONTROLLED —
 * the owner keeps the authoritative selection so bulk operations live where
 * they belong (page/modal code), not inside a table.
 */

export type DtSortDir = "asc" | "desc";
export type DtSort = { key: string; dir: DtSortDir } | null;
export type DtDensity = "compact" | "default" | "comfortable";

export interface DtColumn<T> {
  key: string;
  header: string;
  /** Tooltip on the header, e.g. a short definition. */
  headerTip?: string;
  /** Base width in px (applied when the operator has not dragged their own). */
  width?: number;
  minWidth?: number;
  align?: "left" | "right" | "center";
  sortable?: boolean;
  /** Canonical cell value for sorting AND CSV export. Falls back to `row[key]`. */
  sortValue?: (row: T) => string | number | null | undefined;
  render?: (row: T) => React.ReactNode;
  /** Hidden by default but revealable via the Columns menu. */
  defaultHidden?: boolean;
  /** Excluded from CSV export (action buttons, decorative flags). */
  exportable?: boolean;
}

export interface DataTableFetchParams {
  page: number;
  pageSize: number;
  sort: DtSort;
  search: string;
  filters: Record<string, unknown>;
  /** Abort signal from the table's fetch lifecycle: a newer page/sort/search
   *  superseding this request aborts the in-flight fetch instead of letting
   *  it race the new one. */
  signal?: AbortSignal;
}

export interface DataTableFetchResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DataTableProps<T> {
  columns: DtColumn<T>[];
  rowKey: (row: T) => string | number;
  /** CLIENT MODE: the rows to render (filtered but not yet sorted/paged). */
  rows?: T[];
  /** SERVER MODE: the table fetches one page at a time through here. */
  fetchPage?: (p: DataTableFetchParams) => Promise<DataTableFetchResult<T>>;
  /** Extra query state forwarded verbatim in server mode (filters, etc.). */
  filters?: Record<string, unknown>;
  selectable?: boolean;
  /** Controlled selection keys. */
  selectedKeys?: (string | number)[];
  /** Called when a single row checkbox toggles. */
  onToggleKey?: (key: string | number, checked: boolean) => void;
  /**
   * Called when the header checkbox toggles, with the current page's keys.
   * The owner decides the exact semantics (e.g. page-level select-all).
   */
  onTogglePage?: (keys: (string | number)[]) => void;
  /** Rendered inside the selection bar when ≥1 row is selected. */
  bulkActions?: React.ReactNode;
  /** Right side of the toolbar — primary actions like [+ Add Subscriber]. */
  actions?: React.ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** CLIENT MODE local search predicate; default: substring over the row JSON. */
  clientFilter?: (row: T, q: string) => boolean;
  defaultPageSize?: number;
  pageSizes?: number[];
  density?: DtDensity;
  /** Column layout (widths + visibility + density) is persisted under this key. */
  storageKey?: string;
  /** CSV file name (visible columns, current filter selection). */
  exportName?: string;
  /** Called when the toolbar Refresh button is pressed (client mode). */
  onRefresh?: () => void;
  emptySlot?: React.ReactNode;
  rowClick?: (row: T) => void;
  rowClass?: (row: T) => string;
  /** Right-click on a row (e.g. WinBox-style context menu). */
  onRowContextMenu?: (e: React.MouseEvent<HTMLTableRowElement>, row: T) => void;
  /** When false, the built-in "N selected" bar is hidden (page owns bulk UI). */
  selectionBar?: boolean;
  /** Hide the built-in footer (the page provides its own pager). */
  disablePagination?: boolean;
  /** Force a server-mode refetch whenever this token changes (mutations, Live toggle). */
  refreshToken?: number | string;
  className?: string;
}

function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — layout just won't persist */
  }
}

/** Text value of a cell for sorting and export. */
function cellText<T>(col: DtColumn<T>, row: T): string {
  const v = col.sortValue ? col.sortValue(row) : (row as Record<string, unknown>)[col.key];
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  return String(v);
}

function csvCell(value: unknown): string {
  const safe = csvSafe(value);
  const s = safe === null || safe === undefined ? "" : String(safe);
  // RFC 4180: quote when the cell contains a comma, quote or newline.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** True when the header checkbox should be checked / indeterminate. */
function pageSelectionState<T>(
  items: T[],
  rowKey: (r: T) => string | number,
  selected: Set<string | number>,
): { checked: boolean; some: boolean } {
  const keys = items.map(rowKey);
  if (!keys.length) return { checked: false, some: false };
  const on = keys.filter((k) => selected.has(k)).length;
  return { checked: on === keys.length, some: on > 0 && on < keys.length };
}

export function DataTable<T>(props: DataTableProps<T>) {
  const {
    columns: allColumns,
    rowKey,
    rows,
    fetchPage,
    filters,
    selectable,
    selectedKeys = [],
    onToggleKey,
    onTogglePage,
    bulkActions,
    actions,
    searchable,
    searchPlaceholder,
    clientFilter,
    defaultPageSize = 50,
    pageSizes = [10, 25, 50, 100, 200],
    density: densityProp,
    storageKey,
    onRefresh,
    emptySlot,
    rowClick,
    rowClass,
    onRowContextMenu,
    selectionBar = true,
    disablePagination,
    refreshToken,
    className,
  } = props;

  const serverMode = !!fetchPage;

  // ── Column visibility (persisted) ───────────────────────────────────────
  const defaultVisible = allColumns.filter((c) => !c.defaultHidden).map((c) => c.key);
  const [visible, setVisible] = React.useState<Set<string>>(
    () => new Set(loadJson(storageKey ? `${storageKey}:v` : "", defaultVisible)),
  );
  React.useEffect(() => {
    if (storageKey) saveJson(`${storageKey}:v`, Array.from(visible));
  }, [visible, storageKey]);

  const columns = allColumns.filter((c) => visible.has(c.key));

  // ── Column widths (persisted) ───────────────────────────────────────────
  const [widths, setWidths] = React.useState<Record<string, number>>(
    () => loadJson(storageKey ? `${storageKey}:w` : "", {}),
  );
  const widthsRef = React.useRef(widths);
  React.useEffect(() => {
    widthsRef.current = widths;
  }, [widths]);

  const persistWidths = (w: Record<string, number>) => {
    setWidths(w);
    if (storageKey) saveJson(`${storageKey}:w`, w);
  };

  const startResize = (key: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // never trigger the header's sort while resizing
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    let current = startW;
    const sync = () => {
      persistWidths({ ...widthsRef.current, [key]: current });
    };
    const move = (ev: MouseEvent) => {
      current = Math.max(56, Math.round(startW + (ev.clientX - startX)));
      sync();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  const resetWidth = (key: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    persistWidths((() => {
      const n = { ...widthsRef.current };
      delete n[key];
      return n;
    })());
    setColMenu(false);
  };

  // ── Density (persisted) ─────────────────────────────────────────────────
  const [density, setDensity] = React.useState<DtDensity>(
    () => loadJson(storageKey ? `${storageKey}:d` : "", densityProp ?? "default"),
  );

  // ── Paging ──────────────────────────────────────────────────────────────
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(
    () => loadJson(storageKey ? `${storageKey}:ps` : "", defaultPageSize),
  );
  const changePageSize = (n: number) => {
    setPageSize(n);
    setPage(1);
    if (storageKey) saveJson(`${storageKey}:ps`, n);
  };

  // ── Sorting ─────────────────────────────────────────────────────────────
  const [sort, setSort] = React.useState<DtSort>(null);
  const toggleSort = (key: string) => {
    setSort((prev) =>
      !prev || prev.key !== key
        ? { key, dir: "asc" }
        : prev.dir === "asc"
          ? { key, dir: "desc" }
          : null,
    );
  };

  const sortDirOf = (key: string): DtSortDir | "off" =>
    sort?.key === key ? sort.dir : "off";

  // ── Search ──────────────────────────────────────────────────────────────
  const [q, setQ] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  // Reset to page 1 when the effective search term or the filter set changes.
  // Render-phase adjustment (React's documented alternative to an effect):
  // effects that only mirror input into state cause cascading re-renders.
  const [inputKey, setInputKey] = React.useState("");
  const nextInputKey = debouncedQ + "\u0000" + JSON.stringify(filters ?? null);
  if (nextInputKey !== inputKey) {
    setInputKey(nextInputKey);
    setPage(1);
  }

  // ── Server mode: data + lifecycle ───────────────────────────────────────
  const [items, setItems] = React.useState<T[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(serverMode);
  const [error, setError] = React.useState<string | null>(null);
  const [seq, setSeq] = React.useState(0);
  const seqRef = React.useRef(0);

  // If the dataset shrank (live sessions close between refreshes) and the
  // current page is now beyond the last page, snap back to the last valid
  // page. The pager already shows the clamped page, so without this the
  // fetch would keep requesting a now-empty page forever. Guarded on
  // total>0 so a not-yet-answered first request (restoring a stored
  // page) is never cancelled by a pre-response snap; converges, no loop.
  const lastPage = Math.max(Math.ceil(total / pageSize), 1);
  if (serverMode && total > 0 && page > lastPage) {
    setPage(lastPage);
  }

  React.useEffect(() => {
    if (!serverMode) return;
    const ctrl = new AbortController();
    seqRef.current += 1;
    const mySeq = seqRef.current;
    // The fetch lifecycle must flip loading/error synchronously when a new
    // page·sort·search request starts — this is the canonical fetch effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetchPage!({ page, pageSize, sort, search: debouncedQ, filters: filters ?? {}, signal: ctrl.signal })
      .then((res) => {
        if (mySeq !== seqRef.current) return; // superseded by a newer request
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((e: unknown) => {
        if (mySeq !== seqRef.current) return;
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load data");
      })
      .finally(() => {
        if (mySeq === seqRef.current) setLoading(false);
      });
    return () => ctrl.abort();
  }, [serverMode, page, pageSize, sort, debouncedQ, filters, seq, fetchPage, refreshToken]);

  // ── Client mode: derive the page locally ────────────────────────────────
  const clientAll = React.useMemo(() => {
    if (serverMode) return [];
    let list = rows ?? [];
    if (q) {
      const lower = q.toLowerCase();
      list = list.filter((r) =>
        clientFilter ? clientFilter(r, q) : JSON.stringify(r).toLowerCase().includes(lower),
      );
    }
    if (sort) {
      const col = allColumns.find((c) => c.key === sort.key);
      const dir = sort.dir === "asc" ? 1 : -1;
      list = [...list].sort((a, b) => {
        const clean = (v: unknown): number | string => {
          if (v === null || v === undefined || v === "") return Number.MAX_SAFE_INTEGER;
          if (typeof v === "number") return v;
          const n = Number(v);
          return Number.isFinite(n) ? n : String(v).toLowerCase();
        };
        const x = clean(col ? cellText(col, a) : "");
        const y = clean(col ? cellText(col, b) : "");
        if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
        return String(x).localeCompare(String(y)) * dir;
      });
    }
    return list;
  }, [serverMode, rows, q, sort, clientFilter, allColumns]);

  const totalCount = serverMode ? total : clientAll.length;
  const effectivePage = Math.min(page, Math.max(Math.ceil(totalCount / pageSize), 1));
  const visibleItems = serverMode
    ? items
    : clientAll.slice((effectivePage - 1) * pageSize, effectivePage * pageSize);

  const from = totalCount === 0 ? 0 : (effectivePage - 1) * pageSize + 1;
  const to = Math.min(effectivePage * pageSize, totalCount);

  // ── Selection ───────────────────────────────────────────────────────────
  const selected = React.useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const pageSel = pageSelectionState(visibleItems, rowKey, selected);
  const shownSelect = selectable && visibleItems.length > 0 && !loading;

  // ── CSV export ──────────────────────────────────────────────────────────
  const exportRows = serverMode ? items : clientAll; // server: current page only
  const doExport = () => {
    const cols = columns.filter((c) => c.exportable !== false);
    const head = cols.map((c) => csvCell(c.header));
    const body = exportRows.map((r) =>
      cols.map((c) => csvCell(cellText(c, r))).join(","),
    );
    const csv = "\uFEFF" + [head.join(","), ...body].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${props.exportName ?? "export"}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ── Dropdowns (columns / density) ───────────────────────────────────────
  const [colMenu, setColMenu] = React.useState(false);
  const [denMenu, setDenMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setColMenu(false);
        setDenMenu(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setColMenu(false);
        setDenMenu(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, []);

  const toggleVisible = (key: string) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const refresh = () => {
    if (serverMode) setSeq((s) => s + 1);
    else onRefresh?.();
  };

  // ── Render ──────────────────────────────────────────────────────────────
  const minWidth = columns.reduce(
    (acc, c) => acc + (widths[c.key] ?? c.width ?? c.minWidth ?? 120),
    0,
  );

  return (
    <div className={`jdt ${density} ${className ?? ""}`}>
      <style>{CSS}</style>

      {/* ── Toolbar ── */}
      <div className="jdt-toolbar" role="toolbar" aria-label="Table controls">
        {searchable && (
          <div className="jdt-search">
            <span className="jdt-search-ico" aria-hidden>🔍</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={searchPlaceholder ?? "Search…"}
              aria-label="Search"
            />
            {q && (
              <button className="jdt-search-clr" onClick={() => setQ("")} aria-label="Clear search">✕</button>
            )}
          </div>
        )}

        <div className="jdt-tools">
          <div className="jdt-menuwrap" ref={menuRef}>
            <button
              className="jdt-btn"
              onClick={() => { setColMenu((v) => !v); setDenMenu(false); }}
              aria-haspopup="menu"
              aria-expanded={colMenu}
              title="Show or hide columns"
            >
              ⚙ Columns
            </button>
            {colMenu && (
              <div className="jdt-menu" role="menu">
                {allColumns.map((c) => (
                  <label key={c.key} className="jdt-menu-item" role="menuitemcheckbox" aria-checked={visible.has(c.key)}>
                    <input
                      type="checkbox"
                      checked={visible.has(c.key)}
                      onChange={() => toggleVisible(c.key)}
                    />
                    <span>{c.header}</span>
                    {c.defaultHidden && <em className="jdt-menu-off">off</em>}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="jdt-menuwrap">
            <button
              className="jdt-btn"
              onClick={() => { setDenMenu((v) => !v); setColMenu(false); }}
              aria-haspopup="menu"
              aria-expanded={denMenu}
              title="Row density"
            >
              ▤ Density
            </button>
            {denMenu && (
              <div className="jdt-menu" role="menu">
                {(["compact", "default", "comfortable"] as DtDensity[]).map((d) => (
                  <button
                    key={d}
                    className={`jdt-menu-item ${density === d ? "on" : ""}`}
                    role="menuitemradio"
                    aria-checked={density === d}
                    onClick={() => { setDensity(d); setDenMenu(false); if (storageKey) saveJson(`${storageKey}:d`, d); }}
                  >
                    {d === "compact" ? "Compact" : d === "default" ? "Default" : "Comfortable"}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button className="jdt-btn" onClick={doExport} title="Export visible columns as CSV">
            ⬇ Export
          </button>
          <button className="jdt-btn" onClick={refresh} title="Refresh" aria-label="Refresh">
            ⟳
          </button>
          {actions}
        </div>
      </div>

      {/* ── Bulk selection bar ── */}
      {shownSelect && selectionBar && selected.size > 0 && (
        <div className="jdt-selbar" aria-live="polite">
          <span className="jdt-selcount">
            <b>{selected.size}</b> selected
          </span>
          {bulkActions}
          <button
            className="jdt-btn jdt-selclear"
            onClick={() => onTogglePage?.([...new Set(visibleItems.map(rowKey))])}
          >
            Clear
          </button>
        </div>
      )}

      {/* ── Table ── */}
      <div className="jdt-scroll" aria-busy={loading}>
        <table style={{ minWidth }}>
          <thead>
            <tr>
              {shownSelect && (
                <th className="jdt-pick jdt-sticky">
                  <input
                    type="checkbox"
                    ref={(el) => {
                      if (el) el.indeterminate = pageSel.some && !pageSel.checked;
                    }}
                    checked={pageSel.checked}
                    onChange={() => onTogglePage?.(visibleItems.map(rowKey))}
                    aria-label="Select all rows on this page"
                  />
                </th>
              )}
              {columns.map((c) => {
                const dir = sortDirOf(c.key);
                return (
                  <th
                    key={c.key}
                    className={`${c.sortable ? "jdt-srt" : ""} ${dir !== "off" ? "on" : ""}`}
                    style={{
                      width: widths[c.key] ?? c.width,
                      minWidth: c.minWidth,
                      textAlign: c.align ?? "left",
                    }}
                    aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
                  >
                    {c.sortable ? (
                      <button
                        className="jdt-srtbtn"
                        onClick={() => toggleSort(c.key)}
                        title={c.headerTip ?? `Sort by ${c.header.toLowerCase()}`}
                      >
                        {c.header}
                        <i aria-hidden>{dir === "asc" ? "▲" : dir === "desc" ? "▼" : "⇅"}</i>
                      </button>
                    ) : (
                      <span title={c.headerTip}>{c.header}</span>
                    )}
                    {!c.minWidth && (
                      <span
                        className="jdt-rsz"
                        onMouseDown={startResize(c.key)}
                        onDoubleClick={resetWidth(c.key)}
                        title="Drag to resize · double-click to reset"
                        aria-hidden
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {loading
              ? Array.from({ length: Math.min(pageSize, 8) }).map((_, i) => (
                  <tr key={`skel-${i}`} className="jdt-skelrow">
                    {selectable && <td className="jdt-pick jdt-sticky" />}
                    {columns.map((c) => (
                      <td key={c.key}>
                        <span className="jdt-skel" style={{ width: `${45 + ((i * 13 + c.key.length * 7) % 50)}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              : visibleItems.map((r) => (
                  <tr
                    key={String(rowKey(r))}
                    onClick={rowClick ? () => rowClick(r) : undefined}
                    onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(e, r) : undefined}
                    className={`${selected.has(rowKey(r)) ? "on" : ""} ${rowClass?.(r) ?? ""}`}
                    tabIndex={rowClick ? 0 : undefined}
                    onKeyDown={
                      rowClick
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              rowClick(r);
                            }
                          }
                        : undefined
                    }
                  >
                    {selectable && (
                      <td className="jdt-pick jdt-sticky" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(rowKey(r))}
                          onChange={(e) => onToggleKey?.(rowKey(r), e.target.checked)}
                          aria-label="Select row"
                        />
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.key} data-label={c.header} style={{ textAlign: c.align ?? "left" }}>
                        {c.render ? c.render(r) : cellText(c, r)}
                      </td>
                    ))}
                  </tr>
                ))}

            {!loading && error && (
              <tr className="jdt-err">
                <td colSpan={(columns.length || 1) + (selectable ? 1 : 0)}>
                  <b>Could not load data</b>
                  <span>{error}</span>
                  <button className="jdt-btn" onClick={refresh}>Retry</button>
                </td>
              </tr>
            )}

            {!loading && !error && totalCount === 0 && (
              <tr className="jdt-empty">
                <td colSpan={(columns.length || 1) + (selectable ? 1 : 0)}>
                  {emptySlot ?? (
                    <>
                      <b>No records found</b>
                      <span>Adjust the filters or search, or add the first record.</span>
                    </>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Footer ── */}
      {!disablePagination && (
        <div className="jdt-foot">
          <div className="jdt-footleft">
            <label className="jdt-pagesize">
              Rows
              <select
                value={pageSize}
                onChange={(e) => changePageSize(Number(e.target.value))}
                aria-label="Rows per page"
              >
                {pageSizes.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            {totalCount > 0 && (
              <span className="jdt-range" aria-live="polite">
                {from}–{to} of {totalCount}
              </span>
            )}
          </div>
          <div className="jdt-pager">
            <button
              className="jdt-btn"
              onClick={() => setPage((p) => Math.max(p - 1, 1))}
              disabled={effectivePage <= 1}
              aria-label="Previous page"
            >
              ‹ Prev
            </button>
            <span className="jdt-pg">{serverMode ? effectivePage : Math.min(effectivePage, totalCount === 0 ? 1 : effectivePage)}</span>
            <button
              className="jdt-btn"
              onClick={() => setPage((p) => p + 1)}
              disabled={to >= totalCount}
              aria-label="Next page"
            >
              Next ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const CSS = `
.jdt{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);
  border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.18);
  font-size:13px;color:var(--text)}

/* ── Toolbar ── */
.jdt-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:10px 14px;border-bottom:1px solid var(--border);background:var(--surface-2);
  flex-wrap:wrap}
.jdt-search{position:relative;display:flex;align-items:center;flex:1 1 220px;max-width:340px}
.jdt-search input{width:100%;padding:7px 30px 7px 30px;border-radius:10px;border:1px solid var(--border);
  background:var(--surface);color:var(--text);font:inherit;font-size:12.5px;outline:none;transition:border-color .12s}
.jdt-search input:focus{border-color:var(--accent)}
.jdt-search-ico{position:absolute;left:10px;font-size:12px;opacity:.55;pointer-events:none}
.jdt-search-clr{position:absolute;right:7px;border:none;background:transparent;color:var(--muted);
  cursor:pointer;font-size:11px;padding:3px;line-height:1}
.jdt-search-clr:hover{color:var(--text)}
.jdt-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.jdt-btn{padding:7px 11px;border-radius:9px;font-size:12px;font-weight:700;font-family:inherit;
  cursor:pointer;background:var(--surface);border:1px solid var(--border);color:var(--text);
  transition:all .13s ease;white-space:nowrap}
.jdt-btn:hover{border-color:var(--accent);color:var(--accent)}
.jdt-btn:disabled{opacity:.45;cursor:default;border-color:var(--border);color:var(--muted)}
.jdt-btn:focus-visible{outline:2px solid var(--focus);outline-offset:1px}

/* ── Menus ── */
.jdt-menuwrap{position:relative}
.jdt-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:40;min-width:200px;max-height:340px;
  overflow:auto;padding:5px;background:var(--surface-2);border:1px solid var(--border);
  border-radius:11px;box-shadow:0 12px 34px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:1px}
.jdt-menu-item{display:flex;align-items:center;gap:9px;padding:7px 10px;font-size:12.5px;font-weight:600;
  cursor:pointer;color:var(--text);border-radius:7px;background:transparent;border:none;font-family:inherit;text-align:left}
.jdt-menu-item:hover{background:rgba(124,77,255,.12)}
.jdt-menu-item.on{color:var(--accent)}
.jdt-menu-item input{accent-color:#7C4DFF;width:14px;height:14px;cursor:pointer}
.jdt-menu-off{font-style:normal;font-size:9.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;
  color:var(--muted);margin-left:auto;opacity:.7}

/* ── Selection bar ── */
.jdt-selbar{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border);
  background:rgba(124,77,255,.08);font-size:12px}
.jdt-selcount b{color:var(--accent)}
.jdt-selclear{margin-left:auto}

/* ── Table ── */
.jdt-scroll{overflow:auto;flex:1}
.jdt table{width:100%;border-collapse:separate;border-spacing:0}
.jdt thead th{position:sticky;top:0;z-index:3;padding:10px 14px;text-align:left;
  font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);
  background:linear-gradient(180deg,var(--surface-2),color-mix(in srgb,var(--surface-2) 88%,transparent));
  border-bottom:1px solid var(--border);white-space:nowrap;backdrop-filter:blur(6px)}
.jdt th{position:relative}
.jdt th.jdt-pick{width:40px;padding-right:4px}
.jdt td.jdt-pick{width:40px;padding-right:4px}
.jdt .jdt-pick input{width:15px;height:15px;accent-color:#7C4DFF;cursor:pointer}
.jdt .jdt-sticky{position:sticky;left:0;z-index:4;background:inherit}

.jdt .jdt-srtbtn{background:none;border:none;padding:0;font:inherit;font-size:inherit;font-weight:inherit;
  letter-spacing:inherit;text-transform:inherit;color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:5px;
  text-align:left;width:100%}
.jdt .jdt-srtbtn i{font-style:normal;font-size:8.5px;opacity:.35}
.jdt th.on .jdt-srtbtn{color:var(--accent)}
.jdt th.on .jdt-srtbtn i{opacity:1}
.jdt th:hover .jdt-srtbtn{color:var(--text)}

.jdt .jdt-rsz{position:absolute;top:0;right:-3px;width:7px;height:100%;cursor:col-resize;z-index:5;
  background:transparent}
.jdt .jdt-rsz::after{content:"";position:absolute;top:24%;right:3px;width:2px;height:52%;border-radius:2px;
  background:var(--border);opacity:0;transition:opacity .12s}
.jdt th:hover .jdt-rsz::after{opacity:1}
.jdt .jdt-rsz:hover::after{background:var(--accent);opacity:1}

.jdt tbody tr{cursor:default;transition:background .14s ease}
.jdt tbody tr[tabindex]{cursor:pointer}
.jdt tbody tr:hover{background:linear-gradient(90deg,rgba(124,77,255,.09),rgba(124,77,255,.01))}
.jdt tbody tr.on{background:rgba(124,77,255,.14)}
.jdt tbody tr:hover td:first-child{box-shadow:inset 3px 0 0 #7C4DFF}
.jdt tbody td{padding:11px 14px;border-bottom:1px solid color-mix(in srgb,var(--border) 70%,transparent);
  vertical-align:middle}
.jdt tbody tr:last-child td{border-bottom:none}
.jdt tbody td[data-label]{}

/* Density. */
.jdt.compact tbody td{padding:6px 12px;font-size:12px}
.jdt.compact thead th{padding:7px 12px}
.jdt.comfortable tbody td{padding:15px 16px}
.jdt.comfortable thead th{padding:13px 16px}

/* Skeleton. */
.jdt .jdt-skelrow td{padding:11px 14px}
.jdt .jdt-skel{display:block;height:11px;border-radius:5px;
  background:linear-gradient(90deg,var(--surface-2),rgba(255,255,255,.09),var(--surface-2));
  background-size:200% 100%;animation:jdtsh 1.2s ease-in-out infinite}
@keyframes jdtsh{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* Empty / error rows. */
.jdt tr.jdt-empty td,.jdt tr.jdt-err td{padding:44px 20px;text-align:center;border:none}
.jdt tr.jdt-empty b,.jdt tr.jdt-err b{display:block;font-size:14px;color:var(--text);margin-bottom:6px}
.jdt tr.jdt-empty span,.jdt tr.jdt-err span{display:block;font-size:12px;color:var(--muted);margin-bottom:12px}
.jdt tr.jdt-err td{color:var(--danger)}

/* ── Footer ── */
.jdt-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:7px 14px;border-top:1px solid var(--border);background:var(--surface-2);font-size:11.5px;color:var(--muted)}
.jdt-footleft{display:flex;align-items:center;gap:12px}
.jdt-pagesize{display:inline-flex;align-items:center;gap:7px;font-weight:700}
.jdt-pagesize select{padding:4px 6px;border-radius:7px;border:1px solid var(--border);background:var(--surface);
  color:var(--text);font:inherit;font-size:11.5px;cursor:pointer}
.jdt-range b{color:var(--text)}
.jdt-pager{display:flex;align-items:center;gap:8px}
.jdt-pg{min-width:26px;text-align:center;font-weight:700;color:var(--text)}

/* ── Mobile: each row becomes a labelled card ── */
@media (max-width:760px){
  .jdt{border:none;background:transparent;box-shadow:none}
  .jdt-toolbar{padding:8px 10px;border:1px solid var(--border);border-radius:14px;background:var(--surface)}
  .jdt-scroll{overflow:visible}
  .jdt table{min-width:0 !important;display:block}
  .jdt thead{display:none}
  .jdt tbody{display:block}
  .jdt tbody tr{display:block;margin-bottom:12px;padding:12px 14px;border:1px solid var(--border);
    border-radius:14px;background:var(--surface);box-shadow:0 2px 10px rgba(0,0,0,.20)}
  .jdt tbody tr:hover td:first-child{box-shadow:none}
  .jdt tbody td{display:flex;align-items:center;justify-content:space-between;gap:14px;
    border:none;padding:7px 0;text-align:right}
  .jdt tbody td::before{content:attr(data-label);font-size:10px;font-weight:800;letter-spacing:.06em;
    text-transform:uppercase;color:var(--muted);text-align:left}
  .jdt tbody td:first-child::before{content:""}
  .jdt td.jdt-pick{position:absolute;opacity:0;pointer-events:none}
  .jdt tbody td[data-label=""]::before{content:""}
  .jdt-foot{flex-wrap:wrap;border:1px solid var(--border);border-radius:14px;background:var(--surface);margin-top:4px}
}
`;