"use client";

import React from "react";
import API from "../components/api";
import { useSSE } from "../components/use-sse";

/**
 * Network Monitoring — each account adds hosts (IP/hostname), grouped, pinged
 * continuously by the backend. Small live latency graphs, and a loud in-app
 * alert (beep + spoken "<host> is down", repeating) the moment one drops.
 * Everything is owner-scoped by the API, so a parent's targets stay private.
 */
type Sample = { t: number; ms: number | null; up: boolean };
type Target = {
  id: number; name: string; host: string; groupName: string | null;
  enabled: boolean; isUp: boolean | null; lastLatencyMs: number | null;
  lossPct: number | null; lastCheckedAt: string | null; downSince: string | null;
  intervalSec: number; history: Sample[];
};

export default function MonitoringPage() {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [targets, setTargets] = React.useState<Target[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [muted, setMuted] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", host: "", groupName: "" });
  const [adding, setAdding] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const r = await fetch(`${API}/monitoring/targets`, { headers: H });
      if (r.status === 403) { setErr("You don't have permission to view monitoring."); setLoaded(true); return; }
      if (r.ok) { setTargets(await r.json()); setErr(""); }
    } catch { /* keep last */ }
    setLoaded(true);
  }, []);

  React.useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  // Instant refresh on a down/up transition pushed from the server.
  useSSE({ onEvent: (type) => { if (type === "monitor") load(); } });

  const down = targets.filter((t) => t.isUp === false && t.enabled);

  // ── Alerting: beep + repeating spoken "<host> is down" while anything's down ──
  const audioRef = React.useRef<AudioContext | null>(null);
  const beep = React.useCallback(() => {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      const ctx = audioRef.current || (audioRef.current = new AC());
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "square"; o.frequency.value = 880;
      g.gain.value = 0.06; o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.18);
    } catch { /* audio blocked until first interaction */ }
  }, []);
  const speak = React.useCallback((text: string) => {
    try {
      const s = window.speechSynthesis;
      if (!s) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1; u.pitch = 1; s.speak(u);
    } catch { /* ignore */ }
  }, []);

  React.useEffect(() => {
    if (muted || down.length === 0) return;
    const announce = () => {
      beep();
      // Speak up to 3 names so it isn't endless.
      down.slice(0, 3).forEach((t) => speak(`${t.name || t.host} is down`));
    };
    announce();
    const id = setInterval(announce, 12000); // repeat every 12s until resolved/muted
    return () => clearInterval(id);
  }, [down.map((d) => d.id).join(","), muted, beep, speak]);

  // ── Actions ──────────────────────────────────────────────────
  const add = async () => {
    if (!form.host.trim()) return;
    setAdding(true);
    try {
      const r = await fetch(`${API}/monitoring/targets`, { method: "POST", headers: H, body: JSON.stringify(form) });
      if (r.ok) { setForm({ name: "", host: "", groupName: form.groupName }); await load(); }
      else { const d = await r.json().catch(() => ({})); setErr(d?.message || "Could not add host"); }
    } finally { setAdding(false); }
  };
  const del = async (id: number) => {
    if (!confirm("Remove this monitor?")) return;
    await fetch(`${API}/monitoring/targets/${id}`, { method: "DELETE", headers: H }); load();
  };
  const checkNow = async (id: number) => {
    await fetch(`${API}/monitoring/targets/${id}/check`, { method: "POST", headers: H }); setTimeout(load, 500);
  };
  const toggle = async (t: Target) => {
    await fetch(`${API}/monitoring/targets/${t.id}`, { method: "PUT", headers: H, body: JSON.stringify({ enabled: !t.enabled }) }); load();
  };

  // Group targets.
  const groups = React.useMemo(() => {
    const m = new Map<string, Target[]>();
    for (const t of targets) { const k = t.groupName || "Ungrouped"; (m.get(k) || m.set(k, []).get(k)!).push(t); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [targets]);
  const knownGroups = [...new Set(targets.map((t) => t.groupName).filter(Boolean) as string[])];

  return (
    <div className="mon">
      <style>{CSS}</style>

      <div className="mon-head">
        <div>
          <h1>Network Monitoring</h1>
          <p>Ping your routers, towers and upstreams continuously. You'll hear an alert the moment one drops.</p>
        </div>
        <div className="mon-head-stats">
          <span className="ok">{targets.filter((t) => t.isUp).length} up</span>
          <span className={down.length ? "bad" : "muted"}>{down.length} down</span>
        </div>
      </div>

      {/* DOWN ALERT BANNER */}
      {down.length > 0 && (
        <div className="mon-alert">
          <div>
            <b>⚠ {down.length} host{down.length > 1 ? "s are" : " is"} DOWN:</b>{" "}
            {down.slice(0, 6).map((t) => t.name || t.host).join(", ")}{down.length > 6 ? "…" : ""}
          </div>
          <button onClick={() => setMuted((m) => !m)}>{muted ? "🔔 Unmute" : "🔕 Mute sound"}</button>
        </div>
      )}

      {/* ADD */}
      <div className="mon-add">
        <input placeholder="Host or IP (e.g. 192.168.88.1 or google.com)" value={form.host}
          onChange={(e) => setForm((p) => ({ ...p, host: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && add()} />
        <input placeholder="Label (optional)" value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
        <input placeholder="Group (optional)" value={form.groupName} list="mon-groups"
          onChange={(e) => setForm((p) => ({ ...p, groupName: e.target.value }))} />
        <datalist id="mon-groups">{knownGroups.map((g) => <option key={g} value={g} />)}</datalist>
        <button onClick={add} disabled={adding || !form.host.trim()}>{adding ? "Adding…" : "+ Add monitor"}</button>
      </div>
      {err && <div className="mon-err">{err}</div>}

      {!loaded ? <div className="mon-empty">Loading…</div> :
        targets.length === 0 ? <div className="mon-empty">No monitors yet. Add a host above to start pinging it.</div> :
        groups.map(([g, list]) => (
          <div key={g} className="mon-group">
            <div className="mon-group-h">{g} <span>{list.length}</span></div>
            <div className="mon-grid">
              {list.map((t) => <Card key={t.id} t={t} onDelete={() => del(t.id)} onCheck={() => checkNow(t.id)} onToggle={() => toggle(t)} />)}
            </div>
          </div>
        ))}
    </div>
  );
}

function Card({ t, onDelete, onCheck, onToggle }: { t: Target; onDelete: () => void; onCheck: () => void; onToggle: () => void }) {
  const state = !t.enabled ? "off" : t.isUp === null ? "wait" : t.isUp ? "up" : "down";
  const label = { off: "Paused", wait: "Checking…", up: "Online", down: "DOWN" }[state];
  const color = { off: "#94A3B8", wait: "#8A6209", up: "#157F43", down: "#B02A37" }[state];
  return (
    <div className={`mon-card ${state}`}>
      <div className="mon-card-top">
        <a className="mon-card-name" href={`/monitoring/${t.id}`} title="Open details">
          <b>{t.name || t.host}</b>
          <em>{t.host}</em>
        </a>
        <span className="mon-dot" style={{ background: color }} title={label} />
      </div>
      <LatencyGraph history={t.history} up={t.isUp} />
      <div className="mon-card-metrics">
        <span style={{ color }}>{label}</span>
        <span>{t.isUp && t.lastLatencyMs != null ? `${t.lastLatencyMs} ms` : t.lossPct != null ? `${Math.round(t.lossPct)}% loss` : "—"}</span>
        <span className="muted">{t.lastCheckedAt ? timeAgo(t.lastCheckedAt) : "never"}</span>
      </div>
      {state === "down" && t.downSince && <div className="mon-down-since">down since {timeAgo(t.downSince)}</div>}
      <div className="mon-card-actions">
        {/* Primary way into the per-host history + diagnostics page. */}
        <a className="details" href={`/monitoring/${t.id}`}>📈 Details</a>
        <button onClick={onCheck}>Check now</button>
        <button onClick={onToggle}>{t.enabled ? "Pause" : "Resume"}</button>
        <button className="del" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

/** Small ~220×64 latency sparkline with a filled area; red marks for down samples. */
function LatencyGraph({ history, up }: { history: Sample[]; up: boolean | null }) {
  const W = 220, HH = 64, pad = 4;
  const pts = (history || []).slice(-40);
  if (pts.length < 2) {
    return <div className="mon-graph empty">gathering data…</div>;
  }
  const vals = pts.map((p) => (p.up && p.ms != null ? p.ms : 0));
  const max = Math.max(20, ...vals) * 1.15;
  const stepX = (W - pad * 2) / (pts.length - 1);
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => HH - pad - (v / max) * (HH - pad * 2);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.up && p.ms != null ? p.ms : 0).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${HH - pad} L${x(0).toFixed(1)},${HH - pad} Z`;
  const stroke = up === false ? "#ef4444" : "#22c55e";
  return (
    <svg className="mon-graph" viewBox={`0 0 ${W} ${HH}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="mg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#mg)" />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => (!p.up ? <circle key={i} cx={x(i)} cy={HH - pad - 2} r="1.8" fill="#ef4444" /> : null))}
    </svg>
  );
}

function timeAgo(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const CSS = `
.mon{max-width:1100px;color:var(--text)}
.mon-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.mon-head h1{font-size:20px;font-weight:800;margin:0}
.mon-head p{font-size:12.5px;color:var(--muted);margin:4px 0 0}
.mon-head-stats{display:flex;gap:8px;font-size:12px;font-weight:700}
.mon-head-stats .ok{color:#157F43;background:rgba(21,127,67,.12);border:1px solid rgba(21,127,67,.3);border-radius:999px;padding:4px 12px}
.mon-head-stats .bad{color:#B02A37;background:rgba(176,42,55,.12);border:1px solid rgba(176,42,55,.35);border-radius:999px;padding:4px 12px}
.mon-head-stats .muted{color:#94A3B8;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:4px 12px}
.mon-alert{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;background:rgba(239,68,68,.10);border:1px solid rgba(239,68,68,.4);border-radius:10px;padding:11px 14px;margin-bottom:14px;font-size:13px;color:#f87171;animation:monpulse 1.6s ease-in-out infinite}
@keyframes monpulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.0)}50%{box-shadow:0 0 0 4px rgba(239,68,68,.12)}}
.mon-alert button{background:#B02A37;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.mon-add{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.mon-add input{height:38px;border:1px solid var(--border);border-radius:9px;padding:0 12px;font-size:13px;font-family:inherit;background:var(--bg);color:var(--text)}
.mon-add input:nth-child(1){flex:2;min-width:220px}.mon-add input:nth-child(2),.mon-add input:nth-child(3){flex:1;min-width:130px}
.mon-add button{height:38px;border:none;border-radius:9px;background:#3C50E0;color:#fff;padding:0 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.mon-add button:disabled{opacity:.6}
.mon-err{color:#B02A37;font-size:12px;margin-bottom:8px}
.mon-empty{padding:30px;text-align:center;color:#94A3B8;font-size:13px}
.mon-group{margin-top:16px}
.mon-group-h{font-size:12.5px;font-weight:800;color:var(--text);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}
.mon-group-h span{color:#94A3B8;font-weight:600}
.mon-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.mon-card{background:var(--surface,#fff);border:1px solid var(--border,#E2E8F0);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}
.mon-card.down{border-color:rgba(176,42,55,.5);background:rgba(176,42,55,.05)}
.mon-card.off{opacity:.65}
.mon-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.mon-card-name{display:flex;flex-direction:column;min-width:0;text-decoration:none;color:inherit;cursor:pointer}
.mon-card-name:hover b{color:#3C50E0}
.mon-card-name b{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mon-card-name em{font-style:normal;font-size:10.5px;color:#94A3B8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mon-dot{width:11px;height:11px;border-radius:50%;flex-shrink:0;margin-top:3px}
.mon-graph{width:100%;height:64px;display:block}
.mon-graph.empty{display:flex;align-items:center;justify-content:center;font-size:10.5px;color:#94A3B8;border:1px dashed var(--border);border-radius:8px}
.mon-card-metrics{display:flex;justify-content:space-between;font-size:11.5px;font-weight:600}
.mon-card-metrics .muted{color:#94A3B8;font-weight:500}
.mon-down-since{font-size:10.5px;color:#B02A37;font-weight:600}
.mon-card-actions{display:flex;gap:6px;flex-wrap:wrap}
.mon-card-actions button,.mon-card-actions .details{flex:1;height:30px;border:1px solid var(--border);background:var(--surface-2,#F7F9FC);border-radius:7px;font-size:11px;font-weight:600;color:var(--text);cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;text-decoration:none;white-space:nowrap}
.mon-card-actions .details{flex-basis:100%;background:#EEF1FE;border-color:#C7CEF9;color:#3C50E0}
.mon-card-actions .details:hover{background:#3C50E0;color:#fff}
.mon-card-actions button.del{color:#B02A37;border-color:rgba(176,42,55,.3)}
@media (max-width:640px){ .mon-grid{grid-template-columns:1fr 1fr} .mon-add input,.mon-add button{flex:1 1 100%} }
`;
