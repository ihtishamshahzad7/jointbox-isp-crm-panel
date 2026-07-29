"use client";

import { useEffect, useRef, useState } from "react";

const API = (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

type FeedItem = {
  id: number; ts: number; nasName: string; level: string; kind: string;
  port?: string; username?: string; dbm?: number; message: string;
};

const LEVEL: Record<string, { dot: string; label: string }> = {
  up: { dot: "#22c55e", label: "UP" },
  down: { dot: "#ef4444", label: "DOWN" },
  critical: { dot: "#ef4444", label: "CRIT" },
  warning: { dot: "#f59e0b", label: "WARN" },
  info: { dot: "#38bdf8", label: "INFO" },
};

/**
 * Live network feed — polls the aggregator's in-memory event ring. Shows the
 * newest link ups/downs, flaps, weak signals and syslog across all NAS devices.
 */
export default function LiveFeed({ limit = 40 }: { limit?: number }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  useEffect(() => {
    const load = () => {
      if (pausedRef.current) return;
      fetch(`${API}/telemetry/feed?limit=${limit}`, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : [])).then((d) => Array.isArray(d) && setItems(d)).catch(() => {});
    };
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [limit]);

  const ago = (ts: number) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  };

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>📡 Live Network Feed</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => setPaused((p) => !p)}
            style={{ fontSize: 11, padding: "3px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text)", cursor: "pointer" }}>
            {paused ? "▶ resume" : "⏸ pause"}
          </button>
          <button onClick={() => setItems([])}
            style={{ fontSize: 11, padding: "3px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text)", cursor: "pointer" }}>
            clear
          </button>
        </span>
      </div>
      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        {items.length === 0 && (
          <div style={{ padding: 18, fontSize: 12, color: "var(--muted)" }}>
            No events yet. Enable SNMP or Syslog on a NAS to start tracing links.
          </div>
        )}
        {items.map((it) => {
          const lv = LEVEL[it.level] || LEVEL.info;
          return (
            <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: lv.dot, flex: "0 0 auto" }} />
              <span style={{ width: 40, color: lv.dot, fontWeight: 700, fontSize: 10 }}>{lv.label}</span>
              <span style={{ color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {it.username ? <b>{it.username} </b> : null}{it.message}
              </span>
              <span style={{ color: "var(--muted)", fontSize: 11, flex: "0 0 auto" }}>{it.nasName}</span>
              <span style={{ color: "var(--muted)", fontSize: 11, width: 64, textAlign: "right", flex: "0 0 auto" }}>{ago(it.ts)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
