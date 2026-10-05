"use client";

/**
 * DISCONNECT REASONS (Logs tab) — why customers' sessions ended.
 *
 * Every RADIUS session closes with an Acct-Terminate-Cause (RFC 2866): one of
 * eighteen standard reasons, from "User Request" to "Host Request". This page
 * lays all eighteen out with how often each happened in the chosen window, and
 * for whichever cause or category is picked shows the related records — the
 * sessions, the customers who hit it most and the routers it happened on.
 *
 * Data: GET /logs/disconnects — scoped server-side to the caller's own
 * customers, the same as the subscriber list.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import API from "../components/api";
import {
  CauseBadge, SeverityTag, CATEGORY_META, CATEGORY_ORDER, SEVERITY_META, catVar,
  type CauseCategory, type CauseSeverity,
} from "./terminate-cause";
import s from "./disconnects.module.css";

type Cause = {
  code: number; key: string; label: string; description: string; meaning: string; action: string;
  category: CauseCategory; severity: CauseSeverity; standard: boolean;
  count: number; share: number; customers: number; avgSessionSec: number | null; lastAt: string | null;
};
type Category = { id: CauseCategory; label: string; about: string; count: number; share: number };
type Top = { key: string; label: string; count: number };
type RecordRow = {
  id: string; sessionId: string; username: string | null; subscriberId: number | null; fullName: string | null;
  nasIp: string; nasName: string | null; nasPortId: string | null; nasPortType: string | null;
  framedIp: string | null; mac: string | null; service: string | null;
  start: string | null; stop: string | null; durationSec: number | null;
  downloadBytes: number | null; uploadBytes: number | null; rawCause: string | null;
  terminateCode: number; terminateKey: string; terminateLabel: string; terminateDescription: string;
  terminateMeaning: string; terminateAction: string; terminateCategory: CauseCategory; terminateSeverity: CauseSeverity;
};
type Report = {
  window: { sinceHours: number; from: string; to: string; unit: "hour" | "day" };
  totals: { ended: number; openNow: number; customers: number; avgSessionSec: number | null; abnormal: number; abnormalShare: number; topCause: Top | null };
  causes: Cause[];
  categories: Category[];
  trend: { unit: "hour" | "day"; partial: boolean; buckets: { at: string; counts: Record<string, number> }[] };
  routers: { nasIp: string; name: string | null; count: number; abnormal: number; top: Top[] }[];
  customers: { username: string; subscriberId: number | null; fullName: string | null; count: number; abnormal: number; lastAt: string | null; lastKey: string; top: Top[] }[];
  records: RecordRow[];
  recordsTotal: number;
};

const WINDOWS: Array<[number, string]> = [[24, "24 hours"], [168, "7 days"], [720, "30 days"], [2160, "90 days"]];
const PAGE = 50;

// ── formatting ─────────────────────────────────────────────────
const nf = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString());
const pct = (x: number) => (x > 0 && x < 0.001 ? "<0.1%" : `${(x * 100).toFixed(x >= 0.1 ? 0 : 1)}%`);
function dur(sec: number | null | undefined) {
  if (sec == null || !isFinite(Number(sec))) return "—";
  const t = Math.max(0, Math.round(Number(sec)));
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${t % 60}s`;
  return `${t}s`;
}
function bytes(b: number | null | undefined) {
  if (b == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let v = Number(b), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
const when = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
function ago(d: string | null | undefined) {
  if (!d) return "—";
  const sec = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export default function DisconnectsPanel() {
  const [hours, setHours] = useState(168);
  const [cause, setCause] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [nasIp, setNasIp] = useState("");
  const [userInput, setUserInput] = useState("");
  const [username, setUsername] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [routerOptions, setRouterOptions] = useState<Record<string, string | null>>({});
  const reqId = useRef(0);

  // Deep links: /disconnects?username=…&cause=…
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const u = q.get("username"); if (u) { setUserInput(u); setUsername(u); }
      const c = q.get("cause"); if (c) setCause(c);
      const h = Number(q.get("hours")); if (WINDOWS.some(([w]) => w === h)) setHours(h);
    } catch { /* no query */ }
  }, []);

  // Username box applies after typing stops.
  useEffect(() => {
    const t = setTimeout(() => { setUsername(userInput.trim()); setOffset(0); }, 450);
    return () => clearTimeout(t);
  }, [userInput]);

  const load = useCallback(async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
    if (!token) { setErr("Sign in to see disconnects."); return; }
    const id = ++reqId.current;
    setBusy(true);
    const q = new URLSearchParams({ sinceHours: String(hours), limit: String(PAGE), offset: String(offset), tz: String(new Date().getTimezoneOffset()) });
    if (cause) q.set("cause", cause);
    if (category) q.set("category", category);
    if (nasIp) q.set("nasIp", nasIp);
    if (username) q.set("username", username);
    try {
      const r = await fetch(`${API}/logs/disconnects?${q}`, { headers: { Authorization: `Bearer ${token}` } });
      if (id !== reqId.current) return;
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        setErr(r.status === 403
          ? (body?.message || "Your account does not have access to session logs.")
          : (body?.message || `Could not load disconnects (HTTP ${r.status}).`));
        return;
      }
      const j: Report = await r.json();
      setData(j);
      setErr("");
      setRouterOptions((prev) => {
        const next = { ...prev };
        for (const x of j.routers || []) next[x.nasIp] = x.name || next[x.nasIp] || null;
        return next;
      });
    } catch {
      if (id === reqId.current) setErr("Could not reach the server. Check your connection and try again.");
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  }, [hours, cause, category, nasIp, username, offset]);

  useEffect(() => { void load(); }, [load]);

  const byKey = useMemo(() => new Map((data?.causes || []).map((c) => [c.key, c])), [data]);
  const badgeFor = (key: string, label?: string) => {
    const c = byKey.get(key);
    return { code: c?.code || 0, key, label: c?.label || label || key, category: c?.category || "other", severity: c?.severity || "info", description: c?.description, meaning: c?.meaning };
  };

  const pickCause = (key: string) => { setCause((c) => (c === key ? "" : key)); setCategory(""); setOffset(0); setOpenRow(null); };
  const pickCategory = (id: string) => { setCategory((c) => (c === id ? "" : id)); setCause(""); setOffset(0); setOpenRow(null); };
  const clearSel = () => { setCause(""); setCategory(""); setOffset(0); setOpenRow(null); };

  const standard = (data?.causes || []).filter((c) => c.standard);
  const extra = (data?.causes || []).filter((c) => !c.standard && c.count > 0);
  const maxCause = Math.max(1, ...standard.map((c) => c.count), ...extra.map((c) => c.count));
  const sel = cause ? byKey.get(cause) : null;
  const selCat = category ? data?.categories.find((c) => c.id === category) : null;
  const t = data?.totals;

  return (
    <div id={s.root} className={`${s.page}${busy && data ? " " + s.loading : ""}`}>
      <header className={s.head}>
        <div>
          <div className={s.eyebrow}>RADIUS · Acct-Terminate-Cause</div>
          <h2>Why sessions ended</h2>
          <p>Every disconnect across your customers, grouped by the eighteen standard termination causes. Pick a cause or a category to see the sessions, customers and routers behind it.</p>
        </div>
        <div className={s.controls}>
          <div className={s.seg} role="group" aria-label="Time window">
            {WINDOWS.map(([h, label]) => (
              <button key={h} type="button" aria-pressed={hours === h} onClick={() => { setHours(h); setOffset(0); }}>{label}</button>
            ))}
          </div>
          <select id="disc-router" className={s.select} value={nasIp} aria-label="Router"
            onChange={(e) => { setNasIp(e.target.value); setOffset(0); }}>
            <option value="">All routers</option>
            {Object.entries(routerOptions).map(([ip, name]) => (
              <option key={ip} value={ip}>{name ? `${name} (${ip})` : ip}</option>
            ))}
          </select>
          <input id="disc-user" className={s.userBox} placeholder="Customer username" value={userInput}
            aria-label="Customer username" onChange={(e) => setUserInput(e.target.value)} />
        </div>
      </header>

      {err && <div className={s.error} role="alert">{err}</div>}

      {/* ── Summary ── */}
      <section className={s.stats} aria-label="Summary">
        <Stat label="Sessions ended" value={nf(t?.ended)} sub={data ? `in the last ${WINDOWS.find(([h]) => h === data.window.sinceHours)?.[1] || `${data.window.sinceHours}h`}` : "…"} />
        <Stat label="Customers affected" value={nf(t?.customers)} sub="had at least one disconnect" />
        <Stat label="Need attention" value={nf(t?.abnormal)} warn={!!t?.abnormal}
          sub={t ? `${pct(t.abnormalShare)} were faults or line drops` : "…"} />
        <Stat label="Online now" value={nf(t?.openNow)} sub="sessions reporting in" />
        <Stat label="Average session" value={dur(t?.avgSessionSec)} sub="before it ended" />
        <Stat label="Most common" value={t?.topCause ? t.topCause.label : "—"}
          sub={t?.topCause ? `${nf(t.topCause.count)} sessions` : "nothing ended yet"} />
      </section>

      {/* ── Category split + trend + routers ── */}
      <div className={s.twoCol}>
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>Who or what ended them</h3>
            <span>Click a category to filter</span>
          </div>
          <div className={s.split} aria-label="Share by category">
            {(data?.categories || []).filter((c) => c.count > 0).map((c) => (
              <button key={c.id} type="button" style={{ ...catVar(c.id), width: `${c.share * 100}%` }}
                title={`${c.label}: ${nf(c.count)} (${pct(c.share)}) — ${c.about}`} aria-label={`${c.label} ${pct(c.share)}`}
                onClick={() => pickCategory(c.id)} />
            ))}
          </div>
          <div className={s.splitLegend}>
            {(data?.categories || []).filter((c) => c.id !== "other" || c.count > 0).map((c) => (
              <button key={c.id} type="button" className={`${s.catPick}${c.count ? "" : " " + s.zero}`} style={catVar(c.id)}
                aria-pressed={category === c.id} title={c.about} onClick={() => pickCategory(c.id)}>
                <i />{c.label} <b>{nf(c.count)}</b> <em>{pct(c.share)}</em>
              </button>
            ))}
          </div>
          <div className={s.subHead}>Over time</div>
          <Trend data={data} />
        </section>

        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>By router</h3>
            <span>{sel ? sel.label : selCat ? selCat.label : "All causes"}</span>
          </div>
          {!data?.routers?.length ? (
            <div className={s.empty}>No disconnects in this window.</div>
          ) : (
            <div className={s.bars}>
              {data.routers.map((r) => {
                const max = Math.max(1, data.routers[0]?.count || 1);
                return (
                  <div key={r.nasIp} className={s.barRow}>
                    <div className={s.barTop}>
                      <strong title={r.nasIp}>{r.name || r.nasIp}</strong>
                      <span>{nf(r.count)}{r.abnormal ? ` · ${nf(r.abnormal)} need attention` : ""}</span>
                    </div>
                    <div className={s.track} title={`${nf(r.abnormal)} faults or line drops of ${nf(r.count)}`}>
                      <i style={{ width: `${(r.abnormal / max) * 100}%`, background: SEVERITY_META.warn.color }} />
                      <i style={{ width: `${((r.count - r.abnormal) / max) * 100}%`, background: "var(--accent)", opacity: .55 }} />
                    </div>
                    <div className={s.tagRow}>
                      {r.name && <span className={s.faint}>{r.nasIp}</span>}
                      {r.top.map((x) => <CauseBadge key={x.key} compact cause={{ ...badgeFor(x.key, x.label), label: `${badgeFor(x.key, x.label).label} · ${nf(x.count)}` }} />)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* ── All 18 standard causes ── */}
      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>All termination causes</h3>
          <span>RFC 2866 · routers send the number or the name · click to see the related records</span>
        </div>
        <div className={s.causeGrid}>
          {standard.map((c) => <CauseCard key={c.key} c={c} max={maxCause} active={cause === c.key} onPick={pickCause} />)}
        </div>
        {extra.length > 0 && (
          <>
            <div className={s.subHead}>Panel and non-standard causes</div>
            <div className={s.causeGrid}>
              {extra.map((c) => <CauseCard key={c.key} c={c} max={maxCause} active={cause === c.key} onPick={pickCause} />)}
            </div>
          </>
        )}
        <div className={s.splitLegend} aria-label="Severity legend" style={{ marginTop: 12 }}>
          {(Object.keys(SEVERITY_META) as CauseSeverity[]).map((k) => (
            <span key={k} title={SEVERITY_META[k].about} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)" }}>
              <SeverityTag severity={k} /> {SEVERITY_META[k].about}
            </span>
          ))}
        </div>
      </section>

      {/* ── Selection detail ── */}
      {(sel || selCat) && (
        <section className={s.focus} style={catVar(sel ? sel.category : selCat!.id)} aria-live="polite">
          <div className={s.focusHead}>
            <div className={s.focusTitle}>
              <span className={`${s.num}${sel?.code ? "" : " " + s.dot}`} style={catVar(sel ? sel.category : selCat!.id)}>{sel ? (sel.code || "•") : "•"}</span>
              <div>
                <h3>{sel ? sel.label : selCat!.label} {sel && <SeverityTag severity={sel.severity} />}</h3>
                <p>{sel ? sel.description : selCat!.about}</p>
              </div>
            </div>
            <button type="button" className={s.clear} onClick={clearSel}>Show all causes</button>
          </div>
          {sel && (
            <dl className={s.explain}>
              <div><dt>What it usually means</dt><dd>{sel.meaning}</dd></div>
              <div><dt>What to check</dt><dd>{sel.action}</dd></div>
              <div>
                <dt>In this window</dt>
                <dd>
                  {nf(sel.count)} session{sel.count === 1 ? "" : "s"} ({pct(sel.share)}) · {nf(sel.customers)} customer{sel.customers === 1 ? "" : "s"}
                  <br />Average session {dur(sel.avgSessionSec)} · last {ago(sel.lastAt)}
                  <br /><span className={s.faint}>{sel.code ? `Code ${sel.code} · ` : ""}{sel.key}</span>
                </dd>
              </div>
            </dl>
          )}
          {selCat && (
            <div className={s.tagRow}>
              {(data?.causes || []).filter((c) => c.category === selCat.id && (c.standard || c.count)).map((c) => (
                <button key={c.key} type="button" className={s.catPick} style={catVar(c.category)} onClick={() => pickCause(c.key)}
                  title={c.description}>
                  <i />{c.code ? `${c.code} · ` : ""}{c.label} <b>{nf(c.count)}</b>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Customers ── */}
      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>Customers who disconnected most</h3>
          <span>{sel ? `with ${sel.label}` : selCat ? `in ${selCat.label}` : "all causes"} · top 15</span>
        </div>
        {!data?.customers?.length ? (
          <div className={s.empty}>{data ? "No customer disconnects match." : "Loading…"}</div>
        ) : (
          <div className={s.tableWrap}>
            <table className={`${s.table} ${s.plain}`}>
              <thead><tr>
                <th>Customer</th><th className={s.r}>Disconnects</th><th className={s.r}>Need attention</th><th>Last</th><th>Most common causes</th>
              </tr></thead>
              <tbody>
                {data.customers.map((c) => (
                  <tr key={c.username}>
                    <td>
                      <div className={s.who}>
                        {c.subscriberId ? <Link href={`/subscribers/${c.subscriberId}`}>{c.fullName || c.username}</Link> : (c.fullName || c.username)}
                      </div>
                      <div className={s.whoSub}>{c.username}</div>
                    </td>
                    <td className={s.r}><b>{nf(c.count)}</b></td>
                    <td className={s.r} style={{ color: c.abnormal ? SEVERITY_META.warn.color : "var(--muted)" }}>{nf(c.abnormal)}</td>
                    <td>
                      <div>{ago(c.lastAt)}</div>
                      {c.lastKey && <div className={s.whoSub}>{badgeFor(c.lastKey).label}</div>}
                    </td>
                    <td><div className={s.tagRow}>{c.top.map((x) => (
                      <CauseBadge key={x.key} compact cause={{ ...badgeFor(x.key, x.label), label: `${badgeFor(x.key, x.label).label} · ${nf(x.count)}` }} />
                    ))}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Session records ── */}
      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>{sel ? `Sessions ended by ${sel.label}` : selCat ? `Sessions ended — ${selCat.label}` : "Latest disconnects"}</h3>
          <span>{data ? `${nf(data.recordsTotal)} session${data.recordsTotal === 1 ? "" : "s"} · click a row for every detail` : "…"}</span>
        </div>
        {!data?.records?.length ? (
          <div className={s.empty}>{data ? "No sessions ended with this cause in the window." : "Loading…"}</div>
        ) : (
          <>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr>
                  <th aria-label="Expand" style={{ width: 22 }} /><th>Ended</th><th>Customer</th><th>Router</th><th>IP / MAC</th>
                  <th className={s.r}>Duration</th><th className={s.r}>Down / Up</th><th>Cause</th>
                </tr></thead>
                <tbody>
                  {data.records.map((r) => {
                    const open = openRow === r.id;
                    const toggle = () => setOpenRow(open ? null : r.id);
                    return (
                      <React.Fragment key={r.id}>
                        <tr className={`${s.row}${open ? " " + s.open : ""}`} tabIndex={0} aria-expanded={open}
                          onClick={toggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}>
                          <td><span className={s.chev}>›</span></td>
                          <td style={{ whiteSpace: "nowrap" }}>{when(r.stop)}<div className={s.whoSub}>{ago(r.stop)}</div></td>
                          <td>
                            <div className={s.who}>
                              {r.subscriberId
                                ? <Link href={`/subscribers/${r.subscriberId}`} onClick={(e) => e.stopPropagation()}>{r.fullName || r.username}</Link>
                                : (r.fullName || r.username || "—")}
                            </div>
                            <div className={s.whoSub}>{r.username}</div>
                          </td>
                          <td>{r.nasName || <span className={s.ip}>{r.nasIp}</span>}{r.nasName && <div className={s.faint}>{r.nasIp}</div>}</td>
                          <td><span className={s.ip}>{r.framedIp || "—"}</span><div className={s.faint}>{r.mac || ""}</div></td>
                          <td className={s.r}>{dur(r.durationSec)}</td>
                          <td className={s.r}>{bytes(r.downloadBytes)}<div className={s.whoSub}>{bytes(r.uploadBytes)}</div></td>
                          <td>
                            <CauseBadge cause={{ code: r.terminateCode, key: r.terminateKey, label: r.terminateLabel, category: r.terminateCategory, severity: r.terminateSeverity, description: r.terminateDescription, meaning: r.terminateMeaning }} />
                          </td>
                        </tr>
                        {open && (
                          <tr className={s.detail}>
                            <td colSpan={8}>
                              <div className={s.detailGrid}>
                                <Field k="Started" v={r.start ? new Date(r.start).toLocaleString() : "—"} />
                                <Field k="Ended" v={r.stop ? new Date(r.stop).toLocaleString() : "—"} />
                                <Field k="Duration" v={dur(r.durationSec)} />
                                <Field k="Downloaded" v={bytes(r.downloadBytes)} />
                                <Field k="Uploaded" v={bytes(r.uploadBytes)} />
                                <Field k="Leased IP" v={r.framedIp || "—"} mono />
                                <Field k="MAC (Calling-Station)" v={r.mac || "—"} mono />
                                <Field k="Router" v={r.nasName ? `${r.nasName} · ${r.nasIp}` : r.nasIp} />
                                <Field k="NAS port" v={[r.nasPortId, r.nasPortType].filter(Boolean).join(" · ") || "—"} />
                                <Field k="Service (Called-Station)" v={r.service || "—"} />
                                <Field k="Session ID" v={r.sessionId || "—"} mono />
                                <Field k="Raw cause sent" v={r.rawCause || "(none)"} mono />
                              </div>
                              <div className={s.detailNote}>
                                <div><strong>{r.terminateCode ? `#${r.terminateCode} ` : ""}{r.terminateLabel}</strong> — {r.terminateDescription}</div>
                                <div><strong>Usually means:</strong> {r.terminateMeaning}</div>
                                <div><strong>What to check:</strong> {r.terminateAction}</div>
                                {r.subscriberId && (
                                  <div><Link href={`/subscribers/${r.subscriberId}`}>Open {r.fullName || r.username}’s profile →</Link></div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className={s.pager}>
              <span>{nf(offset + 1)}–{nf(Math.min(offset + PAGE, data.recordsTotal))} of {nf(data.recordsTotal)}</span>
              <div>
                <button type="button" className={s.linkBtn} disabled={offset === 0 || busy} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>← Newer</button>
                <button type="button" className={s.linkBtn} disabled={offset + PAGE >= data.recordsTotal || busy} onClick={() => setOffset((o) => o + PAGE)}>Older →</button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: React.ReactNode; sub?: React.ReactNode; warn?: boolean }) {
  return (
    <div className={s.stat}>
      <span className={s.statLabel}>{label}</span>
      <span className={`${s.statValue}${warn ? " " + s.statWarn : ""}`}>{value}</span>
      {sub && <span className={s.statSub}>{sub}</span>}
    </div>
  );
}

function Field({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return <div><span>{k}</span><b className={mono ? s.ip : undefined}>{v}</b></div>;
}

function CauseCard({ c, max, active, onPick }: { c: Cause; max: number; active: boolean; onPick: (k: string) => void }) {
  return (
    <button type="button" className={`${s.cause}${c.count ? "" : " " + s.zero}`} style={catVar(c.category)}
      aria-pressed={active} onClick={() => onPick(c.key)} title={`${c.meaning}\nWhat to check: ${c.action}`}>
      <div className={s.causeTop}>
        <span className={`${s.num}${c.code ? "" : " " + s.dot}`}>{c.code || "•"}</span>
        <div>
          <div className={s.causeName}>{c.label}</div>
          <div className={s.causeKey}>{c.key}</div>
        </div>
        <div className={s.causeCount}>{nf(c.count)}<small>{pct(c.share)}</small></div>
      </div>
      <div className={s.causeDesc}>{c.description}</div>
      <div className={s.share}><i style={{ width: `${c.count ? Math.max(2, (c.count / max) * 100) : 0}%` }} /></div>
      <div className={s.causeMeta}>
        <SeverityTag severity={c.severity} />
        <span>{c.count ? `${nf(c.customers)} customer${c.customers === 1 ? "" : "s"} · avg ${dur(c.avgSessionSec)} · ${ago(c.lastAt)}` : "none in this window"}</span>
      </div>
    </button>
  );
}

/** Stacked columns by category, one per hour or day. */
function Trend({ data }: { data: Report | null }) {
  const buckets = data?.trend?.buckets || [];
  const totals = buckets.map((b) => Object.values(b.counts || {}).reduce((x, y) => x + Number(y || 0), 0));
  const peak = Math.max(0, ...totals);
  if (!buckets.length || peak === 0) return <div className={s.chartEmpty}>{data ? "No disconnects in this window." : "Loading…"}</div>;

  const W = 640, H = 170, L = 34, R = 6, T = 8, B = 22;
  const iw = W - L - R, ih = H - T - B;
  const step = Math.pow(10, Math.floor(Math.log10(peak)));
  const top = Math.ceil(peak / step) * step || 1;
  const y = (v: number) => T + ih - (v / top) * ih;
  const bw = iw / buckets.length;
  const hourly = data?.trend.unit === "hour";
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 7));
  const fmt = (d: string) => hourly
    ? new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : new Date(d).toLocaleDateString([], { day: "numeric", month: "short" });

  return (
    <>
      <svg className={s.chart} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Disconnects over time by category">
        {[0, top / 2, top].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--border)" />
            <text x={L - 6} y={y(v) + 3} textAnchor="end">{Number.isInteger(v) ? v : v.toFixed(1)}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          let acc = 0;
          const x = L + i * bw + bw * 0.14;
          const w = Math.max(1, bw * 0.72);
          const parts = CATEGORY_ORDER.map((c) => ({ c, n: Number(b.counts?.[c] || 0) })).filter((p) => p.n > 0);
          const tip = `${hourly ? new Date(b.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : fmt(b.at)} — ${totals[i]} ended` +
            (parts.length ? "\n" + parts.map((p) => `${CATEGORY_META[p.c].label}: ${p.n}`).join("\n") : "");
          return (
            <g key={b.at}>
              <title>{tip}</title>
              <rect x={L + i * bw} y={T} width={bw} height={ih} fill="transparent" />
              {parts.map((p) => {
                const y0 = y(acc), y1 = y(acc + p.n);
                acc += p.n;
                return <rect key={p.c} x={x} y={y1} width={w} height={Math.max(0.5, y0 - y1)} fill={CATEGORY_META[p.c].color} rx={w > 6 ? 1.5 : 0} />;
              })}
              {i % labelEvery === 0 && <text x={L + i * bw + bw / 2} y={H - 6} textAnchor="middle">{fmt(b.at)}</text>}
            </g>
          );
        })}
      </svg>
      {data?.trend.partial && <div className={s.whoSub}>Showing the most recent 150,000 sessions on the chart; the counts above include everything.</div>}
    </>
  );
}
