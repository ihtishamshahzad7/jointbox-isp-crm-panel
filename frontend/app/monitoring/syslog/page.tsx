"use client";

/**
 * Syslog — the per-device message feed as parsed by the syslog receiver.
 * Severity + device filters, auto-refresh, live SSE updates.
 */
import React from "react";
import { ndm, fmtTime, type SyslogRow } from "../ndm";
import { NDMCSS, SeverityBadge, useNdmRefresh } from "../ndm-ui";
import { NdmTabs } from "../ndm-tabs";
import { useSSE } from "../../components/use-sse";

const SEVERITIES = ["EMERGENCY", "ALERT", "CRITICAL", "ERROR", "WARNING", "NOTICE", "INFO", "DEBUG"];

export default function SyslogPage() {
  const [rows, setRows] = React.useState<SyslogRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [severity, setSeverity] = React.useState("");
  const [deviceId, setDeviceId] = React.useState<number | "">("");
  const [devices, setDevices] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      const r = await ndm.syslog({ severity: severity || undefined, deviceId: deviceId || undefined, limit: 100 });
      setRows(r.rows); setTotal(r.total);
    } catch { /* keep last */ }
    finally { setLoading(false); }
  }, [severity, deviceId]);

  useNdmRefresh(load, () => {}, [load], 15000);
  useSSE({ onEvent: (t: string) => { if (t === "ndm:event" || t === "syslog") void load(); } });

  React.useEffect(() => { ndm.devices().then(setDevices).catch(() => {}); }, []);

  return (
    <div className="ndm">
      <style>{NDMCSS}</style>
      <NdmTabs active="syslog" />

      <div className="ndm-page-h">
        <div>
          <h1>Syslog</h1>
          <p>Messages received from the devices — {total} in the current filter. Devices must send syslog to this panel; enable it under device settings.</p>
        </div>
        <div className="ndm-row-actions">
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}
            style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 10px", background: "var(--surface)", color: "var(--text)", fontSize: 12.5 }}>
            <option value="">All severities</option>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value ? Number(e.target.value) : "")}
            style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 10px", background: "var(--surface)", color: "var(--text)", fontSize: 12.5 }}>
            <option value="">All devices</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      </div>

      {loading && !rows.length ? <div className="ndm-empty">Loading…</div> :
        !rows.length ? <div className="ndm-empty">No syslog received yet.</div> :
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "auto" }}>
          <table className="ndm-tbl">
            <thead>
              <tr><th>Time</th><th>Severity</th><th>Facility</th><th>Source</th><th>Device</th><th>Message</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtTime(r.receivedAt)}</td>
                  <td><SeverityBadge s={r.severityName || "INFO"} /></td>
                  <td>{r.facilityName || "—"}</td>
                  <td style={{ fontFamily: "monospace", fontSize: 11 }}>{r.sourceIp}{r.hostname ? ` (${r.hostname})` : ""}</td>
                  <td>{r.deviceId ? <a href={`/monitoring/devices/${r.deviceId}`} style={{ color: "var(--accent)" }}>device #{r.deviceId}</a> : "—"}</td>
                  <td style={{ maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.message}>{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
    </div>
  );
}