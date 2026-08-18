"use client";

/**
 * Overview tab — the NOC-style at-a-glance screen for one device.
 * Every value here comes from the live context (device record, reachability,
 * MikroTik sync, RADIUS stats, telemetry events, network logs). Nothing is
 * fabricated; missing values render as "—" / "Unknown".
 */
import React, { useMemo } from "react";
import { useNasDetail } from "./context";
import { apiGet, buildServiceHealth, fmtTime, fmtDateTime, fmtDuration, fmtRouterUptime, parseCpu, show } from "./lib";
import { Session } from "./lib";
import { Btn, DefList, Kpi, Panel, StatusChip, severityOf } from "./ui";
import { Sparkline } from "./charts";

export function OverviewTab({ onOpenSession, onGoto }: {
  onOpenSession: (s: Session) => void;
  onGoto: (tab: string) => void;
}) {
  const { nas, reach, details, sessions, radiusStats, events, networkLogs, loading } = useNasDetail();

  // CPU sparkline from stored SNMP samples (real history; honest "none yet").
  const [cpuSpark, setCpuSpark] = React.useState<Array<{ t: string; v: number }>>([]);
  React.useEffect(() => {
    let alive = true;
    if (!nas?.snmpEnabled || !nas?.id) { setCpuSpark([]); return; }
    apiGet<{ series?: Record<string, Array<{ t: string; v: number }>> }>(
      `/telemetry/nas/${nas.id}/health-history?range=1h`,
    ).then((d) => { if (alive) setCpuSpark(d?.series?.cpu ?? []); }).catch(() => {});
    return () => { alive = false; };
  }, [nas?.snmpEnabled, nas?.id]);

  const hasSnmpSamples = cpuSpark.length > 1;
  const health = useMemo(
    () => buildServiceHealth({ reach, details, nas, events: events ?? [], hasSnmpSamples, radiusAlive: radiusStats?.alive }),
    [reach, details, nas, events, radiusStats, hasSnmpSamples],
  );
  const cpu = parseCpu(reach?.cpuLoad);
  const memFree = parseFloat(String(details?.freeMemory ?? "").replace(/\D+$/g, ""));
  const memTotal = parseFloat(String(details?.totalMemory ?? "").replace(/\D+$/g, ""));

  return (
    <div className="nd-root">
      {/* ── Health markers (device separate from each service) ── */}
      <div className="nd-healthbar">
        {(health as any[]).map((h) => (
          <StatusChip key={h.key} level={h.level} text={h.text} detail={h.detail} dotPulse={h.level === "ok" || h.level === "bad"} />
        ))}
        <span className="sep" />
        <span className="nd-updated" title="Device metadata">
          {show(reach?.identity, "router identity unknown")}
        </span>
      </div>

      {/* ── KPI row ── */}
      <div className="nd-kpi-grid">
        <Kpi label="Active sessions" value={reach?.activeConnections ?? sessions.length} sub="router · radacct fallback" />
        <Kpi label="Subscribers on device" value={nas?._count?.subscribers ?? nas?.subscribers?.length ?? 0} sub="assigned accounts" icon={<span className="nd-mono">≡</span>} />
        <Kpi label="CPU load" value={cpu != null ? `${cpu}%` : "—"} color={cpu != null && cpu >= 85 ? "#D34053" : cpu != null && cpu >= 60 ? "#B45309" : undefined} sub={reach?.cpuLoad ? `raw ${reach.cpuLoad}` : "from router"} />
        <Kpi label="RADIUS 24h" value={`${radiusStats?.accepts ?? 0} / ${radiusStats?.rejects ?? 0}`} sub="accepts / rejects" />
        <Kpi label="Last checked" value={fmtTime(reach?.lastChecked)} sub="reachability probe" />
        <Kpi label="Router uptime" value={fmtRouterUptime(reach?.uptime)} sub={fmtDuration(undefined)} />
      </div>

      <div className="nd-two-col">
        <Panel title="Device" sub="From the router via API (real) — or configuration" actions={
          <Btn size="xs" variant="ghost" onClick={() => onGoto("configuration")}>Edit</Btn>
        }>
          <DefList rows={[
            ["Identity", show(reach?.identity ?? details?.identity, "Unknown")],
            ["Version", show(reach?.version ?? details?.version, "Unknown")],
            ["Board", show(details?.board, "Unknown")],
            ["IP / API", <span key="ip" className="nd-mono">{show(nas?.nasIp)}:{nas?.apiPort ?? 8728}</span>],
            ["API user", nas?.apiUsername ? <span key="u" className="nd-mono">{nas.apiUsername}</span> : "Not configured"],
            ["Memory", memTotal > 0 ? `${memTotal - memFree} free / ${memTotal}` : show(details?.totalMemory, "Unknown")],
            ["Load", show(reach?.cpuLoad, "Unknown")],
            ["Active conns", reach?.activeConnections ?? "—"],
          ]} />
        </Panel>

        <Panel title="Integration status" sub="Independent service health — one failure never damns the router">
          <div className="nd-mini">
            <div className="nd-mini-cell"><div className="m-label">API round-trip</div><div className="m-value">{reach?.responseTimeMs != null ? `${reach.responseTimeMs} ms` : "—"}</div></div>
            <div className="nd-mini-cell"><div className="m-label">CoA port</div><div className="m-value nd-mono">UDP:{nas?.incomingPort ?? 3799}</div><div className="m-sub">{reach?.nasRegistered ? "registered" : "not registered"}</div></div>
            <div className="nd-mini-cell"><div className="m-label">SNMP</div><div className="m-value">{nas?.snmpEnabled ? `v${show(nas.snmpVersion, "2c")}` : "disabled"}</div><div className="m-sub">every {nas?.snmpPollSec ?? 30}s</div></div>
            <div className="nd-mini-cell"><div className="m-label">Syslog</div><div className="m-value">{nas?.syslogEnabled ? "enabled" : "disabled"}</div><div className="m-sub">UDP:{nas?.syslogPort ?? 514}</div></div>
            <div className="nd-mini-cell"><div className="m-label">RADIUS server</div><div className="m-value">{radiusStats?.alive ? "healthy" : "down"}</div><div className="m-sub">{radiusStats?.alive ? `${radiusStats.activeSessionCount} sessions` : "check config"}</div></div>
          </div>
        </Panel>
      </div>

      {/* ── CPU sparkline (only when real samples exist) ── */}
      {cpuSpark.length > 1 && (
        <Panel title="CPU — last hour" sub="Stored SNMP samples">
          <div className="nd-spark-row">
            <Sparkline points={cpuSpark} color="#8b5cf6" width={420} height={34} unit="%" baseline={cpu ?? undefined} />
            <span className="nd-spark-now">now <b>{cpuSpark[cpuSpark.length - 1]?.v ?? "—"}%</b> · peak <b>{Math.max(...cpuSpark.map((p) => p.v))}%</b></span>
          </div>
        </Panel>
      )}

      {/* ── Live sessions preview ── */}
      <Panel title={`Active sessions${sessions.length ? ` (${sessions.length})` : ""}`} sub="Router first, RADIUS accounting fallback" actions={
        sessions.length ? <Btn size="xs" variant="ghost" onClick={() => onGoto("subscribers")}>View all</Btn> : undefined
      }>
        {sessions.length === 0 ? (
          <div className="nd-empty" style={{ padding: 16 }}>
            <div className="nd-empty-title">No active sessions</div>
            <div className="nd-empty-hint">When subscribers connect, their sessions appear here from the router's /ppp/active (or radacct when accounting is enabled).</div>
          </div>
        ) : (
          <table className="nd-table">
            <thead><tr><th>User</th><th>IP</th><th>MAC</th><th>Connected</th><th>Duration</th><th>↓ / ↑</th><th></th></tr></thead>
            <tbody>
              {sessions.slice(0, 8).map((s) => (
                <tr key={s.acctsessionid ?? s.username} className="nd-row-click" onClick={() => onOpenSession(s)}>
                  <td className="nd-mono" style={{ fontWeight: 700 }}>{s.username}</td>
                  <td className="nd-mono">{show(s.framedipaddress)}</td>
                  <td className="nd-mono">{show(s.callingstationid)}</td>
                  <td>{fmtDateTime(s.acctstarttime)}</td>
                  <td className="num">{fmtDuration(s.duration_seconds)}</td>
                  <td className="num nd-mono">{fmtBytesShort(s.download_bytes)} / {fmtBytesShort(s.upload_bytes)}</td>
                  <td><Btn size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); onOpenSession(s); }}>Details</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="nd-two-col">
        <Panel title="Recent events" sub="Telemetry & syslog (durable event log)">
          {events.length === 0 ? (
            <div className="nd-empty" style={{ padding: 14 }}><div className="nd-empty-title">No events yet</div></div>
          ) : (
            <div className="nd-events">
              {events.slice(0, 8).map((e) => {
                const sv = severityOf(e.severity);
                return (
                  <div key={e.id} className="nd-event">
                    <span className="nd-sym" style={{ background: sv.color }} />
                    <span className="nd-event-msg" title={e.message}>{e.message}</span>
                    <span className="nd-event-t" style={{ color: sv.color }}>{sv.label}</span>
                    <span className="nd-event-dt">{fmtDateTime(e.loggedAt)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
        <Panel title="Recent network logs" sub="Link up/down, connection events on this device">
          {networkLogs.length === 0 ? (
            <div className="nd-empty" style={{ padding: 14 }}><div className="nd-empty-title">No network logs yet</div></div>
          ) : (
            <div className="nd-events">
              {networkLogs.slice(0, 8).map((l) => (
                <div key={l.id} className="nd-event">
                  <span className="nd-sym" style={{ background: severityOf(l.severity).color }} />
                  <span className="nd-event-msg" title={l.message ?? ""}>{l.eventType}{l.username ? ` — ${l.username}` : ""}</span>
                  <span className="nd-event-t">{l.eventReason ?? ""}</span>
                  <span className="nd-event-dt">{fmtDateTime(l.loggedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function fmtBytesShort(v?: number | null) {
  const n = Number(v);
  if (!v || Number.isNaN(n) || n < 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${Math.round(n)}B`;
}

export const OverviewCss = `
.nd-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}
.nd-two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.nd-events{display:flex;flex-direction:column}
.nd-event{display:flex;align-items:center;gap:8px;padding:7px 2px;border-bottom:1px dashed var(--border);font-size:11.5px;min-width:0}
.nd-event:last-child{border-bottom:none}
.nd-event-msg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.nd-event-t{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;flex:none}
.nd-event-dt{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums;flex:none}
.nd-spark-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.nd-spark-now{font-size:11px;color:var(--muted)}
.nd-spark-now b{color:var(--text)}
@media (max-width:960px){.nd-two-col{grid-template-columns:1fr}}
`;