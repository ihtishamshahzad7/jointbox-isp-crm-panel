"use client";

/**
 * Session detail drawer + real disconnect.
 *
 * Disconnect hits POST /network/disconnect/:username (real RADIUS CoA → MikroTik
 * API → verify). Every attempt the backend makes is shown in the trail; failures
 * surface the real reason instead of a generic error.
 */
import React, { useState } from "react";
import { useNasDetail } from "./context";
import { Session } from "./lib";
import { apiSend } from "./lib";
import { fmtBits, fmtBytes, fmtDuration, fmtDateTime, show } from "./lib";
import { Btn, DefList, Drawer, StatusChip } from "./ui";

export function SessionDrawer({ session, subscriberName, onClose }: {
  session: Session;
  subscriberName?: string | null;
  onClose: () => void;
}) {
  const { refreshSessions, bumpSessions, refreshEvents } = useNasDetail();
  const [phase, setPhase] = useState<"idle" | "working" | "done">("idle");
  const [outcome, setOutcome] = useState<{ ok: boolean; method?: string; verified?: string; trail: string[]; error?: string } | null>(null);

  const disconnect = async (all: boolean) => {
    if (phase === "working") return;
    setPhase("working");
    setOutcome(null);
    try {
      const r = await apiSend<any>(`/network/disconnect/${encodeURIComponent(session.username)}${all ? "/all" : ""}`, "POST");
      setOutcome({
        ok: true,
        method: r?.method,
        verified: r?.verified,
        trail: r?.attempts ?? [],
      });
      // Real state change — refresh sessions + events so tables update.
      await Promise.allSettled([refreshSessions(), refreshEvents()]);
      bumpSessions();
    } catch (e: any) {
      setOutcome({
        ok: false,
        error: e?.message ?? "Disconnect failed",
        trail: [],
      });
    } finally {
      setPhase("idle");
    }
  };

  const rows: Array<[string, React.ReactNode]> = [
    ["Username", <b key="u" className="nd-mono">{session.username}</b>],
    ["NAS IP", show(session.nasipaddress)],
    ["Framed IP", session.framedipaddress ? <code className="nd-mono">{session.framedipaddress}</code> : "—"],
    ["MAC / Caller ID", show(session.callingstationid)],
    ["Session ID", session.acctsessionid ? <code className="nd-mono" style={{ fontSize: 10 }}>{session.acctsessionid}</code> : "—"],
    ["Connected", fmtDateTime(session.acctstarttime)],
    ["Duration", fmtDuration(session.duration_seconds ?? 0)],
    ["Download", fmtBytes(session.download_bytes ?? 0)],
    ["Upload", fmtBytes(session.upload_bytes ?? 0)],
    ["Source", session.source === "router" ? "Router (/ppp/active)" : "RADIUS (radacct)"],
  ];

  return (
    <Drawer
      title={session.username}
      sub={subscriberName ? `Subscriber: ${subscriberName}` : "Session details"}
      onClose={onClose}
    >
      <DefList rows={rows} />

      <div className="nd-drawer-sec">Actions</div>
      <div className="nd-drawer-actions">
        <Btn variant="danger" onClick={() => disconnect(false)} disabled={phase === "working"}>
          {phase === "working" ? "Disconnecting…" : "Disconnect this session"}
        </Btn>
        <Btn variant="warn" onClick={() => disconnect(true)} disabled={phase === "working"}>
          Disconnect ALL sessions of {session.username}
        </Btn>
      </div>

      {phase === "working" && (
        <div className="nd-drawer-progress">
          <span className="nd-spinner-ring" /> Sending CoA → MikroTik → verifying… (stay on this page)
        </div>
      )}

      {outcome && (
        <div className={`nd-drawer-result ${outcome.ok ? "ok" : "bad"}`}>
          <div className="nd-drawer-result-h">
            {outcome.ok ? (
              <StatusChip level="ok" text="Disconnected" dotPulse={false} />
            ) : (
              <StatusChip level="bad" text="Disconnect failed" dotPulse={false} />
            )}
          </div>
          {outcome.ok && (
            <div className="nd-drawer-result-meta">
              Method: <b className="nd-mono">{outcome.method ?? "?"}</b> · Verify: {outcome.verified ?? "—"}
            </div>
          )}
          {outcome.error && <div className="nd-drawer-result-meta">{outcome.error}</div>}
          {outcome.trail.length > 0 && (
            <ol className="nd-drawer-trail">
              {outcome.trail.map((t, i) => <li key={i}>{t}</li>)}
            </ol>
          )}
        </div>
      )}
    </Drawer>
  );
}

export const SessionCss = `
.nd-drawer-sec{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 0 8px}
.nd-drawer-actions{display:flex;flex-direction:column;gap:7px}
.nd-drawer-progress{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--muted);margin-top:12px;padding:10px;border:1px dashed var(--border);border-radius:8px}
.nd-drawer-err{color:#D34053;font-size:12px;margin-top:10px}
.nd-drawer-result{margin-top:14px;border-radius:9px;padding:11px 13px;font-size:12px;line-height:1.65}
.nd-drawer-result.ok{background:rgba(33,150,83,.08);border:1px solid rgba(33,150,83,.35)}
.nd-drawer-result.bad{background:rgba(211,64,83,.08);border:1px solid rgba(211,64,83,.35)}
.nd-drawer-result-h{margin-bottom:6px}
.nd-drawer-result-meta{font-size:11.5px;color:var(--muted)}
.nd-drawer-trail{margin:10px 0 0 18px;padding:0;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;color:var(--muted);line-height:1.8}
.nd-drawer-trail li::marker{color:var(--accent)}
`;