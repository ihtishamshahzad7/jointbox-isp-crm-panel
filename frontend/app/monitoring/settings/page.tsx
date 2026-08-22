"use client";

/**
 * Settings — live subsystem health (§52): SNMP connectivity, poller beat,
 * alert/notification engines, sound, monitored vs excluded interfaces, plus
 * the syslog listener status. Real numbers only — nothing invented.
 */
import React from "react";
import { ndm, fmtTime } from "../ndm";
import { NDMCSS, Stat, useNdmRefresh } from "../ndm-ui";
import { NdmTabs } from "../ndm-tabs";
import { NdmSoundBell } from "../../components/ndm-sound";

export default function SettingsPage() {
  const [diag, setDiag] = React.useState<any>(null);
  const [err, setErr] = React.useState("");

  const load = React.useCallback(async () => {
    try { setDiag(await ndm.diagnostics()); setErr(""); }
    catch (e: any) { setErr(e?.message || "Diagnostics are only visible to admins."); }
  }, []);

  useNdmRefresh(load, () => {}, [load], 20000);

  const p = diag?.poller ?? {};
  const a = diag?.alertEngine ?? {};
  const n = diag?.notificationEngine ?? {};
  const s = diag?.sound ?? {};
  const i = diag?.interfaces ?? {};

  const Row = ({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 4px", borderBottom: "1px solid var(--border)" }}>
      <span style={{ fontSize: 13 }}>{ok === null ? "⚪" : ok ? "🟢" : "🔴"}</span>
      <b style={{ fontSize: 13, flex: 1 }}>{label}</b>
      {detail && <span className="ndm-card-sub" style={{ fontSize: 11.5 }}>{detail}</span>}
    </div>
  );

  return (
    <div className="ndm">
      <style>{NDMCSS}</style>
      <NdmTabs active="settings" />

      <div className="ndm-page-h">
        <div>
          <h1>Settings &amp; Diagnostics</h1>
          <p>Live health of every background subsystem — the numbers the acceptance report checks.</p>
        </div>
        <div className="ndm-row-actions">
          <NdmSoundBell />
          <button className="ndm-btn" onClick={load}>{diag ? "Refresh" : "Load"}</button>
        </div>
      </div>

      {err && <div className="ndm-err" style={{ marginBottom: 10 }}>{err}</div>}

      {!diag && !err && <div className="ndm-empty">Loading diagnostics…</div>}
      {diag && (
        <>
          <div className="ndm-strip">
            <Stat label="SNMP engine" value={diag.snmp?.connected ? "connected" : "no backend"} color={diag.snmp?.connected ? "var(--online)" : "var(--danger)"} sub={`${diag.snmp?.deviceCount ?? 0} SNMP-enabled devices`} />
            <Stat label="Poller" value={p.running ? "running" : "idle"} color={p.running ? "var(--online)" : "var(--warning)"} sub={p.lastBeat ? `beat ${fmtTime(p.lastBeat)}` : "no beat yet"} />
            <Stat label="Alert engine" value={a.alive ? "alive" : "off"} color={a.alive ? "var(--online)" : "var(--danger)"} sub={`${a.openCount ?? 0} opened`} />
            <Stat label="Notification engine" value={n.alive ? "alive" : "off"} color={n.alive ? "var(--online)" : "var(--danger)"} sub={`${n.soundSent ?? 0} sounds sent`} />
          </div>

          <div className="ndm-card" style={{ marginBottom: 12 }}>
            <div className="ndm-card-h"><b>System health</b></div>
            <Row label="SNMP backend available" ok={!!diag.snmp?.connected} detail={`${diag.snmp?.deviceCount ?? 0} devices`} />
            <Row label="Poll loop running" ok={diag.poller ? !!p.running : null} detail={p.lastBeat ? `last beat ${fmtTime(p.lastBeat)} · ${p.inflight ?? 0} inflight` : "no beat yet"} />
            <Row label="Realtime (SSE) surface" ok={!!diag.realtime?.connected} detail="browser alert cards + sound listen on ndm:* pushes" />
            <Row label="Alert engine" ok={a.alive} detail={`${a.evalCount ?? 0} evaluations · ${a.openCount ?? 0} opens · ${a.thresholdHits ?? 0} threshold hits`} />
            <Row label="Notification engine" ok={n.alive} detail={`${n.soundSent ?? 0} sound · ${n.desktopSent ?? 0} desktop · ${n.emailSent ?? 0} email · ${n.smsSent ?? 0} SMS · ${n.discordSent ?? 0} discord · ${n.failed ?? 0} failed`} />
          </div>

          <div className="ndm-card" style={{ marginBottom: 12 }}>
            <div className="ndm-card-h"><b>Sound</b></div>
            <Row label="Alert sound chain" ok={true} detail="poller → event → rule → alert → SSE → browser audio" />
            <Row label="Interfaces with sound ON" ok={null} detail={String(s.enabledInterfaces ?? 0)} />
            <Row label="Devices with sound ON" ok={null} detail={String(s.defaultSoundOn ?? 0)} />
            <div className="ndm-hint" style={{ marginTop: 8 }}>
              Per-port DOWN/UP alerts and sounds are set on each port (Devices → open a device → Ports). Test buttons on every
              port drive the REAL pipeline: event → rule → alert → SSE → browser sound.
            </div>
          </div>

          <div className="ndm-card" style={{ marginBottom: 12 }}>
            <div className="ndm-card-h"><b>Interface policy</b><span className="ndm-card-sub">physical + VLAN by default; PPPoE/PPP/dynamic/tunnel excluded unless explicitly enabled</span></div>
            <div className="ndm-strip">
              <Stat label="Monitored" value={i.monitored ?? "—"} color="var(--online)" />
              <Stat label="Excluded" value={i.excluded ?? "—"} />
              <Stat label="Enabled rules" value={diag.rules?.enabled ?? "—"} />
              <Stat label="Total rules" value={diag.rules?.total ?? "—"} />
            </div>
          </div>

          <div className="ndm-card">
            <div className="ndm-card-h"><b>Syslog listeners</b></div>
            {diag.syslog?.listeners?.length ? (
              <div className="ndm-row-actions" style={{ flexWrap: "wrap" }}>
                {diag.syslog.listeners.map((l: string) => <span key={l} className="ndm-pill" style={{ cursor: "default" }}>{l} listening</span>)}
              </div>
            ) : (
              <div className="ndm-card-sub">No listeners active — enable them under Alerts &amp; Rules → Syslog server.</div>
            )}
            <div className="ndm-hint" style={{ marginTop: 8 }}>As of {fmtTime(diag.asOf)}</div>
          </div>
        </>
      )}
    </div>
  );
}