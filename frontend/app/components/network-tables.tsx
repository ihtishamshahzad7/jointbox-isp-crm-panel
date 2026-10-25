"use client";

import React from "react";
import { COL_RESIZE_CSS } from "./use-col-resize";
import { DataTable, type DtColumn } from "./data-table";

/**
 * Composed tables for NAS, IP Pools and Packages.
 *
 * Same reasoning as the subscriber table: these lists were wide grids of
 * equal-weight text, which is the worst case for scanning. Each row here has
 * one anchor and its supporting detail beneath, plus the one number that
 * decides whether anyone needs to act — sessions on a router, addresses free
 * in a pool, subscribers on a package.
 *
 * All three share one stylesheet so the project reads as one product rather
 * than three screens built at different times.
 *
 * Standalone: pages keep their state and handlers, swapping one block in or
 * out. Nothing here can break a page it is not wired into.
 */

type Row = any;

/* Shared WinBox-style right-click context menu for these tables. */
type CtxItem = { label: string; onClick: () => void; danger?: boolean };
function useCtxMenu() {
  const [menu, setMenu] = React.useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  React.useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); window.removeEventListener("keydown", onKey); };
  }, [menu]);
  const open = (e: React.MouseEvent, items: CtxItem[]) => {
    e.preventDefault();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 190), y: Math.min(e.clientY, window.innerHeight - 40 - items.length * 34), items });
  };
  const node = menu && (
    <div className="nt-ctx" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      {menu.items.map((it, i) => (
        <button key={i} className={it.danger ? "danger" : ""} onClick={() => { it.onClick(); setMenu(null); }}>{it.label}</button>
      ))}
    </div>
  );
  return { open, node };
}

/* ═══════════════════════════════════════════════════════════════════
   IP POOLS
   ═══════════════════════════════════════════════════════════════════ */
interface PoolRow {
  id: number;
  name: string;
  network: string;
  subnet: string;
  nasId: number | null;
  createdAt: string;
  ownerId?: number | null;
  _count: { packages: number };
  packages: { id: number; name: string; isActive: boolean }[];
  assignments?: unknown[];
}

export function PoolTable({
  rows, me, onView, onEdit, onShare, onDelete,
}: {
  rows: PoolRow[]; me?: { id?: number; role?: string };
  onView: (r: PoolRow) => void; onEdit: (r: PoolRow) => void;
  onShare: (r: PoolRow) => void; onDelete: (r: PoolRow) => void;
}) {
  const isIsp = !me || me.role === "ADMIN" || me.role === "SUPER_ADMIN";
  const columns: DtColumn<PoolRow>[] = [
    {
      key: "name", header: "Pool", sortable: true, width: 220,
      sortValue: (pool) => String(pool.name ?? "").toLowerCase(),
      render: (pool) => (
        <>
          <div className="nm">{pool.name}</div>
          {!isIsp && <div className="sub">{pool.ownerId === me?.id ? "Yours" : "Shared with you"}</div>}
        </>
      ),
    },
    {
      key: "range", header: "Range", sortable: true, width: 190,
      sortValue: (pool) => `${pool.network ?? ""}/${pool.subnet ?? ""}`.toLowerCase(),
      render: (pool) => <code className="wide">{pool.network}/{pool.subnet}</code>,
    },
    {
      key: "usage", header: "In use by", sortable: true, width: 120,
      sortValue: (pool) => pool._count?.packages ?? pool.packages?.length ?? 0,
      render: (pool) => {
        const used = pool._count?.packages ?? pool.packages?.length ?? 0;
        return <><div className={`big ${used > 0 ? "up" : ""}`}>{used}</div><div className="sub">{used === 1 ? "package" : "packages"}</div></>;
      },
    },
    {
      key: "sharing", header: "Sharing", sortable: true,
      sortValue: (pool) => pool.assignments?.length ?? 0,
      render: (pool) => pool.assignments?.length
        ? <span className="tag ok">shared with {pool.assignments.length}</span>
        : <span className="sub">not shared</span>,
    },
    {
      key: "actions", header: "Actions", sortable: false, exportable: false, width: 220,
      render: (pool) => {
        const mine = isIsp || pool.ownerId === me?.id;
        const used = pool._count?.packages ?? pool.packages?.length ?? 0;
        return mine ? (
          <span className="pool-actions">
            <button onClick={() => onShare(pool)}>Share</button>
            <button onClick={() => onEdit(pool)}>Edit</button>
            <button className="bad" disabled={used > 0}
              title={used > 0 ? "In use by a package — reassign it first" : "Delete pool"}
              onClick={() => onDelete(pool)}>Delete</button>
          </span>
        ) : <span className="sub">Read only</span>;
      },
    },
  ];

  return (
    <div className="pool-list">
      <style>{CSS}</style>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(pool) => pool.id}
        rowClick={onView}
        searchable={false}
        storageKey="jb_ip_pool_table"
        exportName="ip-pools"
        defaultPageSize={25}
        pageSizes={[10, 25, 50, 100]}
        emptySlot={<><b>No IP pools.</b><span>Create one that matches a pool name on your router, or use a pool shared with you.</span></>}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PACKAGES
   ═══════════════════════════════════════════════════════════════════ */
export function PackageTable({
  rows, isIsp, money, onView, onEdit, onToggle, onDelete, onPrice, onViewSubs, onDuplicate, onShare,
}: {
  rows: Row[]; isIsp: boolean; money: (n: any) => string;
  onView?: (r: Row) => void;
  onEdit: (r: Row) => void; onToggle: (r: Row) => void; onDelete: (r: Row) => void;
  onPrice: () => void; onViewSubs: (r: Row) => void; onDuplicate?: (r: Row) => void;
  onShare?: (r: Row) => void;
}) {
  const ctx = useCtxMenu();
  const [open, setOpen] = React.useState<Set<number>>(new Set());
  const toggleOpen = (id: number) => setOpen((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const COLS = 5; // Package, Speed, Base price, Status, chevron
  return (
    <div className="nt">
      <style>{CSS}</style>
      <table>
        <thead>
          <tr>
            <th>Package</th>
            <th>Speed</th>
            <th>{isIsp ? "Base price" : "You pay"}</th>
            <th>Status</th>
            <th aria-label="Details" />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const subs = p._count?.subscribers ?? 0;
            const isOpen = open.has(p.id);
            return (
              <React.Fragment key={p.id}>
                {/* Collapsed row — click to expand. */}
                <tr className={`pk-click${isOpen ? " pk-open" : ""}`}
                  onClick={() => toggleOpen(p.id)}
                  onContextMenu={(e) => ctx.open(e, [
                    { label: "Details…", onClick: () => onView ? onView(p) : undefined },
                    { label: "Edit…", onClick: () => onEdit(p) },
                    { label: p.isActive ? "Disable" : "Enable", onClick: () => onToggle(p) },
                    ...(onDuplicate ? [{ label: "Duplicate", onClick: () => onDuplicate(p) }] : []),
                    { label: "View subscribers", onClick: () => onViewSubs(p) },
                    { label: "Delete", onClick: () => onDelete(p), danger: true },
                  ])}>
                  <td>
                    <div className="nm">{p.name}</div>
                    <div className="sub">{p.serviceType || "RESIDENTIAL"}</div>
                  </td>
                  <td className="nw">
                    <div className="nm sm">{p.downloadSpeed}/{p.uploadSpeed} <span className="unit">Mbps</span></div>
                  </td>
                  <td className="nw">
                    <div className="nm sm money">{money(p.price)}</div>
                  </td>
                  <td className="nw">
                    <span className={`pk-status ${p.isActive ? "on" : "off"}`}>{p.isActive ? "Active" : "Inactive"}</span>
                  </td>
                  <td className="nw pk-chevcell">
                    <span className={`pk-chev${isOpen ? " up" : ""}`} aria-hidden>▾</span>
                  </td>
                </tr>

                {/* Expanded detail — allowance, FUP, duration, description + actions. */}
                {isOpen && (
                  <tr className="pk-detail">
                    <td colSpan={COLS}>
                      <div className="pk-dgrid">
                        <div className="pk-dfield"><span className="pk-dlabel">Allowance</span>
                          <span className="pk-dval">{p.dataQuotaGb ? `${p.dataQuotaGb} GB` : "Unlimited"}</span></div>
                        <div className="pk-dfield"><span className="pk-dlabel">FUP</span>
                          <span className="pk-dval">{p.dataQuotaGb
                            ? (p.fupDownloadSpeed ? `then ↓${p.fupDownloadSpeed} ↑${p.fupUploadSpeed ?? "—"} Mbps` : "no FUP speeds — not enforced")
                            : "—"}</span></div>
                        <div className="pk-dfield"><span className="pk-dlabel">Duration</span>
                          <span className="pk-dval">{p.duration || 30} {(p.durationType || "MONTHLY").toLowerCase()}</span></div>
                        <div className="pk-dfield"><span className="pk-dlabel">IP Pool</span>
                          <span className="pk-dval">{p.pool?.name || "—"}</span></div>
                        <div className="pk-dfield"><span className="pk-dlabel">Customers</span>
                          <span className="pk-dval">{subs} on this plan</span></div>
                        <div className="pk-dfield wide"><span className="pk-dlabel">Description</span>
                          <span className="pk-dval">{(p as any).description || "—"}</span></div>
                      </div>
                      <div className="pk-dactions" onClick={(e) => e.stopPropagation()}>
                        {onView && <button onClick={() => onView(p)}>Details</button>}
                        <button onClick={() => onViewSubs(p)}>Subs</button>
                        {isIsp ? (
                          <>
                            <button onClick={() => onEdit(p)}>Edit</button>
                            {onDuplicate && <button onClick={() => onDuplicate(p)}>Copy</button>}
                            {onShare && <button onClick={() => onShare(p)} className="warn">Share</button>}
                            <button onClick={() => onToggle(p)}>{p.isActive ? "Disable" : "Enable"}</button>
                            <button className="bad" disabled={subs > 0}
                              title={subs > 0 ? "Customers are on this plan — move them first" : "Delete package"}
                              onClick={() => onDelete(p)}>Delete</button>
                          </>
                        ) : (
                          <button onClick={onPrice}>Set my price</button>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
          {rows.length === 0 && (
            <tr className="empty"><td colSpan={COLS}>
              <b>No packages.</b>
              <span>{isIsp ? "Create one to start selling." : "Ask the ISP to assign a package to your account."}</span>
            </td></tr>
          )}
        </tbody>
      </table>
      {ctx.node}
    </div>
  );
}

const CSS = `
${COL_RESIZE_CSS}
/* Solid, theme-aware surface (not var(--surface), which was rendering light in
   dark mode here). Hard-coded per theme so the table is always the right shade
   and its text stays readable. */
.nt{background:#ffffff;color:var(--text);border:1px solid var(--border);border-radius:8px;overflow:auto;position:relative}
html[data-theme="dark"] .nt{background:#111827}
@media (prefers-color-scheme: dark){ html:not([data-theme]) .nt{background:#111827} }
.nt table{width:100%;border-collapse:separate;border-spacing:0;min-width:520px}

/* Inline expandable package rows. */
.nt tr.pk-click{cursor:pointer}
.nt tr.pk-open > td{background:color-mix(in srgb,var(--accent) 9%,transparent)}
.nt .pk-status{display:inline-block;padding:4px 12px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;line-height:1.4}
.nt .pk-status.on{background:rgba(16,185,129,.15);color:#059669}
.nt .pk-status.off{background:rgba(148,163,184,.16);color:#64748b}
html[data-theme="dark"] .nt .pk-status.on{color:#4ade80}
.nt .pk-chevcell{width:34px;text-align:center}
.nt .pk-chev{display:inline-block;color:var(--muted);transition:transform .18s;font-size:12px}
.nt .pk-chev.up{transform:rotate(180deg)}
.nt tr.pk-detail > td{padding:0;background:#f8fafc;border-bottom:1px solid var(--border)}
html[data-theme="dark"] .nt tr.pk-detail > td{background:#0d1420}
@media(prefers-color-scheme:dark){html:not([data-theme]) .nt tr.pk-detail > td{background:#0d1420}}
.nt .pk-dgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px 22px;padding:14px 16px}
.nt .pk-dfield{display:flex;flex-direction:column;gap:3px;min-width:0}
.nt .pk-dfield.wide{grid-column:1/-1}
.nt .pk-dlabel{font-size:9.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.nt .pk-dval{font-size:12.5px;color:var(--text);line-height:1.5;word-break:break-word}
.nt .pk-dactions{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 14px;border-top:1px solid var(--border);padding-top:12px}
.nt .pk-dactions button{padding:7px 13px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;transition:background .12s,border-color .12s,color .12s}
.nt .pk-dactions button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.nt .pk-dactions button.warn:hover{border-color:#f59e0b;color:#f59e0b}
.nt .pk-dactions button.bad{margin-left:auto}
.nt .pk-dactions button.bad:hover:not(:disabled){border-color:#ef4444;color:#ef4444}
.nt .pk-dactions button:disabled{opacity:.45;cursor:not-allowed}

/* WinBox flags column. */
.nt th.flg,.nt td.flg{width:52px;white-space:nowrap}
.nt .fl{display:inline-block;width:14px;text-align:center;font-family:ui-monospace,monospace;
  font-size:11px;font-weight:800;margin-right:1px;color:#3a4051}
.nt .fl.r{color:#4a9eff}
.nt .fl.x{color:#94A3B8}
.nt .fl.off{opacity:.28}

/* WinBox right-click context menu. */
.nt-ctx{position:fixed;z-index:200;min-width:170px;padding:4px;
  background:var(--bg-elev,var(--surface-2));border:1px solid var(--border);border-radius:8px;
  box-shadow:0 12px 34px rgba(0,0,0,.5);display:flex;flex-direction:column}
.nt-ctx button{text-align:left;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;
  background:transparent;border:none;color:var(--text);border-radius:5px;font-family:inherit}
.nt-ctx button:hover{background:rgba(74,158,255,.14)}
.nt-ctx button.danger:hover{background:rgba(239,68,68,.16);color:#FCA5A5}

.nt thead th{position:sticky;top:0;z-index:2;padding:10px 14px;text-align:left;
  font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
  color:var(--muted);background:#f1f5f9;border-bottom:1px solid var(--border);
  white-space:nowrap}
html[data-theme="dark"] .nt thead th{background:#0f172a}
@media (prefers-color-scheme: dark){ html:not([data-theme]) .nt thead th{background:#0f172a} }

.nt tbody tr{cursor:pointer;transition:background .12s ease}
.nt tbody tr:hover{background:rgba(108,60,225,.07)}
.nt tbody tr:hover td:first-child{box-shadow:inset 3px 0 0 #6C3CE1}
.nt tbody td{padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
.nt tbody tr:last-child td{border-bottom:none}

.nt .nm{font-size:13px;font-weight:700;color:var(--text);line-height:1.35}
.nt .nm.sm{font-size:12.5px;font-weight:600}
.nt .sub{font-size:10.5px;color:var(--muted);line-height:1.5;margin-top:2px}
.nt .unit{font-size:10px;font-weight:500;color:var(--muted)}
.nt .money{font-variant-numeric:tabular-nums}

/* The one number per row that decides whether anything needs doing. Sized so
   it is readable while scrolling, dimmed to muted when it is zero — a zero
   needs no attention and should not draw any. */
.nt .big{font-size:16px;font-weight:800;color:var(--muted);line-height:1.1;
  font-variant-numeric:tabular-nums}
.nt .big.up{color:var(--text)}

.nt code{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;
  background:rgba(255,255,255,.05);padding:1px 5px;border-radius:4px;letter-spacing:-.02em}
.nt code.wide{font-size:12px;padding:3px 8px;color:#7dd3fc}

.nt .dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;
  vertical-align:1px}
.nt .dot.up{background:#10B981;box-shadow:0 0 7px rgba(16,185,129,.75)}
.nt .dot.down{background:#64748B}
.nt b.up{font-size:12px;color:#6EE7B7}
.nt b.down{font-size:12px;color:var(--muted)}

.nt .tag{display:inline-block;padding:2px 7px;border-radius:20px;font-size:9.5px;
  font-weight:800;letter-spacing:.04em;text-transform:uppercase;margin-right:5px}
.nt .tag.ok{background:rgba(16,185,129,.15);color:#6EE7B7}
.nt .tag.warn{background:rgba(245,158,11,.15);color:#FCD34D}
.nt .tag.site{background:rgba(99,102,241,.15);color:#A5B4FC}

.nt td.act{white-space:nowrap;text-align:right}
.nt td.act button{margin-left:5px;padding:4px 9px;border-radius:7px;font-size:10.5px;
  font-weight:700;cursor:pointer;font-family:inherit;opacity:.65;
  background:var(--surface-2);border:1px solid var(--border);color:var(--muted);
  transition:opacity .12s ease,color .12s ease,border-color .12s ease}
.nt tbody tr:hover td.act button{opacity:1}
.nt td.act button:hover:not(:disabled){color:var(--text);border-color:#6C3CE1}
.nt td.act button.warn:hover:not(:disabled){color:#FCD34D;border-color:#F59E0B}
.nt td.act button.bad:hover:not(:disabled){color:#FCA5A5;border-color:#EF4444}
.nt td.act button:disabled{opacity:.28;cursor:not-allowed}

.pool-list .pool-actions{display:flex;align-items:center;gap:5px;white-space:nowrap}
.pool-list .pool-actions button{padding:5px 9px;border:1px solid var(--border);border-radius:6px;
  background:var(--surface-2);color:var(--text);font:600 11px inherit;cursor:pointer}
.pool-list .pool-actions button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.pool-list .pool-actions button.bad:hover:not(:disabled){border-color:#ef4444;color:#ef4444}
.pool-list .pool-actions button:disabled{opacity:.45;cursor:not-allowed}

.nt tr.empty td{padding:38px;text-align:center;border:none}
.nt tr.empty b{display:block;font-size:13px;color:var(--text);margin-bottom:5px}
.nt tr.empty span{font-size:11.5px;color:var(--muted)}

@media (max-width:720px){
  .nt table{min-width:0}
  .nt thead{display:none}
  .nt tbody tr{display:block;border-bottom:1px solid var(--border);padding:4px 0}
  .nt tbody td{display:flex;justify-content:space-between;gap:12px;border:none;
    padding:5px 13px;text-align:right}
  .nt tbody td.act{justify-content:flex-end}
}
`;
