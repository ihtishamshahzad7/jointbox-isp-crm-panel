"use client";

import { useCallback, useEffect, useState } from "react";
import API_BASE from "../components/api";

/**
 * Public service status — no login.
 *
 * This page exists to answer one question, usually on a phone, usually while
 * the person is annoyed: is my area down, and does anyone know why? Every
 * decision here follows from that.
 *
 *   It says the CAUSE, not just "down". That is the whole point of the outage
 *   classifier: "power failure in your area" ends the call before it starts,
 *   where a red dot only prompts one.
 *   Affected areas sort to the top and the page opens with a single verdict
 *   line, so the answer is visible without reading a table.
 *   Urdu sits alongside English because this is read under stress.
 *   It self-refreshes, because someone waiting for service to return WILL
 *   leave the tab open, and a stale page is worse than no page.
 *
 * Deliberately standalone: no admin shell, no auth, no heavy dependencies —
 * it has to load on a bad connection, which is exactly when it is needed.
 */
type Msg = { en: string; ur: string };
type AreaStatus = {
  area: string;
  city: string | null;
  status: "OPERATIONAL" | "OUTAGE";
  cause: string | null;
  message: Msg;
  since: string | null;
};
type Incident = {
  area: string;
  cause: string | null;
  message: Msg;
  startedAt: string;
  endedAt: string;
  minutes: number | null;
};

const CAUSE_LABEL: Record<string, string> = {
  POWER_RELATED: "Power",
  FIBER_CUT: "Fibre",
  EQUIPMENT_FAILURE: "Equipment",
  UPSTREAM_ISP: "Upstream",
};

export default function StatusPage() {
  const [areas, setAreas] = useState<AreaStatus[] | null>(null);
  const [history, setHistory] = useState<Incident[]>([]);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [urdu, setUrdu] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        fetch(`${API_BASE}/public/status`),
        fetch(`${API_BASE}/public/status/history?days=7`),
      ]);
      if (!s.ok) { setErr(true); return; }
      const d = await s.json();
      setAreas(d.areas ?? []);
      setCheckedAt(d.checkedAt ?? null);
      if (h.ok) setHistory(await h.json());
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);

  useEffect(() => {
    load();
    // Someone waiting for service to come back leaves this open.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const down = (areas ?? []).filter((a) => a.status === "OUTAGE");
  const allGood = areas !== null && down.length === 0 && areas.length > 0;

  return (
    <div className="sp" dir={urdu ? "rtl" : "ltr"}>
      <style>{CSS}</style>

      <header className="sp-top">
        <div className="sp-brand">Service Status</div>
        <button className="sp-lang" onClick={() => setUrdu((v) => !v)} aria-label="Toggle language">
          {urdu ? "English" : "اردو"}
        </button>
      </header>

      {/* The answer, before any table. */}
      <section className={`sp-hero ${allGood ? "ok" : down.length ? "bad" : ""}`}>
        {areas === null && !err && <div className="sp-hero-t">Checking…</div>}
        {err && (
          <>
            <div className="sp-hero-t">Status unavailable</div>
            <div className="sp-hero-s">
              We could not load service status just now. This page does not mean your service is
              down — please try again shortly.
            </div>
          </>
        )}
        {allGood && (
          <>
            <div className="sp-hero-t">{urdu ? "تمام علاقوں میں سروس بحال ہے" : "All areas operational"}</div>
            <div className="sp-hero-s">
              {urdu ? "کوئی معلوم خرابی نہیں۔" : "No known faults across the network."}
            </div>
          </>
        )}
        {down.length > 0 && (
          <>
            <div className="sp-hero-t">
              {urdu
                ? `${down.length} علاقے متاثر ہیں`
                : `${down.length} area${down.length === 1 ? "" : "s"} affected`}
            </div>
            <div className="sp-hero-s">
              {urdu ? "تفصیل نیچے دیکھیں۔" : "Details below. Our team is already aware."}
            </div>
          </>
        )}
      </section>

      {/* Areas — affected first, from the server. */}
      {areas !== null && areas.length > 0 && (
        <section className="sp-list">
          {areas.map((a) => (
            <article key={`${a.area}-${a.city ?? ""}`} className={`sp-row ${a.status === "OUTAGE" ? "out" : ""}`}>
              <div className="sp-row-head">
                <span className="sp-dot" aria-hidden />
                <span className="sp-area">
                  {a.area}
                  {a.city && <em>{a.city}</em>}
                </span>
                {a.status === "OUTAGE" && a.cause && (
                  <span className="sp-tag">{CAUSE_LABEL[a.cause] ?? "Fault"}</span>
                )}
                <span className="sp-state">
                  {a.status === "OPERATIONAL"
                    ? urdu ? "بحال" : "Operational"
                    : urdu ? "متاثر" : "Affected"}
                </span>
              </div>
              {a.status === "OUTAGE" && (
                <p className="sp-msg">{urdu ? a.message.ur : a.message.en}</p>
              )}
              {a.since && (
                <p className="sp-since">
                  {urdu ? "شروع: " : "Since "}
                  {new Date(a.since).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                </p>
              )}
            </article>
          ))}
        </section>
      )}

      {areas !== null && areas.length === 0 && !err && (
        <section className="sp-empty">No service areas are published yet.</section>
      )}

      {/* Track record. */}
      {history.length > 0 && (
        <section className="sp-hist">
          <h2>{urdu ? "پچھلے 7 دن" : "Past 7 days"}</h2>
          {history.map((h, i) => (
            <div className="sp-hist-row" key={`${h.area}-${h.startedAt}-${i}`}>
              <span className="sp-hist-area">{h.area}</span>
              <span className="sp-hist-cause">
                {h.cause ? (CAUSE_LABEL[h.cause] ?? "Fault") : urdu ? "نامعلوم" : "Investigated"}
              </span>
              <span className="sp-hist-when">
                {new Date(h.startedAt).toLocaleDateString([], { day: "numeric", month: "short" })}
              </span>
              <span className="sp-hist-dur">
                {h.minutes != null
                  ? h.minutes >= 60
                    ? `${Math.round((h.minutes / 60) * 10) / 10} h`
                    : `${h.minutes} min`
                  : "—"}
              </span>
            </div>
          ))}
        </section>
      )}

      <footer className="sp-foot">
        {checkedAt && (
          <>
            {urdu ? "آخری بار جانچا گیا: " : "Last checked "}
            {new Date(checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {" · "}
          </>
        )}
        {urdu ? "ہر منٹ خودکار تازہ کاری" : "Updates automatically every minute"}
      </footer>
    </div>
  );
}

/**
 * Self-contained, single-theme on purpose: this renders on unknown phones and
 * must never inherit a half-applied admin theme. Light only, high contrast.
 */
const CSS = `
.sp{max-width:640px;margin:0 auto;padding:20px 16px 48px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#14181F;background:#fff;min-height:100vh}
.sp *{box-sizing:border-box}
.sp-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.sp-brand{font-size:15px;font-weight:700;letter-spacing:-.01em}
.sp-lang{background:#fff;border:1px solid #DDE1E7;border-radius:999px;padding:5px 13px;font-size:12px;font-weight:600;color:#3C4653;cursor:pointer;font-family:inherit}
.sp-hero{border:1px solid #DDE1E7;border-radius:14px;padding:20px 18px;margin-bottom:18px;background:#F7F8FA}
.sp-hero.ok{background:#F0FAF4;border-color:#BBE5CC}
.sp-hero.bad{background:#FEF4F3;border-color:#F3C9C4}
.sp-hero-t{font-size:20px;font-weight:800;letter-spacing:-.02em;line-height:1.25}
.sp-hero.ok .sp-hero-t{color:#166A3C}
.sp-hero.bad .sp-hero-t{color:#A0342A}
.sp-hero-s{font-size:13.5px;color:#5A6472;margin-top:5px;line-height:1.6}
.sp-list{display:flex;flex-direction:column;gap:9px}
.sp-row{border:1px solid #E6E9EE;border-radius:12px;padding:13px 15px;background:#fff}
.sp-row.out{border-color:#F3C9C4;background:#FFFBFB}
.sp-row-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.sp-dot{width:9px;height:9px;border-radius:50%;background:#2F9E5F;flex:none}
.sp-row.out .sp-dot{background:#D14836}
.sp-area{font-size:14.5px;font-weight:650;display:flex;flex-direction:column;line-height:1.3}
.sp-area em{font-style:normal;font-size:11.5px;color:#8A93A0;font-weight:500}
.sp-tag{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:999px;background:#FBE9E7;color:#A0342A}
.sp-state{margin-inline-start:auto;font-size:12px;font-weight:650;color:#2F9E5F}
.sp-row.out .sp-state{color:#A0342A}
.sp-msg{font-size:13.5px;line-height:1.65;color:#3C4653;margin:9px 0 0}
.sp-since{font-size:11.5px;color:#8A93A0;margin:6px 0 0}
.sp-empty{padding:36px 0;text-align:center;color:#8A93A0;font-size:13px}
.sp-hist{margin-top:26px}
.sp-hist h2{font-size:13px;font-weight:700;color:#5A6472;margin:0 0 9px;text-transform:uppercase;letter-spacing:.05em}
.sp-hist-row{display:grid;grid-template-columns:1.5fr 1fr .8fr .6fr;gap:8px;padding:9px 2px;border-top:1px solid #EEF1F5;font-size:12.5px;align-items:center}
.sp-hist-area{font-weight:600}
.sp-hist-cause,.sp-hist-when{color:#5A6472}
.sp-hist-dur{text-align:end;color:#8A93A0;font-variant-numeric:tabular-nums}
.sp-foot{margin-top:26px;padding-top:14px;border-top:1px solid #EEF1F5;font-size:11.5px;color:#8A93A0;text-align:center}
@media (max-width:420px){
  .sp-hist-row{grid-template-columns:1.4fr .9fr .7fr}
  .sp-hist-dur{display:none}
}
`;
