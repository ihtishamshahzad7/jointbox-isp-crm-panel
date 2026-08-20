"use client";

/**
 * Shared CSS + micro-components for the network-device pages
 * (/monitoring/devices…, /monitoring/ports). Styling matches the panel's
 * design tokens (--surface / --border / --muted / --accent) so the new
 * screens look native in both light and dark themes.
 */
import React from "react";
import { fmtBits, fmtTime, isUp, sevColor, portState, catLabel } from "./ndm";

export const NDMCSS = `
.ndm { max-width: 1180px; margin: 0 auto; padding: 20px 16px 40px; }
.ndm-page-h { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 6px 0 16px; flex-wrap: wrap; }
.ndm-page-h h1 { font-size: 20px; font-weight: 700; margin: 0; }
.ndm-page-h p { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
.ndm-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 16px; }
.ndm-tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; box-shadow: var(--card-shadow); }
.ndm-tile b { display: block; font-size: 20px; line-height: 1.2; }
.ndm-tile span { font-size: 11px; color: var(--muted); }
.ndm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.ndm-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--card-shadow); padding: 14px; }
.ndm-card-grad { border: 0; background: var(--grad); color: #fff; }
.ndm-card-grad .ndm-card-sub { color: rgba(255,255,255,.85); }
.ndm-card-grad .ndm-name { font-weight: 700; font-size: 15px; }
.ndm-device { cursor: pointer; transition: transform .08s ease, box-shadow .08s ease; }
.ndm-device:hover { transform: translateY(-1px); box-shadow: 0 12px 18px -6px rgba(0,0,0,.14); }
.ndm-card-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.ndm-card-h b { font-size: 13px; }
.ndm-card-sub { color: var(--muted); font-size: 12px; margin: 2px 0 0; }
.ndm-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 6px; flex: none; }
.ndm-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); background: var(--surface); cursor: pointer; }
.ndm-pill:hover { border-color: var(--accent); color: var(--accent); }
.ndm-btn { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: var(--radius); padding: 6px 12px; font-size: 12.5px; cursor: pointer; }
.ndm-btn:hover { border-color: var(--accent); color: var(--accent); }
.ndm-btn.pri { background: var(--grad); color: #fff; border: 0; }
.ndm-btn.pri:hover { opacity: .92; color: #fff; }
.ndm-btn.danger { color: var(--danger); border-color: var(--danger); background: transparent; }
.ndm-btn:disabled { opacity: .5; cursor: not-allowed; }
.ndm-row-actions { display: flex; gap: 6px; }
.ndm-ports { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
.ndm-p { border: 1px solid var(--border); border-radius: var(--radius); padding: 7px 9px; background: var(--surface); cursor: pointer; transition: border-color .08s; }
.ndm-p:hover { border-color: var(--accent); }
.ndm-p.up { border-left: 3px solid var(--online); }
.ndm-p.down { border-left: 3px solid var(--danger); }
.ndm-p.disabled { border-left: 3px solid var(--border); opacity: .55; }
.ndm-p.excluded { border-left: 3px dashed var(--muted); opacity: .55; }
.ndm-p .pname { font-size: 11.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ndm-p .prate { font-size: 10.5px; color: var(--muted); }
.sev { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px; color: #fff; }
.ndm-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.ndm-tbl th { text-align: left; color: var(--muted); font-weight: 600; font-size: 11px; padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.ndm-tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.ndm-tbl tr:hover td { background: rgba(60,80,224,.03); }
.ndm-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 14px; flex-wrap: wrap; }
.ndm-tab { border: 0; background: none; padding: 8px 14px; font-size: 13px; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
.ndm-tab.on { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.ndm-empty { text-align: center; color: var(--muted); padding: 40px 10px; font-size: 13px; }
.ndm-form { display: grid; gap: 12px; }
.ndm-field label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: var(--text); }
.ndm-field input, .ndm-field select, .ndm-field textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; font-size: 13px; background: var(--surface); color: var(--text); }
.ndm-field input:focus, .ndm-field select:focus { outline: none; border-color: var(--accent); }
.ndm-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.ndm-hint { font-size: 11.5px; color: var(--muted); }
.ndm-ok { color: var(--online); font-size: 12.5px; }
.ndm-err { color: var(--danger); font-size: 12.5px; }
.ndm-modal-back { position: fixed; inset: 0; background: rgba(15,23,42,.5); z-index: 60; display: flex; align-items: center; justify-content: center; padding: 16px; }
.ndm-modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 20px 60px rgba(0,0,0,.25); width: min(680px, 100%); max-height: 90vh; overflow: auto; padding: 18px; }
.ndm-modal.wide { width: min(900px, 100%); }
.ndm-modal-h { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.ndm-modal-h h3 { margin: 0; font-size: 16px; }
.ndm-x { border: 0; background: none; font-size: 16px; cursor: pointer; color: var(--muted); }
.ndm-x:hover { color: var(--text); }
.ndm-trend { position: relative; width: 100%; height: 200px; }
.ndm-trend .tl { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.ndm-trend .tl b { font-size: 12.5px; }
.ndm-ranges { display: flex; gap: 4px; margin: 4px 0 10px; flex-wrap: wrap; }
.ndm-ranges button { border: 1px solid var(--border); background: var(--surface); color: var(--muted); font-size: 11.5px; padding: 3px 10px; border-radius: 999px; cursor: pointer; }
.ndm-ranges button.on { background: var(--grad); color: #fff; border-color: transparent; font-weight: 600; }
`;

export function NdmModal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="ndm-modal-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`ndm-modal${wide ? " wide" : ""}`}>
        <div className="ndm-modal-h"><h3>{title}</h3><button className="ndm-x" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  );
}

export function SeverityBadge({ s }: { s: string }) {
  const c = sevColor(s);
  return <span className="sev" style={{ background: c }}>{String(s || "INFO").toUpperCase()}</span>;
}

export function PortTile({ port, onToggleSound, onToggleUpSound, onToggleMonitor, onTest, onClick }: {
  port: any;
  onToggleSound?: (e: React.MouseEvent) => void;
  onToggleUpSound?: (e: React.MouseEvent) => void;
  onToggleMonitor?: (e: React.MouseEvent) => void;
  onTest?: (dir: "down" | "up") => void;
  onClick?: () => void;
}) {
  const state = portState(port);
  const monitored = port.monitoringEnabled !== false;
  const cat = catLabel(port.interfaceCategory);
  const rx = port.rxRateBps != null ? fmtBits(port.rxRateBps) : "—";
  const tx = port.txRateBps != null ? fmtBits(port.txRateBps) : "—";
  return (
    <div className={`ndm-p ${state}${monitored ? "" : " excluded"}`} onClick={onClick}
      title={`${port.name} · ${cat}${monitored ? "" : ` — NOT MONITORED (${port.excludedReason || "excluded"})`} · ${rx} ↓ / ${tx} ↑`}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
        <div className="pname">{port.name}</div>
        <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {onTest && monitored && (
            <button onClick={(e) => { e.stopPropagation(); void onTest("down"); }}
              title="TEST: drive a real PORT DOWN alert through the pipeline (event → rule → sound)"
              style={{ border: 0, background: "none", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1, color: "var(--danger)" }}>▼</button>
          )}
          {onTest && monitored && (
            <button onClick={(e) => { e.stopPropagation(); void onTest("up"); }}
              title="TEST: drive a real PORT UP / recovery chime through the pipeline"
              style={{ border: 0, background: "none", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1, color: "var(--online)" }}>▲</button>
          )}
          {onToggleUpSound && (
            <button onClick={(e) => { e.stopPropagation(); onToggleUpSound(e); }}
              title={port.soundUpEnabled !== false ? "Recovery sound ON (port UP chimes) — click to mute" : "Recovery sound OFF — click to enable UP chime"}
              style={{ border: 0, background: "none", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1, color: port.soundUpEnabled !== false ? "var(--online)" : "var(--muted)" }}>
              {port.soundUpEnabled !== false ? "▲🔔" : "▲🔕"}
            </button>
          )}
          {onToggleSound && (
            <button onClick={(e) => { e.stopPropagation(); onToggleSound(e); }}
              title={port.soundEnabled !== false ? "Sound ON — click to mute this port" : "Sound OFF — click to enable"}
              style={{ border: 0, background: "none", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1, color: port.soundEnabled !== false ? "var(--accent)" : "var(--muted)" }}>
              {port.soundEnabled !== false ? "🔔" : "🔕"}
            </button>
          )}
          {onToggleMonitor && (
            <button onClick={(e) => { e.stopPropagation(); onToggleMonitor(e); }}
              title={monitored ? "Monitored — click to exclude" : `Excluded (${cat}) — click to monitor`}
              style={{ border: 0, background: "none", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1, color: monitored ? "var(--online)" : "var(--muted)" }}>
              {monitored ? "◉" : "○"}
            </button>
          )}
        </span>
      </div>
      <div className="prate">↓ {rx} · ↑ {tx}</div>
      {!monitored && <div className="prate" style={{ color: "var(--muted)" }}>{cat} · not monitored{port.excludedReason ? ` (${port.excludedReason})` : ""}</div>}
      {monitored && <div className="prate">{cat}</div>}
      {port.errorRatePerMin != null && port.errorRatePerMin > 0 && <div className="prate" style={{ color: "var(--danger)" }}>{Math.round(port.errorRatePerMin)} err/min</div>}
    </div>
  );
}

export function Stat({ label, value, color, sub }: { label: string; value: any; color?: string; sub?: string }) {
  return (
    <div className="ndm-tile">
      <b style={color ? { color } : undefined}>{value}</b>
      <span>{label}</span>
      {sub && <div className="ndm-card-sub">{sub}</div>}
    </div>
  );
}

/** Mini dual-line traffic area chart (plain SVG — no chart lib needed). */
export function TrafficChart({ points, height = 190 }: { points: { at: string; rxRateBps: number; txRateBps: number }[]; height?: number }) {
  const W = 760, HH = height, pad = 30;
  const [hover, setHover] = React.useState<number | null>(null);
  if (!points || points.length < 2) return <div className="ndm-empty">Not enough data yet — samples appear as the poller runs.</div>;
  const max = Math.max(1, ...points.map((p) => Math.max(p.rxRateBps, p.txRateBps)));
  const stepX = (W - pad * 2) / (points.length - 1);
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => pad + (1 - v / max) * (HH - pad * 2);
  const line = (k: "rxRateBps" | "txRateBps") => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  const rx = line("rxRateBps"), tx = line("txRateBps");
  const tick = (n: number) => Math.round(n / Math.pow(10, Math.floor(Math.log10(n)))) * Math.pow(10, Math.floor(Math.log10(n)));
  const tMax = tick(max * 1.1);
  const h = hover != null ? points[hover] : null;
  return (
    <div className="ndm-trend" style={{ height: HH }}>
      {h && (
        <div className="tl">
          <b>{new Date(h.at).toLocaleString()}</b>
          <span className="ndm-card-sub">RX {fmtBits(h.rxRateBps)} · TX {fmtBits(h.txRateBps)}</span>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${HH}`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0 }}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left) / r.width) * W - pad) / stepX;
          setHover(i >= 0 && i < points.length ? Math.round(i) : null);
        }}
        onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="ndm-rx" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3C50E0" stopOpacity="0.25" /><stop offset="100%" stopColor="#3C50E0" stopOpacity="0" /></linearGradient>
          <linearGradient id="ndm-tx" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22c55e" stopOpacity="0.2" /><stop offset="100%" stopColor="#22c55e" stopOpacity="0" /></linearGradient>
        </defs>
        {[0, 0.5, 1].map((f, i) => (
          <g key={i}>
            <line x1={pad} x2={W - pad} y1={pad + f * (HH - pad * 2)} y2={pad + f * (HH - pad * 2)} stroke="var(--border)" strokeWidth="0.5" />
            <text x={2} y={pad + f * (HH - pad * 2) + 3} fontSize="9" fill="var(--muted)">{fmtBits(tMax * (1 - f))}</text>
          </g>
        ))}
        <path d={`${rx} L${x(points.length - 1)},${HH - pad} L${x(0)},${HH - pad} Z`} fill="url(#ndm-rx)" stroke="none" />
        <path d={`${tx} L${x(points.length - 1)},${HH - pad} L${x(0)},${HH - pad} Z`} fill="url(#ndm-tx)" stroke="none" />
        <path d={rx} fill="none" stroke="#3C50E0" strokeWidth="1.7" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <path d={tx} fill="none" stroke="#22c55e" strokeWidth="1.7" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {h && <line x1={x(hover!)} x2={x(hover!)} y1={pad} y2={HH - pad} stroke="var(--accent)" strokeWidth="0.8" />}
      </svg>
      <div style={{ display: "flex", gap: 14, marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
        <span><span style={{ color: "#3C50E0" }}>■</span> RX</span>
        <span><span style={{ color: "#22c55e" }}>■</span> TX</span>
      </div>
    </div>
  );
}

/** Up/down state strip (like the ping detail page's availability bar). */
export function UpStrip({ statuses, height = 46 }: { statuses: { at: string; toStatus: string }[]; height?: number }) {
  if (!statuses || !statuses.length) return <div className="ndm-empty">No state changes yet in this range.</div>;
  const W = 760, HH = height, pad = 4;
  const t0 = new Date(statuses[0].at).getTime();
  const t1 = new Date(statuses[statuses.length - 1].at).getTime();
  const span = Math.max(t1 - t0, 1);
  let d = "";
  statuses.forEach((s, i) => {
    const x0 = pad + ((new Date(s.at).getTime() - t0) / span) * (W - pad * 2);
    const x1 = i + 1 < statuses.length ? pad + ((new Date(statuses[i + 1].at).getTime() - t0) / span) * (W - pad * 2) : W - pad;
    const up = s.toStatus.toUpperCase() === "UP";
    d += `<rect x="${x0}" y="${pad}" width="${Math.max(x1 - x0 - 1, 1)}" height="${HH - pad * 2}" fill="${up ? "#219653" : "#D34053"}" rx="2"/>`;
  });
  return (
    <svg viewBox={`0 0 ${W} ${HH}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
      <g dangerouslySetInnerHTML={{ __html: d }} />
    </svg>
  );
}

export function useNdmRefresh<T>(loader: () => Promise<T>, setter: (t: T) => void, deps: any[], ms = 15000) {
  React.useEffect(() => {
    let alive = true;
    const run = async () => { try { if (alive) setter(await loader()); } catch { /* keep last */ } };
    run();
    const id = setInterval(run, ms);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function isUpStatus(p: any) { return isUp(p); }