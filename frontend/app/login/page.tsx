"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "../components/logo";
import API_BASE from "../components/api";
import { BRAND } from "../../lib/brand";
import { useI18n } from "../../lib/i18n";
import Link from "next/link";
import { NetworkScene } from "../components/landing/network-scene";
import { LanguagePicker } from "../components/landing/language-picker";
import s from "../components/landing/landing.module.css";
import { ensureMediaToken } from "../components/image-upload";
import { isPlatformSession, PLATFORM_HOME } from "../components/platform";

const SUPPORT = BRAND.supportEmail;
const getBackendUrl = () => API_BASE;

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);
  const [demoCredentials, setDemoCredentials] = useState<{email:string;password:string}|null>(null);
  // The demo button only exists on a server that hosts the sandbox. On a
  // customer's panel it is off, and a button that always fails is worse than
  // no button. Null until the server has answered, so it never flashes in.
  const [demoEnabled, setDemoEnabled] = useState<boolean | null>(null);
  const { t } = useI18n();
  const router = useRouter();

  useEffect(() => {
    if (localStorage.getItem("token")) router.push(isPlatformSession() ? PLATFORM_HOME : "/dashboard");
  }, [router]);

  // "Sign in as super admin" from a company lands here with the email filled in.
  useEffect(() => {
    try {
      const e = new URLSearchParams(window.location.search).get("email");
      if (e) setEmail(e);
    } catch { /* no query */ }
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/demo/public`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d) => setDemoEnabled(d?.enabled === true))
      .catch(() => setDemoEnabled(false));
  }, []);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) { setMessage("❌ Please enter both email and password"); return; }
    setMessage(""); setLoading(true);
    try {
      const response = await fetch(`${getBackendUrl()}/auth/login`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({email:email.trim().toLowerCase(),password,code:code||undefined}) });
      let data:any={}; try { data=await response.json(); } catch {}
      if (response.ok && data.requires2fa) { setNeeds2fa(true); setMessage("🔐 Enter the 6-digit code from your authenticator app"); return; }
      if (response.ok && data.token) {
        localStorage.setItem("token",data.token); localStorage.setItem("user",JSON.stringify(data.user));
        // Photos and CNIC scans need a media token; fetching it during the
        // redirect pause means the first screen's images load first time.
        if (!data.user?.mustChangePassword) void ensureMediaToken(true);
        // A first-boot admin (or anyone still on the published default) goes to
        // change their password before anything else — the API would answer
        // every other screen with 403 until they do.
        // The platform account opens on its companies, never a business dashboard.
        const home = data.user?.role === "SUPER_ADMIN" ? PLATFORM_HOME : "/dashboard";
        const next = data.user?.mustChangePassword ? "/change-password" : home;
        setMessage(next === home ? "✅ Login successful! Redirecting..." : "🔐 Please choose a new password to continue.");
        setTimeout(()=>router.push(next),700);
      }
      else setMessage(`❌ Login failed: ${data.message || "Invalid email or password"}`);
    } catch { setMessage("❌ Unable to connect to the server. Please try again in a moment."); }
    finally { setLoading(false); }
  };

  // Enter submits through the <form> below; a key handler as well would send the login twice.

  const handleDemo = async () => {
    setLoading(true);
    setMessage("Creating a NEW demo account…");
    setDemoCredentials(null);
    try {
      // Always create a fresh demo account. Never reuse the shared demo endpoint.
      const r = await fetch(`${API_BASE}/demo/create`, { method:"POST", headers:{"Content-Type":"application/json"}, cache:"no-store" });
      let d:any = {};
      try { d = await r.json(); } catch {}
      const loginEmail = d.email || d.username || d.user?.email || d.user?.username;
      const loginPassword = d.password;
      if (!r.ok || !loginEmail || !loginPassword) throw new Error(d?.message || "The demo service did not return usable credentials");
      const c={email:String(loginEmail),password:String(loginPassword)};
      setEmail(c.email);
      setPassword(c.password);
      setCode("");
      setNeeds2fa(false);
      setDemoCredentials(c);
      setMessage("✅ NEW demo account created. Credentials are shown below.");
    } catch (e:any) {
      setMessage(`❌ ${e?.message || "Could not create a demo account right now. Please try again."}`);
    } finally { setLoading(false); }
  };

  const copy=async(v:string,label:string)=>{try{await navigator.clipboard.writeText(v);setMessage(`✅ ${label} copied to clipboard`);}catch{setMessage(`${label}: ${v}`);}};

  const isError = message.includes("❌");

  return (
    <main id="main" className={s.root}>
      <div className={s.aurora} aria-hidden="true" />
      <div className={`${s.wrap} ${s.loginGrid}`}>
        <div className={s.loginStory}>
          <div className={s.loginCopy}>
            <Link href="/" className={s.back}>← {t("Back to home")}</Link>
            <div style={{ marginTop: 22 }} className="ul-float">
              <span className="ul-glow"><Logo size={68} withText subtitle={BRAND.subtitle} tone="onDark" /></span>
            </div>
            <h1 className={s.loginH1}>
              {t("Command Center")} {t("for")} <span className={s.lit}>{BRAND.subtitle}</span>
            </h1>
            <p className={s.loginLede}>
              {t("Secure. Fast. Always on.")} {t("Enterprise-grade infrastructure")} {t("built for modern ISPs.")}
            </p>
          </div>
          <NetworkScene variant="login" className={s.loginScene} label={t("3D view of a healthy fiber network around a core router.")} />
          <div className={s.loginStats}>
            {/* Facts the code backs, not marketing numbers: AES-256-GCM in common/crypto-box.ts, the UserRole enum, LANGS in lib/i18n. */}
            {[["AES-256", "Encrypted router secrets"], ["7", "User Roles"], ["5", "Languages"]].map(([v, k]) => (
              <div key={k}><b>{v}</b><small>{t(k)}</small></div>
            ))}
          </div>
        </div>

        <div className={s.card}>
          <div className={s.cardTop}>
            <span className={s.label}>{t("Secure Access")}</span>
            <LanguagePicker />
          </div>
          <h2 className={s.cardTitle}>{t("Sign in")}</h2>
          <p className={s.cardSub}>{t("Enter your credentials to continue")}</p>

          <form method="post" onSubmit={(e) => { e.preventDefault(); if (!loading) void handleLogin(); }} noValidate>
            <div className={s.field}>
              <label className={s.fieldLabel} htmlFor="jb-login-email">{t("Email Address")}</label>
              <input id="jb-login-email" className={s.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="you@company.com" />
            </div>
            <div className={s.field}>
              <label className={s.fieldLabel} htmlFor="jb-login-password">{t("Password")}</label>
              <input id="jb-login-password" className={s.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>
            {needs2fa && (
              <div className={s.field}>
                <label className={s.fieldLabel} htmlFor="jb-login-code">{t("Authenticator code")}</label>
                <input id="jb-login-code" className={s.input} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="6-digit authenticator code" autoComplete="one-time-code" />
              </div>
            )}
            <button type="submit" disabled={loading} className={`${s.btn} ${s.primary} ${s.full}`} style={{ marginTop: 6 }}>
              {loading ? t("Signing In...") : t("Sign In →")}
            </button>
          </form>

          {demoEnabled && (
            <button type="button" disabled={loading} onClick={handleDemo} className={s.demoBtn}>
              {loading ? "Creating new demo…" : "Try a NEW demo account"}
            </button>
          )}

          {demoCredentials && (
            <div className={s.creds}>
              <div className={s.credsTitle}>NEW demo login credentials</div>
              <div className={s.credsKey}>Login email / username</div>
              <div className={s.credsRow}>
                <code>{demoCredentials.email}</code>
                <button type="button" className={s.linkBtn} onClick={() => copy(demoCredentials.email, "Email / username")}>Copy</button>
              </div>
              <div className={s.credsKey}>Login password</div>
              <div className={s.credsRow}>
                <code>{demoCredentials.password}</code>
                <button type="button" className={s.linkBtn} onClick={() => copy(demoCredentials.password, "Password")}>Copy</button>
              </div>
              <button type="button" className={`${s.btn} ${s.full}`} style={{ padding: 10, fontSize: 14 }} onClick={handleLogin}>Sign in with this demo account</button>
            </div>
          )}

          {message && (
            <p className={`${s.msg} ${isError ? s.msgError : ""}`} role={isError ? "alert" : "status"} data-error={isError ? "" : undefined}>
              {message}
            </p>
          )}
          <div className={s.help}>
            {t("Need help?")} <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>
          </div>
        </div>
      </div>
    </main>
  );
}
