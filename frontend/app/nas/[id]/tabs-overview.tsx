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

/** One integration row: small icon (✓ ok / ✕ bad / ! warn / – off) + label + value. */
function IntRow({ state, label, value }: { state: "ok" | "bad" | "warn" | "off"; label: string; value: string }) {
  const ic = state === "ok" ? "✓" : state === "bad" ? "✕" : state === "warn" ? "!" : "–";
  return (
    <li>
      <span className={`ov-ic ${state}`} aria-hidden>{ic}</span>
      <span className="ov-int-l"><b>{label}</b><span>{value}</span></span>
    </li>
  );
}

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
      {/* ── Status tags — one clean row of small, subtle tags ── */}
      <div className="ov-tags">
        {(health as any[]).map((h) => (
          <span key={h.key} className={`ov-tag ${h.level}`} title={h.detail || ""}>
            <span className="ov-tag-dot" />{h.label}: {h.text}
          </span>
        ))}
      </div>

      {/* ── Three-column grid ── */}
      <div className="ov-grid">
        {/* Column 1 (wide) — Device Details */}
        <section className="ov-card ov-wide">
          <header className="ov-card-h">
            <h3>Device Details</h3>
            <Btn size="xs" variant="ghost" onClick={() => onGoto("configuration")}>Edit</Btn>
          </header>
          <DefList rows={[
            ["Identity", show(reach?.identity ?? details?.identity)],
            ["Version", show(reach?.version ?? details?.version)],
            ["Board", show(details?.board)],
            ["IP / API", <span key="ip" className="nd-mono">{show(nas?.nasIp)}:{nas?.apiPort ?? 8728}</span>],
            ["API user", nas?.apiUsername ? <span key="u" className="nd-mono">{nas.apiUsername}</span> : "—"],
            ["Memory", memTotal > 0 ? `${memTotal - memFree} free / ${memTotal}` : show(details?.totalMemory)],
            ["CPU load", show(reach?.cpuLoad)],
            ["Uptime", fmtRouterUptime(reach?.uptime)],
            ["Active conns", reach?.activeConnections ?? "—"],
          ]} />
        </section>

        {/* Column 2 (medium) — Active Sessions summary */}
        <section className="ov-card">
          <header className="ov-card-h">
            <h3>Active Sessions</h3>
            {sessions.length ? <Btn size="xs" variant="ghost" onClick={() => onGoto("subscribers")}>View all</Btn> : null}
          </header>
          <div className="ov-big">{reach?.activeConnections ?? sessions.length}</div>
          <div className="ov-big-sub">online now</div>
          <div className="ov-stats">
            <div><span>Subscribers</span><b>{nas?._count?.subscribers ?? nas?.subscribers?.length ?? 0}</b></div>
            <div><span>RADIUS 24h</span><b>{radiusStats?.accepts ?? 0} / {radiusStats?.rejects ?? 0}</b></div>
            <div><span>CPU</span><b>{cpu != null ? `${cpu}%` : "—"}</b></div>
            <div><span>Last check</span><b>{fmtTime(reach?.lastChecked)}</b></div>
          </div>
        </section>

        {/* Column 3 (narrow) — Integration Status (stacked list + icons) */}
        <section className="ov-card ov-narrow">
          <header className="ov-card-h"><h3>Integration Status</h3></header>
          <ul className="ov-int">
            <IntRow state={reach?.apiPortOpen ? "ok" : "bad"} label="Router API"
              value={reach?.responseTimeMs != null ? `${reach.responseTimeMs} ms` : (reach?.apiPortOpen ? "reachable" : "unreachable")} />
            <IntRow state={radiusStats?.alive ? "ok" : "bad"} label="RADIUS server"
              value={radiusStats?.alive ? `${radiusStats.activeSessionCount} sessions` : "down"} />
            <IntRow state={reach?.nasRegistered ? "ok" : "warn"} label="CoA / disconnect"
              value={`UDP ${nas?.incomingPort ?? 3799} · ${reach?.nasRegistered ? "registered" : "not registered"}`} />
            <IntRow state={nas?.snmpEnabled ? (hasSnmpSamples ? "ok" : "warn") : "off"} label="SNMP"
              value={nas?.snmpEnabled ? `v${show(nas.snmpVersion, "2c")} · every ${nas?.snmpPollSec ?? 30}s` : "disabled"} />
          </ul>
        </section>
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

      {/* ── Subscribers summary — single source of truth lives on the
             Subscribers tab; here we only show the count and a link, never a
             second subscriber/session table. ── */}
      <div className="ov-subsum">
        <div className="ov-subsum-l">
          <span className="ov-subsum-n">{nas?._count?.subscribers ?? nas?.subscribers?.length ?? 0}</span>
          <span className="ov-subsum-t">accounts assigned to this router · {reach?.activeConnections ?? sessions.length} online now</span>
        </div>
        <Btn size="xs" variant="ghost" onClick={() => onGoto("subscribers")}>Open Subscribers →</Btn>
      </div>

      <div className="nd-two-col">
        <Panel title="Recent events" sub="Telemetry event log">
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
/* ── Redesigned overview: status tags + 3-column grid ── */
.ov-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.ov-tag{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;padding:3px 10px;border-radius:999px;background:#F1F3F6;color:#4b5563;border:1px solid #E6E9EF}
.ov-tag .ov-tag-dot{width:7px;height:7px;border-radius:50%;background:#9aa3af}
.ov-tag.ok{background:rgba(22,163,74,.1);color:#16794a;border-color:rgba(22,163,74,.22)}
.ov-tag.ok .ov-tag-dot{background:#16a34a}
.ov-tag.warn{background:rgba(245,158,11,.12);color:#9a6a00;border-color:rgba(245,158,11,.28)}
.ov-tag.warn .ov-tag-dot{background:#f59e0b}
.ov-tag.bad{background:rgba(229,72,77,.1);color:#b02a37;border-color:rgba(229,72,77,.22)}
.ov-tag.bad .ov-tag-dot{background:#e5484d}
.ov-grid{display:grid;grid-template-columns:2fr 1.1fr 1fr;gap:14px;margin-bottom:14px;align-items:start}
@media(max-width:980px){.ov-grid{grid-template-columns:1fr 1fr}.ov-wide{grid-column:1/-1}}
@media(max-width:640px){.ov-grid{grid-template-columns:1fr}.ov-wide{grid-column:auto}}
.ov-card{background:#fff;border:1px solid #EAEDF1;border-radius:14px;box-shadow:0 1px 3px rgba(16,24,40,.06),0 1px 2px rgba(16,24,40,.04);padding:16px 18px}
.ov-card-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.ov-card-h h3{margin:0;font-size:12.5px;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:#374151}
.ov-big{font-size:42px;font-weight:800;line-height:1;color:#111827;font-variant-numeric:tabular-nums}
.ov-big-sub{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9aa3af;margin-top:5px}
.ov-stats{display:grid;grid-template-columns:1fr 1fr;gap:12px 10px;margin-top:18px}
.ov-stats>div{display:flex;flex-direction:column;gap:2px;min-width:0}
.ov-stats span{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#9aa3af}
.ov-stats b{font-size:14.5px;color:#111827;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ov-int{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.ov-int li{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #F0F2F5}
.ov-int li:last-child{border-bottom:none}
.ov-ic{width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;flex:0 0 auto;line-height:1}
.ov-ic.ok{background:rgba(22,163,74,.14);color:#16a34a}
.ov-ic.bad{background:rgba(229,72,77,.14);color:#e5484d}
.ov-ic.warn{background:rgba(245,158,11,.18);color:#c07a00}
.ov-ic.off{background:#eef1f4;color:#9aa3af}
.ov-int-l{flex:1;min-width:0}
.ov-int-l b{display:block;font-size:12.5px;color:#111827;font-weight:700}
.ov-int-l span{font-size:11px;color:#6B7280}
.ov-subsum{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fff;border:1px solid #EAEDF1;border-radius:14px;box-shadow:0 1px 3px rgba(16,24,40,.06);padding:14px 18px;margin-bottom:14px}
.ov-subsum-l{display:flex;align-items:baseline;gap:10px;min-width:0}
.ov-subsum-n{font-size:24px;font-weight:800;color:#111827;font-variant-numeric:tabular-nums}
.ov-subsum-t{font-size:12.5px;color:#6B7280}
:root[data-theme="dark"] .ov-subsum{background:#161a22;border-color:#262b36;box-shadow:none}
:root[data-theme="dark"] .ov-subsum-n{color:#E6E9EE}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .ov-subsum{background:#161a22;border-color:#262b36;box-shadow:none}:root:not([data-theme="light"]) .ov-subsum-n{color:#E6E9EE}}
@media (prefers-color-scheme:dark){
 :root:not([data-theme="light"]) .ov-card{background:#161a22;border-color:#262b36;box-shadow:none}
 :root:not([data-theme="light"]) .ov-card-h h3{color:#aab2bf}
 :root:not([data-theme="light"]) .ov-big,:root:not([data-theme="light"]) .ov-stats b,:root:not([data-theme="light"]) .ov-int-l b{color:#E6E9EE}
 :root:not([data-theme="light"]) .ov-int li{border-color:#242a34}
 :root:not([data-theme="light"]) .ov-tag{background:#1b2029;border-color:#2b313d;color:#aab2bf}
}
:root[data-theme="dark"] .ov-card{background:#161a22;border-color:#262b36;box-shadow:none}
:root[data-theme="dark"] .ov-card-h h3{color:#aab2bf}
:root[data-theme="dark"] .ov-big,:root[data-theme="dark"] .ov-stats b,:root[data-theme="dark"] .ov-int-l b{color:#E6E9EE}
:root[data-theme="dark"] .ov-int li{border-color:#242a34}
:root[data-theme="dark"] .ov-tag{background:#1b2029;border-color:#2b313d;color:#aab2bf}

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