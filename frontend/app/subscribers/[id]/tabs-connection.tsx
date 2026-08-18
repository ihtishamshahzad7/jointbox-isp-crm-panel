"use client";

/**
 * Connection — the live PPPoE session from RADIUS radacct, with real controls:
 *  • Disconnect (single) and Cut-all (duplicate takedown) — both re-query the
 *    router/RADIUS afterwards and show what the backend VERIFIED, never a
 *    blanket "success".
 *  • MAC reset / MAC binding view.
 *  • Duplicate-login guard and session-flapping detection.
 *  • Live bandwidth chart + connection path (telemetry).
 */
import React, { useMemo, useState } from "react";
import { useSubscriberDetail } from "./context";
import { Panel, Btn, DefList, EmptyState, Spinner } from "./ui";
import { apiSend, fmtBytes, fmtDateTime, fmtDateTimeFull, fmtDuration, num, show, detectFlapping } from "./lib";
import { BandwidthHistoryChart } from "./charts";
import LinkPath from "./link-path";
import { useRouter } from "next/navigation";

export function ConnectionTab() {
  const {
    sub, liveSession, sessionChecked, sessionLogs, openSessions, duplicate,
    radiusChecks, serviceSettings, staticIp, refreshLive, showToast, setBusy, busies,
  } = useSubscriberDetail();
  const router = useRouter();

  const [disconnectMsg, setDisconnectMsg] = useState<string | null>(null);

  const username = sub?.username ?? "";
  const flap = useMemo(() => detectFlapping(sessionLogs), [sessionLogs]);

  const killSession = async () => {
    if (!username) return;
    if (!confirm(`Disconnect ${sub?.fullName}'s active session? This will force them offline.`)) return;
    setBusy("kill", true);
    setDisconnectMsg(null);
    try {
      // The backend does the full chain: CoA/disconnect to the NAS, then it
      // re-checks the active session and reports what actually happened.
      const r = await apiSend<any>(`/network/disconnect/${encodeURIComponent(username)}`, "POST");
      if (!r) { showToast("Disconnect failed — see the backend response", "err"); return; }
      if (r.sessionsKilled || r.ok) {
        showToast(r.message || "Session disconnected", "ok");
        setDisconnectMsg(r.verified === false
          ? "Backend reported a problem verifying the session is gone — re-check before trusting this."
          : "Disconnected and verified — no active session remains for this username.");
      } else {
        showToast(r.message || "Failed to disconnect", "err");
      }
      await refreshLive();
    } catch (e: any) {
      showToast(e?.message || "Network error disconnecting session", "err");
    } finally {
      setBusy("kill", false);
    }
  };

  const cutAll = async () => {
    if (!username) return;
    if (!confirm(`"${username}" is online ${openSessions}× right now (password sharing or a stuck session). Cut ALL sessions so the customer re-dials exactly once?`)) return;
    setBusy("cutall", true);
    try {
      const r = await apiSend<any>(`/network/disconnect/${encodeURIComponent(username)}/all`, "POST");
      showToast(r?.sessionsCut != null ? `All ${r.sessionsCut} duplicate session(s) cut — subscriber forced offline` : (r?.message || "Sessions cut"), "ok");
      await refreshLive();
    } catch (e: any) {
      showToast(e?.message || "Failed to cut sessions", "err");
    } finally {
      setBusy("cutall", false);
    }
  };

  const resetMac = async () => {
    if (!username) return;
    if (!confirm(`Reset MAC binding for ${sub?.fullName}? They'll be able to reconnect from a new device.`)) return;
    setBusy("mac", true);
    try {
      const r = await apiSend<any>(`/network/mac/${encodeURIComponent(username)}`, "DELETE");
      showToast(r?.message || "MAC binding reset", "ok");
      await refreshLive();
    } catch (e: any) {
      showToast(e?.message || "Reset MAC failed", "err");
    } finally {
      setBusy("mac", false);
    }
  };

  const viewMac = async () => {
    if (!username) return;
    setBusy("macview", true);
    try {
      const r = await apiSend<any>(`/network/mac/${encodeURIComponent(username)}`, "POST");
      if (r?.macAddress) showToast(`Bound MAC: ${r.macAddress}`, "ok");
      else showToast(r?.message || "No MAC binding found for this username", "warn");
    } catch (e: any) {
      showToast(e?.message || "Could not read MAC binding", "err");
    } finally {
      setBusy("macview", false);
    }
  };

  if (!sub) return <EmptyState title="No subscriber" />;

  const isOnline = sessionChecked && !!liveSession;
  const guardActive = radiusChecks.some((c) => c.attribute === "Simultaneous-Use");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Duplicate-login guard — the moment it matters */}
      {openSessions > 1 && (
        <div className="sd-alert">
          <span className="sd-alert-ic">⚠</span>
          <div>
            <b>Duplicate login — {openSessions} online sessions</b>
            <div style={{ color: "var(--muted)", marginTop: 2 }}>
              The same username is connected from more than one device at once — password sharing or a stuck session.
              {guardActive
                ? " RADIUS Simultaneous-Use := 1 is active, so new dial-ins are rejected."
                : " No Simultaneous-Use check in radcheck — \"allow multiple sessions\" is ON, so extra dial-ins are not being rejected."}
            </div>
            <div className="sd-alert-actions">
              <Btn variant="danger" size="sm" onClick={cutAll} disabled={busies.cutall}>
                {busies.cutall ? "Cutting…" : `Cut all ${openSessions} sessions`}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* Session flapping — repeated connect/disconnect */}
      {flap && !duplicate && (
        <div className="sd-alert warn">
          <span className="sd-alert-ic">↻</span>
          <div>
            <b>Session flapping — {flap.count} sessions in {flap.windowHrs}h</b>
            <div style={{ color: "var(--muted)", marginTop: 2 }}>
              {flap.reason} Check the physical link (cable / ONT / power) and the credentials before assuming a random drop.
            </div>
          </div>
        </div>
      )}

      {/* Verification message after a disconnect */}
      {disconnectMsg && (
        <div className="sd-alert ok">
          <span className="sd-alert-ic">✓</span>
          <div>{disconnectMsg}</div>
        </div>
      )}

      <div className="sd-two-col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {/* Live session card */}
        <Panel title="Live session" sub="From radacct — fresh within the last 15 minutes"
          actions={isOnline ? <Btn variant="danger" size="xs" onClick={killSession} disabled={busies.kill}>{busies.kill ? "Disconnecting…" : "Disconnect"}</Btn> : undefined}>
          {!sessionChecked ? (
            <Spinner label="Checking…" />
          ) : liveSession ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#219653", boxShadow: "0 0 8px #219653" }} />
                <b style={{ fontSize: 13, color: "#219653" }}>Online</b>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>up {fmtDuration(liveSession.duration_seconds)}</span>
              </div>
              <DefList rows={[
                ["Leased IP", <code key="lip">{liveSession.framedipaddress || "—"}</code>],
                ["Configured IP", staticIp ? <code key="cip">{staticIp.ipAddress}</code> : <span key="cip" style={{ color: "var(--muted)" }}>pool (dynamic)</span>],
                ["MAC", <code key="mac">{liveSession.callingstationid || "—"}</code>],
                ["NAS", <code key="nas">{liveSession.nasipaddress || "—"}</code>],
                ["NAS Port", show(liveSession.nasportid)],
                ["Port Type", show(liveSession.nasporttype)],
                ["Protocol", show(liveSession.framedprotocol)],
                ["Service", show(liveSession.servicetype)],
                ["Started", fmtDateTimeFull(liveSession.acctstarttime)],
                ["Updated", liveSession.acctupdatetime ? fmtDateTime(liveSession.acctupdatetime) : "—"],
              ]} />
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <div style={{ flex: 1, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", textAlign: "center" }}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>Download</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: "#2563EB" }}>{fmtBytes(liveSession.download_bytes)}</div>
                </div>
                <div style={{ flex: 1, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", textAlign: "center" }}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>Upload</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: "#219653" }}>{fmtBytes(liveSession.upload_bytes)}</div>
                </div>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                <b style={{ color: "var(--text)" }}>Offline</b> — no active session in radacct for this username.
              </div>
              <Btn size="xs" variant="default" onClick={() => { void refreshLive(); }}>Re-check</Btn>
            </div>
          )}
        </Panel>

        {/* Session statistics */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Panel title="Session statistics">
            <DefList rows={[
              ["Current uptime", liveSession ? fmtDuration(liveSession.duration_seconds) : "—"],
              ["Sessions (recent)", String(sessionLogs.length + (liveSession ? 1 : 0))],
              ["Open sessions", String(openSessions)],
              ["All-time download", fmtBytes(sessionLogs.reduce((a, s) => a + num(s.download_bytes), 0) + num(liveSession?.download_bytes))],
              ["All-time upload", fmtBytes(sessionLogs.reduce((a, s) => a + num(s.upload_bytes), 0) + num(liveSession?.upload_bytes))],
            ]} />
          </Panel>

          <Panel title="Device / MAC">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn size="xs" variant="default" onClick={viewMac} disabled={busies.macview}>Read binding</Btn>
              <Btn size="xs" variant="warn" onClick={resetMac} disabled={busies.mac}>Reset MAC</Btn>
              <Btn size="xs" variant="ghost" onClick={() => router.push("/network")}>Network page</Btn>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10, lineHeight: 1.6 }}>
              A MAC lock means the customer can only dial in from one device.
              Resetting it lets them reconnect from a new device (or after a router swap).
            </div>
          </Panel>
        </div>
      </div>

      {/* Live bandwidth chart */}
      <Panel title="Live bandwidth" sub="Rate from RADIUS accounting interim updates — a quiet line is a real zero, not missing data">
        {username ? <BandwidthHistoryChart username={username} /> : <EmptyState title="No username" />}
      </Panel>

      {/* Connection path (telemetry) */}
      {sub?.id && <LinkPath subscriberId={sub.id} />}
    </div>
  );
}