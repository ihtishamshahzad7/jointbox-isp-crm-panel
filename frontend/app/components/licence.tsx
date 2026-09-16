"use client";

import React from "react";
import API from "./api";

/**
 * THE PANEL'S HALF OF LICENSING.
 *
 * The backend has had `GET /licence/status` and a guard that answers 402 since
 * the enforcement work landed; nothing in the UI ever read either. So a server
 * whose licence had lapsed, or which had never been activated at all, looked
 * completely normal until a save failed with a generic "request failed" toast.
 * That is the bug — not the agent, not the licence server.
 *
 * Three pieces, and they are deliberately separate:
 *
 *  1. `LicenceProvider` polls the status endpoint and holds the answer.
 *  2. A `window.fetch` wrapper notices ANY 402 from the API and opens the
 *     dialog. Every screen writes through its own `fetch` call — there are
 *     around sixty of them — so wrapping fetch once is the only way to catch
 *     them all without touching sixty files.
 *  3. `LicenceBanner` and `LicenceDialog` render it.
 *
 * ── WHAT THIS MUST NEVER DO ──────────────────────────────────────────────
 * Block the UI on its own initiative. The dialog appears when the SERVER says
 * 402, or when the server reports a blocking state. If the status endpoint is
 * unreachable, or the agent is not installed, this renders nothing and gets
 * out of the way — same fail-open posture the backend takes, for the same
 * reason: our licensing must not be the thing that stops an ISP working.
 */

export type LicenceState =
  | "ACTIVE"
  | "GRACE"
  | "EXPIRED"
  | "HARDWARE_MISMATCH"
  | "INVALID"
  | "UNLICENSED"
  | "TAMPERED"
  | "UNAVAILABLE";

export interface LicenceStatus {
  state: LicenceState;
  licensed: boolean;
  writable: boolean;
  enforced: boolean;
  plan: string | null;
  company: string | null;
  trial: boolean;
  maxSubscribers: number;
  features: string[];
  expiresAt: string | null;
  graceEndsAt: string | null;
  message: string;
  banner: { level: "none" | "info" | "warn" | "error"; message: string };
}

interface Ctx {
  status: LicenceStatus | null;
  /** Null while loading, false once a request has failed — never blocks. */
  reachable: boolean | null;
  refresh: (force?: boolean) => Promise<void>;
  blocked: { message: string; detail: string; state: string } | null;
  dismissBlocked: () => void;
}

const LicenceCtx = React.createContext<Ctx>({
  status: null,
  reachable: null,
  refresh: async () => {},
  blocked: null,
  dismissBlocked: () => {},
});

export function useLicence() {
  return React.useContext(LicenceCtx);
}

/** Fired by the fetch wrapper when the backend answers 402. */
const BLOCKED_EVENT = "jbx:licence-blocked";

const POLL_MS = 5 * 60 * 1000;

function token(): string {
  try {
    return localStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

export function LicenceProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<LicenceStatus | null>(null);
  const [reachable, setReachable] = React.useState<boolean | null>(null);
  const [blocked, setBlocked] = React.useState<Ctx["blocked"]>(null);

  const refresh = React.useCallback(async (force = false) => {
    const t = token();
    if (!t) return;
    try {
      const r = await fetch(`${API}/licence/${force ? "refresh" : "status"}`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!r.ok) {
        // A 404 means this server predates the licence module. Not an error
        // worth showing anyone — it just means there is nothing to show.
        setReachable(false);
        return;
      }
      setStatus((await r.json()) as LicenceStatus);
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  /**
   * THE 402 INTERCEPTOR.
   *
   * Wrapping the global fetch is a big hammer, so it is kept as small as it
   * can be: it never changes a response, never retries, never swallows an
   * error. It looks at the status code of responses from our own API and, on
   * 402, reads a CLONE of the body so the calling screen still gets an intact
   * response to handle however it already does.
   */
  React.useEffect(() => {
    const original = window.fetch;
    if ((original as any).__jbxLicenceWrapped) return;

    const wrapped: typeof window.fetch = async (input, init) => {
      const res = await original(input, init);
      if (res.status === 402) {
        const url =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
        if (url.includes(API) || url.startsWith("/api")) {
          res
            .clone()
            .json()
            .then((b: any) => {
              if (b?.error === "LICENCE_REQUIRED" || b?.statusCode === 402) {
                window.dispatchEvent(
                  new CustomEvent(BLOCKED_EVENT, {
                    detail: {
                      message: b.message || "This panel is not licensed.",
                      detail: b.detail || "",
                      state: b.state || "UNLICENSED",
                    },
                  }),
                );
              }
            })
            .catch(() => {
              /* not our 402, or not JSON — leave it alone */
            });
        }
      }
      return res;
    };
    (wrapped as any).__jbxLicenceWrapped = true;
    window.fetch = wrapped;

    const onBlocked = (e: Event) => {
      setBlocked((e as CustomEvent).detail);
      void refresh();
    };
    window.addEventListener(BLOCKED_EVENT, onBlocked);

    return () => {
      window.fetch = original;
      window.removeEventListener(BLOCKED_EVENT, onBlocked);
    };
  }, [refresh]);

  const value = React.useMemo<Ctx>(
    () => ({ status, reachable, refresh, blocked, dismissBlocked: () => setBlocked(null) }),
    [status, reachable, refresh, blocked],
  );

  return (
    <LicenceCtx.Provider value={value}>
      {children}
      <LicenceDialog />
    </LicenceCtx.Provider>
  );
}

/**
 * The strip above the page content. Renders nothing in the normal case, which
 * is the overwhelmingly common case — an ACTIVE licence has `level: "none"`.
 */
export function LicenceBanner() {
  const { status, refresh } = useLicence();
  const [busy, setBusy] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);

  const level = status?.banner?.level ?? "none";
  if (!status || level === "none" || hidden) return null;

  const colour =
    level === "error"
      ? { fg: "#b02a37", bg: "rgba(211,64,83,.09)", br: "rgba(211,64,83,.38)" }
      : level === "warn"
        ? { fg: "#b45309", bg: "rgba(245,158,11,.10)", br: "rgba(245,158,11,.38)" }
        : { fg: "#1d4ed8", bg: "rgba(60,80,224,.08)", br: "rgba(60,80,224,.32)" };

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: "10px 14px",
        marginBottom: 14,
        borderRadius: 10,
        border: `1px solid ${colour.br}`,
        background: colour.bg,
        color: colour.fg,
        fontSize: 12.5,
        lineHeight: 1.55,
      }}
    >
      <span style={{ fontWeight: 700 }}>
        {level === "error" ? "Licence" : level === "warn" ? "Licence agent" : "Licence"}
      </span>
      <span style={{ flex: 1, minWidth: 220, color: "var(--text)" }}>
        {status.banner.message}
      </span>
      <a
        href="/licence"
        style={{ fontWeight: 700, color: colour.fg, textDecoration: "none" }}
      >
        Details
      </a>
      <button
        onClick={async () => {
          setBusy(true);
          await refresh(true);
          setBusy(false);
        }}
        disabled={busy}
        style={{
          border: `1px solid ${colour.br}`,
          background: "transparent",
          color: colour.fg,
          borderRadius: 7,
          padding: "4px 10px",
          fontSize: 11.5,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {busy ? "Checking…" : "Re-check"}
      </button>
      {level !== "error" && (
        <button
          onClick={() => setHidden(true)}
          aria-label="Dismiss"
          style={{
            border: "none",
            background: "transparent",
            color: colour.fg,
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/**
 * Shown only when the SERVER refused a write with 402. It explains what is
 * blocked and — the part that matters most to an ISP at 2am — what is not.
 */
export function LicenceDialog() {
  const { blocked, dismissBlocked, refresh } = useLicence();
  const [busy, setBusy] = React.useState(false);
  if (!blocked) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="jbx-licence-title"
      onClick={dismissBlocked}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        background: "rgba(15,23,42,.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px,100%)",
          background: "var(--surface,#fff)",
          border: "1px solid var(--border,#E2E8F0)",
          borderRadius: 14,
          padding: "20px 22px",
          boxShadow: "0 24px 60px rgba(15,23,42,.28)",
        }}
      >
        <h2
          id="jbx-licence-title"
          style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 800 }}
        >
          This change was not saved
        </h2>
        <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.6 }}>
          {blocked.message}
        </p>

        <div
          style={{
            border: "1px solid rgba(33,150,83,.35)",
            background: "rgba(33,150,83,.08)",
            borderRadius: 9,
            padding: "10px 12px",
            fontSize: 12,
            lineHeight: 1.6,
            marginBottom: 14,
          }}
        >
          <b>Your subscribers are online and unaffected.</b> Authentication,
          accounting and bandwidth control run straight from the database and do
          not depend on the licence. Reading, reports and payment collection all
          still work — only new records are held back.
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <a
            href="/licence"
            style={{
              border: "1px solid var(--border,#E2E8F0)",
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 12.5,
              fontWeight: 700,
              textDecoration: "none",
              color: "var(--text)",
            }}
          >
            Licence details
          </a>
          <button
            onClick={async () => {
              setBusy(true);
              await refresh(true);
              setBusy(false);
              dismissBlocked();
            }}
            disabled={busy}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 12.5,
              fontWeight: 700,
              background: "#3C50E0",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            {busy ? "Checking…" : "I've just paid — re-check"}
          </button>
          <button
            onClick={dismissBlocked}
            style={{
              border: "1px solid var(--border,#E2E8F0)",
              background: "transparent",
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: "pointer",
              color: "var(--text)",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
