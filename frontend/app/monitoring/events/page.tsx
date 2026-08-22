"use client";

/**
 * Events — every state change the engines recorded (port up/down, device
 * reboot, syslog-parsed link flaps, thresholds…). Filterable by status and
 * device. Auto-refreshes and updates live from the SSE push.
 */
import React from "react";
import { ndm, fmtTime, type NdmEvent } from "../ndm";
import { NDMCSS, SeverityBadge, useNdmRefresh } from "../ndm-ui";
import { NdmTabs } from "../ndm-tabs";
import { useSSE } from "../../components/use-sse";

export default function EventsPage() {
  const [events, setEvents] = React.useState<NdmEvent[]>([]);
  const [total, setTotal] = React.useState(0);
  const [status, setStatus] = React.useState("OPEN");
  const [deviceId, setDeviceId] = React.useState<number | "">("");
  const [devices, setDevices] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      const r = await ndm.events({ status: status || undefined, deviceId: deviceId || undefined, limit: 100 });
      setEvents(r.rows); setTotal(r.total);
    } catch { /* keep last */ }
    finally { setLoading(false); }
  }, [status, deviceId]);

  useNdmRefresh(load, () => {}, [load], 20000);
  useSSE({ onEvent: (t: string) => { if (t === "ndm:event" || t === "ndm:alert") void load(); } });

  React.useEffect(() => { ndm.devices().then(setDevices).catch(() => {}); }, []);

  return (
    <div className="ndm">
      <style>{NDMCSS}</style>
      <NdmTabs active="events" />

      <div className="ndm-page-h">
        <div>
          <h1>Events</h1>
          <p>Every recorded state change from the pollers, syslog parser and engines — {total} in the current filter.</p>
        </div>
        <div className="ndm-row-actions">
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 10px", background: "var(--surface)", color: "var(--text)", fontSize: 12.5 }}>
            <option value="OPEN">Open</option>
            <option value="RESOLVED">Resolved</option>
            <option value="">All</option>
          </select>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value ? Number(e.target.value) : "")}
            style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 10px", background: "var(--surface)", color: "var(--text)", fontSize: 12.5 }}>
            <option value="">All devices</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      </div>

      {loading && !events.length ? <div className="ndm-empty">Loading…</div> :
        !events.length ? <div className="ndm-empty">No events{status === "OPEN" ? " open" : ""} yet — they appear as transitions happen.</div> :
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "auto" }}>
          <table className="ndm-tbl">
            <thead>
              <tr><th>When</th><th>Event</th><th>Severity</th><th>Device</th><th>Interface</th><th>Source</th><th>Message</th></tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtTime(e.createdAt)}</td>
                  <td><b>{e.label || e.eventType}</b>{e.status === "RESOLVED" && <span className="ndm-hint"> ✓</span>}</td>
                  <td><SeverityBadge s={e.severity} /></td>
                  <td>{e.deviceId ? <a href={`/monitoring/devices/${e.deviceId}`} style={{ color: "var(--accent)" }}>device #{e.deviceId}</a> : "—"}</td>
                  <td>{e.interfaceName || "—"}</td>
                  <td style={{ color: "var(--muted)" }}>{e.sourceIp || "poller"}</td>
                  <td style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.message}>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
    </div>
  );
}