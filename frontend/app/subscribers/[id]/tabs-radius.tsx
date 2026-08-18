"use client";

/**
 * RADIUS — what FreeRADIUS actually holds for this username.
 *  • radcheck entries (credentials/attributes), password always masked.
 *  • Sync / Fix-password actions against the real RADIUS DB.
 *  • Auth log from radpostauth (Access-Accept/Reject) with accept/reject counts.
 * The reply attributes (radreply) are visible through the static-IP health
 * checker in the Service tab — no secrets printed here.
 */
import React from "react";
import { useSubscriberDetail } from "./context";
import { Panel, Btn, StatusChip, EmptyState } from "./ui";
import { apiSend, fmtDateTime, show } from "./lib";

export function RadiusTab() {
  const {
    sub, radiusChecks, authLogs, refreshLive, showToast, setBusy, busies, loading,
  } = useSubscriberDetail();

  if (!sub) return <EmptyState title="No subscriber" />;

  const accepts = authLogs.filter((a) => a.reply === "Access-Accept").length;
  const rejects = authLogs.length - accepts;

  const syncNow = async () => {
    if (!sub?.id) return;
    setBusy("sync", true);
    try {
      const r = await apiSend<any>(`/subscribers/${sub.id}/sync-to-radius`, "POST");
      showToast(r?.message || (r?.addressing ? `RADIUS synchronized — ${r.addressing}` : "Synced to RADIUS"), "ok");
      await refreshLive();
    } catch (e: any) {
      showToast(e?.message || "Sync failed", "err");
    } finally {
      setBusy("sync", false);
    }
  };

  const fixPassword = async () => {
    if (!sub?.id) return;
    setBusy("fixpwd", true);
    try {
      const r = await apiSend<any>(`/subscribers/${sub.id}/fix-radius-password`, "POST");
      showToast(r?.message || "Password fixed in RADIUS", "ok");
      await refreshLive();
    } catch (e: any) {
      showToast(e?.message || "Failed", "err");
    } finally {
      setBusy("fixpwd", false);
    }
  };

  return (
    <div className="sd-two-col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      {/* radcheck */}
      <Panel title="RADIUS profile (radcheck)" sub="What FreeRADIUS will enforce on the next dial-in"
        actions={
          radiusChecks.length > 0
            ? <StatusChip level="ok" text="IN RADIUS" dotPulse={false} />
            : <StatusChip level="off" text="NOT SYNCED" dotPulse={false} />
        }>
        {radiusChecks.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)", padding: "10px 0" }}>
            No entries in radcheck — this user is not synced to RADIUS yet.
            Sync the full profile (speed, pool/static IP, MAC lock, session guard) now.
          </div>
        ) : (
          <div className="sd-table-wrap">
            <table className="sd-table">
              <thead>
                <tr><th>Attribute</th><th>Op</th><th>Value</th></tr>
              </thead>
              <tbody>
                {radiusChecks.map((rc) => (
                  <tr key={rc.id}>
                    <td style={{ fontWeight: 700, color: "#2563EB" }}>{rc.attribute}</td>
                    <td><code style={{ color: "#B45309" }}>{rc.op}</code></td>
                    <td>
                      <code style={{ color: rc.attribute.toLowerCase().includes("password") ? "var(--muted)" : "#219653" }}>
                        {rc.attribute.toLowerCase().includes("password") ? "••••••••" : show(rc.value)}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <Btn size="sm" variant="primary" onClick={syncNow} disabled={busies.sync}>
            {busies.sync ? "Syncing…" : "Sync profile to RADIUS"}
          </Btn>
          <Btn size="sm" variant="warn" onClick={fixPassword} disabled={busies.fixpwd} title="Re-push the current password so the DB and RADIUS agree again">
            {busies.fixpwd ? "Fixing…" : "Fix password"}
          </Btn>
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10, lineHeight: 1.6 }}>
          Sync writes the complete current profile atomically — speed, pool or static IP, MAC lock and Simultaneous-Use —
          so radcheck/radreply never drift apart. The static-IP health checker (Service tab) verifies the result against the live session.
        </div>
      </Panel>

      {/* Auth log */}
      <Panel title="Auth log (radpostauth)" sub={`${authLogs.length} attempts · ${accepts} accept / ${rejects} reject`}
        actions={<Btn size="xs" variant="default" onClick={() => { void refreshLive(); }}>⟳ Refresh</Btn>}>
        {loading.live && authLogs.length === 0 ? (
          <div className="sd-spinner"><span className="sd-spinner-ring" /><span>Loading…</span></div>
        ) : authLogs.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)", padding: "10px 0" }}>
            No auth attempts recorded for this username yet.
          </div>
        ) : (
          <div className="sd-table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
            <table className="sd-table">
              <thead>
                <tr><th>Result</th><th>When</th></tr>
              </thead>
              <tbody>
                {authLogs.map((log, i) => {
                  const ok = log.reply === "Access-Accept";
                  return (
                    <tr key={i}>
                      <td>
                        <StatusChip level={ok ? "ok" : "bad"} text={ok ? "Accept" : "Reject"} dotPulse={false} />
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(log.authdate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10, lineHeight: 1.6 }}>
          Repeated rejects right after a password change usually mean the NAS is still using the old value — "Fix password" re-pushes it.
        </div>
      </Panel>
    </div>
  );
}