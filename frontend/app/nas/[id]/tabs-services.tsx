"use client";

/**
 * RADIUS / SNMP / Syslog tabs.
 *
 * RADIUS: FreeRADIUS server health (real) + the RADIUS client list the router
 * itself reports (from /radius/print). The shared secret is ALWAYS masked.
 * SNMP: polling configuration + live test + poller status.
 * Syslog: configuration + the durable event log filtered by severity.
 */
import React, { useMemo, useState } from "react";
import { useNasDetail } from "./context";
import { apiGet } from "./lib";
import { Btn, DefList, EmptyState, Panel, StatusChip, severityOf } from "./ui";
import { fmtDateTime, show } from "./lib";

// ── RADIUS ────────────────────────────────────────────────────────
export function RadiusTab() {
  const { nas, radiusStats, reach, details, runCoaTest, coaTest } = useNasDetail();
  const clients = details?.radiusClients ?? [];

  return (
    <div className="nd-root">
      <div className="nd-two-col">
        <Panel title="FreeRADIUS server" sub="Health + 24h activity (auth path)">
          <DefList rows={[
            ["Status", radiusStats?.alive ? "Healthy" : "Not answering"],
            ["Address", show(radiusStats?.serverIp, "internal")],
            ["Auth port", `UDP :${radiusStats?.radiusPort ?? 1812}`],
            ["Acct port", `UDP :${radiusStats?.acctPort ?? 1813}`],
            ["Active sessions", radiusStats?.activeSessionCount ?? "—"],
            ["Registered NAS", radiusStats?.nasCount ?? "—"],
            ["24h accepts / rejects", `${radiusStats?.accepts ?? 0} / ${radiusStats?.rejects ?? 0}`],
          ]} />
        </Panel>

        <Panel title="CoA (change-of-authorization)" sub="Live disconnect port on this device">
          <DefList rows={[
            ["CoA port", `UDP :${reach?.coaPort ?? nas?.incomingPort ?? 3799}`],
            ["Registration", reach?.nasRegistered ? "NAS found in client list" : "NAS not registered"],
            ["Last probe", coaTest ? `${coaTest.status === "ok" ? "OK" : "WARN/FAIL"} · ${show(coaTest.latencyMs != null ? `${coaTest.latencyMs} ms` : coaTest.message, coaTest.message ?? "—")}` : "Not run"],
          ]} />
          <div style={{ marginTop: 10 }}>
            <Btn size="sm" onClick={runCoaTest} disabled={coaTest?.status === "running"}>{coaTest?.status === "running" ? "Testing…" : "Probe CoA port"}</Btn>
          </div>
        </Panel>
      </div>

      <Panel title={`RADIUS clients on the router${clients.length ? ` (${clients.length})` : ""}`} sub="As reported by /radius/print — secret shown masked, always">
        {clients.length === 0 ? (
          <EmptyState title="No RADIUS client rows synced" hint="The router's /radius/print result is part of the API sync; check the RouterOS API health." />
        ) : (
          <div className="nd-table-wrap">
            <table className="nd-table">
              <thead>
                <tr><th>Service</th><th>Address</th><th>Secret</th><th>Auth :Acct</th><th>Timeout</th><th>Disabled</th></tr>
              </thead>
              <tbody>
                {clients.map((c, i) => (
                  <tr key={i}>
                    <td className="nd-mono">{show(c.service)}</td>
                    <td className="nd-mono">{show(c.address)}</td>
                    <td className="nd-mono">{c.secret ? "••••••••" : "—"}</td>
                    <td className="nd-mono">{show(c.authPort)} : {show(c.acctPort)}</td>
                    <td className="num">{show(c.timeout)}</td>
                    <td>{String(c.disabled ?? "").toLowerCase() === "true" ? "disabled" : "active"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ── SNMP ──────────────────────────────────────────────────────────
export function SnmpTab() {
  const { nas, snmpTest, runSnmpTest } = useNasDetail();
  const [pollSeries, setPollSeries] = useState<Array<{ t: string; v: number }>>([]);
  const [pollRange, setPollRange] = useState("1h");
  const [pollStat, setPollStat] = useState<any>(null);

  React.useEffect(() => {
    let alive = true;
    if (!nas?.snmpEnabled || !nas?.id) return;
    apiGet<any>(`/telemetry/nas/${nas.id}/health-history?range=${pollRange}`).then((d) => {
      if (!alive) return;
      setPollSeries(d?.series?.snmpMs ?? []);
      setPollStat(d?.stats?.snmpMs ?? null);
    }).catch(() => {});
    return () => { alive = false; };
  }, [nas?.snmpEnabled, nas?.id, pollRange]);

  return (
    <div className="nd-root">
      <div className="nd-two-col">
        <Panel title="SNMP polling" sub="Collector settings for this device">
          <DefList rows={[
            ["Enabled", nas?.snmpEnabled ? "Yes" : "No"],
            ["Version", show(nas?.snmpVersion, "2c")],
            ["Port", `UDP :${nas?.snmpPort ?? 161}`],
            ["Community", nas?.hasSnmpCommunity ? "•••••••• (set)" : show(nas?.snmpCommunity, "not set")],
            ["Poll interval", nas?.snmpPollSec ? `${nas.snmpPollSec}s` : "30s (default)"],
            ["Timeout / retries", nas?.snmpTimeoutMs ? `${nas.snmpTimeoutMs}ms / ${nas.snmpRetries ?? 3}` : "—"],
          ]} />
          <div style={{ marginTop: 10 }}>
            <Btn size="sm" onClick={runSnmpTest} disabled={snmpTest?.status === "running"}>{snmpTest?.status === "running" ? "Testing…" : "Test SNMP connection"}</Btn>
          </div>
          {snmpTest && (
            <div className={`nd-snmp-result ${snmpTest.status === "ok" ? "ok" : "bad"}`}>
              <b>{snmpTest.status === "ok" ? "✓ SNMP connected" : "✕ SNMP failed"}</b>
              <div className="nd-snmp-msg">{snmpTest.message}</div>
              {snmpTest.latencyMs != null && <div className="nd-snmp-msg">latency {snmpTest.latencyMs} ms · {fmtDateTime(snmpTest.ts)}</div>}
            </div>
          )}
        </Panel>

        <Panel
          title="Poller responsiveness"
          sub="SNMP response time from stored samples"
          actions={
            <div className="nd-ranges" role="tablist">
              {["1h", "6h", "24h", "7d"].map((r) => (
                <button key={r} className={pollRange === r ? "on" : ""} onClick={() => setPollRange(r)}>{r}</button>
              ))}
            </div>
          }
        >
          {pollSeries.length < 2 ? (
            <EmptyState title="Collecting data…" hint="SNMP response samples appear after a couple of polls." />
          ) : (
            <PollChart points={pollSeries} stat={pollStat} />
          )}
        </Panel>
      </div>
    </div>
  );
}

function PollChart({ points, stat }: { points: Array<{ t: string; v: number }>; stat: any }) {
  const [hover, setHover] = useState<number | null>(null);
  const hi = Math.max(...points.map((p) => p.v), 10);
  const W = 560, H = 110, pad = 8;
  const stepX = (W - pad * 2) / (points.length - 1);
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => H - pad - (v / (hi * 1.15)) * (H - pad * 2);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  return (
    <div
      className="nd-poll-plot"
      onMouseMove={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        setHover(Math.round(frac * (points.length - 1)));
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="nd-chart-svg" style={{ height: 110 }}>
        <path d={d} fill="none" stroke="#0ea5e9" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad} y2={H - pad} stroke="var(--accent)" strokeWidth="0.7" />}
      </svg>
      <div className="nd-poll-stats">
        <span>min <b>{stat?.min ?? "—"}ms</b></span>
        <span>avg <b>{stat?.avg ?? "—"}ms</b></span>
        <span>max <b>{stat?.max ?? "—"}ms</b></span>
        {hover != null && points[hover] && (
          <span className="nd-poll-hover">{new Date(points[hover].t).toLocaleTimeString()} = <b>{points[hover].v}ms</b></span>
        )}
      </div>
    </div>
  );
}

// ── Syslog ─────────────────────────────────────────────────────────
export function SyslogTab() {
  const { nas, events, refreshEvents } = useNasDetail();
  const [sev, setSev] = useState<string>("all");
  const [page, setPage] = useState(0);
  const PER = 40;

  // Normalize "warn" → "warning" so the fold matches DB severities.
  const activeSev = sev === "warn" ? "warning" : sev;

  const filtered = useMemo(() => {
    if (activeSev === "all") return events;
    return events.filter((e) => ((e.severity ?? "info").toLowerCase() === "warn" ? "warning" : (e.severity ?? "info").toLowerCase()) === activeSev);
  }, [events, activeSev]);

  const fold = ["critical", "error", "warning", "info", "success"];
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of events) {
      const k = (e.severity ?? "info").toLowerCase() === "warn" ? "warning" : (e.severity ?? "info").toLowerCase();
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  }, [events]);

  if (!nas?.syslogEnabled) {
    return (
      <div className="nd-root">
        <Panel title="Syslog">
          <EmptyState
            title="Syslog not enabled for this device"
            hint="Enable the syslog toggle in Configuration (UDP :514 by default) and point the router's /system logging at this server — events will stream here."
          />
        </Panel>
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(filtered.length / PER));
  const rows = filtered.slice(page * PER, (page + 1) * PER);

  return (
    <div className="nd-root">
      <Panel
        title={`Syslog events${events.length ? ` (${events.length} loaded)` : ""}`}
        sub="Durable event log (telemetry + syslog receiver)"
        actions={
          <>
            <div className="nd-ranges" role="tablist">
              <button className={activeSev === "all" ? "on" : ""} onClick={() => { setSev("all"); setPage(0); }}>all{events.length ? ` ${events.length}` : ""}</button>
              {fold.map((s) => (
                <button key={s} className={activeSev === s ? "on" : ""} onClick={() => { setSev(s); setPage(0); }}>
                  {s}{counts[s] ? ` ${counts[s]}` : ""}
                </button>
              ))}
            </div>
            <Btn size="xs" variant="ghost" onClick={refreshEvents}>Refresh</Btn>
          </>
        }
      >
        {rows.length === 0 ? (
          <EmptyState title="No events" hint={events.length === 0 ? "Enabled but nothing received yet — confirm the router sends syslog to this server." : "No events match this severity filter."} />
        ) : (
          <>
            <div className="nd-table-wrap">
              <table className="nd-table">
                <thead><tr><th>Time</th><th>Severity</th><th>Event</th><th>Message</th><th>User / Port</th></tr></thead>
                <tbody>
                  {rows.map((e) => {
                    const sv = severityOf(e.severity);
                    return (
                      <tr key={e.id}>
                        <td className="num nd-mono">{fmtDateTime(e.loggedAt)}</td>
                        <td><span className="nd-sev" style={{ color: sv.color, background: sv.bg }}>{sv.label}</span></td>
                        <td className="nd-mono">{e.eventType ?? "—"}</td>
                        <td style={{ maxWidth: 380 }} title={e.message}>{e.message ?? "—"}</td>
                        <td className="nd-mono">{e.username ?? e.port ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="nd-page">
                <Btn size="xs" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</Btn>
                <span>{page + 1} / {pages}</span>
                <Btn size="xs" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next →</Btn>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

export const ServicesCss = `
.nd-two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:960px){.nd-two-col{grid-template-columns:1fr}}
.nd-snmp-result{margin-top:10px;border-radius:8px;padding:9px 12px;font-size:12px}
.nd-snmp-result.ok{background:rgba(33,150,83,.08);border:1px solid rgba(33,150,83,.35)}
.nd-snmp-result.bad{background:rgba(211,64,83,.08);border:1px solid rgba(211,64,83,.35)}
.nd-snmp-msg{font-size:11px;color:var(--muted);margin-top:3px;line-height:1.5}
.nd-poll-plot{position:relative}
.nd-poll-stats{display:flex;gap:14px;flex-wrap:wrap;font-size:10.5px;color:var(--muted);margin-top:6px}
.nd-poll-stats b{color:var(--text)}
.nd-poll-hover{margin-left:auto}
.nd-sev{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;padding:2px 7px;border-radius:4px;white-space:nowrap}
@media (max-width:640px){
  .nd-ranges{flex-wrap:wrap}
}
`;