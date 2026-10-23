"use client";

/**
 * Per-interface traffic — a multi-series area chart over the real SNMP
 * interface history (telemetry/nas/:id/interfaces + .../:ifIndex/history).
 * Legend checkboxes toggle interfaces; download = blue, upload = green,
 * gradient fill, dashed Mbps/Gbps grid. Nothing is fabricated — an interface
 * with no samples simply shows an empty state.
 */
import React from "react";
import API from "../../components/api";

type Iface = { ifIndex: number; name: string; up: boolean; rxBps: number; txBps: number; speedMbps: number | null };
type Pt = { t: string; rx: number; tx: number };
type Hist = { points: Pt[]; stats: { rxCurrent: number; txCurrent: number; rxAvg: number; txAvg: number; rxPeak: number; txPeak: number } };

const RANGES = ["1h", "6h", "24h", "7d"] as const;
const DL = "#2F6FED"; // download / RX — blue
const UL = "#16A34A"; // upload / TX — green

function fmtBps(v: number) {
  if (!v || v < 0) return "0 bps";
  const u = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let i = 0, x = v;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${u[i]}`;
}
function fmtBytes(v: number) {
  if (!v || v < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${u[i]}`;
}
/** "nice" top-of-axis so gridlines land on round Mbps/Gbps values. */
function niceMax(v: number) {
  if (v <= 0) return 1e6; // 1 Mbps floor so an idle port still has a scale
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}
const rangeSeconds: Record<string, number> = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800 };

export function InterfaceTraffic({ nasId }: { nasId: number }) {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = React.useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [ifaces, setIfaces] = React.useState<Iface[] | null>(null);
  const [range, setRange] = React.useState<(typeof RANGES)[number]>("1h");
  const [sel, setSel] = React.useState<Set<number>>(new Set());
  const [hist, setHist] = React.useState<Record<number, Hist>>({});
  const [err, setErr] = React.useState<string | null>(null);

  // interface list
  React.useEffect(() => {
    let alive = true;
    fetch(`${API}/telemetry/nas/${nasId}/interfaces`, { headers: H })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((list: Iface[]) => {
        if (!alive) return;
        const arr = Array.isArray(list) ? list : [];
        setIfaces(arr);
        // default-select the busiest up interface so the chart isn't empty.
        const busiest = [...arr].filter((i) => i.up).sort((a, b) => (b.rxBps + b.txBps) - (a.rxBps + a.txBps))[0];
        setSel(new Set(busiest ? [busiest.ifIndex] : arr.slice(0, 1).map((i) => i.ifIndex)));
      })
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [nasId, H]);

  // history for selected interfaces
  React.useEffect(() => {
    let alive = true;
    const want = [...sel];
    Promise.all(want.map((ix) =>
      fetch(`${API}/telemetry/nas/${nasId}/interfaces/${ix}/history?range=${range}`, { headers: H })
        .then((r) => (r.ok ? r.json() : null)).then((d) => [ix, d] as const).catch(() => [ix, null] as const),
    )).then((pairs) => {
      if (!alive) return;
      const next: Record<number, Hist> = {};
      for (const [ix, d] of pairs) if (d && Array.isArray(d.points)) next[ix] = d;
      setHist(next);
    });
    return () => { alive = false; };
  }, [sel, range, nasId, H]);

  const toggle = (ix: number) => setSel((p) => { const s = new Set(p); s.has(ix) ? s.delete(ix) : s.add(ix); return s; });

  // ── chart geometry ──
  const W = 760, Ht = 240, padL = 54, padR = 14, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = Ht - padT - padB;
  const selList = (ifaces || []).filter((i) => sel.has(i.ifIndex));
  const allPts = selList.flatMap((i) => hist[i.ifIndex]?.points || []);
  const maxV = niceMax(Math.max(1, ...allPts.map((p) => Math.max(p.rx, p.tx))));
  const tMin = allPts.length ? Math.min(...allPts.map((p) => +new Date(p.t))) : 0;
  const tMax = allPts.length ? Math.max(...allPts.map((p) => +new Date(p.t))) : 1;
  const x = (t: number) => padL + (tMax === tMin ? iw : ((t - tMin) / (tMax - tMin)) * iw);
  const y = (v: number) => padT + ih - (v / maxV) * ih;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxV);

  const areaLine = (pts: Pt[], key: "rx" | "tx") => {
    if (pts.length < 2) return { line: "", area: "" };
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(+new Date(p.t)).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
    const area = `${line}L${x(+new Date(pts[pts.length - 1].t)).toFixed(1)},${(padT + ih).toFixed(1)}L${x(+new Date(pts[0].t)).toFixed(1)},${(padT + ih).toFixed(1)}Z`;
    return { line, area };
  };

  return (
    <div className="itf">
      <style>{CSS}</style>
      <div className="itf-head">
        <div>
          <h3>Interface traffic</h3>
          <span className="itf-sub">Per-port SNMP history · <b style={{ color: DL }}>download</b> / <b style={{ color: UL }}>upload</b></span>
        </div>
        <div className="itf-ranges">
          {RANGES.map((r) => (
            <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
      </div>

      {err && <div className="itf-empty">Couldn’t load interface data ({err}).</div>}
      {!err && ifaces && ifaces.length === 0 && (
        <div className="itf-empty">No interface samples yet. Enable SNMP polling on this NAS; data is collected every few minutes.</div>
      )}

      {ifaces && ifaces.length > 0 && (
        <>
          {/* legend with checkboxes */}
          <div className="itf-legend">
            {ifaces.map((i) => (
              <label key={i.ifIndex} className={`itf-leg${sel.has(i.ifIndex) ? " on" : ""}`}>
                <input type="checkbox" checked={sel.has(i.ifIndex)} onChange={() => toggle(i.ifIndex)} />
                <span className={`itf-dot ${i.up ? "up" : "down"}`} />
                <b>{i.name}</b>
                <span className="itf-leg-rate">↓{fmtBps(i.rxBps)} ↑{fmtBps(i.txBps)}</span>
              </label>
            ))}
          </div>

          {/* chart */}
          <div className="itf-chartwrap">
            {allPts.length < 2 ? (
              <div className="itf-empty">Not enough samples for the selected interface(s) in this range yet.</div>
            ) : (
              <svg viewBox={`0 0 ${W} ${Ht}`} className="itf-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Interface traffic chart">
                <defs>
                  <linearGradient id="itf-dl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={DL} stopOpacity="0.28" /><stop offset="100%" stopColor={DL} stopOpacity="0.02" />
                  </linearGradient>
                  <linearGradient id="itf-ul" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={UL} stopOpacity="0.26" /><stop offset="100%" stopColor={UL} stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                {/* dashed Y grid + labels */}
                {yTicks.map((v, i) => (
                  <g key={i}>
                    <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke="currentColor" strokeOpacity="0.14" strokeDasharray="4 4" />
                    <text x={padL - 8} y={y(v) + 3} textAnchor="end" className="itf-axis">{fmtBps(v)}</text>
                  </g>
                ))}
                {/* one blue(RX)+green(TX) pair per selected interface */}
                {selList.map((i) => {
                  const pts = hist[i.ifIndex]?.points || [];
                  const rx = areaLine(pts, "rx"), tx = areaLine(pts, "tx");
                  return (
                    <g key={i.ifIndex}>
                      <path d={rx.area} fill="url(#itf-dl)" />
                      <path d={rx.line} fill="none" stroke={DL} strokeWidth={1.6} strokeOpacity={0.9} />
                      <path d={tx.area} fill="url(#itf-ul)" />
                      <path d={tx.line} fill="none" stroke={UL} strokeWidth={1.6} strokeOpacity={0.9} />
                    </g>
                  );
                })}
              </svg>
            )}
          </div>

          {/* Port Summary */}
          <table className="itf-table">
            <thead><tr><th>Interface</th><th>Current ↓ / ↑</th><th>Peak ↓ / ↑</th><th>≈ Total ({range})</th><th>Link</th></tr></thead>
            <tbody>
              {ifaces.map((i) => {
                const h = hist[i.ifIndex]?.stats;
                const secs = rangeSeconds[range] || 3600;
                // Approx total = avg rate × window (derived, marked ≈). Only shown
                // when we have history for this interface; otherwise a dash.
                const totRx = h ? (h.rxAvg / 8) * secs : null;
                const totTx = h ? (h.txAvg / 8) * secs : null;
                return (
                  <tr key={i.ifIndex} className={sel.has(i.ifIndex) ? "sel" : ""} onClick={() => toggle(i.ifIndex)}>
                    <td><span className={`itf-dot ${i.up ? "up" : "down"}`} /><b>{i.name}</b></td>
                    <td className="mono">{fmtBps(i.rxBps)} / {fmtBps(i.txBps)}</td>
                    <td className="mono">{h ? `${fmtBps(h.rxPeak)} / ${fmtBps(h.txPeak)}` : "—"}</td>
                    <td className="mono">{totRx != null ? `${fmtBytes(totRx)} / ${fmtBytes(totTx!)}` : "—"}</td>
                    <td>{i.speedMbps ? `${i.speedMbps >= 1000 ? i.speedMbps / 1000 + "G" : i.speedMbps + "M"}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const CSS = `
.itf{color:var(--text,#111827)}
.itf-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
.itf-head h3{margin:0;font-size:14px;font-weight:800}
.itf-sub{font-size:12px;color:var(--muted,#6B7280)}
.itf-ranges{display:flex;gap:4px}
.itf-ranges button{border:1px solid var(--border,#E2E6EC);background:var(--surface,#fff);color:var(--muted,#6B7280);border-radius:8px;padding:4px 11px;font-size:12px;font-weight:700;cursor:pointer}
.itf-ranges button.on{background:#2F6FED;border-color:#2F6FED;color:#fff}
.itf-legend{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.itf-leg{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border,#E6E9EF);border-radius:999px;padding:4px 11px;font-size:12px;cursor:pointer;background:var(--surface,#fff);transition:border-color .12s}
.itf-leg.on{border-color:#2F6FED66}
.itf-leg input{accent-color:#2F6FED;cursor:pointer;margin:0}
.itf-leg b{font-weight:700;color:var(--text,#111827)}
.itf-leg-rate{color:var(--muted,#6B7280);font-size:11px}
.itf-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#9aa3af}
.itf-dot.up{background:#16a34a}.itf-dot.down{background:#e5484d}
.itf-chartwrap{background:var(--surface,#fff);border:1px solid var(--border,#EAEDF1);border-radius:12px;padding:10px;margin-bottom:14px}
.itf-svg{width:100%;height:auto;display:block;color:var(--text,#374151)}
.itf-axis{font-size:10px;fill:var(--muted,#9aa3af)}
.itf-empty{padding:26px 14px;text-align:center;color:var(--muted,#6B7280);font-size:13px}
.itf-table{width:100%;border-collapse:collapse;font-size:12.5px}
.itf-table th{text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#9aa3af);padding:6px 10px;border-bottom:1px solid var(--border,#EAEDF1)}
.itf-table td{padding:8px 10px;border-bottom:1px solid var(--border,#F0F2F5)}
.itf-table tr{cursor:pointer}
.itf-table tr.sel{background:rgba(47,111,237,.05)}
.itf-table td b{font-weight:700}
.itf-table .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
`;

export default InterfaceTraffic;
