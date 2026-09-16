"use client";

import React from "react";
import { useLicence, type LicenceState } from "../components/licence";

/**
 * The screen the banner and the 402 dialog both link to.
 *
 * Its job is to answer three questions an operator actually has, in this
 * order: am I licensed, what stops working if I am not, and what do I do about
 * it. Everything else — plan name, feature list, expiry — is detail underneath.
 *
 * It is on the guard's exempt list server-side, so it keeps working in exactly
 * the state where it is needed most.
 */

const LABEL: Record<LicenceState, { text: string; tone: "ok" | "warn" | "bad" }> = {
  ACTIVE: { text: "Active", tone: "ok" },
  GRACE: { text: "Renewing", tone: "warn" },
  EXPIRED: { text: "Expired", tone: "bad" },
  HARDWARE_MISMATCH: { text: "Hardware changed", tone: "bad" },
  INVALID: { text: "Invalid", tone: "bad" },
  UNLICENSED: { text: "Not activated", tone: "bad" },
  TAMPERED: { text: "Verification failed", tone: "bad" },
  UNAVAILABLE: { text: "Agent not running", tone: "warn" },
};

const TONE = {
  ok: { fg: "#166534", bg: "rgba(33,150,83,.10)", br: "rgba(33,150,83,.35)" },
  warn: { fg: "#b45309", bg: "rgba(245,158,11,.10)", br: "rgba(245,158,11,.38)" },
  bad: { fg: "#b02a37", bg: "rgba(211,64,83,.09)", br: "rgba(211,64,83,.38)" },
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function LicencePage() {
  const { status, reachable, refresh } = useLicence();
  const [busy, setBusy] = React.useState(false);

  if (reachable === false) {
    return (
      <div style={{ maxWidth: 720 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 8px" }}>Licence</h1>
        <p style={{ fontSize: 13, lineHeight: 1.65, color: "var(--muted)" }}>
          This server did not answer a licence status request. That usually means
          it is running a build from before licensing was added — update the
          panel and this page will fill in.
        </p>
      </div>
    );
  }

  if (!status) {
    return (
      <div style={{ maxWidth: 720 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 8px" }}>Licence</h1>
        <p style={{ fontSize: 13, color: "var(--muted)" }}>Loading…</p>
      </div>
    );
  }

  const label = LABEL[status.state] ?? { text: status.state, tone: "warn" as const };
  const tone = TONE[label.tone];
  const notActivated = status.state === "UNLICENSED" || status.state === "INVALID";
  const agentDown = status.state === "UNAVAILABLE";

  return (
    <div style={{ maxWidth: 820 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 6,
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Licence</h1>
        <span
          style={{
            border: `1px solid ${tone.br}`,
            background: tone.bg,
            color: tone.fg,
            borderRadius: 999,
            padding: "3px 11px",
            fontSize: 11,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: ".05em",
          }}
        >
          {label.text}
        </span>
        <button
          onClick={async () => {
            setBusy(true);
            await refresh(true);
            setBusy(false);
          }}
          disabled={busy}
          style={{
            marginLeft: "auto",
            border: "1px solid var(--border,#E2E8F0)",
            background: "var(--surface,#fff)",
            borderRadius: 8,
            padding: "7px 13px",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            color: "var(--text)",
          }}
        >
          {busy ? "Checking…" : "Re-check now"}
        </button>
      </div>

      {status.message && (
        <p style={{ fontSize: 13, lineHeight: 1.65, color: "var(--muted)", margin: "0 0 16px" }}>
          {status.message}
        </p>
      )}

      {!status.enforced && (
        <Card tone="warn" title="Enforcement is switched off on this server">
          <code>JBX_LICENCE_ENFORCE=false</code> is set in the backend
          environment, so nothing is checked and nothing is blocked. Remove it to
          turn licensing back on.
        </Card>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
          gap: 10,
          margin: "14px 0",
        }}
      >
        <Stat label="Plan" value={status.plan || "—"} sub={status.trial ? "trial" : ""} />
        <Stat label="Licensed to" value={status.company || "—"} />
        <Stat
          label="Subscriber cap"
          value={status.maxSubscribers ? String(status.maxSubscribers) : "unlimited"}
        />
        <Stat label="Expires" value={fmt(status.expiresAt)} />
        {status.graceEndsAt && <Stat label="Grace ends" value={fmt(status.graceEndsAt)} />}
        <Stat label="Writes" value={status.writable ? "allowed" : "blocked"} />
      </div>

      <Card tone="ok" title="Your subscribers are not affected by any of this">
        FreeRADIUS reads the database directly and never asks the panel for
        permission, so authentication, accounting and bandwidth control keep
        running in every licence state — including expired. Reading the panel,
        reports and payment collection also stay open. What a lapsed licence
        blocks is creating and changing records.
      </Card>

      {notActivated && (
        <Card tone="bad" title="This server has not been activated">
          Run the activation command on the server with the key from your
          invoice, then press Re-check:
          <pre style={PRE}>sudo jointbox-activate JBX-XXXX-XXXX-XXXX-XXXX</pre>
          Each server needs its own activation. If you moved to a new machine or
          are running a second VM, release the old activation in the licence
          admin first — a key is tied to the hardware it was activated on.
        </Card>
      )}

      {agentDown && (
        <Card tone="warn" title="The licence agent is not running">
          Nothing is blocked — the panel treats an unreachable agent as licensed
          on purpose. But your licence cannot renew itself while the agent is
          down, so it will lapse on its own in a couple of weeks. On the server:
          <pre style={PRE}>
{`sudo systemctl status jointbox-licensed
sudo systemctl restart jointbox-licensed
jointbox-licensed -status`}
          </pre>
          If the service does not exist at all, the agent was never installed —
          run <code>scripts/install-licence-agent.sh</code> from the panel
          directory.
        </Card>
      )}

      {status.state === "HARDWARE_MISMATCH" && (
        <Card tone="bad" title="The hardware fingerprint changed">
          This licence was activated against a different machine. That is normal
          after a server migration, a motherboard change, or cloning a VM.
          Release the old activation in the licence admin and re-run{" "}
          <code>jointbox-activate</code> here.
        </Card>
      )}

      {status.features.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--muted)", marginBottom: 7 }}>
            Included features
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {status.features.map((f) => (
              <span
                key={f}
                style={{
                  border: "1px solid var(--border,#E2E8F0)",
                  borderRadius: 999,
                  padding: "3px 11px",
                  fontSize: 11.5,
                  fontWeight: 600,
                }}
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const PRE: React.CSSProperties = {
  margin: "9px 0 0",
  padding: "9px 11px",
  borderRadius: 8,
  background: "var(--bg,#0f172a0d)",
  border: "1px solid var(--border,#E2E8F0)",
  fontSize: 11.5,
  lineHeight: 1.6,
  overflowX: "auto",
  whiteSpace: "pre",
};

function Card({
  tone,
  title,
  children,
}: {
  tone: "ok" | "warn" | "bad";
  title: string;
  children: React.ReactNode;
}) {
  const c = TONE[tone];
  return (
    <div
      style={{
        border: `1px solid ${c.br}`,
        background: c.bg,
        borderRadius: 11,
        padding: "12px 14px",
        marginTop: 12,
        fontSize: 12.5,
        lineHeight: 1.65,
      }}
    >
      <div style={{ fontWeight: 800, color: c.fg, marginBottom: 5 }}>{title}</div>
      <div style={{ color: "var(--text)" }}>{children}</div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--border,#E2E8F0)",
        background: "var(--surface,#fff)",
        borderRadius: 10,
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 800,
          textTransform: "uppercase",
          letterSpacing: ".06em",
          color: "var(--muted)",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4, wordBreak: "break-word" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
