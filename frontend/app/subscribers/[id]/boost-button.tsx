"use client";

import { useState } from "react";
import API_BASE from "../../components/api";

const API =
  API_BASE;

/**
 * Temporary Boost / speed change for a subscriber. Both options in one dialog:
 *  • pick a speed, and
 *  • a duration — "Permanent" (stays until changed) or a timed boost (1h / 6h /
 *    1 day / custom) that auto-reverts to the plan speed.
 */
export default function BoostButton({ subscriberId }: { subscriberId: number }) {
  const [open, setOpen] = useState(false);
  const [down, setDown] = useState(30);
  const [up, setUp] = useState(30);
  const [hours, setHours] = useState(24); // 0 = permanent
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  const apply = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${API}/boost/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ subscriberId, downMbps: down, upMbps: up, durationHours: hours }),
      }).then((x) => x.json());
      setMsg({ ok: r.ok !== false, text: r.message || (r.ok ? "Applied" : r.message || "Failed") });
    } catch (e: any) { setMsg({ ok: false, text: e?.message || "Failed" }); }
    setBusy(false);
  };

  const durations = [
    { h: 1, label: "1 hour" }, { h: 6, label: "6 hours" }, { h: 24, label: "1 day" },
    { h: 72, label: "3 days" }, { h: 0, label: "Permanent" },
  ];
  const btn: React.CSSProperties = { background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 8, padding: "7px 12px", cursor: "pointer", fontSize: 13 };

  return (
    <>
      <button onClick={() => { setOpen(true); setMsg(null); }} style={{ ...btn, background: "linear-gradient(135deg,#F7971E,#FFD200)", color: "#1a1a1a", fontWeight: 700, border: "none" }}>
        ⚡ Temporary Boost
      </button>

      {open && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setOpen(false)}>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 18, width: "100%", maxWidth: 420, color: "var(--text)" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>⚡ Temporary Boost / speed change</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>Applies live via CoA. A timed boost reverts to the plan speed automatically; “Permanent” stays until you change it.</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: "var(--muted)" }}>Download (Mbps)
                <input type="number" min={1} value={down} onChange={(e) => setDown(+e.target.value)} style={{ width: "100%", marginTop: 4, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }} /></label>
              <label style={{ fontSize: 12, color: "var(--muted)" }}>Upload (Mbps)
                <input type="number" min={1} value={up} onChange={(e) => setUp(+e.target.value)} style={{ width: "100%", marginTop: 4, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }} /></label>
            </div>

            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Duration</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {durations.map((d) => (
                <button key={d.h} onClick={() => setHours(d.h)}
                  style={{ ...btn, background: hours === d.h ? "var(--accent,#378ADD)" : "var(--surface)", color: hours === d.h ? "#fff" : "var(--text)", fontWeight: hours === d.h ? 700 : 400 }}>
                  {d.label}
                </button>
              ))}
            </div>

            {msg && <div style={{ fontSize: 12.5, color: msg.ok ? "#16a34a" : "#ef4444", marginBottom: 10 }}>{msg.text}</div>}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setOpen(false)} style={btn}>Close</button>
              <button onClick={apply} disabled={busy} style={{ ...btn, background: "var(--accent,#378ADD)", color: "#fff", border: "none", fontWeight: 700 }}>
                {busy ? "Applying…" : hours === 0 ? `Set ${down}M/${up}M` : `Boost for ${durations.find((d) => d.h === hours)?.label}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
