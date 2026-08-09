"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import API_BASE from "../components/api";

const API = API_BASE;

type Status = "ok" | "todo" | "blocked";

type Step = {
  id: string;
  title: string;
  why: string;
  status: Status;
  detail: string;
  fixHref?: string;
  fixLabel?: string;
  blockedBy?: string;
};

type SetupState = {
  account?: string;
  role?: string;
  isIsp: boolean;
  done: number;
  total: number;
  complete: boolean;
  nextStep: Step | null;
  steps: Step[];
};

/**
 * Setup — the guided path from an empty panel to a customer who is online.
 *
 * The order of these steps was never written down anywhere. It had to be
 * discovered by trying something, being refused, and working backwards from
 * the error — and several of those refusals had no message at all. This screen
 * makes the dependency chain visible, checks itself against the live database,
 * and links every unfinished step to the page that completes it.
 */
export default function SetupPage() {
  const router = useRouter();
  const [state, setState] = useState<SetupState | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
    if (!token) { router.push("/login"); return; }
    try {
      const r = await fetch(`${API}/setup/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 401) { router.push("/login"); return; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || "Could not load setup status");
      setState(await r.json());
      setErr("");
    } catch (e: any) {
      setErr(e?.message || "Could not load setup status");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  const pct = state && state.total ? Math.round((state.done / state.total) * 100) : 0;

  return (
    <div className="su">
      <style>{CSS}</style>

      <header className="su-head">
        <div>
          <h1>Setup</h1>
          <p>
            Everything below has to be true before a customer can get online. Each item checks
            itself against your live data — nothing here is a reminder you have to tick yourself.
          </p>
        </div>
        <button className="su-refresh" onClick={load}>Re-check</button>
      </header>

      {err && <div className="su-err">{err}</div>}
      {loading && <div className="su-empty">Checking your setup…</div>}

      {state && (
        <>
          {/* Progress + the single next action. Showing one next step matters:
              a list of nine outstanding items tells you nothing about which to
              do first, and most of them cannot be done yet anyway. */}
          <section className="su-card su-progress">
            <div className="su-progress-top">
              <div>
                <b>{state.account}</b>
                <em>{roleLabel(state.role)}</em>
              </div>
              <span className="su-count">{state.done} of {state.total} done</span>
            </div>
            <div className="su-bar"><i style={{ width: `${pct}%` }} /></div>

            {state.complete ? (
              <div className="su-next ok">
                <b>Setup complete.</b>
                <span>Everything needed to sell and activate is in place.</span>
              </div>
            ) : state.nextStep ? (
              <div className="su-next">
                <span className="lbl">Do this next</span>
                <b>{state.nextStep.title}</b>
                <span className="why">{state.nextStep.why}</span>
                {state.nextStep.fixHref && (
                  <a className="su-go" href={state.nextStep.fixHref}>
                    {state.nextStep.fixLabel} →
                  </a>
                )}
              </div>
            ) : (
              <div className="su-next warn">
                <b>Nothing you can do right now.</b>
                <span>
                  Everything outstanding is waiting on another account — usually the one above
                  you. The blocked items below say exactly what is missing.
                </span>
              </div>
            )}
          </section>

          <section className="su-card">
            <header className="su-card-head">
              <h3>All steps</h3>
              <p>
                <i className="dot ok" /> done ·
                <i className="dot todo" /> ready for you ·
                <i className="dot blocked" /> waiting on something else
              </p>
            </header>

            <ol className="su-steps">
              {state.steps.map((s, i) => (
                <li key={s.id} className={`su-step ${s.status}`}>
                  <span className="su-num">
                    {s.status === "ok" ? "✓" : s.status === "blocked" ? "•" : i + 1}
                  </span>
                  <div className="su-body">
                    <div className="su-title">
                      <b>{s.title}</b>
                      <span className={`su-tag ${s.status}`}>
                        {s.status === "ok" ? "Done" : s.status === "blocked" ? "Waiting" : "To do"}
                      </span>
                    </div>
                    <p className="su-why">{s.why}</p>
                    <p className="su-detail">{s.detail}</p>
                  </div>
                  {/* A finished step still links out — people come back to
                      change a price far more often than they set one. */}
                  {s.fixHref && (
                    <a className={`su-fix ${s.status}`} href={s.fixHref}>
                      {s.status === "ok" ? "Review" : s.fixLabel ?? "Fix"}
                    </a>
                  )}
                </li>
              ))}
            </ol>
          </section>

          <section className="su-card su-note">
            <h3>How the money works</h3>
            <p>
              Your wallet is charged <b>what your parent account charges you</b> — never what you
              sell at. Sell at any price above your cost and the difference is yours, collected
              from the customer outside the panel.
            </p>
            <p>
              If a wallet is empty the subscriber is still created, but left <b>inactive</b> with no
              internet until someone tops it up. Nothing is lost; nothing is given away free.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function roleLabel(role?: string) {
  const map: Record<string, string> = {
    SUPER_ADMIN: "ISP", ADMIN: "ISP",
    RESELLER: "Franchise", SUB_RESELLER: "Dealer",
    RETAILER: "Retailer", SALES: "Staff",
  };
  return role ? map[role] ?? role : "";
}

const CSS = `
.su{max-width:960px;margin:0 auto;padding:4px 0 40px}
.su-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:18px}
.su-head h1{margin:0 0 6px;font-size:22px;font-weight:800;color:var(--text)}
.su-head p{margin:0;max-width:620px;font-size:12.5px;line-height:1.75;color:var(--muted)}
.su-refresh{flex-shrink:0;padding:8px 14px;border-radius:10px;font-size:12px;font-weight:700;
  cursor:pointer;background:var(--surface-2);border:1px solid var(--border);color:var(--muted)}
.su-refresh:hover{color:var(--text);border-color:#6C3CE1}

.su-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;
  padding:20px;margin-bottom:16px}
.su-card-head{margin-bottom:14px}
.su-card-head h3{margin:0 0 4px;font-size:14px;font-weight:800;color:var(--text)}
.su-card-head p{margin:0;font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:6px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-left:8px}
.dot.ok{background:#10B981}.dot.todo{background:#6C3CE1}.dot.blocked{background:#F59E0B}

.su-progress-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.su-progress-top b{font-size:14px;color:var(--text)}
.su-progress-top em{font-style:normal;font-size:11.5px;color:var(--muted);margin-left:8px}
.su-count{font-size:12px;font-weight:700;color:var(--muted)}
.su-bar{height:7px;border-radius:99px;background:var(--surface-2);overflow:hidden}
.su-bar i{display:block;height:100%;border-radius:99px;
  background:linear-gradient(135deg,#6C3CE1,#E9408B,#F27121);transition:width .4s ease}

.su-next{margin-top:16px;padding:14px 16px;border-radius:13px;display:flex;flex-direction:column;gap:5px;
  background:rgba(108,60,225,.10);border:1px solid rgba(108,60,225,.4)}
.su-next .lbl{font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#A78BFA}
.su-next b{font-size:14px;color:var(--text)}
.su-next .why{font-size:12px;line-height:1.7;color:var(--muted)}
.su-next.ok{background:rgba(16,185,129,.10);border-color:rgba(16,185,129,.45)}
.su-next.ok b{color:#6EE7B7}
.su-next.warn{background:rgba(245,158,11,.10);border-color:rgba(245,158,11,.45)}
.su-next.warn b{color:#FCD34D}
.su-next span{font-size:12px;line-height:1.7;color:var(--muted)}
.su-go{align-self:flex-start;margin-top:6px;padding:7px 14px;border-radius:9px;font-size:12px;
  font-weight:700;text-decoration:none;color:#fff;background:linear-gradient(135deg,#6C3CE1,#E9408B)}

.su-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px}
.su-step{display:flex;align-items:flex-start;gap:13px;padding:13px 15px;border-radius:13px;
  background:var(--surface-2);border:1px solid var(--border)}
.su-step.ok{opacity:.72}
.su-step.blocked{border-color:rgba(245,158,11,.35)}
.su-num{flex-shrink:0;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;
  font-size:11px;font-weight:800;background:var(--surface);color:var(--muted);border:1px solid var(--border)}
.su-step.ok .su-num{background:rgba(16,185,129,.15);color:#6EE7B7;border-color:rgba(16,185,129,.5)}
.su-step.todo .su-num{background:rgba(108,60,225,.18);color:#C4B5FD;border-color:rgba(108,60,225,.5)}
.su-step.blocked .su-num{background:rgba(245,158,11,.14);color:#FCD34D;border-color:rgba(245,158,11,.45)}
.su-body{flex:1;min-width:0}
.su-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.su-title b{font-size:13px;color:var(--text)}
.su-tag{font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  padding:2px 7px;border-radius:20px}
.su-tag.ok{background:rgba(16,185,129,.15);color:#6EE7B7}
.su-tag.todo{background:rgba(108,60,225,.18);color:#C4B5FD}
.su-tag.blocked{background:rgba(245,158,11,.14);color:#FCD34D}
.su-why{margin:5px 0 0;font-size:11.5px;line-height:1.7;color:var(--muted)}
.su-detail{margin:4px 0 0;font-size:11.5px;line-height:1.6;color:var(--text);opacity:.8}
.su-fix{flex-shrink:0;align-self:center;padding:6px 12px;border-radius:9px;font-size:11.5px;
  font-weight:700;text-decoration:none;border:1px solid var(--border);
  background:var(--surface);color:var(--muted)}
.su-fix:hover{color:var(--text);border-color:#6C3CE1}
.su-fix.todo{background:linear-gradient(135deg,#6C3CE1,#E9408B);color:#fff;border-color:transparent}

.su-note h3{margin:0 0 8px;font-size:13px;font-weight:800;color:var(--text)}
.su-note p{margin:0 0 8px;font-size:12px;line-height:1.8;color:var(--muted)}
.su-note b{color:var(--text)}

.su-err{padding:12px 16px;border-radius:12px;margin-bottom:14px;font-size:12.5px;
  background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4);color:#FCA5A5}
.su-empty{padding:34px;text-align:center;font-size:12.5px;color:var(--muted)}

@media (max-width:640px){
  .su-step{flex-wrap:wrap}
  .su-fix{width:100%;text-align:center;margin-top:8px}
}
`;
