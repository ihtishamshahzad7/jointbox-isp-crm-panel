"use client";

/**
 * DISCONNECT LOG (Logs tab) — every session that ended, and why.
 *
 * Each entry answers the questions support asks first: WHO dropped (customer
 * and username), WHEN (to the second), HOW (the customer's side, the line, the
 * router, a timer, or a panel action and the operator who took it), WHICH NAS
 * and port it was on, and the client's MAC and IP — with the RFC 2866
 * Acct-Terminate-Cause behind it. Below the log: totals, the trend, routers,
 * the customers who drop most, and all eighteen standard causes.
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
type HowBy = "customer" | "timer" | "operator" | "line" | "router" | "panel" | "unknown";
type How = {
  by: HowBy; title: string; detail: string | null;
  actor: { name: string; email: string | null } | null;
  method: string | null; source: "panel" | "cause"; steps: string[];
};
type RecordRow = {
  id: string; sessionId: string; username: string | null; subscriberId: number | null; fullName: string | null;
  nasIp: string; nasName: string | null; nasPortId: string | null; nasPortType: string | null;
  framedIp: string | null; mac: string | null; service: string | null;
  start: string | null; stop: string | null; durationSec: number | null;
  downloadBytes: number | null; uploadBytes: number | null; rawCause: string | null;
  terminateCode: number; terminateKey: string; terminateLabel: string; terminateDescription: string;
  terminateMeaning: string; terminateAction: string; terminateHow?: string;
  terminateCategory: CauseCategory; terminateSeverity: CauseSeverity;
  how?: How;
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

/** Who or what ended the session — the "how" tag on every log entry. */
const HOW_META: Record<HowBy, { label: string; cat: CauseCategory }> = {
  customer: { label: "Customer side", cat: "customer" },
  line:     { label: "Line dropped",  cat: "link" },
  router:   { label: "Router (NAS)",  cat: "router" },
  timer:    { label: "Timer",         cat: "timer" },
  operator: { label: "Operator",      cat: "operator" },
  panel:    { label: "Panel",         cat: "panel" },
  unknown:  { label: "Not reported",  cat: "other" },
};

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
const clock = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const full = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString([], { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
function ago(d: string | null | undefined) {
  if (!d) return "—";
  const sec = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
function dayKey(d: string | null) {
  if (!d) return "unknown";
  const x = new Date(d);
  return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
}
function dayLabel(d: string | null) {
  if (!d) return "Unknown date";
  const x = new Date(d); const now = new Date();
  const start = (y: Date) => new Date(y.getFullYear(), y.getMonth(), y.getDate()).getTime();
  const diff = Math.round((start(now) - start(x)) / 86_400_000);
  const date = x.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  return diff === 0 ? `Today · ${date}` : diff === 1 ? `Yesterday · ${date}` : date;
}
const initials = (name: string) =>
  name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

export default function DisconnectsPanel() {
  const [hours, setHours] = useState(168);
  const [cause, setCause] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [nasIp, setNasIp] = useState("");
  const [findInput, setFindInput] = useState("");
  const [find, setFind] = useState("");
  const [username, setUsername] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [allReasons, setAllReasons] = useState(false);
  const [routerOptions, setRouterOptions] = useState<Record<string, string | null>>({});
  const reqId = useRef(0);
  const logRef = useRef<HTMLElement | null>(null);

  // Deep links: /logs?tab=disconnects&username=…&cause=…&hours=…
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const u = q.get("username"); if (u) { setUsername(u); setFindInput(u); }
      const c = q.get("cause"); if (c) setCause(c);
      const h = Number(q.get("hours")); if (WINDOWS.some(([w]) => w === h)) setHours(h);
    } catch { /* no query */ }
  }, []);

  // The search box applies after typing stops.
  useEffect(() => {
    const t = setTimeout(() => {
      const v = findInput.trim();
      setFind((prev) => (prev === v ? prev : v));
      if (username && v !== username) setUsername("");
      setOffset(0);
    }, 450);
    return () => clearTimeout(t);
  }, [findInput]); // eslint-disable-line react-hooks/exhaustive-deps

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
    else if (find) q.set("search", find);
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
        for (const x of j.records || []) if (x.nasIp) next[x.nasIp] = x.nasName || next[x.nasIp] || null;
        return next;
      });
    } catch {
      if (id === reqId.current) setErr("Could not reach the server. Check your connection and try again.");
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  }, [hours, cause, category, nasIp, username, find, offset]);

  useEffect(() => { void load(); }, [load]);

  const byKey = useMemo(() => new Map((data?.causes || []).map((c) => [c.key, c])), [data]);
  const badgeFor = (key: string, label?: string) => {
    const c = byKey.get(key);
    return { code: c?.code || 0, key, label: c?.label || label || key, category: c?.category || "other", severity: c?.severity || "info", description: c?.description, meaning: c?.meaning };
  };

  const toLog = () => { try { logRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); } catch { /* old browser */ } };
  const pickCause = (key: string, scroll = false) => {
    setCause((c) => (c === key ? "" : key)); setCategory(""); setOffset(0); setOpenRow(null);
    if (scroll) toLog();
  };
  const pickCategory = (id: string) => { setCategory((c) => (c === id ? "" : id)); setCause(""); setOffset(0); setOpenRow(null); };
  const clearSel = () => { setCause(""); setCategory(""); setOffset(0); setOpenRow(null); };

  const standard = (data?.causes || []).filter((c) => c.standard);
  const extra = (data?.causes || []).filter((c) => !c.standard && c.count > 0);
  const maxCause = Math.max(1, ...standard.map((c) => c.count), ...extra.map((c) => c.count));
  const reasonChips = (data?.causes || [])
    .filter((c) => allReasons || c.count > 0 || c.key === cause)
    .sort((a, b) => (allReasons ? (a.standard === b.standard ? (a.code || 99) - (b.code || 99) : a.standard ? -1 : 1) : b.count - a.count));
  const sel = cause ? byKey.get(cause) : null;
  const selCat = category ? data?.categories.find((c) => c.id === category) : null;
  const t = data?.totals;

  // The log, grouped by the day each session ended.
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: RecordRow[] }[] = [];
    for (const r of data?.records || []) {
      const k = dayKey(r.stop);
      let g = out[out.length - 1];
      if (!g || g.key !== k) { g = { key: k, label: dayLabel(r.stop), items: [] }; out.push(g); }
      g.items.push(r);
    }
    return out;
  }, [data]);

  return (
    <div id={s.root} className={`${s.page}${busy && data ? " " + s.loading : ""}`}>
      <header className={s.head}>
        <div>
          <div className={s.eyebrow}>RADIUS · Acct-Terminate-Cause</div>
          <h2>Disconnect log</h2>
          <p>Every session that ended — who it was, when, how it was disconnected, the NAS and port it was on, and the client’s MAC and IP. Click an entry for every detail.</p>
        </div>
        <div className={s.controls}>
          <div className={s.seg} role="group" aria-label="Time window">
            {WINDOWS.map(([h, label]) => (
              <button key={h} type="button" aria-pressed={hours === h} onClick={() => { setHours(h); setOffset(0); }}>{label}</button>
            ))}
          </div>
          <select id="disc-router" className={s.select} value={nasIp} aria-label="NAS"
            onChange={(e) => { setNasIp(e.target.value); setOffset(0); }}>
            <option value="">All NAS / routers</option>
            {Object.entries(routerOptions).map(([ip, name]) => (
              <option key={ip} value={ip}>{name ? `${name} (${ip})` : ip}</option>
            ))}
          </select>
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

      {/* ── Filters ── */}
      <section className={s.filters} aria-label="Filter the log">
        <div className={s.filterRow}>
          <label className={s.findWrap} htmlFor="disc-find">
            <span className={s.findIcon} aria-hidden>⌕</span>
            <input id="disc-find" className={s.findBox} value={findInput} placeholder="Find a username, MAC address or IP"
              onChange={(e) => setFindInput(e.target.value)} autoComplete="off" spellCheck={false} />
            {findInput && <button type="button" className={s.findClear} aria-label="Clear search" onClick={() => setFindInput("")}>×</button>}
          </label>
          <div className={s.typeRow} role="group" aria-label="How it ended">
            {(data?.categories || []).filter((c) => c.count > 0 || category === c.id).map((c) => (
              <button key={c.id} type="button" className={s.catPick} style={catVar(c.id)} aria-pressed={category === c.id}
                title={c.about} onClick={() => pickCategory(c.id)}>
                <i />{c.label} <b>{nf(c.count)}</b>
              </button>
            ))}
          </div>
        </div>
        <div className={s.reasonRow} role="group" aria-label="Reason">
          <span className={s.filterLabel}>Reason</span>
          <button type="button" className={s.reasonAll} aria-pressed={!cause && !category} onClick={clearSel}>All · {nf(t?.ended)}</button>
          {reasonChips.map((c) => (
            <button key={c.key} type="button" className={s.reasonPick} aria-pressed={cause === c.key}
              onClick={() => pickCause(c.key)} title={`${c.description}\n${c.meaning}`}>
              <CauseBadge compact cause={{ ...c, label: `${c.label} · ${nf(c.count)}` }} title="" />
            </button>
          ))}
          <button type="button" className={s.moreLink} onClick={() => setAllReasons((v) => !v)}>
            {allReasons ? "Only reasons that happened" : "Show all 18 reasons"}
          </button>
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
            <button type="button" className={s.clear} onClick={clearSel}>Show all reasons</button>
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
        </section>
      )}

      {/* ── THE LOG ── */}
      <section className={s.panel} ref={logRef} aria-label="Disconnect log">
        <div className={s.panelHead}>
          <h3>{sel ? `Ended by ${sel.label}` : selCat ? `Ended — ${selCat.label}` : find || username ? `Disconnects matching “${username || find}”` : "Latest disconnects"}</h3>
          <span>{data ? `${nf(data.recordsTotal)} entr${data.recordsTotal === 1 ? "y" : "ies"} · newest first` : "…"}</span>
        </div>
        {!data ? (
          <div className={s.empty}>Loading the disconnect log…</div>
        ) : !data.records.length ? (
          <div className={s.empty}>No sessions ended {find || username ? "for that search " : ""}{sel ? `with ${sel.label} ` : ""}in this window.</div>
        ) : (
          <>
            <ol className={s.feed}>
              {groups.map((g) => (
                <li key={g.key} className={s.dayGroup}>
                  <div className={s.dayHead}><span>{g.label}</span><em>{g.items.length} disconnect{g.items.length === 1 ? "" : "s"}</em></div>
                  <ol className={s.events}>
                    {g.items.map((r) => (
                      <EventRow key={r.id} r={r} open={openRow === r.id} onToggle={() => setOpenRow(openRow === r.id ? null : r.id)} />
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
            <div className={s.pager}>
              <span>{nf(offset + 1)}–{nf(Math.min(offset + PAGE, data.recordsTotal))} of {nf(data.recordsTotal)}</span>
              <div>
                <button type="button" className={s.linkBtn} disabled={offset === 0 || busy} onClick={() => { setOffset((o) => Math.max(0, o - PAGE)); toLog(); }}>← Newer</button>
                <button type="button" className={s.linkBtn} disabled={offset + PAGE >= data.recordsTotal || busy} onClick={() => { setOffset((o) => o + PAGE); toLog(); }}>Older →</button>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── Breakdown ── */}
      <div className={s.subHead}>Breakdown for this window</div>
      <div className={s.twoCol}>
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>Who or what ended them</h3>
            <span>Click a part to filter the log</span>
          </div>
          <div className={s.split} aria-label="Share by category">
            {(data?.categories || []).filter((c) => c.count > 0).map((c) => (
              <button key={c.id} type="button" style={{ ...catVar(c.id), width: `${c.share * 100}%` }}
                title={`${c.label}: ${nf(c.count)} (${pct(c.share)}) — ${c.about}`} aria-label={`${c.label} ${pct(c.share)}`}
                onClick={() => { pickCategory(c.id); toLog(); }} />
            ))}
          </div>
          <div className={s.legendRow}>
            {(data?.categories || []).filter((c) => c.count > 0).map((c) => (
              <span key={c.id} style={catVar(c.id)}><i />{c.label} <b>{pct(c.share)}</b></span>
            ))}
          </div>
          <div className={s.subHead}>Over time</div>
          <Trend data={data} />
        </section>

        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>By NAS / router</h3>
            <span>{sel ? sel.label : selCat ? selCat.label : "All reasons"}</span>
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
                      <button type="button" className={s.barName} title={`Show only ${r.name || r.nasIp}`}
                        onClick={() => { setNasIp(r.nasIp); setOffset(0); toLog(); }}>{r.name || r.nasIp}</button>
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

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>Customers who disconnected most</h3>
          <span>{sel ? `with ${sel.label}` : selCat ? `in ${selCat.label}` : "all reasons"} · top 15</span>
        </div>
        {!data?.customers?.length ? (
          <div className={s.empty}>{data ? "No customer disconnects match." : "Loading…"}</div>
        ) : (
          <div className={s.tableWrap}>
            <table className={`${s.table} ${s.plain}`}>
              <thead><tr>
                <th>Customer</th><th className={s.r}>Disconnects</th><th className={s.r}>Need attention</th><th>Last</th><th>Most common reasons</th><th aria-label="Actions" />
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
                      <div className={s.cellMain}>{ago(c.lastAt)}</div>
                      {c.lastKey && <div className={s.whoSub}>{badgeFor(c.lastKey).label}</div>}
                    </td>
                    <td><div className={s.tagRow}>{c.top.map((x) => (
                      <CauseBadge key={x.key} compact cause={{ ...badgeFor(x.key, x.label), label: `${badgeFor(x.key, x.label).label} · ${nf(x.count)}` }} />
                    ))}</div></td>
                    <td>
                      <button type="button" className={s.linkBtn} onClick={() => { setFindInput(c.username); setUsername(c.username); setFind(""); clearSel(); toLog(); }}>
                        Show in log
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>All 18 termination causes</h3>
          <span>RFC 2866 · routers send the number or the name · click one to filter the log</span>
        </div>
        <div className={s.causeGrid}>
          {standard.map((c) => <CauseCard key={c.key} c={c} max={maxCause} active={cause === c.key} onPick={(k) => pickCause(k, true)} />)}
        </div>
        {extra.length > 0 && (
          <>
            <div className={s.subHead}>Panel and non-standard causes</div>
            <div className={s.causeGrid}>
              {extra.map((c) => <CauseCard key={c.key} c={c} max={maxCause} active={cause === c.key} onPick={(k) => pickCause(k, true)} />)}
            </div>
          </>
        )}
        <div className={s.legendRow} aria-label="Severity legend" style={{ marginTop: 12 }}>
          {(Object.keys(SEVERITY_META) as CauseSeverity[]).map((k) => (
            <span key={k} title={SEVERITY_META[k].about}><SeverityTag severity={k} /> {SEVERITY_META[k].about}</span>
          ))}
        </div>
      </section>
    </div>
  );
}

/** One disconnect: who, when, how, which NAS, MAC and IP — and every detail on click. */
function EventRow({ r, open, onToggle }: { r: RecordRow; open: boolean; onToggle: () => void }) {
  const how: How = r.how || { by: "unknown", title: r.terminateHow || r.terminateMeaning, detail: null, actor: null, method: null, source: "cause", steps: [] };
  const hm = HOW_META[how.by] || HOW_META.unknown;
  const sev = SEVERITY_META[r.terminateSeverity] || SEVERITY_META.info;
  const name = r.fullName || r.username || "Unknown customer";
  const port = [r.nasPortId, r.nasPortType].filter(Boolean).join(" · ");
  return (
    <li className={`${s.ev}${open ? " " + s.evOpen : ""}`} style={{ ["--sev" as any]: sev.color }}>
      <button type="button" className={s.evMain} aria-expanded={open} onClick={onToggle}>
        <span className={s.evTime}>
          <b>{clock(r.stop)}</b>
          <span>{ago(r.stop)}</span>
        </span>
        <span className={s.evBody}>
          <span className={s.evTop}>
            <span className={s.avatar} aria-hidden>{initials(name)}</span>
            <span className={s.evWho}>
              <span className={s.evName}>{name}</span>
              {r.username && r.username !== name && <span className={s.evUser}>{r.username}</span>}
            </span>
            <span className={s.evCause}>
              <CauseBadge cause={{ code: r.terminateCode, key: r.terminateKey, label: r.terminateLabel, category: r.terminateCategory, severity: r.terminateSeverity, description: r.terminateDescription, meaning: r.terminateMeaning }} />
              <SeverityTag severity={r.terminateSeverity} />
            </span>
          </span>
          <span className={s.evHow}>
            <span className={s.howTag} style={catVar(hm.cat)}>{hm.label}</span>
            <span className={s.howText}>
              {how.title}
              {how.actor && <> — by <b>{how.actor.name}</b></>}
              {how.method && <span className={s.faint}> · via {how.method}</span>}
            </span>
          </span>
          <span className={s.evFacts}>
            <span className={s.fact}><span className={s.factK}>NAS</span><span className={s.factV}>{r.nasName || r.nasIp}{r.nasName && <span className={s.faint}> {r.nasIp}</span>}{port && <span className={s.faint}> · {port}</span>}</span></span>
            <span className={s.fact}><span className={s.factK}>MAC</span><span className={`${s.factV} ${s.ip}`}>{r.mac || "—"}</span></span>
            <span className={s.fact}><span className={s.factK}>IP</span><span className={`${s.factV} ${s.ip}`}>{r.framedIp || "—"}</span></span>
            <span className={s.fact}><span className={s.factK}>Online for</span><span className={s.factV}>{dur(r.durationSec)}</span></span>
            <span className={s.fact}><span className={s.factK}>Data</span><span className={s.factV}>↓ {bytes(r.downloadBytes)} · ↑ {bytes(r.uploadBytes)}</span></span>
          </span>
        </span>
        <span className={s.chev} aria-hidden>›</span>
      </button>
      {open && (
        <div className={s.evDetail}>
          <div className={s.detailGrid}>
            <Field k="Disconnected at" v={full(r.stop)} />
            <Field k="Connected at" v={full(r.start)} />
            <Field k="Online for" v={dur(r.durationSec)} />
            <Field k="Customer" v={r.fullName ? `${r.fullName} (${r.username})` : (r.username || "—")} />
            <Field k="MAC address (Calling-Station)" v={r.mac || "—"} mono />
            <Field k="Leased IP" v={r.framedIp || "—"} mono />
            <Field k="NAS / router" v={r.nasName ? `${r.nasName} · ${r.nasIp}` : r.nasIp} />
            <Field k="NAS port" v={port || "—"} />
            <Field k="Service (Called-Station)" v={r.service || "—"} />
            <Field k="Downloaded" v={bytes(r.downloadBytes)} />
            <Field k="Uploaded" v={bytes(r.uploadBytes)} />
            <Field k="Session ID" v={r.sessionId || "—"} mono />
            <Field k="Raw cause sent" v={r.rawCause || "(none)"} mono />
            <Field k="Disconnected by" v={how.actor ? `${how.actor.name}${how.actor.email ? ` (${how.actor.email})` : ""}` : hm.label} />
            {how.method && <Field k="Method" v={how.method} />}
          </div>
          <div className={s.detailNote}>
            <div><strong>How:</strong> {how.title}{how.detail ? ` — ${how.detail}` : ""}</div>
            <div><strong>{r.terminateCode ? `#${r.terminateCode} ` : ""}{r.terminateLabel}:</strong> {r.terminateDescription}</div>
            <div><strong>Usually means:</strong> {r.terminateMeaning}</div>
            <div><strong>What to check:</strong> {r.terminateAction}</div>
            {how.steps.length > 0 && <div><strong>Panel steps:</strong> {how.steps.join(" → ")}</div>}
            {r.subscriberId && (
              <div><Link href={`/subscribers/${r.subscriberId}`}>Open {name}’s profile →</Link></div>
            )}
          </div>
        </div>
      )}
    </li>
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
