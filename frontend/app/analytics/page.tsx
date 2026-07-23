"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { money } from "../components/currency";

const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

/**
 * Analytics.
 *
 * DESIGN INTENT — advanced underneath, simple on the surface.
 *
 * The previous version put five equal-weight numbers, three charts and a
 * seven-column table on screen at once. Everything was available and nothing
 * was obvious: the eye had no idea where to land first.
 *
 * Rebuilt around three rules:
 *
 *  1. ANSWER FIRST. A plain-language verdict sits at the top — "Everything is
 *     running normally" or "2 segments need attention". You should know the
 *     state of the network in under a second, without reading a number.
 *
 *  2. ONE HERO. A single dominant figure with one large chart, rather than
 *     five competing tiles. Supporting numbers are deliberately smaller.
 *
 *  3. PROGRESSIVE DISCLOSURE. Healthy segments are collapsed by default —
 *     problems are shown, everything else is one click away. A table of forty
 *     healthy rows hides the two that matter.
 *
 * Depth is not removed, only deferred.
 */

const DIMS = [
  { id: "vlan", label: "VLAN" },
  { id: "area", label: "Area" },
  { id: "dealer", label: "Dealer" },
  { id: "nas", label: "Router" },
  { id: "package", label: "Package" },
];

export default function AnalyticsPage() {
  const router = useRouter();
  const [d, setD] = useState<any>(null);
  const [dim, setDim] = useState("vlan");
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);

  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/segments/command`, { headers });
      if (r.ok) setD(await r.json());
    } catch { /* keep the last good view */ }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, [token]);

  if (loading) {
    return <div className="nv"><style>{CSS}</style>
      <div className="nv-skel-hero" /><div className="nv-skel-row" /></div>;
  }

  const t = d?.totals ?? {};
  const rows: any[] = d?.dimensions?.[dim] ?? [];
  const problems = rows.filter((r) => r.health === "critical" || r.health === "warning");
  const healthy = rows.filter((r) => r.health !== "critical" && r.health !== "warning");
  const shown = showAll ? rows : (problems.length ? problems : rows.slice(0, 5));

  const uptime = t.active ? Math.round((t.online / t.active) * 100) : 100;
  const critical = rows.filter((r) => r.health === "critical").length;

  // The single sentence that decides how the page reads. Severity comes from
  // the network, never from how much data happens to be on screen.
  const verdict = critical > 0
    ? { tone: "bad", head: `${critical} segment${critical > 1 ? "s" : ""} down`,
        line: "Most customers on these are offline. This is a network fault, not individual complaints." }
    : problems.length > 0
      ? { tone: "warn", head: `${problems.length} segment${problems.length > 1 ? "s" : ""} degraded`,
          line: "Fewer customers online than expected. Worth checking before they call you." }
      : { tone: "ok", head: "Everything is running normally",
          line: `${t.online ?? 0} of ${t.active ?? 0} active connections are online.` };

  return (
    <div className="nv">
      <style>{CSS}</style>

      {/* ── 1 · THE ANSWER ─────────────────────────────────── */}
      <section className={`nv-verdict ${verdict.tone}`}>
        <span className="orb" />
        <div className="txt">
          <h1>{verdict.head}</h1>
          <p>{verdict.line}</p>
        </div>
        <div className="live"><i />Live</div>
      </section>

      {/* ── 2 · THE HERO ───────────────────────────────────── */}
      <section className="nv-hero">
        <div className="gauge">
          <Gauge percent={uptime} />
          <div className="gauge-cap">
            <b>{t.online ?? 0}</b>
            <span>online of {t.active ?? 0} active</span>
          </div>
        </div>

        <div className="figures">
          {[
            { k: "Total subscribers", v: (t.subscribers ?? 0).toLocaleString(),
              s: `${d?.hierarchy?.dealerCount ?? 0} dealers · ${d?.hierarchy?.subDealerCount ?? 0} sub-dealers` },
            { k: "Monthly revenue", v: money(t.monthlyRevenue ?? 0), s: "from active connections" },
            { k: "Expiring this week", v: (t.expiringSoon ?? 0).toLocaleString(),
              s: "renew before they lapse", tone: t.expiringSoon ? "warn" : "" },
            { k: "Expired", v: (t.expired ?? 0).toLocaleString(),
              s: "waiting on renewal", tone: t.expired ? "bad" : "" },
          ].map((f) => (
            <div className="fig" key={f.k}>
              <span className="k">{f.k}</span>
              <b className={f.tone}>{f.v}</b>
              <span className="s">{f.s}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── 3 · WHERE ──────────────────────────────────────── */}
      <div className="nv-bar">
        <div className="seg">
          {DIMS.map((x) => (
            <button key={x.id} className={dim === x.id ? "on" : ""}
              onClick={() => { setDim(x.id); setShowAll(false); }}>{x.label}</button>
          ))}
        </div>
        {healthy.length > 0 && problems.length > 0 && (
          <button className="link" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Show only problems" : `Show all ${rows.length}`}
          </button>
        )}
      </div>

      <section className="nv-list">
        {shown.length === 0 && (
          <div className="nv-none">Nothing recorded for this grouping yet.</div>
        )}
        {shown.map((r) => {
          const pct = r.active ? Math.round((r.online / r.active) * 100) : null;
          const tone = r.health === "critical" ? "bad" : r.health === "warning" ? "warn" : "ok";
          return (
            <article key={r.key} className={`row ${tone}`}>
              <div className="lead">
                <span className="dot" />
                <div>
                  <b>{r.label}</b>
                  {r.sub && <em>{r.sub}</em>}
                </div>
              </div>

              <div className="meter">
                <div className="track"><div style={{ width: `${pct ?? 0}%` }} /></div>
                <span className="pct">{pct === null ? "—" : `${pct}%`}</span>
              </div>

              <div className="nums">
                <span><b>{r.total}</b>total</span>
                <span><b className="ok">{r.active}</b>active</span>
                {r.expired > 0 && <span><b className="bad">{r.expired}</b>expired</span>}
                <span><b>{r.online}</b>online</span>
              </div>
            </article>
          );
        })}

        {!showAll && problems.length > 0 && healthy.length > 0 && (
          <button className="nv-more" onClick={() => setShowAll(true)}>
            {healthy.length} healthy {DIMS.find((x) => x.id === dim)?.label.toLowerCase()} segment
            {healthy.length > 1 ? "s" : ""} hidden — show all
          </button>
        )}
      </section>

      {/* ── 4 · WAITING ON SOMEONE ─────────────────────────── */}
      <section className="nv-queue">
        {[
          { l: "Open tickets", v: d?.tickets?.open ?? 0, tone: d?.tickets?.open ? "warn" : "" },
          { l: "In progress", v: d?.tickets?.inProgress ?? 0, tone: "" },
          { l: "Unpaid invoices", v: d?.billing?.unpaidCount ?? 0,
            s: money(d?.billing?.unpaidAmount ?? 0), tone: d?.billing?.unpaidCount ? "bad" : "" },
          { l: "Never connected", v: t.neverConnected ?? 0, s: "created, never dialled in", tone: "" },
        ].map((q) => (
          <div className="q" key={q.l}>
            <span className="k">{q.l}</span>
            <b className={q.tone}>{Number(q.v).toLocaleString()}</b>
            {q.s && <span className="s">{q.s}</span>}
          </div>
        ))}
      </section>
    </div>
  );
}

/** One large ring. A single clear figure beats four competing donuts. */
function Gauge({ percent }: { percent: number }) {
  const R = 78, C = 2 * Math.PI * R;
  const p = Math.max(0, Math.min(100, percent));
  const colour = p >= 80 ? "#10B981" : p >= 50 ? "#F59E0B" : "#EF4444";
  return (
    <svg viewBox="0 0 200 200" className="ring">
      <defs>
        <linearGradient id="gRing" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={colour} />
          <stop offset="100%" stopColor={p >= 80 ? "#92FE9D" : p >= 50 ? "#FFD200" : "#E9408B"} />
        </linearGradient>
      </defs>
      <circle cx="100" cy="100" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="14" />
      <circle
        cx="100" cy="100" r={R} fill="none" stroke="url(#gRing)" strokeWidth="14"
        strokeLinecap="round" strokeDasharray={`${(C * p) / 100} ${C}`}
        transform="rotate(-90 100 100)"
        style={{ animation: "nvRing 1.1s cubic-bezier(.2,.8,.2,1) both" }}
      />
      <text x="100" y="96" textAnchor="middle" className="ring-n" style={{ fill: colour }}>{p}%</text>
      <text x="100" y="118" textAnchor="middle" className="ring-l">uptime</text>
    </svg>
  );
}

const CSS = `
.nv{padding:4px 2px 32px;color:var(--text);font-variant-numeric:tabular-nums;
  --ok:#10B981;--warn:#F59E0B;--bad:#EF4444}

/* skeletons */
.nv-skel-hero,.nv-skel-row{border-radius:20px;
  background:linear-gradient(90deg,var(--surface) 25%,rgba(255,255,255,.05) 37%,var(--surface) 63%);
  background-size:400% 100%;animation:nvShim 1.3s ease infinite}
.nv-skel-hero{height:104px;margin-bottom:16px}.nv-skel-row{height:240px}
@keyframes nvShim{0%{background-position:100% 50%}100%{background-position:0 50%}}
@keyframes nvRing{from{stroke-dasharray:0 9999}}

/* ── 1 · verdict ── */
.nv-verdict{display:flex;align-items:center;gap:20px;padding:22px 26px;border-radius:20px;
  margin-bottom:16px;position:relative;overflow:hidden;
  background:var(--surface);border:1px solid var(--border)}
.nv-verdict::before{content:"";position:absolute;inset:0;opacity:.10;pointer-events:none}
.nv-verdict.ok::before{background:radial-gradient(circle at 12% 50%,#10B981,transparent 62%)}
.nv-verdict.warn::before{background:radial-gradient(circle at 12% 50%,#F59E0B,transparent 62%)}
.nv-verdict.bad::before{background:radial-gradient(circle at 12% 50%,#EF4444,transparent 62%)}
.nv-verdict .orb{width:46px;height:46px;border-radius:50%;flex-shrink:0;position:relative}
.nv-verdict.ok .orb{background:linear-gradient(135deg,#00C9FF,#92FE9D);box-shadow:0 0 26px rgba(16,185,129,.5)}
.nv-verdict.warn .orb{background:linear-gradient(135deg,#F7971E,#FFD200);box-shadow:0 0 26px rgba(245,158,11,.5)}
.nv-verdict.bad .orb{background:linear-gradient(135deg,#F43F5E,#E9408B);box-shadow:0 0 26px rgba(239,68,68,.55);
  animation:nvBeat 1.9s ease-in-out infinite}
@keyframes nvBeat{50%{transform:scale(1.08)}}
.nv-verdict .txt{flex:1;min-width:0;position:relative}
.nv-verdict h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.025em}
.nv-verdict p{margin:5px 0 0;font-size:13px;color:var(--muted);line-height:1.5}
.nv-verdict .live{display:inline-flex;align-items:center;gap:7px;padding:6px 13px;border-radius:99px;
  background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);color:#10B981;
  font-size:11px;font-weight:700;flex-shrink:0;position:relative}
.nv-verdict .live i{width:6px;height:6px;border-radius:99px;background:#10B981;animation:nvP 2s infinite}
@keyframes nvP{0%{box-shadow:0 0 0 0 rgba(16,185,129,.5)}
  70%{box-shadow:0 0 0 7px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}

/* ── 2 · hero ── */
.nv-hero{display:grid;grid-template-columns:minmax(220px,270px) 1fr;gap:20px;align-items:center;
  background:var(--surface);border:1px solid var(--border);border-radius:20px;
  padding:26px 30px;margin-bottom:20px}
@media(max-width:820px){.nv-hero{grid-template-columns:1fr}}
.gauge{text-align:center}
.ring{width:100%;max-width:190px;display:block;margin:0 auto}
.ring-n{font-size:36px;font-weight:800;letter-spacing:-.03em}
.ring-l{fill:var(--muted);font-size:10px;letter-spacing:.1em;text-transform:uppercase}
.gauge-cap{margin-top:10px}
.gauge-cap b{display:block;font-size:20px;font-weight:700}
.gauge-cap span{font-size:11.5px;color:var(--muted)}

.figures{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:26px}
.fig .k{display:block;font-size:10.5px;font-weight:600;color:var(--muted);
  text-transform:uppercase;letter-spacing:.07em}
.fig b{display:block;font-size:26px;font-weight:800;letter-spacing:-.03em;margin-top:6px;line-height:1.1}
.fig b.warn{color:var(--warn)}.fig b.bad{color:var(--bad)}
.fig .s{display:block;font-size:11.5px;color:var(--muted);margin-top:3px}

/* ── 3 · segments ── */
.nv-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;
  flex-wrap:wrap;margin-bottom:12px}
.seg{display:inline-flex;gap:2px;padding:3px;border-radius:12px;background:var(--surface-2);
  border:1px solid var(--border)}
.seg button{border:none;background:transparent;color:var(--muted);cursor:pointer;padding:7px 16px;
  border-radius:9px;font-size:12.5px;font-weight:500;font-family:inherit;
  transition:color .15s,background .15s,transform .12s}
.seg button:hover{color:var(--text)}
.seg button:active{transform:scale(.96)}
.seg button.on{background:linear-gradient(135deg,#6C3CE1,#E9408B);color:#fff;font-weight:600;
  box-shadow:0 4px 14px rgba(233,64,139,.3)}
.link{background:none;border:none;color:#A78BFA;font-size:12px;font-weight:600;cursor:pointer;
  font-family:inherit;padding:4px 2px}
.link:hover{text-decoration:underline}

.nv-list{display:grid;gap:8px;margin-bottom:20px}
.row{display:grid;grid-template-columns:minmax(150px,1.1fr) minmax(120px,1fr) auto;
  gap:20px;align-items:center;padding:16px 20px;border-radius:16px;
  background:var(--surface);border:1px solid var(--border);border-left-width:3px;
  transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s,border-color .2s}
.row:hover{transform:translateX(3px);box-shadow:0 10px 30px rgba(0,0,0,.26)}
.row.ok{border-left-color:var(--ok)}
.row.warn{border-left-color:var(--warn)}
.row.bad{border-left-color:var(--bad)}
@media(max-width:760px){.row{grid-template-columns:1fr;gap:12px}}
.row .lead{display:flex;align-items:center;gap:11px;min-width:0}
.row .dot{width:8px;height:8px;border-radius:99px;flex-shrink:0}
.row.ok .dot{background:var(--ok)}
.row.warn .dot{background:var(--warn)}
.row.bad .dot{background:var(--bad);animation:nvP2 1.8s infinite}
@keyframes nvP2{0%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}
  70%{box-shadow:0 0 0 6px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
.row .lead b{display:block;font-size:14px;font-weight:600}
.row .lead em{display:block;font-style:normal;font-size:11px;color:var(--muted);margin-top:1px}

.row .meter{display:flex;align-items:center;gap:11px}
.row .track{flex:1;height:7px;border-radius:99px;background:var(--surface-2);overflow:hidden;min-width:70px}
.row .track div{height:100%;border-radius:99px;transition:width .55s cubic-bezier(.2,.8,.2,1)}
.row.ok .track div{background:linear-gradient(90deg,#00C9FF,#92FE9D)}
.row.warn .track div{background:linear-gradient(90deg,#F7971E,#FFD200)}
.row.bad .track div{background:linear-gradient(90deg,#F43F5E,#E9408B)}
.row .pct{font-size:13px;font-weight:700;min-width:42px;text-align:right}
.row.ok .pct{color:var(--ok)}.row.warn .pct{color:var(--warn)}.row.bad .pct{color:var(--bad)}

.row .nums{display:flex;gap:20px}
.row .nums span{display:flex;flex-direction:column;font-size:10px;color:var(--muted);
  text-transform:uppercase;letter-spacing:.05em}
.row .nums b{font-size:16px;font-weight:700;color:var(--text);letter-spacing:-.02em;
  text-transform:none;letter-spacing:0}
.row .nums b.ok{color:var(--ok)}.row .nums b.bad{color:var(--bad)}

.nv-none{padding:36px;text-align:center;color:var(--muted);font-size:13px;
  background:var(--surface);border:1px dashed var(--border);border-radius:16px}
.nv-more{width:100%;padding:13px;border-radius:14px;background:transparent;
  border:1px dashed var(--border);color:var(--muted);font-size:12px;font-family:inherit;
  cursor:pointer;transition:color .18s,border-color .18s,background .18s}
.nv-more:hover{color:var(--text);border-color:rgba(140,90,255,.4);background:var(--surface)}

/* ── 4 · queue ── */
.nv-queue{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
  background:var(--surface);border:1px solid var(--border);border-radius:18px;overflow:hidden}
.q{padding:18px 22px;transition:background .18s}
.q+.q{border-left:1px solid var(--border)}
.q:hover{background:var(--surface-2)}
.q .k{display:block;font-size:10.5px;font-weight:600;color:var(--muted);
  text-transform:uppercase;letter-spacing:.07em}
.q b{display:block;font-size:24px;font-weight:800;letter-spacing:-.03em;margin-top:5px}
.q b.warn{color:var(--warn)}.q b.bad{color:var(--bad)}
.q .s{display:block;font-size:11px;color:var(--muted);margin-top:2px}

@media (prefers-reduced-motion: reduce){
  .row,.row .track div,.q,.nv-more{transition:none}
  .nv-verdict.bad .orb,.row.bad .dot,.nv-verdict .live i,.ring circle,
  .nv-skel-hero,.nv-skel-row{animation:none}
}
`;
