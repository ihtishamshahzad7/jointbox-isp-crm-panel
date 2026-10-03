"use client";

import React from "react";
import { useRouter } from "next/navigation";
import API from "../components/api";
import { isPlatformSession, PLATFORM_HOME } from "../components/platform";

/**
 * CHANGE PASSWORD — and the forced first-login version of it.
 *
 * A new server's owner account is created from the password in install.sh,
 * which means it is known to anyone who has read install.sh. Until it is
 * changed the API answers every route except this one with 403, so this page
 * is the only thing such an account can do — and it must work standalone,
 * outside the app shell, because the shell itself loads a dozen endpoints that
 * would all refuse.
 *
 * On success the server issues a fresh token and revokes the old one: a
 * password change is exactly when an existing session should stop, because the
 * reason for the change may be that someone else has the password.
 */
export default function ChangePassword() {
  const router = useRouter();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [forced, setForced] = React.useState(false);

  React.useEffect(() => {
    let token = "";
    try { token = localStorage.getItem("token") || ""; } catch { /* private mode */ }
    if (!token) { router.replace("/login"); return; }
    fetch(`${API}/auth/profile`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setForced(!!d?.user?.mustChangePassword))
      .catch(() => router.replace("/login"));
  }, [router]);

  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length >= 8 && next === confirm && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const token = localStorage.getItem("token") || "";
      const r = await fetch(`${API}/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.message || "The password could not be changed.");
      if (body?.token) localStorage.setItem("token", body.token);
      router.replace(isPlatformSession() ? PLATFORM_HOME : "/dashboard");
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    try { localStorage.removeItem("token"); localStorage.removeItem("user"); } catch { /* ignore */ }
    router.replace("/login");
  }

  return (
    <div style={WRAP}>
      <form onSubmit={submit} style={CARD}>
        <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>
          {forced ? "Choose your own password" : "Change password"}
        </div>
        <p style={HINT}>
          {forced
            ? "This account is still using the default password from the installer. Anyone who has seen the install script knows it, so the panel stays locked until you choose your own."
            : "Your current sessions on other devices will need to sign in again."}
        </p>

        <Field id="cp-current" label={forced ? "Default password" : "Current password"} value={current} onChange={setCurrent} autoComplete="current-password" />
        <Field id="cp-new" label="New password" value={next} onChange={setNext} autoComplete="new-password" />
        {tooShort && <div style={WARN}>Use at least 8 characters.</div>}
        <Field id="cp-confirm" label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        {mismatch && <div style={WARN}>The two passwords do not match.</div>}

        {error && <div style={ERR} role="alert">{error}</div>}

        <button type="submit" disabled={!ready} style={{ ...PRIMARY, opacity: ready ? 1 : 0.55 }}>
          {busy ? "Saving…" : "Save and continue"}
        </button>
        <button type="button" onClick={signOut} style={LINK}>Sign out instead</button>
      </form>
    </div>
  );
}

function Field({ id, label, value, onChange, autoComplete }: {
  id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label htmlFor={id} style={LBL}>{label}</label>
      <input id={id} type="password" value={value} autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)} style={INPUT} />
    </div>
  );
}

const WRAP: React.CSSProperties = {
  minHeight: "100vh", display: "grid", placeItems: "center", padding: "24px 16px",
  background: "var(--bg,#0a0e14)", color: "var(--text,#e6e9ef)",
  fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif",
};
const CARD: React.CSSProperties = {
  width: "100%", maxWidth: 420, border: "1px solid var(--border,rgba(255,255,255,.12))",
  background: "var(--surface,rgba(255,255,255,.04))", borderRadius: 14, padding: "22px 22px 18px",
};
const HINT: React.CSSProperties = { fontSize: 12.5, lineHeight: 1.6, color: "var(--muted,#94a3b8)", margin: "0 0 16px" };
const LBL: React.CSSProperties = {
  display: "block", fontSize: 10, fontWeight: 800, textTransform: "uppercase",
  letterSpacing: ".06em", color: "var(--muted,#94a3b8)", marginBottom: 5,
};
const INPUT: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1px solid var(--border,rgba(255,255,255,.14))",
  background: "var(--bg,#0a0e14)", color: "var(--text,#e6e9ef)", borderRadius: 9, padding: "10px 12px", fontSize: 14,
};
const PRIMARY: React.CSSProperties = {
  width: "100%", marginTop: 6, border: "1px solid transparent", background: "linear-gradient(135deg,#6C3CE1,#E9408B)",
  color: "#fff", borderRadius: 10, padding: "11px", fontSize: 14, fontWeight: 800, cursor: "pointer",
};
const LINK: React.CSSProperties = {
  width: "100%", marginTop: 10, border: "none", background: "transparent",
  color: "var(--muted,#94a3b8)", fontSize: 12, cursor: "pointer", textDecoration: "underline",
};
const WARN: React.CSSProperties = { fontSize: 11.5, color: "#f59e0b", margin: "-6px 0 10px" };
const ERR: React.CSSProperties = {
  border: "1px solid rgba(211,64,83,.38)", background: "rgba(211,64,83,.09)", color: "#f87171",
  borderRadius: 9, padding: "9px 12px", fontSize: 12.5, fontWeight: 600, margin: "4px 0 12px",
};
