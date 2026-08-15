"use client";

import React from "react";
import { fileUrl } from "../components/image-upload";

/**
 * SubscriberMobileList — a purpose-built mobile view, designed as if this were
 * a native app screen, not a table squeezed onto a phone.
 *
 * Each subscriber is a tappable card: avatar + name + a clear online/offline
 * badge, then the three facts an operator scans for (package, live IP, expiry),
 * then the actions. Tapping the card opens the full profile; the action row is
 * spaced for a fingertip. Shown only under 768px — the desktop table stays for
 * wide screens.
 */

type Row = any;

function initials(name: string) {
  return (
    name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?"
  );
}

const S = {
  online:  { bg: "#E7F6EC", fg: "#157F43", dot: "#219653" },
  offline: { bg: "#F1F5F9", fg: "#64748B", dot: "#94A3B8" },
  expired: { bg: "#FDE8EA", fg: "#B02A37", dot: "#D34053" },
  soon:    { bg: "#FDF3E3", fg: "#8A6209", dot: "#F0A500" },
};

export function SubscriberMobileList({
  rows, onOpen, onEdit, onMove, onDeactivate, onDelete, onActivate,
}: {
  rows: Row[];
  onOpen: (r: Row) => void;
  onEdit: (r: Row) => void;
  onMove: (r: Row) => void;
  onDeactivate: (r: Row) => void;
  onDelete: (r: Row) => void;
  onActivate?: (r: Row) => void;
}) {
  return (
    <div className="sm-wrap">
      <style>{CSS}</style>
      {rows.length === 0 ? (
        <div className="sm-empty">
          <b>No subscribers here</b>
          <span>Add one, or clear the filters above.</span>
        </div>
      ) : (
        rows.map((r) => {
          const name = r.fullName || r.username || "?";
          const online = String(r.onlineStatus ?? r.liveStatus ?? r.status).toUpperCase() === "ONLINE" || r.isOnline === true;
          const expired = r.daysLeft != null && r.daysLeft <= 0;
          const soon = r.daysLeft != null && r.daysLeft > 0 && r.daysLeft <= 7;
          const conn = online ? S.online : S.offline;
          const exp = expired ? S.expired : soon ? S.soon : S.offline;
          const ip = r.framedIp || (online ? r.framedipaddress : null);

          return (
            <div key={r.id} className="sm-card">
              {/* Tappable header opens the profile */}
              <button className="sm-head" onClick={() => onOpen(r)}>
                <span className="sm-av" style={r.photoUrl ? { backgroundImage: `url(${fileUrl(r.photoUrl)})` } : undefined}>
                  {r.photoUrl ? "" : initials(name)}
                </span>
                <span className="sm-id">
                  <span className="sm-name">{name}</span>
                  <span className="sm-sub">{r.username}{r.phone ? ` · ${r.phone}` : ""}</span>
                </span>
                <span className="sm-pill" style={{ background: conn.bg, color: conn.fg }}>
                  <i style={{ background: conn.dot }} />{online ? "Online" : "Offline"}
                </span>
              </button>

              {/* The three facts, evenly split */}
              <div className="sm-facts">
                <div>
                  <span className="k">Package</span>
                  <span className="v">{r.package?.name || "—"}</span>
                </div>
                <div>
                  <span className="k">Live IP</span>
                  <span className="v mono">{ip || "—"}</span>
                </div>
                <div>
                  <span className="k">Expiry</span>
                  <span className="v">
                    {r.daysLeft != null
                      ? <span className="sm-days" style={{ background: exp.bg, color: exp.fg }}>{expired ? "Expired" : `${r.daysLeft}d`}</span>
                      : "—"}
                  </span>
                </div>
              </div>

              {/* Actions — real tap targets */}
              <div className="sm-acts">
                {String(r.status ?? "").toUpperCase() === "ACTIVE" ? (
                  <span className="sm-active">● Active</span>
                ) : (
                  <button className="ok" onClick={() => onActivate?.(r)}>Activate</button>
                )}
                <button onClick={() => onEdit(r)}>Edit</button>
                <button onClick={() => onMove(r)}>Move</button>
                <button className="warn" onClick={() => onDeactivate(r)}>Off</button>
                <button className="bad" onClick={() => onDelete(r)}>Del</button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

const CSS = `
.sm-wrap{display:none}
@media (max-width:768px){
  .sm-wrap{display:flex;flex-direction:column;gap:12px}
  .sm-card{background:#fff;border:1px solid #E2E8F0;border-radius:14px;
    box-shadow:0 1px 3px rgba(0,0,0,.05);overflow:hidden}
  .sm-head{display:flex;align-items:center;gap:11px;width:100%;text-align:left;
    background:transparent;border:none;padding:13px 14px 11px;cursor:pointer;
    border-bottom:1px solid #EEF2F7;font-family:inherit}
  .sm-av{width:42px;height:42px;flex:none;border-radius:50%;background:#EEF1FE;
    color:#3C50E0;display:flex;align-items:center;justify-content:center;
    font-weight:600;font-size:15px;background-size:cover;background-position:center}
  .sm-id{display:flex;flex-direction:column;min-width:0;flex:1}
  .sm-name{font-size:15px;font-weight:600;color:#1C2434;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  .sm-sub{font-size:12px;color:#64748B;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis}
  .sm-pill{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:11px;
    font-weight:600;padding:4px 10px;border-radius:999px;white-space:nowrap}
  .sm-pill i{width:6px;height:6px;border-radius:999px;display:inline-block}
  .sm-facts{display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px;padding:10px 14px}
  .sm-facts>div{display:flex;flex-direction:column;gap:2px;min-width:0}
  .sm-facts .k{font-size:10px;font-weight:600;letter-spacing:.04em;
    text-transform:uppercase;color:#94A3B8}
  .sm-facts .v{font-size:13px;color:#1C2434;font-weight:500;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  .sm-facts .v.mono{font-family:ui-monospace,"JetBrains Mono",monospace;font-size:12px}
  .sm-days{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;
    border-radius:999px}
  .sm-acts{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;
    padding:0 14px 13px}
  .sm-acts button{min-height:40px;border:1px solid #E2E8F0;background:#F7F9FC;
    border-radius:9px;font-size:12.5px;font-weight:600;color:#1C2434;cursor:pointer;
    font-family:inherit}
  .sm-acts button:active{transform:scale(.97)}
  .sm-acts button.ok{background:#E7F6EC;border-color:#C6E9D3;color:#157F43}
  .sm-acts .sm-active{display:flex;align-items:center;justify-content:center;min-height:40px;border-radius:9px;font-size:12.5px;font-weight:700;color:#157F43;background:#E7F6EC;border:1px solid #C6E9D3}
  .sm-acts button.warn{background:#FDF3E3;border-color:#F5DFB4;color:#8A6209}
  .sm-acts button.bad{background:#FDE8EA;border-color:#F5C2C7;color:#B02A37}
  .sm-empty{padding:40px 20px;text-align:center}
  .sm-empty b{display:block;font-size:15px;color:#1C2434;margin-bottom:5px}
  .sm-empty span{font-size:13px;color:#64748B}
}
`;
