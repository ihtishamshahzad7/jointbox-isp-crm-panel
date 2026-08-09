"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import API_BASE from "../components/api";

const API =
  API_BASE;

/**
 * Segments — subscriber base sliced by VLAN, router, area, reseller, package
 * and auth method, with live availability per slice.
 *
 * LAYOUT NOTE
 * This page must NOT use the `.db-root` class. In globals.css that class is
 * the app shell's own wrapper (display:flex, height:100vh) — applying it to a
 * page turns every section into a flex column laid out side by side, which is
 * exactly what broke the previous version.
 *
 * STYLING NOTE
 * Interaction states live in a real stylesheet below rather than in React
 * mouse handlers. Hover, focus and transitions belong to CSS: it is faster
 * (no re-render per hover), it supports :hover on children and media queries,
 * and it keeps the JSX readable.
 */

const DIMENSIONS = [
  { id: "vlan",       label: "VLAN",      hint: "Load and health per VLAN — the fastest way to spot a failing segment." },
  { id: "nas",        label: "Router",    hint: "How subscribers are spread across your MikroTiks." },
  { id: "area",       label: "Area",      hint: "Coverage areas — a quiet area usually means an outage." },
  { id: "reseller",   label: "Reseller",  hint: "Who owns which customers down the chain." },
  { id: "tier",       label: "Franchise / Dealer", hint: "Base split across ISP, franchise, dealer and sub-dealer tiers." },
  { id: "package",    label: "Package",   hint: "Which plans are actually selling." },
  { id: "cnic",       label: "CNIC / KYC", hint: "Identity coverage — verified, pending, missing. PTA compliance at a glance." },
  { id: "uptime",     label: "Uptime",    hint: "Stable vs down vs flapping — connection quality across the base." },
  { id: "outage",     label: "Outage",    hint: "How many customers sit inside an area with an active outage right now." },
  { id: "authMethod", label: "Auth Type", hint: "PPPoE, hotspot, static or DHCP." },
];

const REASON_TONE: Record<string, string> = { bad: "#ef4444", warn: "#f59e0b", muted: "#64748b" };

const PALETTE = [
  "#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ec4899", "#14b8a6",
  "#6366f1", "#f97316", "#84cc16", "#06b6d4", "#a855f7", "#eab308",
];

const HEALTH: Record<string, { c: string; label: string }> = {
  ok:       { c: "#10b981", label: "Healthy" },
  warning:  { c: "#f59e0b", label: "Degraded" },
  critical: { c: "#ef4444", label: "Likely fault" },
  unknown:  { c: "#64748b", label: "No customers" },
};

const nf = (n: number) => new Intl.NumberFormat().format(n);

/* Numbers counting up read as "live instrument" rather than "static report",
   and the motion draws the eye to a figure that has changed. */
function useCountUp(target: number, ms = 650) {
  const [n, setN] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      setN(Math.round(a + (target - a) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return n;
}

/** Donut drawn with stroke-dasharray so each ring animates itself into place. */
function Donut({
  data, total, onHover, hovered,
}: {
  data: Array<{ label: string; value: number; color: string }>;
  total: number;
  onHover: (i: number | null) => void;
  hovered: number | null;
}) {
  const R = 62, CIRC = 2 * Math.PI * R;
  const shown = hovered !== null ? data[hovered] : null;
  const centre = useCountUp(shown ? shown.value : total);

  let offset = 0;

  return (
    <div className="sg-donut-wrap">
      <svg viewBox="0 0 160 160" className="sg-donut">
        <circle cx="80" cy="80" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="16" />
        {data.map((d, i) => {
          const len = total ? (d.value / total) * CIRC : 0;
          const dash = `${len} ${CIRC - len}`;
          const rot = (offset / CIRC) * 360 - 90;
          offset += len;
          return (
            <circle
              key={i}
              cx="80" cy="80" r={R} fill="none"
              stroke={d.color}
              strokeWidth={hovered === i ? 20 : 16}
              strokeDasharray={dash}
              strokeLinecap={data.length > 1 ? "butt" : "round"}
              transform={`rotate(${rot} 80 80)`}
              className="sg-arc"
              style={{ opacity: hovered === null || hovered === i ? 1 : 0.28 }}
              onMouseEnter={() => onHover(i)}
              onMouseLeave={() => onHover(null)}
            />
          );
        })}
        <text x="80" y="76" textAnchor="middle" className="sg-donut-num">{nf(centre)}</text>
        <text x="80" y="92" textAnchor="middle" className="sg-donut-cap">
          {shown ? "in segment" : "subscribers"}
        </text>
      </svg>
    </div>
  );
}

function UpBar({ online, active, color }: { online: number; active: number; color: string }) {
  const pct = active > 0 ? Math.min(100, (online / active) * 100) : 0;
  return (
    <div className="sg-upbar">
      <div className="sg-upbar-track">
        <div className="sg-upbar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="sg-upbar-num">{online}/{active}</span>
    </div>
  );
}

export default function SegmentsPage() {
  const router = useRouter();
  const [dim, setDim] = useState("vlan");
  const [data, setData] = useState<any>(null);
  const [drill, setDrill] = useState<{ key: string; label: string; rows: any[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/segments`, { headers });
      if (r.ok) setData(await r.json());
    } catch { /* keep the last good view */ }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load();
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, [token]);

  // Escape closes the drawer — expected of anything that overlays the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrill(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function openDrill(key: string, label: string) {
    setBusy(true);
    setDrill({ key, label, rows: [] });
    try {
      const r = await fetch(`${API}/segments/${dim}/${encodeURIComponent(key)}`, { headers });
      setDrill({ key, label, rows: r.ok ? await r.json() : [] });
    } catch { setDrill({ key, label, rows: [] }); }
    setBusy(false);
  }

  const segments: any[] = data?.dimensions?.[dim] ?? [];
  const current = DIMENSIONS.find((x) => x.id === dim);
  const problems = segments.filter((s) => s.health === "critical" || s.health === "warning");
  const chartData = segments.slice(0, 12).map((s, i) => ({
    label: s.label, value: s.total, color: PALETTE[i % PALETTE.length],
  }));
  const chartTotal = chartData.reduce((s, d) => s + d.value, 0);

  const t = data?.totals ?? {};
  const upPct = t.active > 0 ? Math.round((t.online / t.active) * 100) : null;

  const cSubs = useCountUp(t.subscribers ?? 0);
  const cOnline = useCountUp(t.online ?? 0);
  const cActive = useCountUp(t.active ?? 0);
  const cFlag = useCountUp(problems.length);

  return (
    <div className="sg">
      <style>{CSS}</style>

      {loading ? (
        <div className="sg-strip">
          {[0, 1, 2, 3].map((i) => <div key={i} className="sg-stat"><div className="sg-skel" /></div>)}
        </div>
      ) : (
        <>
          {/* Summary */}
          <div className="sg-strip">
            {[
              { k: "Subscribers", v: cSubs, s: "in your scope", tone: "" },
              { k: "Online now",  v: cOnline, s: upPct !== null ? `${upPct}% of active` : "live sessions", tone: "good" },
              { k: "Active",      v: cActive, s: "billing current", tone: "" },
              { k: "Flagged",     v: cFlag, s: problems.length ? "need attention" : "all healthy",
                tone: problems.length ? "bad" : "dim" },
            ].map((s) => (
              <div key={s.k} className="sg-stat">
                <div className="sg-stat-k">{s.k}</div>
                <div className={`sg-stat-v ${s.tone}`}>{nf(s.v)}</div>
                <div className="sg-stat-s">{s.s}</div>
              </div>
            ))}
          </div>

          {/* Controls */}
          <div className="sg-controls">
            <div className="sg-seg" role="tablist">
              {DIMENSIONS.map((x) => (
                <button key={x.id} role="tab" aria-selected={dim === x.id}
                  className={`sg-seg-btn ${dim === x.id ? "on" : ""}`}
                  onClick={() => { setDim(x.id); setDrill(null); setHovered(null); }}>
                  {x.label}
                </button>
              ))}
            </div>
            <div className="sg-hint">{current?.hint}</div>
          </div>

          {/* Faults */}
          {problems.length > 0 && (
            <div className="sg-alert">
              <div className="sg-alert-h">
                <span className="sg-pulse" />
                {problems.length} {current?.label.toLowerCase()} segment{problems.length > 1 ? "s" : ""} below expected availability
              </div>
              {problems.map((p) => (
                <button key={p.key} className="sg-alert-row" onClick={() => openDrill(p.key, p.label)}>
                  <span className="sg-alert-name">{p.label}</span>
                  <span className="sg-alert-bar">
                    <UpBar online={p.online} active={p.active} color={HEALTH[p.health].c} />
                  </span>
                  <span className="sg-alert-pct" style={{ color: HEALTH[p.health].c }}>{p.onlinePercent}%</span>
                </button>
              ))}
            </div>
          )}

          {/* Advanced flagged reasons — the "why", across the whole scope */}
          {Array.isArray(data?.reasons) && data.reasons.length > 0 && (() => {
            const reasons = data.reasons as Array<{ key: string; label: string; count: number; tone: string }>;
            const rmax = Math.max(...reasons.map((r) => r.count), 1);
            const rtot = reasons.reduce((a, r) => a + r.count, 0);
            return (
              <section className="sg-card" style={{ marginBottom: 16 }}>
                <header className="sg-card-h bordered">
                  <h3>Why customers need attention</h3>
                  <p>Every flag raised across your scope right now — worst first. Click a reason to see who.</p>
                </header>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 20, padding: "8px 4px 4px", alignItems: "center" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {reasons.map((r) => {
                      const c = REASON_TONE[r.tone] || REASON_TONE.muted;
                      return (
                        <div key={r.key}
                          style={{ display: "grid", gridTemplateColumns: "180px 1fr 44px", alignItems: "center", gap: 10, padding: 0 }}>
                          <span style={{ fontSize: 12.5, color: "var(--text)" }}>{r.label}</span>
                          <span style={{ height: 14, borderRadius: 7, background: "var(--surface-2)", overflow: "hidden" }}>
                            <span style={{ display: "block", height: "100%", width: `${(r.count / rmax) * 100}%`, background: c, borderRadius: 7, transition: "width .5s ease" }} />
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: c, textAlign: "right" }}>{nf(r.count)}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ textAlign: "center", minWidth: 130 }}>
                    <div style={{ fontSize: 34, fontWeight: 800, color: "#ef4444", lineHeight: 1 }}>{nf(rtot)}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>total flags raised</div>
                  </div>
                </div>
              </section>
            );
          })()}

          {/* Charts + table */}
          <div className="sg-grid">
            <section className="sg-card sg-dist">
              <header className="sg-card-h">
                <h3>Distribution</h3>
                <p>by {current?.label.toLowerCase()}</p>
              </header>
              <Donut data={chartData} total={chartTotal} onHover={setHovered} hovered={hovered} />
              <ul className="sg-legend">
                {chartData.map((c, i) => (
                  <li key={c.label}
                    className={hovered !== null && hovered !== i ? "dim" : ""}
                    onMouseEnter={() => setHovered(i)}
                    onMouseLeave={() => setHovered(null)}>
                    <span className="sg-swatch" style={{ background: c.color }} />
                    <span className="sg-legend-label">{c.label}</span>
                    <span className="sg-legend-v">{nf(c.value)}</span>
                    <span className="sg-legend-p">{chartTotal ? Math.round((c.value / chartTotal) * 100) : 0}%</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="sg-card">
              <header className="sg-card-h bordered">
                <h3>Availability by {current?.label.toLowerCase()}</h3>
                <p>The bar shows how many active customers are actually connected. A short bar is a fault, not a quiet segment.</p>
              </header>
              <div className="sg-tablewrap">
                <table className="sg-table">
                  <thead>
                    <tr>
                      <th>{current?.label}</th>
                      <th>Availability</th>
                      <th className="r">Total</th>
                      <th className="r">Up</th>
                      <th className="r">Traffic</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segments.length === 0 && (
                      <tr><td colSpan={6} className="sg-empty">Nothing recorded for this grouping yet.</td></tr>
                    )}
                    {segments.map((s, i) => {
                      const h = HEALTH[s.health];
                      return (
                        <tr key={s.key} onClick={() => openDrill(s.key, s.label)}
                          onMouseEnter={() => setHovered(i < 12 ? i : null)}
                          onMouseLeave={() => setHovered(null)}
                          className={hovered === i ? "hot" : ""}>
                          <td>
                            <div className="sg-name">
                              <span className="sg-tick" style={{ background: PALETTE[i % PALETTE.length] }} />
                              <span>
                                <b>{s.label}</b>
                                {s.sub && <em>{s.sub}</em>}
                              </span>
                            </div>
                          </td>
                          <td className="sg-barcell"><UpBar online={s.online} active={s.active} color={h.c} /></td>
                          <td className="r strong">{nf(s.total)}</td>
                          <td className="r" style={{ color: s.online ? "#10b981" : "var(--muted)", fontWeight: 600 }}>
                            {nf(s.online)}
                          </td>
                          <td className="r muted">{s.gbTransferred} GB</td>
                          <td>
                            <span className="sg-status" style={{ color: h.c }}>
                              <i style={{ background: h.c }} />{h.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      )}

      {/* Drawer */}
      {drill && (
        <div className="sg-scrim" onClick={() => setDrill(null)}>
          <aside className="sg-drawer" onClick={(e) => e.stopPropagation()}>
            <header>
              <div>
                <span className="sg-eyebrow">{current?.label}</span>
                <h2>{drill.label}</h2>
                <p>{busy ? "Loading…" : `${drill.rows.length} subscriber${drill.rows.length === 1 ? "" : "s"} · ${drill.rows.filter((r) => r.online).length} online`}</p>
              </div>
              <button onClick={() => setDrill(null)} aria-label="Close">×</button>
            </header>
            <div className="sg-tablewrap grow">
              <table className="sg-table">
                <thead>
                  <tr>{["Subscriber", "State", "VLAN", "Router", "Traffic", "Last issue"].map((h) => <th key={h}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {drill.rows.map((r) => (
                    <tr key={r.id} onClick={() => router.push(`/subscribers/${r.id}`)}>
                      <td>
                        <b>{r.name}</b>
                        <em>{r.username}{r.phone ? ` · ${r.phone}` : ""}</em>
                      </td>
                      <td>
                        <span className="sg-status" style={{ color: r.online ? "#10b981" : "var(--muted)" }}>
                          <i style={{ background: r.online ? "#10b981" : "var(--muted)" }} />
                          {r.online ? "Online" : "Offline"}
                        </span>
                        <em>{r.status}</em>
                      </td>
                      <td className="muted">{r.vlan ?? "—"}</td>
                      <td className="muted">{r.nas ?? "—"}</td>
                      <td className="muted">{r.gbTransferred} GB</td>
                      <td style={{ color: r.lastDisconnect ? "#f59e0b" : "var(--muted)", fontSize: 11.5 }}>
                        {r.lastDisconnect ?? "—"}
                      </td>
                    </tr>
                  ))}
                  {!busy && drill.rows.length === 0 && (
                    <tr><td colSpan={6} className="sg-empty">No subscribers in this segment.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

/* Kept at the bottom so the component reads as structure, not styling. */
const CSS = `
.sg { padding: 4px 2px 24px; color: var(--text);
      font-variant-numeric: tabular-nums; }

/* ── Summary strip ── */
.sg-strip { display: grid; grid-template-columns: repeat(auto-fit,minmax(170px,1fr));
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  overflow: hidden; margin-bottom: 18px; }
.sg-stat { padding: 16px 20px; position: relative; transition: background .18s; }
.sg-stat + .sg-stat { border-left: 1px solid var(--border); }
.sg-stat:hover { background: var(--surface-2); }
.sg-stat::after { content:""; position:absolute; left:0; right:0; bottom:0; height:2px;
  background: linear-gradient(90deg,#3b82f6,#8b5cf6); transform: scaleX(0);
  transform-origin: left; transition: transform .25s ease; }
.sg-stat:hover::after { transform: scaleX(1); }
.sg-stat-k { font-size: 10px; font-weight: 600; color: var(--muted);
  text-transform: uppercase; letter-spacing: .07em; }
.sg-stat-v { font-size: 28px; font-weight: 700; letter-spacing: -.02em; line-height: 1.15; margin-top: 4px; }
.sg-stat-v.good { color: #10b981; } .sg-stat-v.bad { color: #ef4444; } .sg-stat-v.dim { color: var(--muted); }
.sg-stat-s { font-size: 11px; color: var(--muted); margin-top: 2px; }
.sg-skel { height: 56px; border-radius: 8px;
  background: linear-gradient(90deg,var(--surface-2) 25%,rgba(255,255,255,.06) 37%,var(--surface-2) 63%);
  background-size: 400% 100%; animation: sgShimmer 1.3s ease infinite; }
@keyframes sgShimmer { 0%{background-position:100% 50%} 100%{background-position:0 50%} }

/* ── Controls ── */
.sg-controls { display:flex; align-items:center; justify-content:space-between;
  gap:16px; flex-wrap:wrap; margin-bottom:16px; }
.sg-seg { display:inline-flex; gap:2px; padding:3px; border-radius:11px;
  background: var(--surface-2); border:1px solid var(--border); }
.sg-seg-btn { border:none; background:transparent; color:var(--muted); cursor:pointer;
  padding:7px 15px; border-radius:8px; font-size:12.5px; font-weight:500;
  transition: color .15s, background .15s, transform .12s; }
.sg-seg-btn:hover { color: var(--text); }
.sg-seg-btn:active { transform: scale(.96); }
.sg-seg-btn.on { background: var(--surface); color: var(--text); font-weight:600;
  box-shadow: 0 1px 3px rgba(0,0,0,.28); }
.sg-hint { font-size:12px; color:var(--muted); }

/* ── Fault callout ── */
.sg-alert { background: var(--surface); border:1px solid var(--border);
  border-left:3px solid #ef4444; border-radius:12px; padding:14px 18px; margin-bottom:18px; }
.sg-alert-h { display:flex; align-items:center; gap:9px; font-size:13px; font-weight:600; margin-bottom:10px; }
.sg-pulse { width:7px; height:7px; border-radius:99px; background:#ef4444;
  box-shadow:0 0 0 0 rgba(239,68,68,.6); animation: sgPulse 1.8s infinite; flex-shrink:0; }
@keyframes sgPulse { 70%{box-shadow:0 0 0 7px rgba(239,68,68,0)} 100%{box-shadow:0 0 0 0 rgba(239,68,68,0)} }
.sg-alert-row { display:flex; align-items:center; gap:14px; width:100%; padding:7px 8px;
  background:transparent; border:none; border-radius:8px; cursor:pointer; text-align:left;
  color:var(--muted); font-size:12.5px; transition: background .15s, transform .15s; }
.sg-alert-row:hover { background: var(--surface-2); transform: translateX(3px); }
.sg-alert-name { color:var(--text); font-weight:500; min-width:130px; }
.sg-alert-bar { flex:1; min-width:90px; max-width:220px; }
.sg-alert-pct { font-weight:600; min-width:44px; text-align:right; }

/* ── Grid ── */
.sg-grid { display:grid; grid-template-columns: minmax(230px,282px) minmax(0,1fr); gap:16px; align-items:start; }
@media (max-width: 900px) { .sg-grid { grid-template-columns: 1fr; } }

.sg-card { background:var(--surface); border:1px solid var(--border); border-radius:14px; overflow:hidden; }
.sg-card-h { padding:16px 18px 12px; }
.sg-card-h.bordered { border-bottom:1px solid var(--border); }
.sg-card-h h3 { margin:0; font-size:13px; font-weight:600; }
.sg-card-h p { margin:3px 0 0; font-size:11px; color:var(--muted); line-height:1.5; }
.sg-dist { padding-bottom:8px; }

/* ── Donut ── */
.sg-donut-wrap { padding: 4px 18px 0; }
.sg-donut { width:100%; max-width:190px; display:block; margin:0 auto; overflow:visible; }
.sg-arc { transition: opacity .18s ease, stroke-width .18s ease; cursor:pointer;
  animation: sgDraw .8s cubic-bezier(.4,0,.2,1) both; }
@keyframes sgDraw { from { stroke-dashoffset: 400; opacity:0 } to { stroke-dashoffset:0 } }
.sg-donut-num { fill:var(--text); font-size:26px; font-weight:700; letter-spacing:-.02em; }
.sg-donut-cap { fill:var(--muted); font-size:8.5px; letter-spacing:.08em; text-transform:uppercase; }

.sg-legend { list-style:none; margin:16px 0 0; padding:14px 18px 10px; border-top:1px solid var(--border);
  display:grid; gap:2px; }
.sg-legend li { display:flex; align-items:center; gap:9px; font-size:12px; padding:5px 7px;
  margin:0 -7px; border-radius:7px; cursor:default; transition: background .15s, opacity .15s; }
.sg-legend li:hover { background: var(--surface-2); }
.sg-legend li.dim { opacity:.4; }
.sg-swatch { width:9px; height:9px; border-radius:3px; flex-shrink:0; }
.sg-legend-label { flex:1; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sg-legend-v { font-weight:600; }
.sg-legend-p { color:var(--muted); font-size:11px; min-width:34px; text-align:right; }

/* ── Bars ── */
.sg-upbar { display:flex; align-items:center; gap:10px; }
.sg-upbar-track { flex:1; min-width:60px; height:6px; border-radius:99px;
  background:var(--surface-2); overflow:hidden; }
.sg-upbar-fill { height:100%; border-radius:99px; transition: width .45s cubic-bezier(.4,0,.2,1); }
.sg-upbar-num { font-size:11px; color:var(--muted); min-width:46px; text-align:right; }

/* ── Tables ── */
.sg-tablewrap { overflow-x:auto; }
.sg-tablewrap.grow { flex:1; overflow-y:auto; }
.sg-table { width:100%; border-collapse:collapse; min-width:600px; }
.sg-table th { text-align:left; padding:11px 16px; font-size:10px; font-weight:600; color:var(--muted);
  text-transform:uppercase; letter-spacing:.07em; border-bottom:1px solid var(--border);
  white-space:nowrap; position:sticky; top:0; background:var(--surface); z-index:1; }
.sg-table td { padding:13px 16px; font-size:13px; border-bottom:1px solid var(--border); vertical-align:middle; }
.sg-table th.r, .sg-table td.r { text-align:right; }
.sg-table td.muted { color:var(--muted); }
.sg-table td.strong { font-weight:600; }
.sg-table tbody tr { cursor:pointer; transition: background .13s; }
.sg-table tbody tr:hover, .sg-table tbody tr.hot { background:var(--surface-2); }
.sg-table tbody tr:last-child td { border-bottom:none; }
.sg-table td b { font-weight:500; display:block; }
.sg-table td em { font-style:normal; display:block; font-size:11px; color:var(--muted); margin-top:1px; }
.sg-barcell { width:210px; }
.sg-empty { text-align:center; color:var(--muted); padding:34px !important; }
.sg-name { display:flex; align-items:center; gap:10px; }
.sg-tick { width:3px; height:26px; border-radius:2px; flex-shrink:0; transition: height .18s; }
.sg-table tr:hover .sg-tick { height:32px; }
.sg-status { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:500; }
.sg-status i { width:6px; height:6px; border-radius:99px; display:inline-block; }

/* ── Drawer ── */
.sg-scrim { position:fixed; inset:0; z-index:60; display:flex; justify-content:flex-end;
  background:rgba(2,6,23,.62); backdrop-filter:blur(3px); animation: sgFade .18s ease; }
@keyframes sgFade { from{opacity:0} to{opacity:1} }
.sg-drawer { width:min(800px,100%); background:var(--surface); border-left:1px solid var(--border);
  display:flex; flex-direction:column; box-shadow:-24px 0 70px rgba(0,0,0,.45);
  animation: sgSlide .26s cubic-bezier(.4,0,.2,1); }
@keyframes sgSlide { from{transform:translateX(34px); opacity:.4} to{transform:none; opacity:1} }
.sg-drawer > header { display:flex; justify-content:space-between; align-items:flex-start;
  padding:18px 22px; border-bottom:1px solid var(--border); }
.sg-drawer h2 { margin:3px 0 0; font-size:17px; font-weight:600; }
.sg-drawer p { margin:3px 0 0; font-size:12px; color:var(--muted); }
.sg-eyebrow { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.07em; }
.sg-drawer > header button { background:transparent; border:none; color:var(--muted);
  font-size:24px; line-height:1; cursor:pointer; padding:0 4px; border-radius:6px; transition:color .15s, background .15s; }
.sg-drawer > header button:hover { color:var(--text); background:var(--surface-2); }
`;
