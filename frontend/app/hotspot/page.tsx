"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import API_BASE from "../components/api";

/**
 * CAPTIVE PORTAL — the page a hotspot customer sees before they have internet.
 *
 * THE SITUATION THIS PAGE IS FOR
 * Someone bought a printed card in a shop, joined the Wi-Fi, and their browser
 * was intercepted and dropped here by MikroTik. They have no account, no app,
 * and no patience. There are exactly two fields worth showing.
 *
 * WHY IT LOOKS THE WAY IT DOES
 *   Two inputs and one button. Everything else — history, language chrome,
 *   marketing — costs a tap from someone who is standing up.
 *   The code input uppercases as they type, because the card is printed in
 *   caps and a phone keyboard is not.
 *   The PIN input is numeric-only (inputMode="numeric") so phones show a
 *   keypad, and it is NOT masked: nobody is shoulder-surfing a one-hour card,
 *   and masking causes far more mistyped PINs than it prevents theft.
 *   Errors are shown verbatim from the server. The server deliberately returns
 *   one identical message for every failure so the endpoint cannot be used to
 *   discover which codes are real — so this page must NOT try to be helpful by
 *   guessing which part was wrong.
 *
 * HOW IT ACTUALLY CONNECTS THEM
 * Redeeming turns the card into a RADIUS credential, but the router is what
 * grants access. MikroTik redirects here with `link-login-only`; we post the
 * credentials straight back to it, so a successful redeem flows into a live
 * session with no second step. If that parameter is absent (someone opened
 * this page directly, or a non-MikroTik gateway), we show the credentials so
 * they can be typed into the router's own login form instead of leaving the
 * customer stranded with a spent card.
 */
export default function HotspotPage() {
  return (
    <Suspense fallback={null}>
      <Portal />
    </Suspense>
  );
}

type Success = {
  username: string;
  password: string;
  minutes: number | null;
  dataQuota: string | null;
};

function Portal() {
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<Success | null>(null);
  const [urdu, setUrdu] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  /**
   * Router-supplied context. Read from the URL rather than passed in, because
   * MikroTik builds this redirect itself and we do not control its shape.
   */
  const router = useMemo(() => {
    if (typeof window === "undefined") return { mac: "", loginUrl: "" };
    const q = new URLSearchParams(window.location.search);
    return {
      mac: q.get("mac") || "",
      // MikroTik's own variable name. `link-orig` is where to send them after.
      loginUrl: q.get("link-login-only") || q.get("link-login") || "",
    };
  }, []);

  // Hand the credentials to the router the moment we have them. Doing this in
  // an effect (not inline) guarantees the hidden inputs are rendered first.
  useEffect(() => {
    if (ok && router.loginUrl && formRef.current) formRef.current.submit();
  }, [ok, router.loginUrl]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${API_BASE}/public/hotspot/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, pin, mac: router.mac }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Server messages are intentionally uniform — show them as-is.
        setErr(
          d?.message ||
            "That card is not valid, has already been used, or has expired.",
        );
        return;
      }
      setOk(d as Success);
    } catch {
      setErr("Could not reach the network just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const t = (en: string, ur: string) => (urdu ? ur : en);

  return (
    <div className="hp" dir={urdu ? "rtl" : "ltr"}>
      <style>{CSS}</style>

      <div className="hp-card">
        <div className="hp-top">
          <div className="hp-brand">{t("Wi-Fi Login", "وائی فائی لاگ اِن")}</div>
          <button
            type="button"
            className="hp-lang"
            onClick={() => setUrdu((v) => !v)}
            aria-label="Toggle language"
          >
            {urdu ? "English" : "اردو"}
          </button>
        </div>

        {!ok && (
          <>
            <p className="hp-lead">
              {t(
                "Enter the code and PIN printed on your card.",
                "اپنے کارڈ پر لکھا کوڈ اور پن درج کریں۔",
              )}
            </p>

            <form onSubmit={submit}>
              <label className="hp-lab" htmlFor="hp-code">
                {t("Card code", "کارڈ کوڈ")}
              </label>
              <input
                id="hp-code"
                className="hp-in hp-mono"
                value={code}
                // Cards are printed in caps; phone keyboards are not.
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                autoFocus
                required
              />

              <label className="hp-lab" htmlFor="hp-pin">
                {t("PIN", "پن")}
              </label>
              <input
                id="hp-pin"
                className="hp-in hp-mono"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                autoComplete="off"
                required
              />

              {err && <div className="hp-err">{err}</div>}

              <button className="hp-go" type="submit" disabled={busy}>
                {busy ? t("Connecting…", "منسلک ہو رہا ہے…") : t("Connect", "منسلک کریں")}
              </button>
            </form>
          </>
        )}

        {ok && (
          <div className="hp-ok">
            <div className="hp-tick" aria-hidden>
              ✓
            </div>
            <div className="hp-ok-t">{t("Card accepted", "کارڈ قبول کر لیا گیا")}</div>
            <div className="hp-ok-s">
              {ok.minutes
                ? t(
                    `You have ${formatDuration(ok.minutes)} of internet.`,
                    `آپ کے پاس ${formatDuration(ok.minutes)} کا انٹرنیٹ ہے۔`,
                  )
                : t("You are being connected.", "آپ کو منسلک کیا جا رہا ہے۔")}
              {ok.dataQuota ? ` (${ok.dataQuota})` : ""}
            </div>

            {/* No router redirect available — they finish by hand rather than
                being left with a spent card and nowhere to type it. */}
            {!router.loginUrl && (
              <div className="hp-manual">
                <p>
                  {t(
                    "Enter these on the Wi-Fi login screen:",
                    "یہ وائی فائی لاگ اِن اسکرین پر درج کریں:",
                  )}
                </p>
                <div className="hp-cred">
                  <span>{t("Username", "یوزر نیم")}</span>
                  <b className="hp-mono">{ok.username}</b>
                </div>
                <div className="hp-cred">
                  <span>{t("Password", "پاس ورڈ")}</span>
                  <b className="hp-mono">{ok.password}</b>
                </div>
              </div>
            )}

            {router.loginUrl && (
              <div className="hp-ok-s hp-dim">
                {t("Signing you in…", "سائن اِن کیا جا رہا ہے…")}
              </div>
            )}
          </div>
        )}
      </div>

      <p className="hp-foot">
        {t("Keep your card until your time runs out.", "وقت ختم ہونے تک کارڈ سنبھال کر رکھیں۔")}
      </p>

      {/* The actual handoff to MikroTik. Plain form POST, because the router's
          login endpoint is not our API and does not speak JSON or CORS. */}
      {ok && router.loginUrl && (
        <form ref={formRef} method="post" action={router.loginUrl} className="hp-hidden">
          <input type="hidden" name="username" value={ok.username} readOnly />
          <input type="hidden" name="password" value={ok.password} readOnly />
        </form>
      )}
    </div>
  );
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  if (h < 24) return `${Math.round(h * 10) / 10} hours`;
  const d = Math.round((h / 24) * 10) / 10;
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * Self-contained and single-theme, for the same reason as the status page:
 * this renders on unknown phones, over a connection that is not yet working,
 * and must never inherit a half-loaded admin theme.
 */
const CSS = `
.hp{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px;background:#F4F6F9;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#14181F}
.hp *{box-sizing:border-box}
.hp-card{width:100%;max-width:380px;background:#fff;border:1px solid #E2E6EC;border-radius:16px;padding:22px 20px 24px}
.hp-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.hp-brand{font-size:17px;font-weight:800;letter-spacing:-.02em}
.hp-lang{background:#fff;border:1px solid #DDE1E7;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:600;color:#3C4653;cursor:pointer;font-family:inherit}
.hp-lead{font-size:13.5px;color:#5A6472;line-height:1.6;margin:0 0 16px}
.hp-lab{display:block;font-size:12px;font-weight:700;color:#3C4653;margin:0 0 6px;text-transform:uppercase;letter-spacing:.04em}
.hp-in{width:100%;border:1px solid #D7DCE3;border-radius:10px;padding:13px 14px;font-size:17px;margin-bottom:14px;background:#fff;color:#14181F;font-family:inherit}
.hp-in:focus{outline:none;border-color:#2F6FED;box-shadow:0 0 0 3px rgba(47,111,237,.14)}
.hp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}
.hp-err{background:#FEF4F3;border:1px solid #F3C9C4;color:#A0342A;border-radius:10px;padding:11px 13px;font-size:13px;line-height:1.55;margin-bottom:14px}
.hp-go{width:100%;border:0;border-radius:10px;background:#2F6FED;color:#fff;font-size:15px;font-weight:700;padding:14px;cursor:pointer;font-family:inherit}
.hp-go:disabled{background:#9DB6F2;cursor:default}
.hp-ok{text-align:center;padding:6px 0 2px}
.hp-tick{width:52px;height:52px;border-radius:50%;background:#E8F7EE;color:#1F8A4C;font-size:26px;font-weight:700;display:flex;align-items:center;justify-content:center;margin:4px auto 14px}
.hp-ok-t{font-size:18px;font-weight:800;letter-spacing:-.02em}
.hp-ok-s{font-size:13.5px;color:#5A6472;margin-top:6px;line-height:1.6}
.hp-dim{color:#8A93A0}
.hp-manual{margin-top:18px;border-top:1px solid #EEF1F5;padding-top:14px;text-align:start}
.hp-manual p{font-size:12.5px;color:#5A6472;margin:0 0 10px}
.hp-cred{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #F2F4F7;font-size:13px}
.hp-cred span{color:#8A93A0}
.hp-cred b{font-size:15px}
.hp-foot{font-size:11.5px;color:#8A93A0;margin-top:18px;text-align:center}
.hp-hidden{display:none}
`;
