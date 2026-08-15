"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { silent } from "../components/silent";
import API_BASE from "../components/api";
import { Logo } from "../components/logo";
import { BRAND } from "../../lib/brand";
import { LANGS, useI18n } from "../../lib/i18n";

const API = API_BASE;

const NOVA = "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)";
const T = {
  bg: "#080b12", card: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.09)",
  row: "rgba(255,255,255,0.05)", text: "#fff", muted: "#94a3b8", sub: "#64748b",
  accent: "#E9408B", green: "#22c55e", red: "#f87171", amber: "#f59e0b",
};

const TABS = ["Overview", "Usage", "Invoices", "Support", "My Account"] as const;
type Tab = (typeof TABS)[number];

const hms = (s: number) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

/** Language picker — same pattern as the login screen; reused in both views. */
function LangSwitch() {
  const { lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          background: "transparent", border: `1px solid ${T.border}`,
          color: T.muted, borderRadius: 9, padding: "6px 11px",
          fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
        }}
      >
        🌐 {LANGS.find((l) => l.code === lang)?.native ?? "English"}
      </button>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: 36, zIndex: 60, width: 180,
          background: "#0f1625", border: `1px solid ${T.border}`,
          borderRadius: 12, padding: 6, boxShadow: "0 20px 50px rgba(0,0,0,.5)",
        }}>
          {LANGS.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => { setLang(l.code); setOpen(false); }}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                width: "100%", background: lang === l.code ? "rgba(233,64,139,.14)" : "transparent",
                border: "none", color: "#fff", borderRadius: 8, padding: "8px 10px",
                fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                textAlign: "start",
              }}
            >
              <span>{l.native}</span>
              {lang === l.code && <span style={{ color: "#F9A8D4" }}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PortalPage() {
  const { t, locale, dir } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<any>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [login, setLogin] = useState({ username: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<any>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [gateways, setGateways] = useState<string[]>([]);
  const [tickets, setTickets] = useState<any[]>([]);
  const [ticketForm, setTicketForm] = useState({ subject: "", description: "" });
  const [paidBanner, setPaidBanner] = useState<string>("");
  // Self-service: recharge by voucher, change password, connection history.
  const [sessions, setSessions] = useState<any[]>([]);
  const [voucher, setVoucher] = useState({ code: "", pin: "" });
  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "" });
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  const headers = (tk = token) => ({ "Content-Type": "application/json", Authorization: `Bearer ${tk}` });

  const get = useCallback(async (path: string, tk = token) => {
    const r = await fetch(`${API}${path}`, { headers: headers(tk) });
    if (r.status === 401) { localStorage.removeItem("portal_token"); setToken(null); setMe(null); throw new Error("unauthorized"); }
    return r.json();
  }, [token]);

  // Locale-aware formatters: dates + numbers follow the active language.
  const fdate = useMemo(() => (d?: string | null) => (d ? new Date(d).toLocaleDateString(locale, { dateStyle: "medium" }) : "—"), [locale]);
  const fdt = useMemo(() => (d?: string | null) => (d ? new Date(d).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "—"), [locale]);
  const fmt = useMemo(() => (n: number) => new Intl.NumberFormat(locale).format(Math.round((n || 0) * 100) / 100), [locale]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("paid") === "1") setPaidBanner(t("Payment received — your service has been renewed."));
    if (params.get("paid") === "0") setPaidBanner(t("Payment was cancelled or failed."));
    const saved = localStorage.getItem("portal_token");
    if (saved) {
      setToken(saved);
      get("/portal/me", saved).then(setMe).catch(silent("restoreSession"));
    }
  }, []);

  useEffect(() => {
    if (!token || !me) return;
    if (tab === "Usage") get("/portal/usage").then(setUsage).catch(silent("loadUsage"));
    if (tab === "Invoices") {
      get("/portal/invoices").then(setInvoices).catch(silent("loadInvoices"));
      get("/portal/gateways").then(setGateways).catch(silent("loadGateways"));
    }
    if (tab === "Support") get("/portal/tickets").then(setTickets).catch(silent("loadTickets"));
    if (tab === "My Account") get("/portal/sessions?limit=20").then(setSessions).catch(silent("loadSessions"));
  }, [tab, token, me]);

  /** Redeem a prepaid scratch card into the wallet. */
  async function redeem() {
    if (!voucher.code.trim()) return setNote({ text: t("Enter the voucher code."), ok: false });
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`${API}/portal/recharge`, {
        method: "POST", headers: headers(), body: JSON.stringify(voucher),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || t("Enter the voucher code."));
      setVoucher({ code: "", pin: "" });
      setNote({ text: `${t("Recharged. New balance:")} ${fmt(data.newBalance ?? 0)}`, ok: true });
      // Refresh the header balance.
      get("/portal/me").then(setMe).catch(silent("refreshMeAfterRecharge"));
    } catch (e: any) {
      setNote({ text: e.message, ok: false });
    } finally { setBusy(false); }
  }

  /** Change the PPPoE password (applies on next reconnect). */
  async function changePassword() {
    if (!pwForm.currentPassword || !pwForm.newPassword) {
      return setNote({ text: t("Enter both your current and new password."), ok: false });
    }
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`${API}/portal/change-password`, {
        method: "POST", headers: headers(), body: JSON.stringify(pwForm),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || t("Password changed."));
      setPwForm({ currentPassword: "", newPassword: "" });
      setNote({ text: data.note || t("Password changed."), ok: true });
    } catch (e: any) {
      setNote({ text: e.message, ok: false });
    } finally { setBusy(false); }
  }

  async function doLogin() {
    setErr(""); setBusy(true);
    try {
      const r = await fetch(`${API}/portal/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(login) });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || "Login failed");
      localStorage.setItem("portal_token", data.token);
      setToken(data.token);
      setMe(data.subscriber);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  function logout() {
    localStorage.removeItem("portal_token");
    setToken(null); setMe(null);
  }

  async function payNow(invoiceId: number, gateway: string) {
    setBusy(true);
    try {
      const r = await fetch(`${API}/portal/invoices/${invoiceId}/pay/${gateway}`, { method: "POST", headers: headers() });
      const data = await r.json();
      if (data?.paymentUrl) window.location.href = data.paymentUrl;
      else setErr(data?.message || "Could not start payment");
    } finally { setBusy(false); }
  }

  async function submitTicket() {
    if (!ticketForm.subject || !ticketForm.description) return setErr(t("Subject and description required"));
    setBusy(true);
    try {
      await fetch(`${API}/portal/tickets`, { method: "POST", headers: headers(), body: JSON.stringify(ticketForm) });
      setTicketForm({ subject: "", description: "" });
      setTickets(await get("/portal/tickets"));
    } finally { setBusy(false); }
  }

  const card: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 18 };
  const input: React.CSSProperties = {
    background: "rgba(255,255,255,0.05)", border: `1px solid ${T.border}`, borderRadius: 10,
    padding: "11px 13px", color: T.text, fontSize: 14, width: "100%", outline: "none",
    transition: "border-color .2s, box-shadow .2s", fontFamily: "inherit",
  };
  const inputFocus = { borderColor: T.accent, boxShadow: "0 0 0 3px rgba(233,64,139,0.12)" };
  const btn = (bg: string): React.CSSProperties => ({
    background: bg, color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px",
    fontSize: 13, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
    transition: "transform .15s, box-shadow .2s", fontFamily: "inherit",
  });
  const chip = (color: string, bg: string): React.CSSProperties => ({
    fontSize: 11, padding: "3px 11px", borderRadius: 20, background: bg, color, fontWeight: 700, letterSpacing: "0.03em",
  });
  const label: React.CSSProperties = { display: "block", marginBottom: 6, fontSize: 11, fontWeight: 600, color: T.muted, letterSpacing: "0.5px" };

  /* ── shared background: grid + glow orbs, same family as the login screen ── */
  const bgDecor = (
    <>
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        backgroundImage:
          "linear-gradient(rgba(233,64,139,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(233,64,139,0.04) 1px, transparent 1px)",
        backgroundSize: "40px 40px",
      }} />
      <div style={{
        position: "absolute", width: 420, height: 420, top: -180, left: -120, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(233,64,139,0.12) 0%, transparent 70%)", filter: "blur(60px)", pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", width: 380, height: 380, bottom: -160, right: -100, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(100,80,255,0.1) 0%, transparent 70%)", filter: "blur(60px)", pointerEvents: "none",
      }} />
    </>
  );

  // ── LOGIN VIEW ──
  if (!token || !me) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Segoe UI', system-ui, sans-serif", position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        {bgDecor}
        <div style={{ position: "absolute", top: 18, right: 20, zIndex: 5 }}><LangSwitch /></div>

        <div style={{ ...card, width: 380, position: "relative", zIndex: 2, background: "#0c0f17", border: `1px solid ${T.border}`, boxShadow: "0 25px 50px -12px rgba(0,0,0,0.5)", borderRadius: 22, padding: "36px 32px" }}>
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <div style={{ display: "inline-flex" }}><Logo size={46} withText subtitle={BRAND.subtitle} /></div>
            <div style={{ fontSize: 12, color: T.sub, marginTop: 14, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 600 }}>
              {t("Customer Portal")}
            </div>
          </div>

          {paidBanner && (
            <div style={{ fontSize: 13, color: T.green, marginBottom: 12, textAlign: "center", padding: "10px 12px", background: "rgba(34,197,94,0.1)", borderRadius: 10 }}>{paidBanner}</div>
          )}

          <div style={{ display: "grid", gap: 12 }}>
            <div>
              <label style={label}>{t("Username")}</label>
              <input
                style={input} placeholder={t("Username")} value={login.username}
                onChange={(e) => setLogin({ ...login, username: e.target.value })}
                onFocus={(e) => Object.assign(e.target.style, inputFocus)}
                onBlur={(e) => { e.target.style.borderColor = T.border; e.target.style.boxShadow = "none"; }}
              />
            </div>
            <div>
              <label style={label}>{t("Password")}</label>
              <input
                style={input} placeholder="••••••••" type="password" value={login.password}
                onChange={(e) => setLogin({ ...login, password: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && doLogin()}
                onFocus={(e) => Object.assign(e.target.style, inputFocus)}
                onBlur={(e) => { e.target.style.borderColor = T.border; e.target.style.boxShadow = "none"; }}
              />
            </div>
            {err && <div style={{ fontSize: 12, color: T.red, padding: "8px 10px", background: "rgba(248,113,113,0.1)", borderRadius: 8 }}>{err}</div>}
            <button
              style={{ ...btn(NOVA), padding: "12px 18px", letterSpacing: "0.06em", boxShadow: "0 4px 14px rgba(233,64,139,0.35)" }}
              disabled={busy} onClick={doLogin}
              onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-1px)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; }}
            >
              {busy ? t("Signing In...") : t("Sign In →")}
            </button>
            <div style={{ fontSize: 11, color: T.sub, textAlign: "center" }}>{t("Use your internet connection username & password")}</div>
          </div>

          <div style={{ marginTop: 22, padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 8, textAlign: "center" }}>
            <span style={{ fontSize: 11, color: T.sub }}>
              {t("Need help?")}{" "}
              <a href={`mailto:${BRAND.supportEmail}`} style={{ color: "#F9A8D4", textDecoration: "none", fontWeight: 600 }}>{BRAND.supportEmail}</a>
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ── PORTAL VIEW ──
  const statusOk = me.status === "ACTIVE";

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Segoe UI', system-ui, sans-serif", position: "relative", overflow: "hidden" }}>
      {bgDecor}

      {/* Header */}
      <header style={{ position: "relative", zIndex: 2, maxWidth: 880, margin: "0 auto", padding: "22px 18px 6px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
          <Logo size={36} withText subtitle={BRAND.subtitle} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <LangSwitch />
          <button
            style={{ ...btn(T.card), border: `1px solid ${T.border}`, color: T.muted, background: "transparent", padding: "7px 14px", fontSize: 12 }}
            onClick={logout}
          >
            {t("Log out")}
          </button>
        </div>
      </header>

      {/* Greeting */}
      <div style={{ position: "relative", zIndex: 2, maxWidth: 880, margin: "0 auto", padding: "14px 18px 4px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em" }}>{t("Hi, ")}{me.fullName}</div>
            <div style={{ fontSize: 13, color: T.sub, marginTop: 2 }}>
              {statusOk ? "✓" : "!"} {me.package?.name || ""} · {t("Expires")} {fdate(me.expiryDate)}
            </div>
          </div>
          <span style={chip(statusOk ? T.green : T.red, statusOk ? "rgba(34,197,94,0.12)" : "rgba(248,113,113,0.12)")}>
            {statusOk ? "● " + t("Active") : "○ " + t("OFFLINE")}
          </span>
        </div>
      </div>

      {/* Paid banner */}
      {paidBanner && (
        <div style={{ position: "relative", zIndex: 2, maxWidth: 880, margin: "12px auto 0", padding: "0 18px" }}>
          <div style={{ ...card, padding: "12px 16px", cursor: "pointer", color: paidBanner.startsWith("✅") ? T.green : T.amber, fontSize: 13, fontWeight: 600, display: "flex", justifyContent: "space-between", gap: 8 }} onClick={() => setPaidBanner("")}>
            <span>{paidBanner}</span>
            <span style={{ color: T.sub }}>✕</span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <nav style={{ position: "relative", zIndex: 2, maxWidth: 880, margin: "0 auto", padding: "18px 18px 0", display: "flex", gap: 6, flexWrap: "wrap" }}>
        {TABS.map((name) => (
          <button
            key={name}
            onClick={() => setTab(name)}
            style={{
              ...(tab === name ? btn(NOVA) : btn(T.card)),
              ...(tab === name ? {} : { background: "transparent", border: `1px solid ${T.border}`, color: T.muted }),
              borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 700,
            }}
          >
            {t(name)}
          </button>
        ))}
      </nav>

      {/* Content */}
      <main style={{ position: "relative", zIndex: 2, maxWidth: 880, margin: "0 auto", padding: "16px 18px 60px" }}>
        {tab === "Overview" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
            <div style={{ ...card, gridColumn: "1 / -1", background: "linear-gradient(135deg, rgba(108,60,225,0.28), rgba(233,64,139,0.22))", border: "1px solid rgba(233,64,139,0.25)", padding: 22 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: "#d8c9f5", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>{t("Wallet balance")}</div>
                  <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.03em", marginTop: 4, background: NOVA, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>{fmt(me.balance)}</div>
                </div>
                <span style={chip(statusOk ? "#22c55e" : "#f87171", statusOk ? "rgba(34,197,94,0.15)" : "rgba(248,113,113,0.15)")}>
                  {statusOk ? "● " + t("Active") : "○ " + t("OFFLINE")}
                </span>
              </div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 11, color: T.sub, textTransform: "uppercase", letterSpacing: "0.08em" }}>{t("Status")}</div>
              <div style={{ marginTop: 8 }}>
                <span style={chip(statusOk ? T.green : T.red, statusOk ? "rgba(34,197,94,0.12)" : "rgba(248,113,113,0.12)")}>{me.status}</span>
              </div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 11, color: T.sub, textTransform: "uppercase", letterSpacing: "0.08em" }}>{t("Package")}</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 6 }}>{me.package?.name || "—"}</div>
              <div style={{ fontSize: 12, color: T.sub }}>{me.package ? `${me.package.downloadSpeed}↓ / ${me.package.uploadSpeed}↑ Mbps` : ""}</div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 11, color: T.sub, textTransform: "uppercase", letterSpacing: "0.08em" }}>{t("Expires")}</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 6 }}>{fdate(me.expiryDate)}</div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 11, color: T.sub, textTransform: "uppercase", letterSpacing: "0.08em" }}>{t("Wallet balance")}</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 6, color: T.green }}>{fmt(me.balance)}</div>
            </div>
          </div>
        )}

        {tab === "Usage" && (
          <div style={card}>
            {usage ? (
              <>
                <div style={{ display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={chip(usage.online ? T.green : T.muted, usage.online ? "rgba(34,197,94,0.12)" : "rgba(100,116,139,0.12)")}>
                    {usage.online ? "● " + t("ONLINE NOW") : "○ " + t("OFFLINE")}
                  </span>
                  <span style={{ fontSize: 13, color: T.sub }}>↓ {gb(usage.totals.download)} · ↑ {gb(usage.totals.upload)} · {hms(usage.totals.seconds)} ({t("Session(s)")} {usage.sessions.length})</span>
                </div>

                {/* Data cap / FUP allowance for the current cycle */}
                {usage.quota && usage.quota.quotaGb ? (() => {
                  const q = usage.quota;
                  const pct = Math.min(100, q.percentUsed ?? 0);
                  const bar = q.state === "BLOCKED" ? T.red : q.state === "THROTTLED" || pct >= 80 ? T.amber : T.green;
                  return (
                    <div style={{ marginBottom: 16, padding: 14, borderRadius: 12, background: T.row, border: `1px solid ${T.border}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
                        <span style={{ fontWeight: 700 }}>{t("Data used this cycle")}</span>
                        <span style={{ color: T.sub }}>
                          {q.usedGb} GB / {q.quotaGb} GB{q.bonusGb ? ` (+${q.bonusGb} GB)` : ""} · {q.remainingGb} {t("GB left")}
                        </span>
                      </div>
                      <div style={{ background: "rgba(100,116,139,0.2)", borderRadius: 8, height: 10, overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: 10, background: bar, transition: "width .3s", borderRadius: 8 }} />
                      </div>
                      {q.state !== "OK" && (
                        <div style={{ fontSize: 12, color: bar, marginTop: 6 }}>
                          {q.state === "BLOCKED" ? t("Your data allowance is used up — service is paused until renewal or a top-up.") : `${t("Fair-use speed reduction is active")}${q.throttledTo ? ` (${q.throttledTo})` : ""}.`}
                        </div>
                      )}
                    </div>
                  );
                })() : null}
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead><tr style={{ color: T.sub, fontSize: 11, textAlign: "start" }}>
                      <th style={{ padding: 6, textAlign: "start" }}>{t("Started")}</th>
                      <th style={{ padding: 6, textAlign: "start" }}>{t("Ended")}</th>
                      <th style={{ padding: 6, textAlign: "start" }}>{t("Time")}</th>
                      <th style={{ padding: 6, textAlign: "start" }}>{t("Download")}</th>
                      <th style={{ padding: 6, textAlign: "start" }}>{t("Upload")}</th>
                      <th style={{ padding: 6, textAlign: "start" }}>{t("IP")}</th>
                    </tr></thead>
                    <tbody>
                      {usage.sessions.map((s: any, i: number) => (
                        <tr key={i} style={{ background: i % 2 ? "transparent" : T.row }}>
                          <td style={{ padding: 6 }}>{fdt(s.start)}</td>
                          <td style={{ padding: 6 }}>{s.stop ? fdt(s.stop) : <span style={{ color: T.green }}>{t("active")}</span>}</td>
                          <td style={{ padding: 6 }}>{hms(s.seconds || 0)}</td>
                          <td style={{ padding: 6 }}>{gb(s.download)}</td>
                          <td style={{ padding: 6 }}>{gb(s.upload)}</td>
                          <td style={{ padding: 6, color: T.sub }}>{s.ip || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : <div style={{ color: T.muted }}>{t("Loading usage…")}</div>}
          </div>
        )}

        {tab === "Invoices" && (
          <div style={card}>
            {invoices.map((inv, i) => (
              <div key={inv.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 8px", background: i % 2 ? "transparent" : T.row, borderRadius: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{inv.invoiceNo}</div>
                  <div style={{ fontSize: 12, color: T.sub }}>{t("Due")} {fdate(inv.dueDate)}</div>
                </div>
                <div style={{ fontSize: 16, fontWeight: 800 }}>{fmt(inv.total)}</div>
                <span style={chip(
                  inv.status === "PAID" ? T.green : inv.status === "CANCELLED" ? T.sub : T.amber,
                  inv.status === "PAID" ? "rgba(34,197,94,0.12)" : inv.status === "CANCELLED" ? "rgba(100,116,139,0.12)" : "rgba(245,158,11,0.12)")}>
                  {inv.status}
                </span>
                {["UNPAID", "PARTIAL", "OVERDUE"].includes(inv.status) && gateways.map((g) => (
                  <button key={g} style={{ ...btn(T.green), padding: "6px 14px", fontSize: 12 }} disabled={busy} onClick={() => payNow(inv.id, g)}>
                    {t("Pay")} {g === "SANDBOX" ? t("(test)") : `via ${g}`}
                  </button>
                ))}
              </div>
            ))}
            {!invoices.length && <div style={{ color: T.sub, fontSize: 13 }}>{t("No invoices yet.")}</div>}
          </div>
        )}

        {tab === "Support" && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={card}>
              <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 12 }}>{t("Open a ticket")}</div>
              <div style={{ display: "grid", gap: 10 }}>
                <input style={input} placeholder={t("Subject")} value={ticketForm.subject} onChange={(e) => setTicketForm({ ...ticketForm, subject: e.target.value })} />
                <textarea style={{ ...input, minHeight: 90, resize: "vertical" }} placeholder={t("Describe the problem")} value={ticketForm.description} onChange={(e) => setTicketForm({ ...ticketForm, description: e.target.value })} />
                <button style={{ ...btn(NOVA), width: 150 }} disabled={busy} onClick={submitTicket}>{t("Submit")}</button>
              </div>
            </div>
            {tickets.map((tk) => (
              <div key={tk.id} style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                  <div style={{ fontWeight: 700 }}>{tk.subject} <span style={{ color: T.sub, fontWeight: 400, fontSize: 12 }}>({tk.ticketNo})</span></div>
                  <span style={chip(
                    tk.status === "OPEN" ? T.amber : tk.status === "RESOLVED" || tk.status === "CLOSED" ? T.green : T.accent,
                    tk.status === "OPEN" ? "rgba(245,158,11,0.12)" : tk.status === "RESOLVED" || tk.status === "CLOSED" ? "rgba(34,197,94,0.12)" : "rgba(233,64,139,0.12)")}>
                    {tk.status}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: T.sub, marginTop: 6 }}>{tk.description}</div>
                {tk.messages?.map((m: any) => (
                  <div key={m.id} style={{ fontSize: 13, marginTop: 8, padding: 9, background: T.row, borderRadius: 10 }}>
                    <span style={{ color: m.sentByType === "STAFF" ? T.accent : T.green, fontSize: 11, fontWeight: 800, letterSpacing: "0.05em" }}>
                      {m.sentByType === "STAFF" ? t("SUPPORT") : t("YOU")}
                    </span>
                    <div style={{ color: T.sub, marginTop: 2 }}>{m.message}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* ── MY ACCOUNT — recharge, password, connection history ── */}
        {tab === "My Account" && (
          <div style={{ display: "grid", gap: 14 }}>
            {note && (
              <div style={{
                ...card,
                borderColor: note.ok ? "rgba(34,197,94,0.4)" : "rgba(248,113,113,0.4)",
                color: note.ok ? T.green : T.red, fontSize: 13, fontWeight: 700,
              }}>
                {note.text}
              </div>
            )}

            {/* Recharge — the dominant top-up method here: a scratch card
                bought from a shop, no bank or card needed. */}
            <div style={card}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>{t("Recharge with a voucher")}</div>
              <div style={{ fontSize: 12, color: T.sub, marginBottom: 12, lineHeight: 1.6 }}>
                {t("Enter the code from your scratch card. Credit is added to your balance and your service renews automatically when it expires.")}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  style={{ ...input, flex: "1 1 180px" }}
                  placeholder={t("Voucher code")}
                  value={voucher.code}
                  onChange={(e) => setVoucher({ ...voucher, code: e.target.value })}
                />
                <input
                  style={{ ...input, flex: "0 1 130px" }}
                  placeholder={t("PIN (if any)")}
                  value={voucher.pin}
                  onChange={(e) => setVoucher({ ...voucher, pin: e.target.value })}
                />
                <button style={{ ...btn(T.green) }} disabled={busy} onClick={redeem}>
                  {busy ? t("Please wait…") : t("Recharge")}
                </button>
              </div>
            </div>

            {/* Password — pushed to RADIUS so it applies on reconnect. */}
            <div style={card}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>{t("Change your internet password")}</div>
              <div style={{ fontSize: 12, color: T.sub, marginBottom: 12, lineHeight: 1.6 }}>
                {t("This is the password your router uses to connect. It takes effect the next time you reconnect.")}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  style={{ ...input, flex: "1 1 170px" }}
                  type="password"
                  placeholder={t("Current password")}
                  value={pwForm.currentPassword}
                  onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })}
                />
                <input
                  style={{ ...input, flex: "1 1 170px" }}
                  type="password"
                  placeholder={t("New password")}
                  value={pwForm.newPassword}
                  onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })}
                />
                <button style={{ ...btn(NOVA) }} disabled={busy} onClick={changePassword}>
                  {t("Update")}
                </button>
              </div>
            </div>

            {/* Connection history — answers "was I really offline last night?" */}
            <div style={card}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>{t("Recent connections")}</div>
              {!sessions.length && (
                <div style={{ fontSize: 13, color: T.sub }}>{t("No connection history yet.")}</div>
              )}
              {sessions.map((s, i) => (
                <div key={i} style={{
                  display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6,
                  padding: "9px 0", borderBottom: `1px solid ${T.border}`, fontSize: 13,
                }}>
                  <div>
                    <span style={{ color: s.online ? T.green : T.sub, fontWeight: 700 }}>
                      {s.online ? "● " + t("Online now") : fdt(s.startedAt)}
                    </span>
                    <div style={{ fontSize: 11, color: T.sub }}>
                      {s.ipAddress || "—"} · {hms(s.durationSeconds)}
                      {s.reason ? ` · ${s.reason}` : ""}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: T.sub, textAlign: "end" }}>
                    ↑ {gb(s.uploadBytes)}<br />↓ {gb(s.downloadBytes)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer style={{ position: "relative", zIndex: 2, maxWidth: 880, margin: "0 auto", padding: "0 18px 30px", textAlign: "center" }}>
        <div style={{ fontSize: 11, color: T.sub, opacity: 0.7 }}>
          {BRAND.name} · {t("Customer Portal")} — {BRAND.supportEmail}
        </div>
      </footer>
    </div>
  );
}
