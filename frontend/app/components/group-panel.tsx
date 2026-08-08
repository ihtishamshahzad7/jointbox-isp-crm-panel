"use client";

import React from "react";
import API from "./api";

/**
 * GroupPanel — generic "classify by a dimension" panel with total + active
 * counts per group. Reused across NAS and Users (and mirrors the subscriber
 * grouping). Pass the grouped endpoint and the dimensions to offer.
 */
export function GroupPanel({
  endpoint, dims, title = "Group", onPick,
}: {
  endpoint: string; // e.g. "/nas/grouped"
  dims: { id: string; label: string }[];
  title?: string;
  onPick?: (dimension: string, key: any, label: string) => void;
}) {
  const [by, setBy] = React.useState(dims[0]?.id || "");
  const [groups, setGroups] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  const load = React.useCallback(async (dim: string) => {
    setLoading(true);
    try {
      const r = await fetch(`${API}${endpoint}?by=${dim}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      setGroups(Array.isArray(d?.groups) ? d.groups : []);
    } catch { setGroups([]); }
    setLoading(false);
  }, [endpoint, token]);

  React.useEffect(() => { if (open) load(by); }, [open, by, load]);
  const total = groups.reduce((a, g) => a + g.total, 0);

  return (
    <div className="gp">
      <style>{CSS}</style>
      <div className="gp-bar">
        <button className={`gp-toggle ${open ? "on" : ""}`} onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} {title}
        </button>
        {open && (
          <>
            <span className="gp-lbl">by</span>
            <select value={by} onChange={(e) => setBy(e.target.value)}>
              {dims.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
            <span className="gp-count">{loading ? "Loading…" : `${groups.length} groups · ${total} items`}</span>
          </>
        )}
      </div>
      {open && (
        <div className="gp-grid">
          {groups.map((g) => {
            const pct = g.total ? Math.round((g.active / g.total) * 100) : 0;
            return (
              <button key={String(g.key)} className="gp-card" onClick={() => onPick?.(by, g.key, g.label)} title={`Show ${g.label}`}>
                <div className="gp-name">{g.label}</div>
                <div className="gp-nums"><b>{g.total}</b> total · <span className="on">{g.active} active</span></div>
                <div className="gp-meter"><span style={{ width: `${pct}%` }} /></div>
              </button>
            );
          })}
          {!loading && groups.length === 0 && <div className="gp-empty">No groups to show.</div>}
        </div>
      )}
    </div>
  );
}

const CSS = `
.gp{margin-bottom:12px}
.gp-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.gp-toggle{background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit}
.gp-toggle.on{border-color:var(--accent);color:var(--accent)}
.gp-lbl{font-size:12px;color:var(--muted)}
.gp-bar select{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:12px;padding:5px 9px;font-family:inherit;cursor:pointer}
.gp-count{font-size:11.5px;color:var(--muted);margin-left:auto}
.gp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:12px}
.gp-card{text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:11px 13px;cursor:pointer;font-family:inherit;transition:all .13s ease}
.gp-card:hover{border-color:var(--accent);transform:translateY(-1px)}
.gp-name{font-size:13px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gp-nums{font-size:11.5px;color:var(--muted);margin-top:4px}
.gp-nums b{color:var(--text);font-size:14px}
.gp-nums .on{color:#4ade80}
.gp-meter{height:5px;border-radius:3px;background:var(--surface-2);margin-top:8px;overflow:hidden}
.gp-meter span{display:block;height:100%;background:linear-gradient(90deg,#7C4DFF,#4ade80)}
.gp-empty{grid-column:1/-1;padding:20px;text-align:center;color:var(--muted);font-size:12px}
`;
