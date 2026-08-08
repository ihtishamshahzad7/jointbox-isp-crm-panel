"use client";

import React from "react";
import API from "../components/api";

/**
 * SubscriberGroups — classify the list by a related dimension (NAS, area,
 * dealer/parent, package, status) and show each group with total + active
 * counts. Clicking a group drills the main list into it via onPick.
 */

const DIMS = [
  { id: "nas", label: "NAS / Router" },
  { id: "area", label: "Area" },
  { id: "owner", label: "Dealer / Parent" },
  { id: "package", label: "Package" },
  { id: "status", label: "Status" },
];

export function SubscriberGroups({ onPick }: { onPick?: (dimension: string, key: any, label: string) => void }) {
  const [by, setBy] = React.useState("nas");
  const [groups, setGroups] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  const load = React.useCallback(async (dim: string) => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/subscribers/grouped?by=${dim}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      setGroups(Array.isArray(d?.groups) ? d.groups : []);
    } catch { setGroups([]); }
    setLoading(false);
  }, [token]);

  React.useEffect(() => { if (open) load(by); }, [open, by, load]);

  const totalSubs = groups.reduce((a, g) => a + g.total, 0);

  return (
    <div className="sg">
      <style>{CSS}</style>
      <div className="sg-bar">
        <button className={`sg-toggle ${open ? "on" : ""}`} onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} Group subscribers
        </button>
        {open && (
          <>
            <span className="sg-lbl">by</span>
            <select value={by} onChange={(e) => setBy(e.target.value)}>
              {DIMS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
            <span className="sg-count">{loading ? "Loading…" : `${groups.length} groups · ${totalSubs} subscribers`}</span>
          </>
        )}
      </div>

      {open && (
        <div className="sg-grid">
          {groups.map((g) => {
            const pct = g.total ? Math.round((g.active / g.total) * 100) : 0;
            return (
              <button key={String(g.key)} className="sg-card"
                onClick={() => onPick?.(by, g.key, g.label)} title={`Show ${g.label}`}>
                <div className="sg-name">{g.label}</div>
                <div className="sg-nums">
                  <b>{g.total}</b> total · <span className="on">{g.active} active</span>
                </div>
                <div className="sg-meter"><span style={{ width: `${pct}%` }} /></div>
              </button>
            );
          })}
          {!loading && groups.length === 0 && <div className="sg-empty">No groups to show.</div>}
        </div>
      )}
    </div>
  );
}

const CSS = `
.sg{margin-bottom:12px}
.sg-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sg-toggle{background:var(--surface-2);border:1px solid var(--border);color:var(--text);
  border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit}
.sg-toggle.on{border-color:var(--accent);color:var(--accent)}
.sg-lbl{font-size:12px;color:var(--muted)}
.sg-bar select{background:var(--surface);color:var(--text);border:1px solid var(--border);
  border-radius:6px;font-size:12px;padding:5px 9px;font-family:inherit;cursor:pointer}
.sg-count{font-size:11.5px;color:var(--muted);margin-left:auto}
.sg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:12px}
.sg-card{text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:11px 13px;cursor:pointer;font-family:inherit;transition:all .13s ease}
.sg-card:hover{border-color:var(--accent);transform:translateY(-1px)}
.sg-name{font-size:13px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sg-nums{font-size:11.5px;color:var(--muted);margin-top:4px}
.sg-nums b{color:var(--text);font-size:14px}
.sg-nums .on{color:#4ade80}
.sg-meter{height:5px;border-radius:3px;background:var(--surface-2);margin-top:8px;overflow:hidden}
.sg-meter span{display:block;height:100%;background:linear-gradient(90deg,#7C4DFF,#4ade80)}
.sg-empty{grid-column:1/-1;padding:20px;text-align:center;color:var(--muted);font-size:12px}
`;
