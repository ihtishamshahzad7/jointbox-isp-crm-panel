"use client";

import React from "react";

/**
 * SubscriberTable — the list, composed rather than tabulated.
 *
 * The old table had TWELVE columns: Subscriber, Username, Status, Package,
 * Connection, NAS, Area, Salesperson, Expiry, RADIUS, Install Date, Actions.
 * At 1400px that is roughly 110px each, so every value truncates or wraps and
 * a row reads as a wall of fragments. No amount of CSS fixes that — it is a
 * content problem, not a styling one.
 *
 * Same information, six cells. Each cell carries a primary value and its
 * supporting detail underneath, which is how the eye actually reads a list:
 * one anchor, then context.
 *
 * Standalone on purpose. The page keeps its state and handlers; swapping this
 * in or out is one line, and if it is wrong only this file is wrong.
 */

type Row = any;

export function SubscriberTable({
  rows, selectedIds, onToggle, onToggleAll, onOpen, onEdit, onMove, onDeactivate, onDelete, money,
}: {
  rows: Row[];
  selectedIds: number[];
  onToggle: (id: number) => void;
  onToggleAll: () => void;
  onOpen: (r: Row) => void;
  onEdit: (r: Row) => void;
  onMove: (r: Row) => void;
  onDeactivate: (r: Row) => void;
  onDelete: (r: Row) => void;
  money: (n: any) => string;
}) {
  const allOn = rows.length > 0 && rows.every((r) => selectedIds.includes(r.id));

  /**
   * Sorting, client-side over the current page.
   *
   * Deliberately not a server round-trip: the operator's real questions are
   * "who expires first" and "who is offline", and both are answered instantly
   * from rows already on screen. A network call to reorder ten items would be
   * slower and could fail, for no gain.
   */
  const [sort, setSort] = React.useState<{ key: string; dir: 1 | -1 } | null>(null);

  const value = (r: Row, key: string): any => {
    switch (key) {
      case "name":    return (r.fullName || "").toLowerCase();
      // Offline first when descending: the rows that need attention.
      case "online":  return String(r.onlineStatus ?? r.status).toUpperCase() === "ONLINE" || r.isOnline === true ? 1 : 0;
      case "package": return (r.package?.name || "").toLowerCase();
      // Missing expiry sorts last rather than pretending to be the year 1970.
      case "expiry":  return r.serviceSettings?.expiryDate
        ? new Date(r.serviceSettings.expiryDate).getTime() : Number.MAX_SAFE_INTEGER;
      case "owner":   return (r.user?.name || r.salesperson?.name || "").toLowerCase();
      default:        return 0;
    }
  };

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((a, b) => {
      const x = value(a, sort.key), y = value(b, sort.key);
      return x < y ? -sort.dir : x > y ? sort.dir : 0;
    });
  }, [rows, sort]);

  /** Click cycles ascending → descending → off, so the original order is
      always reachable without reloading the page. */
  const head = (key: string, label: string) => {
    const active = sort?.key === key;
    return (
      <th
        className={`srt ${active ? "on" : ""}`}
        onClick={() => setSort(!active ? { key, dir: 1 } : sort!.dir === 1 ? { key, dir: -1 } : null)}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        <i>{active ? (sort!.dir === 1 ? "▲" : "▼") : "⇅"}</i>
      </th>
    );
  };

  return (
    <div className="st">
      <style>{CSS}</style>
      <table>
        <thead>
          <tr>
            <th className="pick"><input type="checkbox" checked={allOn} onChange={onToggleAll} /></th>
            {head("name", "Subscriber")}
            {head("online", "Connection")}
            {head("package", "Package")}
            {head("expiry", "Expiry")}
            {head("owner", "Owner")}
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const online = String(r.onlineStatus ?? r.status).toUpperCase() === "ONLINE"
              || r.isOnline === true;
            const expired = r.daysLeft != null && r.daysLeft <= 0;
            const soon = r.daysLeft != null && r.daysLeft > 0 && r.daysLeft <= 7;
            const name = r.fullName || r.username || "?";
            const initials = String(name).trim().split(/\s+/).slice(0, 2)
              .map((w: string) => w[0]).join("").toUpperCase() || "?";

            return (
              <tr key={r.id} onClick={() => onOpen(r)} className={selectedIds.includes(r.id) ? "on" : ""}>
                <td className="pick" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selectedIds.includes(r.id)} onChange={() => onToggle(r.id)} />
                </td>

                {/* Who. Avatar anchors the row; name loud, identifiers quiet. */}
                <td data-label="Subscriber">
                  <div className="who">
                    <span className={`av ${online ? "on" : ""}`} aria-hidden>{initials}</span>
                    <span className="whoTxt">
                      <span className="nm">{r.fullName || r.username}</span>
                      <span className="sub">
                        <code>{r.username}</code>
                        {r.phone && <span className="ph"> {r.phone}</span>}
                      </span>
                    </span>
                  </div>
                </td>

                {/* State. A glowing pill reads before a word does. */}
                <td data-label="Connection">
                  <span className={`pill ${online ? "up" : "down"}`}>
                    <span className={`dot ${online ? "up" : "down"}`} />
                    {online ? "Online" : "Offline"}
                  </span>
                  <div className="sub mt">
                    {r.framedIp || r.leasedIp
                      ? <code>{r.framedIp || r.leasedIp}</code>
                      : (r.connectionType || "—")}
                  </div>
                </td>

                {/* What they bought, with the speed that defines it. */}
                <td data-label="Package">
                  <span className="chip">{r.package?.name ?? "—"}</span>
                  {r.package && (
                    <div className="sub mt">
                      {r.package.downloadSpeed}/{r.package.uploadSpeed} Mbps
                      {r.sellPrice != null && <> · {money(r.sellPrice)}</>}
                    </div>
                  )}
                </td>

                {/* When it runs out — coloured only when it matters. */}
                <td data-label="Expiry">
                  <div className={`nm sm ${expired ? "down" : soon ? "warn" : ""}`}>
                    {r.serviceSettings?.expiryDate
                      ? new Date(r.serviceSettings.expiryDate).toLocaleDateString()
                      : "—"}
                  </div>
                  {r.daysLeft != null && (
                    <span className={`badge ${expired ? "bad" : soon ? "warnb" : "okb"}`}>
                      {expired ? "expired" : `${r.daysLeft} days left`}
                    </span>
                  )}
                </td>

                {/* Whose customer, and where. */}
                <td data-label="Owner">
                  <div className="nm sm">{r.user?.name ?? r.salesperson?.name ?? "—"}</div>
                  <div className="sub">{r.area?.name ?? r.nas?.nasname ?? "—"}</div>
                </td>

                <td className="act" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => onEdit(r)} title="Edit">Edit</button>
                  <button onClick={() => onMove(r)} title="Move">Move</button>
                  <button className="warn" onClick={() => onDeactivate(r)} title="Deactivate">Off</button>
                  <button className="bad" onClick={() => onDelete(r)} title="Delete">Del</button>
                </td>
              </tr>
            );
          })}

          {sorted.length === 0 && (
            <tr className="empty">
              <td colSpan={7}>
                <b>No subscribers yet.</b>
                <span>Add one with the button above, or adjust the filters if you expected to see some.</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const CSS = `
.st{background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:auto;
  box-shadow:0 1px 2px rgba(0,0,0,.18)}
.st table{width:100%;border-collapse:separate;border-spacing:0;min-width:860px}

.st thead th{position:sticky;top:0;z-index:2;padding:12px 16px;text-align:left;
  font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;
  color:var(--muted);background:linear-gradient(180deg,var(--surface-2),color-mix(in srgb,var(--surface-2) 85%,transparent));
  border-bottom:1px solid var(--border);white-space:nowrap;backdrop-filter:blur(6px)}
.st th.pick,.st td.pick{width:38px;padding-right:0}
.st .pick input{width:15px;height:15px;accent-color:#7C4DFF;cursor:pointer}

.st th.srt{cursor:pointer;user-select:none;transition:color .12s ease}
.st th.srt:hover{color:var(--text)}
.st th.srt.on{color:#C4B5FD}
.st th.srt i{font-style:normal;margin-left:5px;font-size:8.5px;opacity:.35}
.st th.srt:hover i{opacity:.7}
.st th.srt.on i{opacity:1}

.st tbody tr{cursor:pointer;transition:background .14s ease,box-shadow .14s ease}
.st tbody tr:hover{background:linear-gradient(90deg,rgba(124,77,255,.10),rgba(124,77,255,.02))}
.st tbody tr.on{background:rgba(124,77,255,.14)}
.st tbody tr:hover td:first-child{box-shadow:inset 3px 0 0 #7C4DFF}
.st tbody td{padding:12px 16px;border-bottom:1px solid color-mix(in srgb,var(--border) 70%,transparent);vertical-align:middle}
.st tbody tr:last-child td{border-bottom:none}

/* Identity cell: avatar + text. */
.st .who{display:flex;align-items:center;gap:11px}
.st .av{flex:none;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;
  font-size:13px;font-weight:800;color:#fff;letter-spacing:.02em;
  background:linear-gradient(135deg,#7C4DFF,#B14DE8 55%,#F0508A);
  box-shadow:0 2px 8px rgba(124,77,255,.35);position:relative}
.st .av.on::after{content:"";position:absolute;right:-2px;bottom:-2px;width:11px;height:11px;
  border-radius:50%;background:#10B981;border:2px solid var(--surface);box-shadow:0 0 8px rgba(16,185,129,.9)}
.st .whoTxt{display:flex;flex-direction:column;min-width:0}
.st .ph{color:var(--muted)}

.st .nm{font-size:13.5px;font-weight:700;color:var(--text);line-height:1.35}
.st .nm.sm{font-size:12.5px;font-weight:600}
.st .sub{font-size:10.5px;color:var(--muted);line-height:1.5}
.st .sub.mt{margin-top:5px}
.st code{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;
  background:rgba(255,255,255,.06);padding:1px 5px;border-radius:4px;letter-spacing:-.02em}

/* Status pill. */
.st .pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;
  font-size:11px;font-weight:700;line-height:1;border:1px solid transparent}
.st .pill.up{color:#6EE7B7;background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.35)}
.st .pill.down{color:#94A3B8;background:rgba(148,163,184,.10);border-color:rgba(148,163,184,.22)}
.st .dot{display:inline-block;width:6px;height:6px;border-radius:50%}
.st .dot.up{background:#10B981;box-shadow:0 0 7px rgba(16,185,129,.9)}
.st .dot.down{background:#64748B}

/* Package chip. */
.st .chip{display:inline-block;padding:3px 10px;border-radius:8px;font-size:12px;font-weight:700;
  color:#C4B5FD;background:rgba(124,77,255,.12);border:1px solid rgba(124,77,255,.28)}

/* Expiry badges. */
.st .badge{display:inline-block;margin-top:5px;padding:2px 9px;border-radius:999px;
  font-size:10px;font-weight:700}
.st .badge.okb{color:#6EE7B7;background:rgba(16,185,129,.12)}
.st .badge.warnb{color:#FCD34D;background:rgba(245,158,11,.14)}
.st .badge.bad{color:#FCA5A5;background:rgba(239,68,68,.14)}
.st .warn{color:#FCD34D}
.st .down{color:#FCA5A5}

/* Action buttons. */
.st td.act{white-space:nowrap;text-align:right}
.st td.act button{margin-left:6px;padding:5px 11px;border-radius:8px;font-size:11px;
  font-weight:700;cursor:pointer;font-family:inherit;
  background:var(--surface-2);border:1px solid var(--border);color:var(--text);
  transition:all .13s ease}
.st td.act button:hover{border-color:#7C4DFF;color:#C4B5FD;background:rgba(124,77,255,.12);transform:translateY(-1px)}
.st td.act button.warn:hover{color:#FCD34D;border-color:#F59E0B;background:rgba(245,158,11,.12)}
.st td.act button.bad:hover{color:#FCA5A5;border-color:#EF4444;background:rgba(239,68,68,.12)}

.st tr.empty td{padding:44px;text-align:center;border:none}
.st tr.empty b{display:block;font-size:14px;color:var(--text);margin-bottom:6px}
.st tr.empty span{font-size:12px;color:var(--muted)}

/* ── Mobile: each row becomes a card with labelled fields ── */
@media (max-width:760px){
  .st{border:none;background:transparent;box-shadow:none;overflow:visible}
  .st table{min-width:0;display:block}
  .st thead{display:none}
  .st tbody{display:block}
  .st tbody tr{display:block;margin-bottom:12px;padding:12px 14px;border:1px solid var(--border);
    border-radius:14px;background:var(--surface);box-shadow:0 2px 10px rgba(0,0,0,.20)}
  .st tbody tr:hover td:first-child{box-shadow:none}
  .st tbody td{display:flex;align-items:center;justify-content:space-between;gap:14px;
    border:none;padding:7px 0;text-align:right}
  .st tbody td::before{content:attr(data-label);font-size:10px;font-weight:800;
    letter-spacing:.06em;text-transform:uppercase;color:var(--muted);text-align:left}
  .st td[data-label="Subscriber"]{padding-bottom:11px;margin-bottom:5px;
    border-bottom:1px solid var(--border)}
  .st td[data-label="Subscriber"]::before{display:none}
  .st td[data-label="Subscriber"] .who{width:100%}
  .st td.pick{position:absolute;opacity:0;pointer-events:none}
  .st td.act{justify-content:flex-end;padding-top:11px;margin-top:5px;
    border-top:1px solid var(--border)}
  .st td.act::before{display:none}
  .st td.act button{margin:0 0 0 7px}
  .st .sub.mt{margin-top:2px}
}
`;
