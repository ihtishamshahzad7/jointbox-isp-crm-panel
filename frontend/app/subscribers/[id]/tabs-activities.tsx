"use client";

/**
 * Activities — computed summary of everything this subscriber has done in the
 * window: sessions, traffic, auth verdicts, RADIUS records. The numbers come
 * from the same live state the other tabs show, never from a fabricated table.
 */
import React, { useMemo } from "react";
import { useSubscriberDetail } from "./context";
import { Panel, StatusChip, EmptyState } from "./ui";
import { fmtBytes, fmtDuration } from "./lib";

export function ActivitiesTab() {
  const { sub, liveSession, sessionLogs, authLogs, radiusChecks, openSessions, duplicate } = useSubscriberDetail();

  const stats = useMemo(() => {
    const accepted = authLogs.filter((a) => a.reply === "Access-Accept").length;
    const rejected = authLogs.length - accepted;
    const totalDownload = sessionLogs.reduce((a, s) => a + Number(s.download_bytes ?? 0), 0) + Number(liveSession?.download_bytes ?? 0);
    const totalUpload = sessionLogs.reduce((a, s) => a + Number(s.upload_bytes ?? 0), 0) + Number(liveSession?.upload_bytes ?? 0);
    const totalSeconds = sessionLogs.reduce((a, s) => a + Number(s.duration_seconds ?? 0), 0) + Number(liveSession?.duration_seconds ?? 0);
    return { accepted, rejected, totalDownload, totalUpload, totalSeconds };
  }, [authLogs, sessionLogs, liveSession]);

  if (!sub) return <EmptyState title="No subscriber" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel title="Activity summary">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 7 }}>
          <div className="sd-mini-cell">
            <div className="m-label">Sessions (window)</div>
            <div className="m-value">{sessionLogs.length + (liveSession ? 1 : 0)}</div>
            <div className="m-sub">{liveSession ? "1 active now" : "none active"}</div>
          </div>
          <div className="sd-mini-cell">
            <div className="m-label">Total download</div>
            <div className="m-value">{fmtBytes(stats.totalDownload)}</div>
            <div className="m-sub">all sessions + live</div>
          </div>
          <div className="sd-mini-cell">
            <div className="m-label">Total upload</div>
            <div className="m-value">{fmtBytes(stats.totalUpload)}</div>
            <div className="m-sub">all sessions + live</div>
          </div>
          <div className="sd-mini-cell">
            <div className="m-label">Connected time</div>
            <div className="m-value">{fmtDuration(stats.totalSeconds)}</div>
            <div className="m-sub">sum of session times</div>
          </div>
          <div className="sd-mini-cell">
            <div className="m-label">Auth accepts</div>
            <div className="m-value" style={{ color: "#219653" }}>{stats.accepted}</div>
          </div>
          <div className="sd-mini-cell">
            <div className="m-label">Auth rejects</div>
            <div className="m-value" style={{ color: stats.rejected > 0 ? "#D34053" : "var(--text)" }}>{stats.rejected}</div>
          </div>
          <div className="sd-mini-cell">
            <div className="m-label">RADIUS records</div>
            <div className="m-value">{radiusChecks.length}</div>
            <div className="m-sub">radcheck entries</div>
          </div>
          <div className="sd-mini-cell">
            <div className="m-label">Open sessions</div>
            <div className="m-value" style={{ color: duplicate ? "#D34053" : "var(--text)" }}>{openSessions}</div>
            <div className="m-sub">{duplicate ? "duplicate login" : "normal"}</div>
          </div>
        </div>
      </Panel>

      <Panel title="State at a glance">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Connection</span>
            <StatusChip level={liveSession ? "ok" : "off"} text={liveSession ? "Online" : "Offline"} dotPulse={!!liveSession} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>IP address</span>
            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "ui-monospace,monospace" }}>{liveSession?.framedipaddress || "—"}</span>
          </div>
        </div>
      </Panel>

      <Panel title="Data sources">
        <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.9 }}>
          • <b>Sessions</b> — live from the <code style={{ color: "#38bdf8" }}>radacct</code> table (PostgreSQL radius DB)<br />
          • <b>Auth verdicts</b> — from <code style={{ color: "#38bdf8" }}>radpostauth</code> (FreeRADIUS reply log)<br />
          • <b>RADIUS records</b> — from <code style={{ color: "#38bdf8" }}>radcheck</code> (profile credentials)<br />
          • <b>Online status</b> — active session in radacct (<code>acctstoptime IS NULL</code>)
        </div>
      </Panel>
    </div>
  );
}