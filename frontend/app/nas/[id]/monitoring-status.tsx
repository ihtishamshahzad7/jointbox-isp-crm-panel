"use client";

/**
 * SNMP MONITORING STATUS (Stage 2).
 *
 * A compact, operator-focused panel for one NAS: current monitoring health,
 * last successful poll, latest real metrics, and the recent event timeline with
 * acknowledge. Every value comes from the backend — unavailable metrics are
 * shown as "—", never fabricated as zero. No credentials are ever requested or
 * displayed here.
 */
import React from "react";
import API from "../../components/api";
import { Panel, Kpi, StatusChip, EmptyState, Spinner, Btn, severityOf } from "./ui";

type Status = {
  status: string;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextPollAt: string | null;
  sysDescr: string | null;
  uptimeSec: number | null;
  metrics: { cpu: number | null; memory: number | null; uptime: number | null; temperature: number | null; snmpMs: number | null; updatedAt: string | null };
  interfaces: { up: number; down: number; total: number };
};
type NasEvent = { id: number; type: string; severity: string; message: string; ts: string; acknowledged: boolean };

const H = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${typeof window !== "undefined" ? localStorage.getItem("token") : ""}` });

const STATUS_LEVEL: Record<string, "ok" | "warn" | "bad" | "off" | "unknown"> = {
  ok: "ok", timeout: "warn", config_error: "warn",
  unreachable: "bad", auth_error: "bad", poll_failed: "warn",
  disabled: "off", unknown: "unknown",
};
const STATUS_TEXT: Record<string, string> = {
  ok: "Healthy", timeout: "Timing out", unreachable: "Unreachable",
  auth_error: "Auth failing", config_error: "Misconfigured", poll_failed: "Polling failed",
  disabled: "Monitoring off", unknown: "Not polled yet",
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function uptimeText(sec: number | null): string {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  return `${d}d ${h}h`;
}

export function MonitoringStatus({ nasId, snmpEnabled, snmpVersion }: { nasId: number; snmpEnabled?: boolean; snmpVersion?: string }) {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [events, setEvents] = React.useState<NasEvent[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [acknowledging, setAcknowledging] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const [s, e] = await Promise.all([
        fetch(`${API}/telemetry/nas/${nasId}/snmp-status`, { headers: H() }),
        fetch(`${API}/telemetry/nas/${nasId}/snmp-events?limit=10`, { headers: H() }),
      ]);
      if (s.status === 403 || e.status === 403) { setError("You don't have permission to view monitoring for this device."); return; }
      if (!s.ok) { setError("Could not load monitoring status."); return; }
      setStatus(await s.json());
      setEvents(e.ok ? (await e.json()).items : []);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [nasId]);

  React.useEffect(() => {
    const initial = window.setTimeout(() => { void load(); }, 0);
    const t = setInterval(load, 15000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(t);
    };
  }, [load]);

  const ack = async (eventId: number) => {
    setError(null);
    setAcknowledging(eventId);
    try {
      const response = await fetch(`${API}/telemetry/nas/${nasId}/snmp-events/${eventId}/ack`, { method: "POST", headers: H() });
      if (response.status === 403) {
        setError("You don't have permission to acknowledge events for this device.");
        return;
      }
      if (!response.ok) {
        setError("Could not acknowledge this monitoring event.");
        return;
      }
      await load();
    } catch {
      setError("Could not reach the server to acknowledge this event.");
    } finally {
      setAcknowledging(null);
    }
  };

  if (snmpEnabled === false) {
    return (
      <Panel title="SNMP monitoring" sub="Per-device polling — opt-in">
        <EmptyState
          title="Monitoring is off for this device"
          hint="Enable SNMP in Configuration (and set the community or SNMPv3 credentials). The monitor then polls on this device's own interval, stores real metrics, and raises events on reachability changes."
        />
      </Panel>
    );
  }
  if (loading) return <Panel title="SNMP monitoring"><Spinner label="Loading monitoring status…" /></Panel>;
  if (error) return <Panel title="SNMP monitoring"><EmptyState title="Unavailable" hint={error} /></Panel>;
  if (!status) return <Panel title="SNMP monitoring"><EmptyState title="No status yet" hint="The monitor has not recorded a poll for this device." /></Panel>;

  const level = STATUS_LEVEL[status.status] ?? "unknown";
  const m = status.metrics;
  const fmt = (v: number | null, suffix = "") => (v == null ? "—" : `${v}${suffix}`);

  return (
    <Panel
      title="SNMP monitoring"
      sub={status.sysDescr ? status.sysDescr.slice(0, 80) : `SNMP ${snmpVersion ?? ""}`.trim()}
      actions={<StatusChip level={level} text={STATUS_TEXT[status.status] ?? status.status} detail={status.lastSuccessAt ? `last OK ${ago(status.lastSuccessAt)}` : undefined} />}
    >
      {/* Last error — only on a current failure, redacted on the server. */}
      {level !== "ok" && status.lastError && (
        <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "rgba(211,64,83,.08)", color: "#B4283C", fontSize: 13 }}>
          {status.lastError}
          {status.consecutiveFailures > 1 ? <em style={{ opacity: .7, fontStyle: "normal" }}> · {status.consecutiveFailures} consecutive failures</em> : null}
        </div>
      )}

      {/* Latest real metrics. "—" means not available, never a fake 0. */}
      <div className="nd-kpis" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
        <Kpi label="Last poll" value={ago(status.lastPollAt)} sub={status.nextPollAt ? `next ${ago(status.nextPollAt).replace(" ago", "")} out` : undefined} />
        <Kpi label="Uptime" value={uptimeText(status.uptimeSec ?? m.uptime)} />
        <Kpi label="CPU" value={fmt(m.cpu, "%")} color={m.cpu != null && m.cpu >= 90 ? "#D34053" : undefined} />
        <Kpi label="Memory used" value={fmt(m.memory, "%")} color={m.memory != null && m.memory >= 90 ? "#D34053" : undefined} />
        <Kpi label="SNMP response" value={m.snmpMs == null ? "—" : `${Math.round(m.snmpMs)}ms`} />
        <Kpi label="Interfaces" value={status.interfaces.total ? `${status.interfaces.up}/${status.interfaces.total} up` : "—"} sub={status.interfaces.down ? `${status.interfaces.down} down` : undefined} color={status.interfaces.down ? "#B45309" : undefined} />
      </div>

      {/* Recent events. */}
      <div style={{ marginTop: 16 }}>
        <div className="nd-group-label">Recent events</div>
        {!events || events.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--muted, #64748B)", padding: "8px 0" }}>No monitoring events recorded.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            {events.map((ev) => {
              const sev = severityOf(ev.severity);
              return (
                <div key={ev.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "6px 10px", borderRadius: 8, background: "var(--panel-2, rgba(100,116,139,.06))" }}>
                  <span style={{ flex: "0 0 auto", color: sev.color, background: sev.bg, borderRadius: 6, padding: "1px 7px", fontSize: 11, fontWeight: 600 }}>{sev.label}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={ev.message}>{ev.message}</span>
                  <span style={{ flex: "0 0 auto", color: "var(--muted, #94A3B8)" }}>{ago(ev.ts)}</span>
                  {!ev.acknowledged && <Btn size="sm" variant="default" disabled={acknowledging === ev.id} onClick={() => ack(ev.id)}>{acknowledging === ev.id ? "…" : "Ack"}</Btn>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}
