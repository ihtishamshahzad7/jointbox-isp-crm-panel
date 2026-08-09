"use client";

import { useEffect, useRef, useState } from "react";
import API_BASE from "./api";

interface BWPoint {
  timestamp: string;
  uploadBps: number;
  downloadBps: number;
  uploadBytes: number;
  downloadBytes: number;
}

interface BWChartProps {
  username: string;
  /** How many minutes of history to fetch (default 60) */
  minutes?: number;
  darkMode?: boolean;
}

/**
 * Lightweight SVG bandwidth chart — shows upload/download rates over the last
 * N minutes by querying the RADIUS accounting table. Auto-polls every 30s.
 *
 * Pure SVG — zero dependencies. Renders a 600×240 responsive chart.
 */
export function BandwidthChart({ username, minutes = 60, darkMode = true }: BWChartProps) {
  const API = API_BASE;
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { Authorization: `Bearer ${token}` };

  const [samples, setSamples] = useState<BWPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(
          `${API}/subscribers/bandwidth-history/${encodeURIComponent(username)}?minutes=${minutes}`,
          { headers },
        );
        if (!res.ok) return;
        const data = await res.json();
        setSamples(data.samples || []);
      } catch {
        // silent
      }
      setLoading(false);
    };
    load();
    intervalRef.current = setInterval(load, 30000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [username, minutes]);

  // ── SVG chart dimensions ──
  const W = 600;
  const H = 200;
  const PAD = { top: 20, right: 16, bottom: 28, left: 52 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const gridColor = darkMode ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)";
  const textColor = darkMode ? "var(--muted)" : "#64748b";
  const upColor = "#4ade80";
  const downColor = "#60a5fa";

  // Compute max rate for scaling
  const maxRate = samples.reduce(
    (m, s) => Math.max(m, s.uploadBps, s.downloadBps),
    1,
  );
  const yMax = Math.max(maxRate * 1.15, 100); // at least 100 bps for scale

  // Format bytes to human-readable
  const fmt = (bps: number) => {
    if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(1) + " Mbps";
    if (bps >= 1_000) return (bps / 1_000).toFixed(0) + " Kbps";
    return bps.toFixed(0) + " bps";
  };

  // X-axis time labels
  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  // Chart path generator
  const linePath = (points: BWPoint[], accessor: (p: BWPoint) => number) => {
    if (points.length < 2) return "";
    const x = (i: number) =>
      PAD.left + (innerW * i) / Math.max(points.length - 1, 1);
    const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
    return points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(accessor(p)).toFixed(1)}`)
      .join(" ");
  };

  // Area fill path (line + bottom for fill)
  const areaPath = (points: BWPoint[], accessor: (p: BWPoint) => number) => {
    if (points.length < 2) return "";
    const x = (i: number) =>
      PAD.left + (innerW * i) / Math.max(points.length - 1, 1);
    const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
    const bottom = PAD.top + innerH;
    let d = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(accessor(p)).toFixed(1)}`)
      .join(" ");
    d += ` L${x(points.length - 1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`;
    return d;
  };

  // Y-axis ticks (5 steps)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ display: "flex", gap: 16 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: upColor, fontWeight: 600 }}>
            <span style={{ width: 12, height: 3, borderRadius: 2, background: upColor }} /> Upload
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: downColor, fontWeight: 600 }}>
            <span style={{ width: 12, height: 3, borderRadius: 2, background: downColor }} /> Download
          </span>
          <span style={{ fontSize: 10, color: textColor }}>
            {loading ? "Loading…" : `${samples.length} samples over ${minutes} min`}
          </span>
        </div>
      </div>

      {samples.length < 2 ? (
        <div style={{
          height: H,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: textColor, fontSize: 12, background: darkMode ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)",
          borderRadius: 8, border: `1px solid ${gridColor}`,
        }}>
          {loading ? "Loading bandwidth data…" : "Not enough data yet — check back when the subscriber has active sessions"}
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", maxHeight: H, overflow: "visible" }}>
          {/* Grid lines (horizontal) */}
          {yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={PAD.left} y1={PAD.top + innerH - (tick / yMax) * innerH}
                x2={W - PAD.right} y2={PAD.top + innerH - (tick / yMax) * innerH}
                stroke={gridColor} strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={PAD.top + innerH - (tick / yMax) * innerH + 4}
                textAnchor="end" fontSize={9} fill={textColor}
              >
                {fmt(tick)}
              </text>
            </g>
          ))}

          {/* X-axis time labels (show 5 labels evenly spread) */}
          {samples.length > 1 && [0, 0.25, 0.5, 0.75, 1].map((f, i) => {
            const idx = Math.floor(f * (samples.length - 1));
            return (
              <text
                key={i}
                x={PAD.left + (innerW * idx) / Math.max(samples.length - 1, 1)}
                y={H - 4}
                textAnchor="middle" fontSize={9} fill={textColor}
              >
                {fmtTime(samples[idx].timestamp)}
              </text>
            );
          })}

          {/* Area fill — download */}
          <path d={areaPath(samples, (p) => p.downloadBps)} fill="rgba(96,165,250,0.12)" />
          {/* Line — download */}
          <path d={linePath(samples, (p) => p.downloadBps)} fill="none" stroke={downColor} strokeWidth={2} strokeLinejoin="round" />

          {/* Area fill — upload */}
          <path d={areaPath(samples, (p) => p.uploadBps)} fill="rgba(74,222,128,0.12)" />
          {/* Line — upload */}
          <path d={linePath(samples, (p) => p.uploadBps)} fill="none" stroke={upColor} strokeWidth={2} strokeLinejoin="round" />

          {/* Y-axis label */}
          <text
            x={6} y={PAD.top + innerH / 2}
            textAnchor="middle" fontSize={9} fill={textColor}
            transform={`rotate(-90, 6, ${PAD.top + innerH / 2})`}
          >
            Rate
          </text>
        </svg>
      )}
    </div>
  );
}