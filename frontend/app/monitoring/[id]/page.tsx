"use client";

import React from "react";
import { useParams, useRouter } from "next/navigation";
import API from "../../components/api";

type Point = { at: string; up: boolean; latencyMs: number | null; lossPct: number | null };
type Stats = { samples: number; min: number | null; avg: number | null; max: number | null; uptimePct: number | null; lossPct: number | null };
const RANGES = ["5m", "1h", "6h", "24h", "7d", "30d"] as const;

export default function MonitorDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [target, setTarget] = React.useState<any>(null);
  const [range, setRange] = React.useState<(typeof RANGES)[number]>("1h");
  const [hist, setHist] = React.useState<{ points: Point[]; stats: Stats } | null>(null);
  const [err, setErr] = React.useState("");

  const loadTarget = React.useCallback(async () => {
    const r = await fetch(`${API}/monitoring/targets/${id}`, { headers: H });
    if (r.status === 403 || r.status === 404) { setErr("Not found or no permission."); return; }
    if (r.ok) setTarget(await r.json());
  }, [id]);
  const loadHist = React.useCallback(async () => {
    const r = await fetch(`${API}/monitoring/targets/${id}/history?range=${range}`, { headers: H });
    if (r.ok) setHist(await r.json());
  }, [id, range]);

  React.useEffect(() => { loadTarget(); const t = setInterval(loadTarget, 15000); return () => clearInterval(t); }, [loadTarget]);
  React.useEffect(() => { loadHist(); const t = setInterval(loadHist, 20000); return () => clearInterval(t); }, [loadHist]);

  if (err) return <div className="md"><style>{CSS}</style><div className="md-empty">{err} <a onClick={() => router.push("/monitoring")}>← Back to Monitoring</a></div></div>;
  if (!target) return <div className="md"><style>{CSS}</style><div className="md-empty">Loading…</div></div>;

  const state = !target.enabled ? "off" : target.isUp === null ? "wait" : target.isUp ? "up" : "down";
  const color = { off: "#94A3B8", wait: "#8A6209", up: "#157F43", down: "#B02A37" }[state];
  const label = { off: "Paused", wait: "Checking…", up: "Online", down: "DOWN" }[state];

  return (
    <div className="md">
      <style>{CSS}</style>
      <a className="md-back" onClick={() => router.push("/monitoring")}>← Monitoring</a>

      <div className="md-head">
        <div>
          <h1><span className="md-dot" style={{ background: color }} /> {target.name || target.host}</h1>
          <p>{target.host}{target.groupName ? ` · ${target.groupName}` : ""} · checks every {target.intervalSec}s</p>
        </div>
        <div className="md-status" style={{ color }}>{label}{target.isUp && target.lastLatencyMs != null ? ` · ${target.lastLatencyMs} ms` : ""}</div>
      </div>

      {/* Range switch */}
      <div className="md-ranges">
        {RANGES.map((r) => <button key={r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>)}
      </div>

      {/* Stats */}
      <div className="md-stats">
        <Stat label="Uptime" value={hist?.stats.uptimePct != null ? `${hist.stats.uptimePct}%` : "—"} good />
        <Stat label="Avg latency" value={hist?.stats.avg != null ? `${hist.stats.avg} ms` : "—"} />
        <Stat label="Min" value={hist?.stats.min != null ? `${hist.stats.min} ms` : "—"} />
        <Stat label="Max" value={hist?.stats.max != null ? `${hist.stats.max} ms` : "—"} />
        <Stat label="Packet loss" value={hist?.stats.lossPct != null ? `${hist.stats.lossPct}%` : "—"} />
        <Stat label="Samples" value={hist?.stats.samples ?? "—"} />
      </div>

      {/* Latency chart */}
      <div className="md-card">
        <div className="md-card-h">Latency (ms) — last {range}</div>
        <BigChart points={hist?.points || []} kind="latency" />
      </div>
      {/* Availability / loss strip */}
      <div className="md-card">
        <div className="md-card-h">Availability</div>
        <UpStrip points={hist?.points || []} />
      </div>

      {/* Diagnostics */}
      <Diagnostics host={target.host} />
    </div>
  );
}

function Stat({ label, value, good }: { label: string; value: any; good?: boolean }) {
  return <div className="md-stat"><span>{label}</span><b style={good ? { color: "#157F43" } : undefined}>{value}</b></div>;
}

/** Latency line chart (SVG, tooltip on hover). */
function BigChart({ points, kind }: { points: Point[]; kind: "latency" }) {
  const W = 900, HH = 200, pad = 26;
  const [hover, setHover] = React.useState<number | null>(null);
  if (points.length < 2) return <div className="md-graph empty">Not enough data yet — samples appear as the poller runs.</div>;
  // Scale to the data range (not zero) so real jitter is visible.
  const okVals = points.filter((p) => p.up && p.latencyMs != null).map((p) => p.latencyMs!) as number[];
  if (okVals.length < 2) return <div className="md-graph empty">No latency samples in this range.</div>;
  const lo = Math.min(...okVals), hi = Math.max(...okVals);
  const span = Math.max(hi - lo, 1);
  const yMin = Math.max(0, lo - span * 0.2), yMax = hi + span * 0.2;
  const stepX = (W - pad * 2) / (points.length - 1);
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => pad + (1 - (v - yMin) / (yMax - yMin)) * (HH - pad * 2);
  let line = ""; let started = false;
  points.forEach((p, i) => {
    if (p.up && p.latencyMs != null) { line += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(p.latencyMs).toFixed(1)} `; started = true; }
    else { started = false; }
  });
  const area = line ? `${line} L${x(points.length - 1).toFixed(1)},${HH - pad} L${x(0).toFixed(1)},${HH - pad} Z` : "";
  const gy = [0, 0.5, 1].map((f) => ({ v: Math.round(yMax - f * (yMax - yMin)), y: pad + f * (HH - pad * 2) }));
  return (
    <div style={{ position: "relative" }}>
      <svg className="md-graph" viewBox={`0 0 ${W} ${HH}`} preserveAspectRatio="none"
        onMouseMove={(e) => { const r = (e.currentTarget as SVGElement).getBoundingClientRect(); const i = Math.round(((e.clientX - r.left) / r.width * W - pad) / stepX); setHover(i >= 0 && i < points.length ? i : null); }}
        onMouseLeave={() => setHover(null)}>
        <defs><linearGradient id="mdg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22c55e" stopOpacity="0.22" /><stop offset="100%" stopColor="#22c55e" stopOpacity="0" /></linearGradient></defs>
        {gy.map((g, i) => <g key={i}><line x1={pad} x2={W - pad} y1={g.y} y2={g.y} stroke="var(--border)" strokeWidth="0.5" /><text x={2} y={g.y + 3} fontSize="9" fill="#94A3B8">{g.v}</text></g>)}
        {area && <path d={area} fill="url(#mdg)" />}
        {line && <path d={line} fill="none" stroke="#22c55e" strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
        {points.map((p, i) => (!p.up ? <rect key={i} x={x(i) - stepX / 2} y={pad} width={stepX} height={HH - pad * 2} fill="rgba(239,68,68,.12)" /> : null))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad} y2={HH - pad} stroke="#3C50E0" strokeWidth="0.7" />}
      </svg>
      {hover != null && points[hover] && (
        <div className="md-tip">
          {new Date(points[hover].at).toLocaleString()}<br />
          {points[hover].up ? `Latency: ${points[hover].latencyMs ?? "—"} ms` : "DOWN"}
        </div>
      )}
    </div>
  );
}

/** A thin up/down strip. */
function UpStrip({ points }: { points: Point[] }) {
  if (points.length === 0) return <div className="md-graph empty">No data.</div>;
  return (
    <div className="md-strip">
      {points.map((p, i) => <span key={i} title={new Date(p.at).toLocaleString() + (p.up ? " · up" : " · down")} style={{ background: p.up ? "#22c55e" : "#ef4444" }} />)}
    </div>
  );
}

/** On-demand diagnostics panel. */
function Diagnostics({ host }: { host: string }) {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const [tab, setTab] = React.useState<"ping" | "traceroute" | "tcp" | "tcp-trace" | "dns" | "http">("ping");
  const [port, setPort] = React.useState("443");
  const [dnsName, setDnsName] = React.useState(host);
  const [dnsType, setDnsType] = React.useState("A");
  const [resolver, setResolver] = React.useState("");
  const [url, setUrl] = React.useState(`https://${host}`);
  const [busy, setBusy] = React.useState(false);
  const [out, setOut] = React.useState<any>(null);

  const run = async () => {
    setBusy(true); setOut(null);
    try {
      const map: Record<string, { path: string; body: any }> = {
        ping: { path: "ping", body: { host } },
        traceroute: { path: "traceroute", body: { host } },
        tcp: { path: "tcp", body: { host, port: Number(port) } },
        "tcp-trace": { path: "tcp-trace", body: { host, port: Number(port) } },
        dns: { path: "dns", body: { name: dnsName, type: dnsType, resolver: resolver || undefined } },
        http: { path: "http", body: { url } },
      };
      const { path, body } = map[tab];
      const r = await fetch(`${API}/monitoring/diagnostics/${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
      setOut(await r.json());
    } catch (e: any) { setOut({ error: e?.message || "Failed" }); }
    finally { setBusy(false); }
  };

  return (
    <div className="md-card">
      <div className="md-card-h">Diagnostics</div>
      <div className="md-diag-tabs">
        {(["ping", "traceroute", "tcp", "tcp-trace", "dns", "http"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => { setTab(t); setOut(null); }}>{t}</button>
        ))}
      </div>
      <div className="md-diag-inputs">
        {(tab === "tcp" || tab === "tcp-trace") && <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="Port" style={{ width: 90 }} />}
        {tab === "dns" && <><input value={dnsName} onChange={(e) => setDnsName(e.target.value)} placeholder="Name" />
          <select value={dnsType} onChange={(e) => setDnsType(e.target.value)}>{["A", "AAAA", "CNAME", "MX", "NS", "TXT"].map((x) => <option key={x}>{x}</option>)}</select>
          <input value={resolver} onChange={(e) => setResolver(e.target.value)} placeholder="Resolver (optional)" /></>}
        {tab === "http" && <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL" style={{ flex: 1, minWidth: 200 }} />}
        <button onClick={run} disabled={busy}>{busy ? "Running…" : `Run ${tab}`}</button>
      </div>
      {out && <DiagResult tab={tab} out={out} />}
    </div>
  );
}

function DiagResult({ tab, out }: { tab: string; out: any }) {
  if (out.error) return <div className="md-diag-out err">⚠ {out.error}</div>;
  if (tab === "ping") return <div className="md-diag-out">{out.reachable ? `✅ Reachable — ${out.packetLoss}% loss, avg ${out.avg} ms (min ${out.min} / max ${out.max})` : `❌ Unreachable — ${out.packetLoss}% loss`}<pre>{out.raw}</pre></div>;
  if (tab === "traceroute" || tab === "tcp-trace") return (
    <div className="md-diag-out">
      {tab === "tcp-trace" && <div style={{ marginBottom: 8, fontWeight: 700, color: out.destinationReached ? "#157F43" : "#B02A37" }}>{out.destinationReached ? `✅ DESTINATION REACHED — TCP :${out.port} in ${out.connectLatencyMs} ms` : `❌ ${out.connectError || "not reachable"}`}</div>}
      {/* Why the hop table is empty — missing binary or no raw-socket capability. */}
      {(out.error || out.pathError) && (
        <div className="md-diag-warn">
          ⚠ {out.error || out.pathError}
          {out.hint && <div className="md-hint">{out.hint}</div>}
        </div>
      )}
      {out.tool && <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 4 }}>via {out.tool}</div>}
      {(out.hops || []).length > 0 && (
        <table className="md-hops"><thead><tr><th>Hop</th><th>IP</th><th>Latency</th></tr></thead><tbody>
          {out.hops.map((h: any, i: number) => <tr key={i}><td>{h.hop}</td><td>{h.timedOut ? <span className="dim">* (no reply)</span> : h.ip}</td><td>{h.latencyMs != null ? `${h.latencyMs} ms` : "—"}</td></tr>)}
        </tbody></table>
      )}
      <div className="md-note">{out.note}</div>
    </div>
  );
  if (tab === "tcp") return <div className="md-diag-out">{out.open ? `✅ TCP ${out.host}:${out.port} open — ${out.latencyMs} ms` : `❌ TCP ${out.host}:${out.port} — ${out.error}`}</div>;
  if (tab === "dns") return <div className="md-diag-out">{out.success ? `✅ ${out.type} for ${out.name} via ${out.resolver} — ${out.responseMs} ms` : `❌ ${out.error}`}<pre>{JSON.stringify(out.answers, null, 2)}</pre></div>;
  if (tab === "http") return <div className="md-diag-out">{out.success ? `✅ HTTP ${out.status} — ${out.responseMs} ms${out.server ? ` · ${out.server}` : ""}${out.tls ? ` · TLS valid to ${out.tls.validTo}` : ""}` : `❌ ${out.error || `HTTP ${out.status}`}`}</div>;
  return null;
}

const CSS = `
.md{max-width:960px;color:var(--text)}
.md-empty{padding:40px;text-align:center;color:#94A3B8}
.md-empty a,.md-back{color:#3C50E0;cursor:pointer;font-size:12.5px;font-weight:600}
.md-back{display:inline-block;margin-bottom:12px}
.md-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.md-head h1{font-size:19px;font-weight:800;margin:0;display:flex;align-items:center;gap:9px}
.md-head p{font-size:12px;color:var(--muted);margin:4px 0 0}
.md-dot{width:12px;height:12px;border-radius:50%}
.md-status{font-size:14px;font-weight:800}
.md-ranges,.md-diag-tabs{display:inline-flex;background:var(--surface-2,#F1F5F9);border-radius:9px;padding:3px;margin-bottom:12px;flex-wrap:wrap}
.md-ranges button,.md-diag-tabs button{border:none;background:transparent;padding:6px 13px;border-radius:7px;font-size:12.5px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit;text-transform:capitalize}
.md-ranges button.on,.md-diag-tabs button.on{background:#3C50E0;color:#fff}
.md-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:12px}
.md-stat{background:var(--surface,#fff);border:1px solid var(--border,#E2E8F0);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}
.md-stat span{font-size:11px;color:var(--muted)}
.md-stat b{font-size:17px}
.md-card{background:var(--surface,#fff);border:1px solid var(--border,#E2E8F0);border-radius:12px;padding:12px;margin-bottom:12px}
.md-card-h{font-size:12px;font-weight:700;color:var(--muted);margin-bottom:8px}
.md-graph{width:100%;height:200px}
.md-graph.empty{display:flex;align-items:center;justify-content:center;height:120px;color:#94A3B8;font-size:12px;border:1px dashed var(--border);border-radius:8px}
.md-tip{position:absolute;top:4px;right:4px;background:rgba(15,20,30,.9);color:#fff;font-size:10.5px;padding:5px 8px;border-radius:6px;pointer-events:none;line-height:1.5}
.md-strip{display:flex;gap:1px;height:22px;border-radius:5px;overflow:hidden}
.md-strip span{flex:1;min-width:1px}
.md-diag-inputs{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.md-diag-inputs input,.md-diag-inputs select{height:34px;border:1px solid var(--border);border-radius:8px;padding:0 10px;font-size:12.5px;font-family:inherit;background:var(--bg);color:var(--text)}
.md-diag-inputs button{height:34px;border:none;border-radius:8px;background:#3C50E0;color:#fff;padding:0 16px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
.md-diag-out{font-size:12.5px;line-height:1.7}
.md-diag-out.err{color:#B02A37}
.md-diag-out pre{background:var(--surface-2,#0d1627);color:var(--text);padding:10px;border-radius:8px;font-size:11px;overflow:auto;margin-top:8px;max-height:260px}
.md-hops{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px}
.md-hops th,.md-hops td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--border)}
.md-hops .dim{color:#94A3B8}
.md-note{font-size:11px;color:#94A3B8;margin-top:8px;line-height:1.6}
.md-diag-warn{background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.4);color:#b45309;border-radius:8px;padding:9px 11px;font-size:12px;line-height:1.6;margin-bottom:8px}
.md-hint{margin-top:6px;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#92400e;background:rgba(245,158,11,.12);padding:6px 8px;border-radius:6px;word-break:break-all}
`;
