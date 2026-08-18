"use client";

/**
 * Sessions — history from radacct (completed sessions, newest first), with the
 * plain-language termination cause the backend attaches to every row. The
 * active session is pinned on top. Uses what the context already loaded (last
 * 50) — no unbounded full-table pulls on the client.
 */
import React, { useMemo, useState } from "react";
import { useSubscriberDetail } from "./context";
import { Panel, Btn, StatusChip, EmptyState } from "./ui";
import { fmtBytes, fmtDuration, fmtDateTime, num, show } from "./lib";

const PAGE = 20;

export function SessionsTab() {
  const { sub, liveSession, sessionLogs, refreshLive, loading } = useSubscriberDetail();
  const [page, setPage] = useState(0);

  // Active session first, then completed sessions (backend order preserved).
  const all = useMemo(() => [...(liveSession ? [liveSession] : []), ...sessionLogs], [liveSession, sessionLogs]);
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = all.slice(safePage * PAGE, safePage * PAGE + PAGE);

  if (!sub) return <EmptyState title="No subscriber" />;

  return (
    <Panel
      title="Session history"
      sub={`${all.length} sessions in the loaded window (active session on top)`}
      actions={<Btn size="xs" variant="default" onClick={() => { void refreshLive(); }}>⟳ Refresh</Btn>}
    >
      {loading.live && all.length === 0 ? (
        <div className="sd-spinner"><span className="sd-spinner-ring" /><span>Loading sessions…</span></div>
      ) : all.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--muted)", padding: "14px 0" }}>
          No session history found — this subscriber has never had a RADIUS session recorded, or the radius DB is not reachable.
        </div>
      ) : (
        <>
          <div className="sd-table-wrap">
            <table className="sd-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Leased IP</th>
                  <th>MAC</th>
                  <th>NAS</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th className="r">Up</th>
                  <th className="r">Down</th>
                  <th>Ended (cause)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => {
                  const active = !s.acctstoptime && i === 0 && !!liveSession;
                  return (
                    <tr key={`${s.acctstarttime}-${i}`}>
                      <td>
                        {active
                          ? <StatusChip level="ok" text="Online" dotPulse />
                          : <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700 }}>Ended</span>}
                      </td>
                      <td><code style={{ fontSize: 10.5, color: "#2563EB" }}>{s.framedipaddress || "—"}</code></td>
                      <td><code style={{ fontSize: 10, color: "var(--muted)" }}>{s.callingstationid || "—"}</code></td>
                      <td><code style={{ fontSize: 10, color: "var(--muted)" }}>{s.nasipaddress || "—"}</code></td>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(s.acctstarttime)}</td>
                      <td style={{ fontWeight: 700 }}>{fmtDuration(s.duration_seconds)}</td>
                      <td className="r" style={{ color: "#219653", fontWeight: 600 }}>{fmtBytes(s.upload_bytes)}</td>
                      <td className="r" style={{ color: "#2563EB", fontWeight: 600 }}>{fmtBytes(s.download_bytes)}</td>
                      <td title={(s as any).terminateDescription || undefined} style={{ fontSize: 10.5 }}>
                        {(s as any).terminateLabel || s.acctterminatecause || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                {safePage * PAGE + 1}–{Math.min((safePage + 1) * PAGE, all.length)} of {all.length}
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn size="xs" variant="default" disabled={safePage === 0} onClick={() => setPage((p) => p - 1)}>← Prev</Btn>
                <Btn size="xs" variant="default" disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Next →</Btn>
              </div>
            </div>
          )}

          <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 10, lineHeight: 1.6 }}>
            Termination causes are the backend's plain-language reading of acctterminatecause — e.g. "Lost carrier" means the customer's cable/ONU dropped, not that the panel cut them.
          </div>
        </>
      )}
    </Panel>
  );
}