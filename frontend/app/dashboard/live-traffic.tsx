"use client";

/**
 * LiveTraffic — real-time whole-network upload/download meter.
 *
 * Unlike the 5/10-minute MRTG chart next door, this widget reads
 * /telemetry/live-traffic: the backend polls every RouterOS device's live
 * PPPoE session byte counters and diffs consecutive reads, so both series
 * move every ~2 seconds (last 60 points ≈ 2 minutes of history).
 *
 * Shown in KB/s. Green = download, orange = upload (spec). Plain inline SVG
 * redrawn every tick — no animation library, no CSS transitions, nothing to
 * jank, stall, or crash. Errors and degraded states (router(s) unreachable,
 * stale data) are shown honestly instead of faking zeros.
 */
import { useEffect, useMemo, useRef, useState } from "react";

const CARD: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 16,
  padding: 18,
  boxShadow: "0 1px 2px rgba(15,23,42,.04)",
};

const DOWN = "#4ade80"; // download — green
const UP = "#fb923c";   // upload — orange
const MUTED = "var(--muted)";
const WARN = "#fbbf24";

interface Lp { t: string; upBps: number; downBps: number }
interface LiveDevice { nasId: number; ip: string; ok: boolean; error?: string }
interface LiveResp {
  points: Lp[];
  sampleMs: number;
  maxPoints: number;
  lastSampleAt: string | null;
  staleSec: number | null;
  deviceSummary: string;
  devices: LiveDevice[];
  now: string;
}

/** bytes/sec → human KB/s / MB/s. */
function kb(v: number): string {
  const n = Math.max(0, v) / 1024;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} MB/s`;
  if (n >= 10) return `${n.toFixed(1)} KB/s`;
  return `${n.toFixed(1)} KB/s`;
}

/** Round the y-axis ceiling up to a "nice" 1/2/5×10^n so grid lines read well. */
function niceMax(v: number): number {
  if (v <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / pow;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return step * pow;
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function LiveTraffic({ API }: { API: string }) {
  const [resp, setResp] = useState<LiveResp | null>(null);
  const [err, setErr] = useState(false);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const token = ((): string => (typeof window !== "undefined" ? localStorage.getItem("token") || "" : ""))();
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    const load = async () => {
      if (inFlight.current) return; // never stack polls on a slow router
      inFlight.current = true;
      try {
        const r = await fetch(`${API}/telemetry/live-traffic`, { headers });
        const d = r.ok ? await r.json() : null;
        if (!alive) return;
        if (d) { setErr(false); setResp(d); }
        else setErr(true);
      } catch {
        if (alive) setErr(true);
      } finally {
        inFlight.current = false;
      }
    };

    load();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(load, 2000); // 1–2s requirement
    return () => { alive = false; if (timer.current) clearInterval(timer.current); };
  }, [API]);

  const pts = resp?.points ?? [];
  const { dl, ul, yMax, peakDl, peakUl } = useMemo(() => {
    const dl = pts.map((p) => p.downBps / 1024); // KB/s
    const ul = pts.map((p) => p.upBps / 1024);
    const peak = niceMax(Math.max(1, ...dl, ...ul) * 1.15);
    return { dl, ul, yMax: peak, peakDl: Math.max(0, ...dl), peakUl: Math.max(0, ...ul) };
  }, [pts]);

  const W = 640, H = 220, PAD = { top: 16, right: 14, bottom: 26, left: 60 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const line = (vals: number[]) => {
    if (vals.length < 2) return "";
    const x = (i: number) => PAD.left + (innerW * i) / (vals.length - 1);
    const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
    return vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(Math.max(0, v)).toFixed(1)}`).join(" ");
  };
  const area = (vals: number[]) => {
    if (vals.length < 2) return "";
    const x = (i: number) => PAD.left + (innerW * i) / (vals.length - 1);
    const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
    const bottom = PAD.top + innerH;
    const d = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(Math.max(0, v)).toFixed(1)}`).join(" ");
    return `${d} L${x(vals.length - 1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`;
  };

  const dlP = line(dl), ulP = line(ul), dlA = area(dl), ulA = area(ul);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMax * f);
  const cur = pts.length ? { d: dl[dl.length - 1], u: ul[ul.length - 1] } : null;
  const devices = resp?.devices ?? [];
  const someDown = devices.some((d) => !d.ok);
  const stale = resp?.staleSec != null && resp.staleSec > 10;
  const idle = pts.length >= 4 && !dl.some((v) => v > 0.01) && !ul.some((v) => v > 0.01);
  const degraded = someDown || stale;

  return (
    <div style={CARD}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 14 }}>
            Live traffic {pts.length > 0 && <span style={{ color: MUTED, fontWeight: 600 }}>· {resp?.deviceSummary}</span>}
          </div>
          <div style={{ fontSize: 11, color: MUTED }}>
            Real-time router counters · ~2s resolution · last {Math.min(pts.length, resp?.maxPoints ?? 60)} of {resp?.maxPoints ?? 60}s
          </div>
        </div>
        {degraded && (
          <span style={{
            fontSize: 10.5, fontWeight: 700, color: WARN, background: "rgba(251,191,36,.08)",
            border: "1px solid rgba(251,191,36,.25)", borderRadius: 8, padding: "3px 8px",
          }}>
            {stale ? `no fresh data ${resp?.staleSec}s` : `${devices.filter((d) => !d.ok).length} router(s) unreachable`}
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 14, fontSize: 11, color: MUTED, marginBottom: 8 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <i style={{ width: 9, height: 9, background: DOWN, borderRadius: 2, display: "inline-block" }} /> Download
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <i style={{ width: 9, height: 9, background: UP, borderRadius: 2, display: "inline-block" }} /> Upload
        </span>
        {cur && (
          <span style={{ marginLeft: "auto", color: MUTED }}>
            now: <b style={{ color: "var(--text)" }}>↓{kb(cur.d * 1024)}</b> / <b style={{ color: "var(--text)" }}>↑{kb(cur.u * 1024)}</b>
          </span>
        )}
      </div>

      {err && pts.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--muted)", padding: "40px 0", textAlign: "center" }}>
          Live traffic unavailable — retrying…
        </div>
      ) : !resp ? (
        <div style={{ fontSize: 12, color: "var(--muted)", padding: "40px 0", textAlign: "center" }}>Connecting…</div>
      ) : pts.length < 2 ? (
        <div style={{ fontSize: 12, color: "var(--muted)", padding: "40px 0", textAlign: "center", lineHeight: 1.6 }}>
          Collecting live samples — the first point appears on the next 2-second poll after the routers' baseline counters are read.
        </div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", overflow: "visible" }}>
            {yTicks.map((tick, i) => {
              const y = PAD.top + innerH - (tick / yMax) * innerH;
              return (
                <g key={i}>
                  <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y}
                    stroke="var(--border)" strokeWidth={1} strokeDasharray={i === 0 ? "" : "2 3"} />
                  <text x={PAD.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill={MUTED}>{kb(tick * 1024)}</text>
                </g>
              );
            })}
            {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
              const idx = Math.min(pts.length - 1, Math.floor(f * (pts.length - 1)));
              return (
                <text key={i} x={PAD.left + (innerW * idx) / (pts.length - 1)}
                  y={H - 5} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"} fontSize={9} fill={MUTED}>
                  {fmtClock(pts[idx].t)}
                </text>
              );
            })}
            <path d={dlA} fill="rgba(74,222,128,0.12)" />
            <path d={dlP} fill="none" stroke={DOWN} strokeWidth={2} strokeLinejoin="round" />
            <path d={ulA} fill="rgba(251,146,60,0.12)" />
            <path d={ulP} fill="none" stroke={UP} strokeWidth={2} strokeLinejoin="round" />
          </svg>
          <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 11, color: MUTED, flexWrap: "wrap" }}>
            <span>Peak ↓ <b style={{ color: "var(--text)" }}>{kb(peakDl * 1024)}</b></span>
            <span>Peak ↑ <b style={{ color: "var(--text)" }}>{kb(peakUl * 1024)}</b></span>
            <span style={{ marginLeft: "auto" }}>
              {idle
                ? <span style={{ color: MUTED }}>idle — no traffic right now</span>
                : <span>last sample <b style={{ color: "var(--text)" }}>{resp?.lastSampleAt ? fmtClock(resp.lastSampleAt) : "—"}</b></span>}
            </span>
          </div>
        </>
      )}
      {someDown && pts.length > 0 && (
        <div style={{ fontSize: 10.5, color: WARN, marginTop: 8, opacity: 0.9 }}>
          {devices.filter((d) => !d.ok).map((d) => `${d.ip}`).join(", ")} not responding
          {devices.filter((d) => !d.ok).length > 1 ? " — " : " — "}showing remaining routers, first point after reconnect is baseline-only.
        </div>
      )}
    </div>
  );
}