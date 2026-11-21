"use client";

/**
 * Server health banner — Super Admin only, on every page.
 *
 * Polls /system/stats every 30 s and shows what needs attention right now
 * (disk almost full, memory exhausted, CPU pinned). Silent when the server is
 * healthy. Companies never see it: the server belongs to the platform.
 */
import { useEffect, useState } from "react";
import API_BASE from "./api";

type Alert = { level: "critical" | "warning"; key: string; text: string };
type Stats = {
  visible?: boolean;
  disk?: { totalGb: number; usedGb: number; freeGb: number; pct: number } | null;
  alerts?: Alert[];
};

export default function ServerHealthBanner() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [hidden, setHidden] = useState<string>("");

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const token = localStorage.getItem("token") || "";
        const r = await fetch(`${API_BASE}/system/stats`, { headers: { Authorization: `Bearer ${token}` } });
        const b = r.ok ? await r.json() : null;
        if (!stop) setStats(b);
      } catch { /* keep the last reading */ }
    };
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  const alerts = stats?.visible ? stats.alerts ?? [] : [];
  // Dismiss hides only the CURRENT set; a new or worse alert shows again.
  const sig = alerts.map((a) => `${a.key}:${a.level}`).join(",");
  if (!alerts.length || hidden === sig) return null;

  const critical = alerts.some((a) => a.level === "critical");
  const d = stats?.disk;
  const c = critical
    ? { bg: "#FDECEF", border: "#F5B5C2", title: "#C81E4B" }
    : { bg: "#FFF7E6", border: "#F6D38B", title: "#9A5B00" };

  return (
    <div role="alert" style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, padding: "12px 16px", margin: "0 0 14px", color: "#1C2434" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div style={{ fontWeight: 800, fontSize: 14, color: c.title }}>
          {critical ? "⚠ CRITICAL: Server needs attention" : "⚠ Server warning"}
        </div>
        <button type="button" onClick={() => setHidden(sig)} aria-label="Hide until something changes"
          style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 16, color: "#64748B" }}>×</button>
      </div>
      {alerts.map((a) => (
        <div key={a.key} style={{ fontSize: 13, marginTop: 4 }}>{a.text}</div>
      ))}
      {d && alerts.some((a) => a.key === "disk") && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
          <span style={{ background: "#EEF2FF", color: "#4338CA", padding: "2px 8px", borderRadius: 6 }}>Total: {d.totalGb} GB</span>
          <span style={{ background: "#FEF2F2", color: "#B91C1C", padding: "2px 8px", borderRadius: 6 }}>Used: {d.usedGb} GB ({d.pct.toFixed(2)}%)</span>
          <span style={{ background: "#F0FDF4", color: "#15803D", padding: "2px 8px", borderRadius: 6 }}>Free: {d.freeGb} GB ({(100 - d.pct).toFixed(2)}%)</span>
        </div>
      )}
      <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 8 }}>
        Low disk space can corrupt the database and stop logging. Common fixes: clear old logs and backups, remove unused
        files, or expand the server&apos;s disk. Details: Settings → Server health.
      </div>
    </div>
  );
}
