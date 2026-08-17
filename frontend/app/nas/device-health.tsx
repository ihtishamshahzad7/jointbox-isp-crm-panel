"use client";

import React from "react";
import API from "../components/api";

/**
 * Device Health — real historical graphs from the SNMP collector.
 *
 * Every point here is a stored measurement, never a live single value dressed
 * up as a series. Long ranges are aggregated server-side (5-minute, hourly,
 * daily buckets) so a year of data is a couple of hundred points, not a million.
 * When a device has not been polled yet the panel says "Collecting data…"
 * rather than drawing an empty axis.
 */
const RANGES = ["5m", "15m", "1h", "6h", "24h", "7d", "30d", "90d", "1y"] as const;
type Range = (typeof RANGES)[number];
type Point = { t: string; v: number };
type Stat = { current: number | null; min: number; avg: number; max: number };

export function DeviceHealth({ nasId, nasName }: { nasId: number; nasName?: string }) {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const [range, setRange] = React.useState<Range>("1h");
  const [series, setSeries] = React.useState<Record<string, Point[]>>({});
  const [stats, setStats] = React.useState<Record<string, Stat>>({});
  const [ifaces, setIfaces] = React.useState<any[]>([]);
  const [openIf, setOpenIf] = React.useState<number | null>(null);
  const [ifHist, setIfHist] = React.useState<any>(null);
  const [testing, setTesting] = React.useState(false);
  const [test, setTest] = React.useState<any>(null);
  const [loaded, setLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [h, i] = await Promise.all([
        fetch(`${API}/telemetry/nas/${nasId}/health-history?range=${range}`, { headers: H }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API}/telemetry/nas/${nasId}/interfaces`, { headers: H }).then((r) => (r.ok ? r.json() : [])),
      ]);
      if (h) { setSeries(h.series || {}); setStats(h.stats || {}); }
      setIfaces(Array.isArray(i) ? i : []);
    } catch { /* keep what we have */ }
    setLoaded(true);
  }, [nasId, range]);

  React.useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  React.useEffect(() => {
    if (openIf == null) { setIfHist(null); return; }
    fetch(`${API}/telemetry/nas/${nasId}/interfaces/${openIf}/history?range=${range}`, { headers: H })
      .then((r) => (r.ok ? r.json() : null)).then(setIfHist).catch(() => setIfHist(null));
  }, [openIf, nasId, range]);

  const runTest = async () => {
    setTesting(true); setTest(null);
    try {
      const r = await fetch(`${API}/telemetry/nas/${nasId}/snmp-test`, { method: "POST", headers: H });
      setTest(await r.json());
    } catch (e: any) { setTest({ ok: false, error: e?.message || "Test failed" }); }
    finally { setTesting(false); }
  };

  const has = (k: string) => (series[k]?.length ?? 0) > 1;

  return (
    <div className="dh">
      <style>{CSS}</style>

      <div className="dh-bar">
        <div className="dh-ranges">
          {RANGES.map((r) => (
            <button key={r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
        <button className="dh-test" onClick={runTest} disabled={testing}>{testing ? "Testing…" : "Test SNMP"}</button>
      </div>

      {test && (
        <div className={`dh-test-out ${test.ok ? "ok" : "bad"}`}>
          {test.ok ? (
            <>
              <b>✓ SNMP connection successful</b>
              <div className="grid">
                <span>Target</span><b>{test.target}</b>
                <span>Version</span><b>{test.version}</b>
                <span>Response</span><b>{test.responseMs} ms</b>
                <span>Uptime</span><b>{test.uptimeText}</b>
                <span>Interfaces</span><b>{test.interfaces}</b>
                {test.cpu != null && (<><span>CPU</span><b>{test.cpu}%</b></>)}
                {test.memory != null && (<><span>Memory</span><b>{test.memory}%</b></>)}
              </div>
              {test.sysDescr && <div className="descr">{test.sysDescr}</div>}
              {test.note && <div className="descr">{test.note}</div>}
            </>
          ) : (
            <>
              <b>✕ SNMP connection failed</b>
              <div className="descr">{test.error} {test.target ? `— ${test.target}` : ""}</div>
              {test.check && <ul>{test.check.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>}
            </>
          )}
        </div>
      )}

      {!loaded ? <div className="dh-empty">Loading…</div> : (
        <>
          <div className="dh-charts">
            <Chart title="CPU" unit="%" points={series.cpu} stat={stats.cpu} color="#8b5cf6" max={100} />
            <Chart title="Memory" unit="%" points={series.memory} stat={stats.memory} color="#f59e0b" max={100} />
            {has("temperature") && <Chart title="Temperature" unit="°C" points={series.temperature} stat={stats.temperature} color="#ef4444" />}
            <Chart title="SNMP response" unit="ms" points={series.snmpMs} stat={stats.snmpMs} color="#0ea5e9" />
          </div>

          <div className="dh-sec">Interfaces {ifaces.length ? `(${ifaces.length})` : ""}</div>
          {ifaces.length === 0 ? (
            <div className="dh-empty">
              No interface samples yet. Enable SNMP on this device — the collector stores a sample every 30 seconds and graphs appear as data arrives.
            </div>
          ) : (
            <div className="dh-if">
              <div className="dh-if-h"><span>Interface</span><span>Status</span><span>RX</span><span>TX</span><span>Errors</span><span>Speed</span></div>
              {ifaces.map((f) => (
                <React.Fragment key={f.ifIndex}>
                  <div className="dh-if-r" onClick={() => setOpenIf(openIf === f.ifIndex ? null : f.ifIndex)}>
                    <span className="nm">{f.name}<em>#{f.ifIndex}</em></span>
                    <span className={f.up ? "up" : "down"}>{f.up ? "UP" : "DOWN"}</span>
                    <span>{bps(f.rxBps)}</span>
                    <span>{bps(f.txBps)}</span>
                    <span className={f.inErrors + f.outErrors > 0 ? "warn" : ""}>{Math.round(f.inErrors + f.outErrors)}/s</span>
                    <span className="dim">{f.speedMbps ? `${f.speedMbps} Mbps` : "—"}</span>
                  </div>
                  {openIf === f.ifIndex && (
                    <div className="dh-if-graph">
                      {!ifHist || ifHist.points.length < 2 ? (
                        <div className="dh-empty small">Collecting data… traffic history appears after a few polls.</div>
                      ) : (
                        <>
                          <div className="dh-if-stats">
                            <span>RX now <b>{bps(ifHist.stats.rxCurrent)}</b></span>
                            <span>TX now <b>{bps(ifHist.stats.txCurrent)}</b></span>
                            <span>RX avg <b>{bps(ifHist.stats.rxAvg)}</b></span>
                            <span>TX avg <b>{bps(ifHist.stats.txAvg)}</b></span>
                            <span>RX peak <b>{bps(ifHist.stats.rxPeak)}</b></span>
                            <span>TX peak <b>{bps(ifHist.stats.txPeak)}</b></span>
                          </div>
                          <TrafficChart points={ifHist.points} />
                        </>
                      )}
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** bits/s → human units, as the spec requires (bps → Kbps → Mbps → Gbps). */
function bps(v: number) {
  const n = Number(v) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} Kbps`;
  return `${Math.round(n)} bps`;
}

/** Single-metric line chart, scaled to the data range with a hover tooltip. */
function Chart({ title, unit, points, stat, color, max }:
  { title: string; unit: string; points?: Point[]; stat?: Stat; color: string; max?: number }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const pts = points || [];
  if (pts.length < 2) {
    return (
      <div className="dh-card">
        <div className="dh-card-h">{title}</div>
        <div className="dh-empty small">Collecting data…</div>
      </div>
    );
  }
  const W = 460, HH = 130, pad = 24, padT = 10;
  const vals = pts.map((p) => p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, 1);
  const yMin = max != null ? 0 : Math.max(0, lo - span * 0.2);
  const yMax = max != null ? Math.max(max, hi) : hi + span * 0.2;
  const stepX = (W - pad - 6) / (pts.length - 1);
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * (HH - padT - 18);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${HH - 18} L${x(0).toFixed(1)},${HH - 18} Z`;
  const gid = `g${title.replace(/\W/g, "")}`;

  return (
    <div className="dh-card">
      <div className="dh-card-h">
        {title}
        <span className="dh-card-now">{stat?.current != null ? `${stat.current}${unit}` : "—"}</span>
      </div>
      <div className="dh-card-stats">
        <span>min <b>{stat?.min ?? 0}{unit}</b></span>
        <span>avg <b>{stat?.avg ?? 0}{unit}</b></span>
        <span>max <b>{stat?.max ?? 0}{unit}</b></span>
      </div>
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${HH}`} className="dh-svg" preserveAspectRatio="none"
          onMouseMove={(e) => { const r = (e.currentTarget as SVGElement).getBoundingClientRect(); const i = Math.round((((e.clientX - r.left) / r.width) * W - pad) / stepX); setHover(i >= 0 && i < pts.length ? i : null); }}
          onMouseLeave={() => setHover(null)}>
          <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" /><stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient></defs>
          {[0, 0.5, 1].map((f, i) => {
            const yy = padT + f * (HH - padT - 18);
            return <g key={i}><line x1={pad} x2={W - 6} y1={yy} y2={yy} stroke="var(--border,#E2E8F0)" strokeWidth="0.5" />
              <text x={2} y={yy + 3} fontSize="8" fill="#94A3B8">{Math.round(yMax - f * (yMax - yMin))}</text></g>;
          })}
          <path d={area} fill={`url(#${gid})`} />
          <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={HH - 18} stroke="#3C50E0" strokeWidth="0.7" />}
        </svg>
        {hover != null && pts[hover] && (
          <div className="dh-tip">{new Date(pts[hover].t).toLocaleString()}<br />{pts[hover].v}{unit}</div>
        )}
      </div>
    </div>
  );
}

/** RX/TX dual-series traffic chart. */
function TrafficChart({ points }: { points: any[] }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const W = 900, HH = 160, pad = 44, padT = 10;
  const all = points.flatMap((p) => [p.rx, p.tx]);
  const hi = Math.max(...all, 1);
  const stepX = (W - pad - 8) / (points.length - 1);
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => padT + (1 - v / (hi * 1.15)) * (HH - padT - 18);
  const path = (k: "rx" | "tx") => points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  return (
    <div style={{ position: "relative" }}>
      <div className="dh-legend"><span className="rx">RX</span><span className="tx">TX</span></div>
      <svg viewBox={`0 0 ${W} ${HH}`} className="dh-svg tall" preserveAspectRatio="none"
        onMouseMove={(e) => { const r = (e.currentTarget as SVGElement).getBoundingClientRect(); const i = Math.round((((e.clientX - r.left) / r.width) * W - pad) / stepX); setHover(i >= 0 && i < points.length ? i : null); }}
        onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f, i) => {
          const yy = padT + f * (HH - padT - 18);
          return <g key={i}><line x1={pad} x2={W - 8} y1={yy} y2={yy} stroke="var(--border,#E2E8F0)" strokeWidth="0.5" />
            <text x={2} y={yy + 3} fontSize="8" fill="#94A3B8">{bps(hi * 1.15 * (1 - f))}</text></g>;
        })}
        <path d={path("rx")} fill="none" stroke="#22c55e" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        <path d={path("tx")} fill="none" stroke="#3b82f6" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={HH - 18} stroke="#3C50E0" strokeWidth="0.7" />}
      </svg>
      {hover != null && points[hover] && (
        <div className="dh-tip">{new Date(points[hover].t).toLocaleString()}<br />RX {bps(points[hover].rx)}<br />TX {bps(points[hover].tx)}</div>
      )}
    </div>
  );
}

const CSS = `
.dh{color:var(--text)}
.dh-bar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.dh-ranges{display:inline-flex;background:var(--surface-2,#F1F5F9);border-radius:8px;padding:3px;flex-wrap:wrap}
.dh-ranges button{border:none;background:transparent;padding:5px 11px;border-radius:6px;font-size:11.5px;font-weight:600;color:var(--muted,#64748B);cursor:pointer;font-family:inherit}
.dh-ranges button.on{background:#3C50E0;color:#fff}
.dh-test{border:1px solid #C7CEF9;background:#EEF1FE;color:#3C50E0;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.dh-test-out{border-radius:9px;padding:11px 13px;font-size:12px;margin-bottom:12px;line-height:1.7}
.dh-test-out.ok{background:rgba(21,127,67,.08);border:1px solid rgba(21,127,67,.35);color:#157F43}
.dh-test-out.bad{background:rgba(176,42,55,.08);border:1px solid rgba(176,42,55,.35);color:#B02A37}
.dh-test-out .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:2px 10px;margin-top:6px;color:var(--text)}
.dh-test-out .grid span{color:var(--muted,#64748B)}
.dh-test-out .descr{color:var(--muted,#64748B);margin-top:6px;font-size:11px}
.dh-test-out ul{margin:6px 0 0 16px;color:var(--muted,#64748B);font-size:11.5px}
.dh-charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px}
.dh-card{background:var(--surface,#fff);border:1px solid var(--border,#E2E8F0);border-radius:10px;padding:10px 12px}
.dh-card-h{display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:700;color:var(--muted,#64748B);text-transform:uppercase;letter-spacing:.03em}
.dh-card-now{font-size:16px;color:var(--text);font-weight:800;text-transform:none}
.dh-card-stats{display:flex;gap:12px;font-size:10.5px;color:#94A3B8;margin:2px 0 4px}
.dh-card-stats b{color:var(--text)}
.dh-svg{width:100%;height:130px;display:block}
.dh-svg.tall{height:170px}
.dh-tip{position:absolute;top:2px;right:2px;background:rgba(15,20,30,.92);color:#fff;font-size:10.5px;padding:5px 8px;border-radius:6px;pointer-events:none;line-height:1.5}
.dh-sec{font-size:12px;font-weight:700;margin:16px 0 8px;color:var(--text)}
.dh-empty{padding:22px;text-align:center;color:#94A3B8;font-size:12.5px;border:1px dashed var(--border,#E2E8F0);border-radius:9px}
.dh-empty.small{padding:14px;font-size:11.5px}
.dh-if{border:1px solid var(--border,#E2E8F0);border-radius:10px;overflow:hidden}
.dh-if-h,.dh-if-r{display:grid;grid-template-columns:2fr .8fr 1fr 1fr .9fr .9fr;gap:8px;padding:8px 12px;align-items:center;font-size:12px}
.dh-if-h{background:var(--surface-2,#F7F9FC);font-size:10.5px;font-weight:700;text-transform:uppercase;color:#64748B;letter-spacing:.03em}
.dh-if-r{border-top:1px solid var(--border,#EEF2F7);cursor:pointer}
.dh-if-r:hover{background:var(--surface-2,#F7F9FC)}
.dh-if-r .nm{display:flex;flex-direction:column;font-weight:600}
.dh-if-r .nm em{font-style:normal;font-size:10px;color:#94A3B8}
.dh-if-r .up{color:#157F43;font-weight:700}
.dh-if-r .down{color:#B02A37;font-weight:700}
.dh-if-r .warn{color:#B45309;font-weight:700}
.dh-if-r .dim{color:#94A3B8}
.dh-if-graph{padding:10px 12px;border-top:1px solid var(--border,#EEF2F7);background:var(--surface-2,#FAFBFD)}
.dh-if-stats{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:#94A3B8;margin-bottom:6px}
.dh-if-stats b{color:var(--text)}
.dh-legend{display:flex;gap:12px;font-size:10.5px;margin-bottom:2px}
.dh-legend .rx{color:#22c55e;font-weight:700}
.dh-legend .tx{color:#3b82f6;font-weight:700}
@media (max-width:768px){
  .dh-if-h{display:none}
  .dh-if-r{grid-template-columns:1fr 1fr;gap:3px 8px}
  .dh-if-r .nm{grid-column:1 / -1}
}
`;
