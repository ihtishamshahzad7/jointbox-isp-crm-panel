"use client";

import React from "react";

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
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); };
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
   NAS / ROUTERS
   ═══════════════════════════════════════════════════════════════════ */
export function NasTable({
  rows, me, onView, onEdit, onShare, onCheck, onDelete, checking, checkingIds, reachOf, onMessageSubs,
}: {
  rows: Row[];
  me?: any;
  onView: (r: Row) => void;
  onEdit: (r: Row) => void;
  onShare: (r: Row) => void;
  onCheck: (id: number) => void;
  onDelete: (r: Row) => void;
  /** Optional: message all subscribers on this NAS (maintenance notice, etc.). */
  onMessageSubs?: (r: Row) => void;
  /** Global disable for the Check button — used when no per-row state exists. */
  checking?: boolean;
  /** Per-row "currently checking" — takes precedence over `checking` when given. */
  checkingIds?: Set<number>;
  /** Live reachability from an on-demand API probe, keyed by NAS id. When
      given, the Reachability column reports the live read instead of the
      stored isActive flag — "can I reach it right now" is what matters when
      a customer is offline, and that can differ from the config flag. */
  reachOf?: (id: number) => { apiPortOpen?: boolean; activeSessionCount?: number; identity?: string } | undefined;
}) {
  const isIsp = !me || me.role === "ADMIN" || me.role === "SUPER_ADMIN";
  const ctx = useCtxMenu();

  return (
    <div className="nt">
      <style>{CSS}</style>
      <table>
        <thead>
          <tr>
            <th className="flg" title="R: reachable/active · X: disabled">Flags</th>
            <th>Router</th><th>Reachability</th><th>Sessions</th><th>Ports</th><th>Site</th><th>Access</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => {
            const mine = isIsp || n.ownerId === me?.id;
            const live = reachOf?.(n.id);
            const sessions = live?.activeSessionCount ?? n.activeSessions ?? n._count?.subscribers ?? 0;
            const rowChecking = checkingIds ? checkingIds.has(n.id) : !!checking;
            const reachable = live ? !!live.apiPortOpen : !!n.isActive;
            return (
              <tr key={n.id} onClick={() => onView(n)}
                onContextMenu={(e) => ctx.open(e, [
                  { label: "Open", onClick: () => onView(n) },
                  ...(onMessageSubs ? [{ label: "Message subscribers…", onClick: () => onMessageSubs(n) }] : []),
                  ...(mine ? [
                    { label: "Check reachability", onClick: () => onCheck(n.id) },
                    { label: "Share…", onClick: () => onShare(n) },
                    { label: "Edit…", onClick: () => onEdit(n) },
                    { label: "Delete", onClick: () => onDelete(n), danger: true },
                  ] : []),
                ])}>
                <td className="flg">
                  <span className={`fl ${reachable ? "r" : ""}`} title="Running (reachable)">R</span>
                  <span className={`fl ${!n.isActive ? "x" : "off"}`} title="Disabled">X</span>
                </td>
                <td>
                  <div className="nm">{n.nasname}</div>
                  <div className="sub">
                    <code>{n.nasIp || "no IP"}</code>
                    {!isIsp && (
                      mine
                        ? <span className="tag ok">yours</span>
                        : <span className="tag warn">shared with you</span>
                    )}
                  </div>
                </td>

                {/* The question this column answers is "can I reach it right
                    now", not "is the row enabled" — those diverge, and only
                    the first one matters when a customer is offline. When a
                    live probe exists it wins over the stored config flag. */}
                <td>
                  {live ? (
                    <>
                      <span className={`dot ${live.apiPortOpen ? "up" : "down"}`} />
                      <b className={live.apiPortOpen ? "up" : "down"}>{live.apiPortOpen ? "Reachable" : "Unreachable"}</b>
                      <div className="sub">{live.identity || n.type || "default"}</div>
                    </>
                  ) : (
                    <>
                      <span className={`dot ${n.isActive ? "up" : "down"}`} />
                      <b className={n.isActive ? "up" : "down"}>{n.isActive ? "Active" : "Disabled"}</b>
                      <div className="sub">{rowChecking ? "checking…" : (n.type || "default")}</div>
                    </>
                  )}
                </td>

                <td>
                  <div className={`big ${sessions > 0 ? "up" : ""}`}>{sessions}</div>
                  <div className="sub">online now</div>
                </td>

                <td>
                  <div className="sub">RADIUS 1812/1813</div>
                  <div className="sub">API {n.apiPort || 8728} · CoA {n.incomingPort || 3799}</div>
                </td>

                {/* Site / Group — parsed from description or shortname.
                    Shows where the router lives physically. */}
                <td>
                  {n.description ? (
                    <>
                      <span className="tag site">{n.shortname || n.description.slice(0, 20)}</span>
                      {n.description.length > 20 && <div className="sub">{n.description.slice(0, 30)}</div>}
                    </>
                  ) : n.shortname ? (
                    <span className="tag site">{n.shortname}</span>
                  ) : (
                    <span className="sub">—</span>
                  )}
                </td>

                {/* Credentials present or not, stated plainly. Without API
                    access the panel cannot read sessions, pull router logs or
                    disconnect anyone — worth knowing at a glance. */}
                <td>
                  {n.apiUsername
                    ? <span className="tag ok">API ready</span>
                    : <span className="tag warn">no API access</span>}
                  {typeof n.assignments?.length === "number" && n.assignments.length > 0 && (
                    <div className="sub">shared with {n.assignments.length}</div>
                  )}
                </td>

                <td className="act" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => onCheck(n.id)} disabled={rowChecking}>{rowChecking ? "Checking…" : "Check"}</button>
                  {mine && <button onClick={() => onShare(n)}>Share</button>}
                  {mine && <button onClick={() => onEdit(n)}>Edit</button>}
                  {mine && <button className="bad" onClick={() => onDelete(n)}>Del</button>}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr className="empty"><td colSpan={8}>
              <b>No routers yet.</b>
              <span>Add one, or ask your parent account to share theirs with you.</span>
            </td></tr>
          )}
        </tbody>
      </table>
      {ctx.node}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   IP POOLS
   ═══════════════════════════════════════════════════════════════════ */
export function PoolTable({
  rows, me, onView, onEdit, onShare, onDelete,
}: {
  rows: Row[]; me?: any;
  onView: (r: Row) => void; onEdit: (r: Row) => void;
  onShare: (r: Row) => void; onDelete: (r: Row) => void;
}) {
  const isIsp = !me || me.role === "ADMIN" || me.role === "SUPER_ADMIN";

  return (
    <div className="nt">
      <style>{CSS}</style>
      <table>
        <thead>
          <tr><th>Pool</th><th>Range</th><th>In use by</th><th>Sharing</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const mine = isIsp || p.ownerId === me?.id;
            const used = p._count?.packages ?? p.packages?.length ?? 0;
            return (
              <tr key={p.id} onClick={() => onView(p)}>
                <td>
                  <div className="nm">{p.name}</div>
                  <div className="sub">
                    {!isIsp && (mine
                      ? <span className="tag ok">yours</span>
                      : <span className="tag warn">shared with you</span>)}
                  </div>
                </td>

                {/* The CIDR is what has to match the router, so it gets the
                    monospace treatment and sits on its own. */}
                <td><code className="wide">{p.network}/{p.subnet}</code></td>

                <td>
                  <div className={`big ${used > 0 ? "up" : ""}`}>{used}</div>
                  <div className="sub">{used === 1 ? "package" : "packages"}</div>
                </td>

                <td>
                  {p.assignments?.length
                    ? <span className="tag ok">shared with {p.assignments.length}</span>
                    : <span className="sub">not shared</span>}
                </td>

                <td className="act" onClick={(e) => e.stopPropagation()}>
                  {mine && <button onClick={() => onShare(p)}>Share</button>}
                  {mine && <button onClick={() => onEdit(p)}>Edit</button>}
                  {mine && (
                    <button className="bad" disabled={used > 0}
                      title={used > 0 ? "In use by a package — reassign it first" : "Delete pool"}
                      onClick={() => onDelete(p)}>Del</button>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr className="empty"><td colSpan={5}>
              <b>No IP pools.</b>
              <span>Create one that matches a pool name on your router, or use a pool shared with you.</span>
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PACKAGES
   ═══════════════════════════════════════════════════════════════════ */
export function PackageTable({
  rows, isIsp, money, onEdit, onToggle, onDelete, onPrice, onViewSubs, onDuplicate, onShare,
}: {
  rows: Row[]; isIsp: boolean; money: (n: any) => string;
  onEdit: (r: Row) => void; onToggle: (r: Row) => void; onDelete: (r: Row) => void;
  onPrice: () => void; onViewSubs: (r: Row) => void; onDuplicate?: (r: Row) => void;
  onShare?: (r: Row) => void;
}) {
  const ctx = useCtxMenu();
  return (
    <div className="nt">
      <style>{CSS}</style>
      <table>
        <thead>
          <tr>
            <th className="flg" title="R: active · X: inactive">Flags</th>
            <th>Package</th><th>Speed</th><th>{isIsp ? "Base price" : "You pay"}</th>
            <th>Allowance</th><th>Customers</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const subs = p._count?.subscribers ?? 0;
            return (
              <tr key={p.id}
                onContextMenu={(e) => ctx.open(e, [
                  { label: "Edit…", onClick: () => onEdit(p) },
                  { label: p.isActive ? "Disable" : "Enable", onClick: () => onToggle(p) },
                  ...(onDuplicate ? [{ label: "Duplicate", onClick: () => onDuplicate(p) }] : []),
                  { label: "View subscribers", onClick: () => onViewSubs(p) },
                  { label: "Delete", onClick: () => onDelete(p), danger: true },
                ])}>
                <td className="flg">
                  <span className={`fl ${p.isActive ? "r" : ""}`} title="Active">R</span>
                  <span className={`fl ${!p.isActive ? "x" : "off"}`} title="Inactive">X</span>
                </td>
                <td>
                  <div className="nm">{p.name}</div>
                  <div className="sub">
                    <span className={`dot ${p.isActive ? "up" : "down"}`} />
                    {p.isActive ? "Active" : "Inactive"} · {p.serviceType || "RESIDENTIAL"}
                  </div>
                </td>

                <td>
                  <div className="nm sm">{p.downloadSpeed}/{p.uploadSpeed} <span className="unit">Mbps</span></div>
                  <div className="sub">{p.duration || 30} {(p.durationType || "MONTHLY").toLowerCase()}</div>
                </td>

                <td>
                  <div className="nm sm money">{money(p.price)}</div>
                  {p.pool?.name && <div className="sub">pool <code>{p.pool.name}</code></div>}
                </td>

                {/* Unlimited is the common case, and saying so is clearer than
                    a dash the reader has to interpret. */}
                <td>
                  {p.dataQuotaGb
                    ? <><div className="nm sm">{p.dataQuotaGb} <span className="unit">GB</span></div>
                        <div className="sub">{p.fupDownloadSpeed ? `then ${p.fupDownloadSpeed} Mbps` : "then blocked"}</div></>
                    : <span className="sub">unlimited</span>}
                </td>

                <td>
                  <div className={`big ${subs > 0 ? "up" : ""}`}>{subs}</div>
                  <div className="sub">on this plan</div>
                </td>

                <td className="act">
                  <button onClick={() => onViewSubs(p)}>Subs</button>
                  {isIsp ? (
                    <>
                      <button onClick={() => onEdit(p)}>Edit</button>
                      {onDuplicate && <button onClick={() => onDuplicate(p)}>Copy</button>}
                      {onShare && <button onClick={() => onShare(p)} className="warn">Share</button>}
                      <button onClick={() => onToggle(p)}>{p.isActive ? "Off" : "On"}</button>
                      <button className="bad" disabled={subs > 0}
                        title={subs > 0 ? "Customers are on this plan — move them first" : "Delete package"}
                        onClick={() => onDelete(p)}>Del</button>
                    </>
                  ) : (
                    <button onClick={onPrice}>Set my price</button>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr className="empty"><td colSpan={7}>
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
.nt{background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:auto;position:relative}
.nt table{width:100%;border-collapse:separate;border-spacing:0;min-width:760px}

/* WinBox flags column. */
.nt th.flg,.nt td.flg{width:52px;white-space:nowrap}
.nt .fl{display:inline-block;width:14px;text-align:center;font-family:ui-monospace,monospace;
  font-size:11px;font-weight:800;margin-right:1px;color:#3a4051}
.nt .fl.r{color:#4a9eff}
.nt .fl.x{color:#94A3B8}
.nt .fl.off{opacity:.28}

/* WinBox right-click context menu. */
.nt-ctx{position:fixed;z-index:200;min-width:170px;padding:4px;
  background:var(--surface-2);border:1px solid var(--border);border-radius:8px;
  box-shadow:0 12px 34px rgba(0,0,0,.5);display:flex;flex-direction:column}
.nt-ctx button{text-align:left;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;
  background:transparent;border:none;color:var(--text);border-radius:5px;font-family:inherit}
.nt-ctx button:hover{background:rgba(74,158,255,.14)}
.nt-ctx button.danger:hover{background:rgba(239,68,68,.16);color:#FCA5A5}

.nt thead th{position:sticky;top:0;z-index:2;padding:10px 14px;text-align:left;
  font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
  color:var(--muted);background:var(--surface-2);border-bottom:1px solid var(--border);
  white-space:nowrap}

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
