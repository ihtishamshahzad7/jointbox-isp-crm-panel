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

            return (
              <tr key={r.id} onClick={() => onOpen(r)} className={selectedIds.includes(r.id) ? "on" : ""}>
                <td className="pick" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selectedIds.includes(r.id)} onChange={() => onToggle(r.id)} />
                </td>

                {/* Who. The anchor: name loud, identifiers quiet beneath it. */}
                <td>
                  <div className="nm">{r.fullName}</div>
                  <div className="sub">
                    <code>{r.username}</code>
                    {r.phone && <span> · {r.phone}</span>}
                  </div>
                </td>

                {/* State. A dot resolves before a word does — you read forty
                    rows at a glance instead of forty labels. */}
                <td>
                  <span className={`dot ${online ? "up" : "down"}`} />
                  <b className={online ? "up" : "down"}>{online ? "Online" : "Offline"}</b>
                  <div className="sub">
                    {r.framedIp || r.leasedIp
                      ? <code>{r.framedIp || r.leasedIp}</code>
                      : (r.connectionType || "—")}
                  </div>
                </td>

                {/* What they bought, with the speed that defines it. */}
                <td>
                  <div className="nm sm">{r.package?.name ?? "—"}</div>
                  {r.package && (
                    <div className="sub">
                      {r.package.downloadSpeed}/{r.package.uploadSpeed} Mbps
                      {r.sellPrice != null && <> · {money(r.sellPrice)}</>}
                    </div>
                  )}
                </td>

                {/* When it runs out — the number that decides whether anyone
                    needs to act today. Coloured only when it matters. */}
                <td>
                  <div className={`nm sm ${expired ? "down" : soon ? "warn" : ""}`}>
                    {r.serviceSettings?.expiryDate
                      ? new Date(r.serviceSettings.expiryDate).toLocaleDateString()
                      : "—"}
                  </div>
                  {r.daysLeft != null && (
                    <div className={`sub ${expired ? "down" : soon ? "warn" : ""}`}>
                      {expired ? "expired" : `${r.daysLeft} days left`}
                    </div>
                  )}
                </td>

                {/* Whose customer, and where. Two facts that are always read
                    together and never separately. */}
                <td>
                  <div className="nm sm">{r.user?.name ?? r.salesperson?.name ?? "—"}</div>
                  <div className="sub">{r.area?.name ?? r.nas?.nasname ?? "—"}</div>
                </td>

                <td className="act" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => onEdit(r)}>Edit</button>
                  <button onClick={() => onMove(r)}>Move</button>
                  <button className="warn" onClick={() => onDeactivate(r)}>Off</button>
                  <button className="bad" onClick={() => onDelete(r)}>Del</button>
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
.st{background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:auto}
.st table{width:100%;border-collapse:separate;border-spacing:0;min-width:820px}

.st thead th{position:sticky;top:0;z-index:2;padding:10px 14px;text-align:left;
  font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
  color:var(--muted);background:var(--surface-2);border-bottom:1px solid var(--border);
  white-space:nowrap}
.st th.pick,.st td.pick{width:34px;padding-right:0}

/* Sortable headers: the arrow is faint until the column is in use, so the
   header row stays quiet while still telling you sorting exists. */
.st th.srt{cursor:pointer;user-select:none;transition:color .12s ease}
.st th.srt:hover{color:var(--text)}
.st th.srt.on{color:#C4B5FD}
.st th.srt i{font-style:normal;margin-left:5px;font-size:8.5px;opacity:.35}
.st th.srt:hover i{opacity:.7}
.st th.srt.on i{opacity:1}

.st tbody tr{cursor:pointer;transition:background .12s ease}
.st tbody tr:hover{background:rgba(108,60,225,.07)}
.st tbody tr.on{background:rgba(108,60,225,.12)}
.st tbody tr:hover td:first-child{box-shadow:inset 3px 0 0 #6C3CE1}
.st tbody td{padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
.st tbody tr:last-child td{border-bottom:none}

/* One anchor per row, everything else a step quieter. */
.st .nm{font-size:13px;font-weight:700;color:var(--text);line-height:1.35}
.st .nm.sm{font-size:12px;font-weight:600}
.st .sub{font-size:10.5px;color:var(--muted);line-height:1.5;margin-top:2px}
.st code{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;
  background:rgba(255,255,255,.05);padding:1px 5px;border-radius:4px;letter-spacing:-.02em}

.st .dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;
  vertical-align:1px}
.st .dot.up{background:#10B981;box-shadow:0 0 7px rgba(16,185,129,.75)}
.st .dot.down{background:#64748B}
.st b.up{font-size:12px;color:#6EE7B7}
.st b.down{font-size:12px;color:var(--muted)}
.st .warn{color:#FCD34D}
.st .down{color:#FCA5A5}

/* Actions stay quiet until the row is under the pointer — four bright
   buttons on every row of a long list compete with the data itself. */
.st td.act{white-space:nowrap;text-align:right}
.st td.act button{margin-left:5px;padding:4px 9px;border-radius:7px;font-size:10.5px;
  font-weight:700;cursor:pointer;font-family:inherit;opacity:.65;
  background:var(--surface-2);border:1px solid var(--border);color:var(--muted);
  transition:opacity .12s ease,color .12s ease,border-color .12s ease}
.st tbody tr:hover td.act button{opacity:1}
.st td.act button:hover{color:var(--text);border-color:#6C3CE1}
.st td.act button.warn:hover{color:#FCD34D;border-color:#F59E0B}
.st td.act button.bad:hover{color:#FCA5A5;border-color:#EF4444}

.st tr.empty td{padding:38px;text-align:center;border:none}
.st tr.empty b{display:block;font-size:13px;color:var(--text);margin-bottom:5px}
.st tr.empty span{font-size:11.5px;color:var(--muted)}

@media (max-width:720px){
  .st table{min-width:0}
  .st thead{display:none}
  .st tbody tr{display:block;border-bottom:1px solid var(--border);padding:4px 0}
  .st tbody td{display:flex;justify-content:space-between;gap:12px;border:none;
    padding:5px 13px;text-align:right}
  .st tbody td.act{justify-content:flex-end}
  .st .sub{margin-top:0}
}
`;
