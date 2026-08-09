"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import API_BASE from "../components/api";
import Portal from "../components/portal";

const API = API_BASE;

const T = {
  bg: "var(--bg)", card: "var(--surface)", border: "var(--border)", row: "var(--surface-2)",
  text: "var(--text)", muted: "var(--muted)", sub: "var(--muted)",
  accent: "#0ea5e9", green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
};

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GB`;
const rate = (bps: number) => (bps > 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${(bps / 1e3).toFixed(0)} kbps`);
const hms = (s: number) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const mbps = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} Gbps` : `${m.toFixed(1)} Mbps`);

/**
 * Live throughput graph.
 *
 * The stat cards show CUMULATIVE bytes since each session began — that only
 * ever grows, so it can't answer "how much is flowing right now". This turns
 * the running totals into a real rate: (bytes now − bytes last sample) ÷ the
 * seconds between them, ×8 for bits, in Mbps. Two lines — download and upload —
 * over a rolling window. Drops (a session ending) clamp to zero rather than
 * drawing a negative spike.
 */
function LiveTraffic({ hist, T }: { hist: { d: number; u: number }[]; T: any }) {
  const W = 640, H = 150, P = 8;
  const max = Math.max(1, ...hist.map((p) => Math.max(p.d, p.u)));
  const top = max * 1.2;
  const n = Math.max(hist.length - 1, 1);
  const x = (i: number) => P + (i * (W - P * 2)) / Math.max(n, 1);
  const y = (v: number) => H - P - (v / top) * (H - P * 2);
  const path = (key: "d" | "u") => hist.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const last = hist[hist.length - 1] ?? { d: 0, u: 0 };

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 11, color: T.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Live throughput · all online users</span>
        <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
          <span style={{ color: "#38bdf8", fontWeight: 700 }}>▼ {mbps(last.d)} <span style={{ color: T.muted, fontWeight: 400 }}>down</span></span>
          <span style={{ color: "#f472b6", fontWeight: 700 }}>▲ {mbps(last.u)} <span style={{ color: T.muted, fontWeight: 400 }}>up</span></span>
        </div>
      </div>
      {hist.length < 2 ? (
        <div style={{ height: H, display: "grid", placeItems: "center", color: T.muted, fontSize: 12 }}>Sampling… the line fills in as live data arrives.</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }}>
          {[0.5, 1].map((f) => (
            <line key={f} x1={P} x2={W - P} y1={y(top * f)} y2={y(top * f)} stroke="currentColor" strokeOpacity="0.08" strokeDasharray="3 5" />
          ))}
          <path d={`${path("d")} L${x(n)},${H - P} L${x(0)},${H - P} Z`} fill="#38bdf8" fillOpacity="0.10" />
          <path d={path("d")} fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={path("u")} fill="none" stroke="#f472b6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  );
}

export default function NetworkPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [auto, setAuto] = useState(true);
  const [msg, setMsg] = useState("");
  const [macFor, setMacFor] = useState<any>(null);
  const [macBinding, setMacBinding] = useState<any>(null);
  const [macInput, setMacInput] = useState("");
  const [rateHist, setRateHist] = useState<{ d: number; u: number }[]>([]);
  const prevSample = useRef<{ d: number; u: number; t: number } | null>(null);
  const timer = useRef<any>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const get = useCallback(async (path: string) => {
    const r = await fetch(`${API}${path}`, { headers });
    if (r.status === 401) { router.push("/login"); throw new Error("unauthorized"); }
    return r.json();
  }, [token]);

  const load = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([get("/network/live"), get("/network/live/stats")]);
      setSessions(Array.isArray(s) ? s : []);
      setStats(st);

      // Turn cumulative byte totals into a live rate: delta bytes ÷ delta time.
      // BIGINT arrives as a string, so coerce before subtracting.
      const d = Number(st?.totalDownloadBytes || 0);
      const u = Number(st?.totalUploadBytes || 0);
      const now = Date.now();
      const prev = prevSample.current;
      if (prev) {
        const dt = (now - prev.t) / 1000;
        if (dt > 0.5) {
          const down = Math.max(0, ((d - prev.d) * 8) / 1e6 / dt); // Mbps
          const up = Math.max(0, ((u - prev.u) * 8) / 1e6 / dt);
          setRateHist((h) => [...h, { d: down, u: up }].slice(-40));
        }
      }
      prevSample.current = { d, u, t: now };
    } catch {}
  }, [get]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load();
  }, []);

  useEffect(() => {
    if (auto) { timer.current = setInterval(load, 5000); return () => clearInterval(timer.current); }
    if (timer.current) clearInterval(timer.current);
  }, [auto, load]);

  async function disconnect(username: string) {
    if (!confirm(`Disconnect ${username}? They'll be dropped from the network.`)) return;
    const r = await fetch(`${API}/network/disconnect/${username}`, { method: "POST", headers });
    const data = await r.json();
    setMsg(data?.disconnected ? `Disconnected ${username} (${data.method})` : data?.message || "Failed");
    load();
  }

  async function changeSpeed(s: any) {
    if (!s.subscriberId) { setMsg("This session isn't linked to a subscriber."); return; }
    const dl = prompt(`New DOWNLOAD speed (Mbps) for ${s.username}:`, "10");
    if (dl === null) return;
    const ul = prompt(`New UPLOAD speed (Mbps) for ${s.username}:`, "10");
    if (ul === null) return;
    const d = Number(dl), u = Number(ul);
    if (!(d > 0) || !(u > 0)) { setMsg("Enter valid speeds in Mbps."); return; }
    try {
      const r = await fetch(`${API}/network/bandwidth/${s.subscriberId}`, {
        method: "POST", headers, body: JSON.stringify({ downloadSpeed: d, uploadSpeed: u }),
      });
      const data = await r.json();
      setMsg(data?.message || (r.ok ? "Speed updated" : "Speed change failed"));
      load();
    } catch { setMsg("Speed change failed"); }
  }

  const [syncing, setSyncing] = useState(false);
  async function syncSessions() {
    setSyncing(true);
    setMsg("Checking routers…");
    try {
      const r = await fetch(`${API}/subscribers/integrity/sessions`, { headers });
      const d = await r.json();
      if (!r.ok) { setMsg(d?.message || "Sync failed"); return; }
      setMsg(
        `Synced ${d.routers} router(s): closed ${d.closed} ghost session(s)` +
        (d.skipped ? `, skipped ${d.skipped} unreachable` : "") + ".",
      );
      load();
    } catch { setMsg("Sync failed — check router API credentials"); }
    finally { setSyncing(false); }
  }

  async function openMac(s: any) {
    setMacFor(s);
    setMacInput(s.mac || "");
    setMacBinding(await get(`/network/mac/${s.username}`));
  }
  async function bindMac() {
    const r = await fetch(`${API}/network/mac/${macFor.username}`, { method: "POST", headers, body: JSON.stringify({ mac: macInput }) });
    const data = await r.json();
    if (data?.bound) { setMacBinding(await get(`/network/mac/${macFor.username}`)); setMsg("MAC bound"); }
    else setMsg(data?.message || "Failed");
  }
  async function autolearn() {
    const r = await fetch(`${API}/network/mac/${macFor.username}/autolearn`, { method: "POST", headers });
    const data = await r.json();
    if (data?.bound) { setMacBinding(await get(`/network/mac/${macFor.username}`)); setMsg("MAC learned from live session"); }
    else setMsg(data?.message || "Failed");
  }
  async function unbind(mac: string) {
    await fetch(`${API}/network/mac/${macFor.username}?mac=${encodeURIComponent(mac)}`, { method: "DELETE", headers });
    setMacBinding(await get(`/network/mac/${macFor.username}`));
  }

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 };
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", color: T.muted, fontSize: 11, textTransform: "uppercase" };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: T.text };
  const input: React.CSSProperties = { background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", color: T.text, fontSize: 13 };
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" });

  return (
    <div style={{ padding: "10px 20px 20px", color: T.text }}>
      {/* One compact control strip instead of a full-height band: the
          auto-refresh toggle and manual refresh sit inline as a single pill so
          the online stats below rise into view. */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        {msg && <span style={{ fontSize: 12, color: T.accent, cursor: "pointer", marginRight: "auto" }} onClick={() => setMsg("")}>{msg} ✕</span>}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 2, background: T.card, border: `1px solid ${T.border}`, borderRadius: 999, padding: 3 }}>
          <button
            onClick={() => setAuto(!auto)}
            title={auto ? "Auto-refresh every 5 seconds — on" : "Auto-refresh off"}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "none", cursor: "pointer", borderRadius: 999, padding: "5px 11px", fontSize: 12, fontWeight: 600, background: auto ? "var(--g-primary,#6C3CE1)" : "transparent", color: auto ? "#fff" : T.sub }}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: auto ? "#6EE7B7" : T.sub, boxShadow: auto ? "0 0 6px #6EE7B7" : "none" }} />
            Live 5s
          </button>
          <button style={{ border: "none", background: "transparent", color: T.sub, cursor: "pointer", borderRadius: 999, padding: "5px 11px", fontSize: 12, fontWeight: 600 }} onClick={load}>Refresh</button>
        </div>
        <button
          onClick={syncSessions}
          disabled={syncing}
          title="Ask the routers who is really connected and close any ghost sessions the panel still shows as online"
          style={{ border: `1px solid ${T.border}`, background: T.card, color: T.sub, cursor: syncing ? "default" : "pointer", borderRadius: 999, padding: "5px 12px", fontSize: 12, fontWeight: 600, opacity: syncing ? 0.6 : 1 }}
        >
          {syncing ? "Syncing…" : "⟳ Sync sessions"}
        </button>
      </div>

      <LiveTraffic hist={rateHist} T={T} />

      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
          {[
            ["Online now", stats.online, T.green],
            ["Known subscribers", stats.knownSubscribers, T.accent],
            ["Total download", gb(stats.totalDownloadBytes), T.text],
            ["Total upload", gb(stats.totalUploadBytes), T.text],
          ].map(([label, val, color]) => (
            <div key={label as string} style={card}>
              <div style={{ fontSize: 11, color: T.muted, textTransform: "uppercase" }}>{label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: color as string }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      <div style={card}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
              <th style={th}>Subscriber</th><th style={th}>Username</th><th style={th}>IP</th><th style={th}>MAC</th>
              <th style={th}>Uptime</th><th style={{ ...th, textAlign: "right" }}>↓ / ↑</th><th style={{ ...th, textAlign: "right" }}>Rate</th><th style={th} />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s, i) => (
              <tr key={s.username + i} style={{ background: i % 2 ? "transparent" : T.row }}>
                <td style={td}>{s.fullName || <span style={{ color: T.muted }}>unknown</span>}<div style={{ fontSize: 11, color: T.muted }}>{s.package || ""}</div></td>
                <td style={{ ...td, color: T.sub }}>{s.username}</td>
                <td style={{ ...td, color: T.sub }}>{s.framedIp || "—"}</td>
                <td style={{ ...td, color: T.sub, fontSize: 11 }}>{s.mac || "—"}</td>
                <td style={td}>{hms(s.durationSeconds)}</td>
                <td style={{ ...td, textAlign: "right", fontSize: 12 }}>{gb(s.downloadBytes)} / {gb(s.uploadBytes)}</td>
                <td style={{ ...td, textAlign: "right", color: T.green }}>{rate(s.rateBps)}</td>
                <td style={{ ...td, whiteSpace: "nowrap", textAlign: "right" }}>
                  {s.subscriberId && <button style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub, marginRight: 6 }} onClick={() => openMac(s)}>MAC</button>}
                  {s.subscriberId && <button title="Change this customer's speed live via RADIUS CoA (no reconnect)" style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.sub, marginRight: 6 }} onClick={() => changeSpeed(s)}>Speed</button>}
                  <button style={btn(T.red)} onClick={() => disconnect(s.username)}>Disconnect</button>
                </td>
              </tr>
            ))}
            {!sessions.length && <tr><td style={{ ...td, color: T.muted }} colSpan={8}>No active sessions right now. (Sessions appear here when subscribers are online via RADIUS.)</td></tr>}
          </tbody>
        </table>
      </div>

      {macFor && (
        <Portal><div style={{ position: "fixed", inset: 0, background: "#000a", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000 }} onClick={() => setMacFor(null)}>
          <div style={{ ...card, width: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>MAC binding — {macFor.username}</h3>
            <div style={{ fontSize: 12, color: T.muted, marginBottom: 10 }}>Bound MACs restrict this user to only authenticate from those devices.</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input style={{ ...input, flex: 1 }} placeholder="AA:BB:CC:DD:EE:FF" value={macInput} onChange={(e) => setMacInput(e.target.value)} />
              <button style={btn(T.accent)} onClick={bindMac}>Bind</button>
              <button style={btn(T.green)} onClick={autolearn} title="Bind the MAC from the current live session">Auto-learn</button>
            </div>
            {macBinding?.boundMacs?.length ? macBinding.boundMacs.map((m: string) => (
              <div key={m} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${T.border}`, fontSize: 13 }}>
                <span style={{ fontFamily: "monospace" }}>{m}</span>
                <button style={btn(T.red)} onClick={() => unbind(m)}>Remove</button>
              </div>
            )) : <div style={{ fontSize: 12, color: T.muted }}>No MAC bound — user can connect from any device.</div>}
          </div>
        </div></Portal>
      )}
    </div>
  );
}
