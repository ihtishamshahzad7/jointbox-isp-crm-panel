"use client";

import React from "react";
import API from "../components/api";
import { useLicence } from "../components/licence";

/**
 * ACTIVATING FROM THE BROWSER.
 *
 * Until now the only way to activate a server was to SSH in and run
 * `jointbox-activate`. The backend has had `POST /licence/activate` since the
 * enforcement work landed; nothing in the UI ever called it, so every install
 * still needed a terminal and someone who knew the command. That is the gap
 * this closes.
 *
 * ── THE TWO WAYS A LICENCE ARRIVES, AND WHY BOTH END UP HERE ─────────────
 *
 *  1. SOMEONE TYPES THE KEY (this form). The panel runs the agent's own
 *     `-activate` with the key, which contacts panel.jointbox.net, binds the
 *     licence to this machine's fingerprint and writes the signed entitlement
 *     to /etc/jointbox. The daemon is restarted so the new state is live
 *     immediately rather than at the next heartbeat.
 *
 *  2. WE CHANGE SOMETHING ON THE LICENCE SERVER — extend an expiry, move a
 *     customer to a bigger plan, lift a suspension. Nobody logs in here at
 *     all. The agent's heartbeat collects the new SIGNED entitlement on its
 *     own schedule and the panel picks it up.
 *
 * Both paths converge on the same artefact: an Ed25519-signed entitlement that
 * the panel verifies against the embedded public key. The panel does not
 * decide anything about plans or caps — it reads what the signature vouches
 * for. That is why a server-side change needs no client action, and why this
 * form cannot grant anything the licence server did not sign.
 *
 * "Sync now" exists because path 2 is correct but not instant. It forces the
 * read that would otherwise happen on the next poll, for the operator who has
 * just been told on the phone that their renewal has gone through.
 *
 * ── THE KEY IS A CREDENTIAL ──────────────────────────────────────────────
 * It is never logged here, never put in a query string, and the field is typed
 * so a password manager treats it as a secret. The backend masks it in the
 * audit row and in every error it returns.
 */

const KEY_RE = /^JBX-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/;

function token(): string {
  try {
    return localStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

/**
 * Format as the operator types: upper-case, strip anything that is not a key
 * character, and re-insert the dashes. Someone pasting from an invoice gets a
 * valid key whether the invoice used dashes, spaces or neither.
 */
function formatKey(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 23);
  if (s.startsWith("JBX")) {
    const rest = s.slice(3);
    const groups = rest.match(/.{1,5}/g) || [];
    return ["JBX", ...groups].join("-");
  }
  const groups = s.match(/.{1,5}/g) || [];
  return groups.join("-");
}

export default function ActivateLicence() {
  const { status, refresh } = useLicence();

  const [key, setKey] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [company, setCompany] = React.useState("");
  const [website, setWebsite] = React.useState("");
  const [contact, setContact] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");

  const [busy, setBusy] = React.useState<"" | "activate" | "sync">("");
  const [error, setError] = React.useState("");
  const [ok, setOk] = React.useState("");

  const valid = KEY_RE.test(key);
  const activated = !!status && status.state !== "UNLICENSED" && status.state !== "INVALID";

  async function activate(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy("activate");
    setError("");
    setOk("");
    try {
      const r = await fetch(`${API}/licence/activate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token()}`,
        },
        body: JSON.stringify({ key, company, website, contact, email, phone }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        // The agent's own message is the useful one ("already bound to another
        // machine", "unknown key"). The backend passes it through; so do we.
        throw new Error(body?.message || "Activation failed.");
      }
      setKey("");
      setOk(body?.message || "Licence activated.");
      await refresh(true);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy("");
    }
  }

  async function sync() {
    if (busy) return;
    setBusy("sync");
    setError("");
    setOk("");
    try {
      await refresh(true);
      setOk("Re-read the licence from this server's agent.");
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy("");
    }
  }

  return (
    <div style={CARD}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 15, fontWeight: 800, margin: 0 }}>
          {activated ? "Change or re-activate licence" : "Activate this server"}
        </h2>
        <button type="button" onClick={sync} disabled={!!busy} style={GHOST}>
          {busy === "sync" ? "Syncing…" : "Sync from licence server"}
        </button>
      </div>

      <p style={HINT}>
        {activated
          ? "This server already holds a licence. Entering a new key re-binds it — use this after an upgrade, a renewal issued against a new key, or a server migration."
          : "Enter the key from your invoice. The server contacts panel.jointbox.net, binds the licence to this machine and starts enforcing your plan straight away."}
      </p>

      <form onSubmit={activate}>
        <label style={LABEL} htmlFor="jbx-key">Licence key</label>
        <input
          id="jbx-key"
          value={key}
          onChange={(e) => setKey(formatKey(e.target.value))}
          placeholder="JBX-XXXXX-XXXXX-XXXXX-XXXXX"
          autoComplete="off"
          spellCheck={false}
          style={{
            ...INPUT,
            fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
            letterSpacing: ".06em",
            borderColor: key && !valid ? "rgba(211,64,83,.55)" : "var(--border,#E2E8F0)",
          }}
        />
        {key && !valid && (
          <div style={{ ...HINT, color: "#b02a37", marginTop: 4 }}>
            A key is JBX followed by four groups of five characters.
          </div>
        )}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{ ...GHOST, marginTop: 10, marginLeft: 0 }}
        >
          {open ? "Hide" : "Add"} company details (optional)
        </button>

        {open && (
          <div style={GRID}>
            <Field label="Company" value={company} onChange={setCompany} />
            <Field label="Website" value={website} onChange={setWebsite} />
            <Field label="Contact name" value={contact} onChange={setContact} />
            <Field label="Email" value={email} onChange={setEmail} type="email" />
            <Field label="Phone" value={phone} onChange={setPhone} />
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          <button type="submit" disabled={!valid || !!busy} style={{ ...PRIMARY, opacity: !valid || busy ? 0.55 : 1 }}>
            {busy === "activate" ? "Activating…" : "Activate"}
          </button>
          <span style={{ ...HINT, margin: 0 }}>
            Takes a few seconds — the server has to reach the licence server.
          </span>
        </div>
      </form>

      {error && <Note tone="bad">{error}</Note>}
      {ok && <Note tone="ok">{ok}</Note>}

      <details style={{ marginTop: 14 }}>
        <summary style={{ fontSize: 12, fontWeight: 700, cursor: "pointer", color: "var(--muted)" }}>
          Activate from the command line instead
        </summary>
        <pre style={PRE}>sudo jointbox-activate JBX-XXXXX-XXXXX-XXXXX-XXXXX</pre>
        <div style={HINT}>
          Identical effect — this form runs exactly that. Use it if the panel
          itself will not load.
        </div>
      </details>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label style={LABEL}>{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} style={INPUT} maxLength={120} />
    </div>
  );
}

function Note({ tone, children }: { tone: "ok" | "bad"; children: React.ReactNode }) {
  const c =
    tone === "ok"
      ? { fg: "#166534", bg: "rgba(33,150,83,.10)", br: "rgba(33,150,83,.35)" }
      : { fg: "#b02a37", bg: "rgba(211,64,83,.09)", br: "rgba(211,64,83,.38)" };
  return (
    <div
      role="status"
      style={{
        marginTop: 12,
        border: `1px solid ${c.br}`,
        background: c.bg,
        color: c.fg,
        borderRadius: 9,
        padding: "9px 12px",
        fontSize: 12.5,
        lineHeight: 1.6,
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

const CARD: React.CSSProperties = {
  border: "1px solid var(--border,#E2E8F0)",
  background: "var(--surface,#fff)",
  borderRadius: 12,
  padding: "14px 16px",
  marginTop: 14,
};

const HINT: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--muted)",
  margin: "6px 0 12px",
};

const LABEL: React.CSSProperties = {
  display: "block",
  fontSize: 9.5,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: ".06em",
  color: "var(--muted)",
  marginBottom: 4,
};

const INPUT: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  border: "1px solid var(--border,#E2E8F0)",
  background: "var(--bg,#fff)",
  color: "var(--text)",
  borderRadius: 8,
  padding: "9px 11px",
  fontSize: 13,
};

const GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
  gap: 10,
  marginTop: 10,
};

const PRIMARY: React.CSSProperties = {
  border: "1px solid transparent",
  background: "linear-gradient(135deg,#6C3CE1,#E9408B)",
  color: "#fff",
  borderRadius: 9,
  padding: "9px 20px",
  fontSize: 13,
  fontWeight: 800,
  cursor: "pointer",
};

const GHOST: React.CSSProperties = {
  marginLeft: "auto",
  border: "1px solid var(--border,#E2E8F0)",
  background: "var(--surface,#fff)",
  color: "var(--text)",
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 11.5,
  fontWeight: 700,
  cursor: "pointer",
};

const PRE: React.CSSProperties = {
  margin: "8px 0 0",
  padding: "9px 11px",
  borderRadius: 8,
  background: "var(--bg,#0f172a0d)",
  border: "1px solid var(--border,#E2E8F0)",
  fontSize: 11.5,
  overflowX: "auto",
  whiteSpace: "pre",
};
