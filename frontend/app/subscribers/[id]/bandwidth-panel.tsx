"use client";

import { useEffect, useState } from "react";

const API = (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

/** Historical daily up/down usage bars — complements the live BandwidthChart. */
export default function DailyUsageBars({ username }: { username: string }) {
  const [daily, setDaily] = useState<any[]>([]);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  useEffect(() => {
    fetch(`${API}/subscribers/usage-daily/${encodeURIComponent(username)}?days=14`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((d) => setDaily(d?.days || [])).catch(() => {});
  }, [username]);

  const dayMax = Math.max(...daily.map((d) => d.downloadGb + d.uploadGb), 0.001);
  const green = "#22c55e", blue = "#38bdf8", muted = "var(--muted)";

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginTop: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Daily usage · last 14 days</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 96 }}>
        {daily.length === 0 && <div style={{ fontSize: 12, color: muted, alignSelf: "center" }}>No usage recorded yet.</div>}
        {daily.map((d) => {
          const tot = d.downloadGb + d.uploadGb;
          return (
            <div key={d.day} title={`${d.day}: ↓${d.downloadGb} / ↑${d.uploadGb} GB`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: 9, color: "var(--text)" }}>{tot >= 0.01 ? tot.toFixed(1) : ""}</span>
              <div style={{ width: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", height: 64 }}>
                <div style={{ height: `${(d.uploadGb / dayMax) * 60}px`, background: blue, borderRadius: "3px 3px 0 0" }} />
                <div style={{ height: `${(d.downloadGb / dayMax) * 60}px`, background: green }} />
              </div>
              <span style={{ fontSize: 9, color: muted }}>{d.day.slice(5)}</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 11, color: muted }}>
        <span><span style={{ display: "inline-block", width: 9, height: 9, background: green, borderRadius: 2, marginRight: 4 }} />Download (GB)</span>
        <span><span style={{ display: "inline-block", width: 9, height: 9, background: blue, borderRadius: 2, marginRight: 4 }} />Upload (GB)</span>
      </div>
    </div>
  );
}
