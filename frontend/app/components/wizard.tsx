"use client";

import React, { useMemo, useState } from "react";

/**
 * Wizard — a reusable multi-step form shell.
 *
 * Every creation form in this panel was one long scroll: the subscriber form
 * alone has forty-odd fields, and the NAS form mixes connection details with
 * RADIUS secrets and API credentials. A single wall of inputs hides which
 * fields are actually required, gives no sense of how much is left, and lets
 * someone submit with a required field they never scrolled past.
 *
 * Splitting into steps fixes all three, but only if two rules hold:
 *
 *   1. VALIDATE PER STEP. Blocking at the end and saying "something is wrong"
 *      is worse than one long form, because now the offending field is hidden
 *      on a step you cannot see.
 *   2. ALWAYS END WITH REVIEW. The cost of steps is that you lose sight of the
 *      whole. A final summary of every value, with a jump-back link on each
 *      section, buys that back.
 */

export type WizardStep = {
  id: string;
  title: string;
  /** One line explaining what this step is for. */
  hint?: string;
  /** The fields for this step. */
  render: () => React.ReactNode;
  /**
   * Return an error string to block Next, or null to allow it.
   * Runs when the user presses Next, not on every keystroke — validating as
   * someone types tells them they are wrong before they have finished being
   * right.
   */
  validate?: () => string | null;
  /** Lines shown on the review step: [label, value]. */
  summary?: () => Array<[string, React.ReactNode]>;
  /** Hide this step entirely (e.g. options that depend on an earlier answer). */
  skip?: boolean;
};

export function Wizard({
  steps,
  onFinish,
  onCancel,
  finishLabel = "Create",
  busy = false,
  error,
}: {
  steps: WizardStep[];
  /**
   * May be async and MAY THROW. A thrown error is caught, shown, and the form
   * stays open on the review step with every value intact.
   *
   * This is the part that was wrong before: `onFinish` was fire-and-forget, so
   * a save that failed server-side either closed the dialog as though it had
   * worked, or left the button looking clickable with no explanation. Neither
   * tells you that the customer was not created.
   */
  onFinish: () => void | Promise<any>;
  onCancel: () => void;
  finishLabel?: string;
  busy?: boolean;
  error?: string;
}) {
  const live = useMemo(() => steps.filter((s) => !s.skip), [steps]);
  const [i, setI] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  /** Error thrown by onFinish — kept separate so a retry clears only this. */
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Steps the user has completed at least once — drives the ✓ marks. */
  const [seen, setSeen] = useState<Set<number>>(new Set());

  // The review step is appended, never authored — so it can never be
  // forgotten on a new form.
  const total = live.length + 1;
  const onReview = i === live.length;
  const current = live[i];
  const working = busy || saving;

  const go = (to: number) => { setStepError(null); setSaveError(null); setI(to); };

  const next = () => {
    const err = current?.validate?.();
    if (err) { setStepError(err); return; }
    setSeen((s) => new Set(s).add(i));
    go(Math.min(i + 1, total - 1));
  };

  /**
   * Re-run EVERY step's validation before saving, not just the current one.
   *
   * Jumping back via the rail to change one answer can invalidate a step that
   * was already ticked. Checking only the last step would let that through and
   * turn a catchable mistake into a server error.
   */
  const submit = async () => {
    for (let n = 0; n < live.length; n++) {
      const err = live[n].validate?.();
      if (err) { setStepError(err); setI(n); return; }
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onFinish();
    } catch (e: any) {
      const msg = Array.isArray(e?.message) ? e.message.join(" ") : e?.message;
      setSaveError(msg || "Could not save. Nothing was created.");
    } finally {
      setSaving(false);
    }
  };

  /** Enter advances; it should never submit silently from a middle step. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "TEXTAREA") return;
    e.preventDefault();
    if (!onReview) next();
  };

  return (
    <div className="wz" onKeyDown={onKeyDown}>
      <style>{CSS}</style>

      {/* Step rail. Completed steps are clickable so going back to change one
          answer does not mean pressing Back five times. */}
      <ol className="wz-rail">
        {live.map((s, n) => {
          const state = n === i ? "now" : seen.has(n) || n < i ? "done" : "later";
          return (
            <li key={s.id} className={`wz-r ${state}`}>
              <button
                type="button"
                className="wz-dot"
                disabled={state === "later"}
                onClick={() => state !== "later" && go(n)}
                title={state === "later" ? "Finish the earlier steps first" : `Go to ${s.title}`}
              >
                {state === "done" ? "✓" : n + 1}
              </button>
              <span className="wz-lbl">{s.title}</span>
            </li>
          );
        })}
        <li className={`wz-r ${onReview ? "now" : "later"}`}>
          <button type="button" className="wz-dot" disabled={!onReview}>✓</button>
          <span className="wz-lbl">Review</span>
        </li>
      </ol>

      <div className="wz-bar"><i style={{ width: `${((i + 1) / total) * 100}%` }} /></div>

      <div className="wz-panel">
        {onReview ? (
          <>
            <h3 className="wz-h">Check before you create</h3>
            <p className="wz-hint">
              Nothing has been saved yet. Anything wrong here can be fixed by clicking
              the step name beside it.
            </p>
            <div className="wz-review">
              {live.map((s, n) => {
                const rows = s.summary?.() ?? [];
                if (!rows.length) return null;
                return (
                  <section key={s.id}>
                    <header>
                      <b>{s.title}</b>
                      <button type="button" onClick={() => go(n)}>Change</button>
                    </header>
                    <dl>
                      {rows.map(([k, v], idx) => (
                        <div key={idx}>
                          <dt>{k}</dt>
                          <dd>{v === "" || v == null ? <em>not set</em> : v}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <h3 className="wz-h">{current?.title}</h3>
            {current?.hint && <p className="wz-hint">{current.hint}</p>}
            <div className="wz-fields">{current?.render()}</div>
          </>
        )}

        {/* Step errors sit next to the buttons that caused them, and persist
            until the next attempt rather than fading. */}
        {(stepError || error) && <div className="wz-err">{stepError || error}</div>}
      </div>

      {/*
        A failed save gets its own treatment, not a line of red text.
        It is the one message that means "the thing you asked for did not
        happen", and it has to be impossible to mistake for a field hint.
      */}
      {saveError && (
        <div className="wz-fail" role="alert">
          <span className="ico">!</span>
          <div>
            <b>Not saved</b>
            <p>{saveError}</p>
            <em>Your entries are still here — fix the problem and press {finishLabel} again.</em>
          </div>
          <button type="button" onClick={() => setSaveError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <footer className="wz-foot">
        <button type="button" className="wz-btn ghost" onClick={onCancel} disabled={working}>
          Cancel
        </button>
        <span className="wz-of">Step {i + 1} of {total}</span>
        <div className="wz-actions">
          {i > 0 && (
            <button type="button" className="wz-btn" onClick={() => go(i - 1)} disabled={working}>
              ← Back
            </button>
          )}
          {onReview ? (
            <button type="button" className="wz-btn go" onClick={submit} disabled={working}>
              {working ? <><span className="wz-spin" /> Saving…</> : finishLabel}
            </button>
          ) : (
            <button type="button" className="wz-btn go" onClick={next} disabled={working}>
              Next →
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/** Labelled field — keeps every wizard step visually identical. */
export function Field({
  label, hint, required, error, children,
}: {
  label: string; hint?: string; required?: boolean; error?: string; children: React.ReactNode;
}) {
  return (
    <label className={`wz-f ${error ? "bad" : ""}`}>
      <span className="wz-f-l">
        {label}{required && <i title="Required">*</i>}
      </span>
      {children}
      {hint && !error && <span className="wz-f-h">{hint}</span>}
      {error && <span className="wz-f-e">{error}</span>}
    </label>
  );
}

const CSS = `
/* Centred and width-capped. A form stretched across a 1400px dialog makes the
   eye travel the full width for a 12-character field; 720px keeps a label and
   its input in one glance, which is the width most of these forms actually
   need. The dialog can be wider — the form does not have to fill it. */
.wz{display:flex;flex-direction:column;gap:13px;max-width:720px;margin:0 auto;width:100%}

.wz-rail{list-style:none;display:flex;gap:4px;margin:0;padding:0;overflow-x:auto;padding-bottom:2px}
.wz-r{display:flex;align-items:center;gap:7px;padding-right:10px;flex-shrink:0}
.wz-dot{width:25px;height:25px;flex-shrink:0;border-radius:50%;display:grid;place-items:center;
  font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;
  background:var(--surface-2);border:1px solid var(--border);color:var(--muted)}
.wz-dot:disabled{cursor:default}
.wz-r.done .wz-dot{background:rgba(16,185,129,.16);border-color:rgba(16,185,129,.55);color:#6EE7B7}
.wz-r.now .wz-dot{background:linear-gradient(135deg,#6C3CE1,#E9408B);border-color:transparent;color:#fff}
.wz-lbl{font-size:11.5px;white-space:nowrap;color:var(--muted)}
.wz-r.now .wz-lbl{color:var(--text);font-weight:700}
.wz-r.done .wz-lbl{color:var(--text);opacity:.75}

.wz-bar{height:4px;border-radius:99px;background:var(--surface-2);overflow:hidden}
.wz-bar i{display:block;height:100%;border-radius:99px;transition:width .35s ease;
  background:linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)}

.wz-panel{background:var(--surface-2);border:1px solid var(--border);border-radius:14px;padding:18px}
.wz-h{margin:0 0 4px;font-size:15px;font-weight:800;color:var(--text)}
.wz-hint{margin:0 0 16px;font-size:12px;line-height:1.7;color:var(--muted)}
.wz-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}

.wz-f{display:flex;flex-direction:column;gap:5px}
.wz-f-l{font-size:11.5px;font-weight:600;color:var(--muted)}
.wz-f-l i{color:#F87171;font-style:normal;margin-left:3px}
.wz-f input,.wz-f select,.wz-f textarea{width:100%;padding:9px 11px;border-radius:9px;
  font-family:inherit;font-size:13px;background:var(--bg);color:var(--text);
  border:1px solid var(--border)}
.wz-f input:focus,.wz-f select:focus,.wz-f textarea:focus{outline:none;border-color:#6C3CE1}
.wz-f.bad input,.wz-f.bad select{border-color:#EF4444}
.wz-f-h{font-size:10.5px;line-height:1.6;color:var(--muted);opacity:.85}
.wz-f-e{font-size:10.5px;line-height:1.6;color:#FCA5A5}

.wz-review{display:flex;flex-direction:column;gap:12px}
.wz-review section{border:1px solid var(--border);border-radius:11px;overflow:hidden}
.wz-review header{display:flex;justify-content:space-between;align-items:center;
  padding:9px 13px;background:var(--surface)}
.wz-review header b{font-size:12px;color:var(--text)}
.wz-review header button{background:none;border:none;cursor:pointer;font-family:inherit;
  font-size:11px;font-weight:700;color:#A78BFA}
.wz-review dl{margin:0;padding:5px 13px 11px}
.wz-review dl>div{display:flex;justify-content:space-between;gap:16px;padding:5px 0;
  border-bottom:1px dashed var(--border)}
.wz-review dl>div:last-child{border-bottom:none}
.wz-review dt{font-size:11.5px;color:var(--muted)}
.wz-review dd{margin:0;font-size:11.5px;font-weight:600;color:var(--text);text-align:right;
  word-break:break-word}
.wz-review dd em{font-style:italic;font-weight:400;color:var(--muted);opacity:.7}

.wz-err{margin-top:14px;padding:10px 13px;border-radius:10px;font-size:12px;line-height:1.6;
  background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.42);color:#FCA5A5}

/* ── Failed save ────────────────────────────────────────────────────
   Deliberately loud, and deliberately NOT a toast: a toast that fades takes
   the only explanation with it, which is how "Delete failed" cost hours
   earlier in this project. It stays until dismissed or until the next try. */
.wz-fail{display:flex;align-items:flex-start;gap:11px;padding:13px 15px;border-radius:13px;
  background:rgba(239,68,68,.13);border:1px solid rgba(239,68,68,.5);
  animation:wz-shake .3s ease}
.wz-fail .ico{flex-shrink:0;width:22px;height:22px;border-radius:50%;display:grid;
  place-items:center;font-weight:900;font-size:13px;background:#EF4444;color:#fff}
.wz-fail div{flex:1;min-width:0}
.wz-fail b{display:block;font-size:13px;color:#FCA5A5;margin-bottom:3px}
.wz-fail p{margin:0 0 5px;font-size:12px;line-height:1.65;color:var(--text);word-break:break-word}
.wz-fail em{font-style:normal;font-size:11px;color:var(--muted)}
.wz-fail>button{flex-shrink:0;background:none;border:none;cursor:pointer;color:var(--muted);
  font-size:14px;line-height:1;padding:2px}
.wz-fail>button:hover{color:var(--text)}
@keyframes wz-shake{
  0%,100%{transform:translateX(0)}
  25%{transform:translateX(-4px)}
  75%{transform:translateX(4px)}
}

.wz-spin{display:inline-block;width:11px;height:11px;margin-right:6px;vertical-align:-1px;
  border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;
  animation:wz-rot .6s linear infinite}
@keyframes wz-rot{to{transform:rotate(360deg)}}

/* Sticky so Cancel and the primary action are reachable without scrolling back
   — on a long step the buttons used to sit below the fold. */
.wz-foot{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;
  justify-content:space-between;gap:12px;padding-top:11px;margin-top:1px;
  background:var(--surface);border-top:1px solid var(--border)}
.wz-of{font-size:11.5px;color:var(--muted)}
.wz-actions{display:flex;gap:8px}
.wz-btn{padding:9px 17px;border-radius:10px;font-size:12.5px;font-weight:700;cursor:pointer;
  font-family:inherit;background:var(--surface-2);border:1px solid var(--border);color:var(--text)}
.wz-btn:hover:not(:disabled){border-color:#6C3CE1}
.wz-btn:disabled{opacity:.5;cursor:not-allowed}
.wz-btn.ghost{background:transparent;color:var(--muted)}
.wz-btn.go{background:linear-gradient(135deg,#6C3CE1,#E9408B);border-color:transparent;color:#fff;
  box-shadow:0 3px 14px rgba(108,60,225,.32)}
.wz-btn.go:hover:not(:disabled){filter:brightness(1.08)}
.wz-btn.go:active:not(:disabled){transform:translateY(1px)}
.wz-btn:focus-visible{outline:2px solid #A78BFA;outline-offset:2px}
.wz-f input:focus,.wz-f select:focus{box-shadow:0 0 0 3px rgba(108,60,225,.18)}

@media (max-width:600px){
  .wz-fields{grid-template-columns:1fr}
  .wz-lbl{display:none}
  .wz-foot{flex-wrap:wrap}
}
`;
