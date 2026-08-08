"use client";

import React from "react";
import API from "../components/api";

/** MRTG-style traffic graph + VLAN breakdown for one NAS. */
const RANGES = [
  { id: "1h", label: "1h" }, { id: "6h", label: "6h" },
  { id: "7d", label: "7 days" }, { id: "30d", label: "30 days" },
];

const bps = (n: number) => {
  if (!n || n < 0) return "0";
  const u = ["bps", "Kbps", "Mbps", "Gbps"]; let i = 0; let v = n;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
};
const bytes = (n: number) => {
  if (!n) return "0 B"; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
};

export function NasTraffic({ nasId }: { nasId: number }) {
  const [range, setRange] = React.useState("7d");
  const [data, setData] = React.useState<any>(null);
  const [vlans, setVlans] = React.useState<any[]>([]);
  const [links, setLinks] = React.useState<any[]>([]);
  const [uptime, setUptime] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const h = { Authorization: `Bearer ${token}` };

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    const days = range === "30d" ? 30 : range === "7d" ? 7 : 1;
    Promise.all([
      fetch(`${API}/telemetry/nas/${nasId}/traffic?range=${range}`, { headers: h }).then((r) => r.ok ? r.json() : null),
      fetch(`${API}/telemetry/nas/${nasId}/vlans`, { headers: h }).then((r) => r.ok ? r.json() : null),
      fetch(`${API}/telemetry/nas/${nasId}/signals`, { headers: h }).then((r) => r.ok ? r.json() : null),
      fetch(`${API}/telemetry/nas/${nasId}/uptime?days=${days}`, { headers: h }).then((r) => r.ok ? r.json() : null),
    ]).then(([t, v, s, u]) => { if (!alive) return; setData(t); setVlans(v?.vlans || []); setLinks(s?.links || []); setUptime(u); setLoading(false); })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [nasId, range]);

  const pts: any[] = data?.points || [];
  const W = 560, H = 150, pad = 4;
  const max = Math.max(data?.peakIn || 0, data?.peakOut || 0, 1);
  const path = (key: "inBps" | "outBps") => {
    if (pts.length < 2) return "";
    const step = (W - pad * 2) / (pts.length - 1);
    const y = (v: number) => H - pad - (Math.max(0, v) / max) * (H - pad * 2);
    const top = pts.map((p, i) => `${i === 0 ? "M" : "L"}${(pad + i * step).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
    return `${top} L${(pad + (pts.length - 1) * step).toFixed(1)},${H - pad} L${pad},${H - pad} Z`;
  };

  return (
    <div className="nt-traf">
      <style>{CSS}</style>
      <div className="nt-head">
        <span className="nt-title">📈 Traffic</span>
        <span className="nt-legend"><i className="dl" /> Download <i className="ul" /> Upload</span>
        <div className="nt-ranges">
          {RANGES.map((r) => (
            <button key={r.id} className={range === r.id ? "on" : ""} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="nt-empty">Loading…</div>
      ) : pts.length < 2 ? (
        <div className="nt-empty">Not enough samples yet — traffic is sampled every 5 minutes. Check back shortly.</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="nt-svg" preserveAspectRatio="none">
            <path d={path("inBps")} className="area-dl" />
            <path d={path("outBps")} className="area-ul" />
          </svg>
          <div className="nt-peaks">
            <span>Peak ↓ <b>{bps(data.peakIn)}</b></span>
            <span>Peak ↑ <b>{bps(data.peakOut)}</b></span>
            <span>Now online <b>{pts[pts.length - 1]?.online ?? 0}</b></span>
            {uptime && (
              <span>Uptime <b style={{ color: uptime.uptimePercent >= 99 ? "#4ade80" : uptime.uptimePercent >= 95 ? "#ff9800" : "#f87171" }}>
                {uptime.uptimePercent}%</b>{uptime.downMinutes ? ` · ${uptime.downMinutes}m down` : ""}</span>
            )}
          </div>
        </>
      )}

      <div className="nt-vlan-h">VLAN breakdown (live)</div>
      {vlans.length === 0 ? (
        <div className="nt-empty sm">No active sessions grouped by VLAN.</div>
      ) : (
        <div className="nt-vlans">
          {vlans.map((v) => (
            <div key={v.vlan} className="nt-vlan">
              <span className="v-name">{v.vlan === "-" ? "(no VLAN)" : v.vlan}</span>
              <span className="v-on">{v.online} online</span>
              <span className="v-b">↓ {bytes(v.inBytes)} · ↑ {bytes(v.outBytes)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="nt-vlan-h">Links up/down &amp; optical signal</div>
      {links.length === 0 ? (
        <div className="nt-empty sm">No ONU/link telemetry for this NAS (needs SNMP-enabled OLT/ONU).</div>
      ) : (
        <div className="nt-links">
          <div className="nt-links-sum">
            {links.filter((l) => l.up).length} up · <span className="dn">{links.filter((l) => !l.up).length} down</span>
          </div>
          {links.slice(0, 200).map((l) => (
            <div key={l.onuId} className={`nt-link q-${l.quality}`}>
              <span className={`ld ${l.up ? "up" : "dn"}`} />
              <span className="l-name">{l.name}</span>
              <span className="l-st">{l.status}</span>
              <span className="l-sig">{l.rxPowerDbm != null ? `${l.rxPowerDbm.toFixed(1)} dBm` : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CSS = `
.nt-traf{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-top:12px}
.nt-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.nt-title{font-weight:800;font-size:13px}
.nt-legend{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:6px}
.nt-legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.nt-legend .dl{background:#4a9eff}.nt-legend .ul{background:#4ade80}
.nt-ranges{margin-left:auto;display:flex;gap:4px}
.nt-ranges button{background:var(--surface);border:1px solid var(--border);color:var(--muted);
  border-radius:6px;padding:3px 9px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit}
.nt-ranges button.on{border-color:var(--accent);color:var(--accent)}
.nt-svg{width:100%;height:150px;display:block;background:var(--bg);border-radius:8px}
.area-dl{fill:rgba(74,158,255,.25);stroke:#4a9eff;stroke-width:1.2}
.area-ul{fill:rgba(74,222,128,.18);stroke:#4ade80;stroke-width:1.2}
.nt-peaks{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-top:8px}
.nt-peaks b{color:var(--text)}
.nt-empty{padding:24px;text-align:center;color:var(--muted);font-size:12px}
.nt-empty.sm{padding:12px}
.nt-vlan-h{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:14px 0 8px}
.nt-vlans{display:grid;gap:6px}
.nt-vlan{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);
  border-radius:8px;padding:7px 11px;font-size:12px}
.v-name{font-family:ui-monospace,monospace;font-weight:700;color:#7cc0ff;min-width:120px}
.v-on{color:#4ade80;font-weight:700}
.v-b{margin-left:auto;color:var(--muted);font-size:11px}
.nt-links-sum{font-size:11.5px;color:var(--muted);margin-bottom:8px}
.nt-links-sum .dn{color:#f87171;font-weight:700}
.nt-links{display:grid;gap:5px;max-height:260px;overflow:auto}
.nt-link{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);
  border-radius:8px;padding:6px 11px;font-size:12px;border-left-width:3px}
.nt-link.q-good{border-left-color:#4ade80}
.nt-link.q-warn{border-left-color:#ff9800}
.nt-link.q-critical{border-left-color:#f44336}
.nt-link.q-unknown{border-left-color:var(--border)}
.nt-link .ld{width:8px;height:8px;border-radius:50%;flex:none}
.nt-link .ld.up{background:#4ade80;box-shadow:0 0 6px rgba(74,222,128,.8)}
.nt-link .ld.dn{background:#f87171;box-shadow:0 0 6px rgba(248,113,113,.8)}
.nt-link .l-name{font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nt-link .l-st{margin-left:auto;font-size:10.5px;color:var(--muted);text-transform:uppercase}
.nt-link .l-sig{min-width:74px;text-align:right;font-family:ui-monospace,monospace;font-size:11px;color:var(--text)}
`;
