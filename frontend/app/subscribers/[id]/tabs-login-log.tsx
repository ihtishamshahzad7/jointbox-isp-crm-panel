"use client";

/**
 * Login Log — FreeRADIUS radpostauth: every authentication attempt this username
 * made, with Accept/Reject verdicts and the NAS that saw it. Failures here are
 * how you catch cut-off subscribers (FUP block or wrong password) trying to dial.
 */
import React from "react";
import { useSubscriberDetail } from "./context";
import { Panel, StatusChip, EmptyState } from "./ui";
import { fmtDateTime } from "./lib";

export function LoginLogTab() {
  const { sub, authLogs } = useSubscriberDetail();

  if (!sub) return <EmptyState title="No subscriber" />;

  const accepts = authLogs.filter((a) => a.reply === "Access-Accept").length;
  const rejects = authLogs.length - accepts;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 7 }}>
        <div className="sd-mini-cell">
          <div className="m-label">Attempts (window)</div>
          <div className="m-value">{authLogs.length}</div>
        </div>
        <div className="sd-mini-cell">
          <div className="m-label">Accepted</div>
          <div className="m-value" style={{ color: "#219653" }}>{accepts}</div>
        </div>
        <div className="sd-mini-cell">
          <div className="m-label">Rejected</div>
          <div className="m-value" style={{ color: rejects > 0 ? "#D34053" : "var(--text)" }}>{rejects}</div>
        </div>
        <div className="sd-mini-cell">
          <div className="m-label">Reject reason</div>
          <div className="m-value" style={{ fontSize: 11 }}>{rejects > 0 ? "see replies below" : "none"}</div>
        </div>
      </div>

      <Panel
        title="RADIUS auth log (radpostauth)"
        sub="Every dial-in attempt recorded by FreeRADIUS — Accept means the credentials were valid"
      >
        {authLogs.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            No authentication attempts recorded. If the subscriber reports connectivity issues,
            check the Connection tab — a working link never shows here until something dials.
          </div>
        ) : (
          <div className="sd-table-wrap" style={{ maxHeight: 480, overflowY: "auto" }}>
            <table className="sd-table">
              <thead>
                <tr>
                  <th>Result</th>
                  <th>Reply</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {authLogs.map((log, i) => {
                  const ok = log.reply === "Access-Accept";
                  return (
                    <tr key={i}>
                      <td>
                        <StatusChip level={ok ? "ok" : "bad"} text={ok ? "Accept" : "Reject"} dotPulse={false} />
                      </td>
                      <td style={{ fontFamily: "ui-monospace,monospace", fontSize: 11.5, color: ok ? "#219653" : "#D34053", wordBreak: "break-word" }}>
                        {log.reply || "—"}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(log.authdate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}