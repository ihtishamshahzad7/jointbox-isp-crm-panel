"use client";

/**
 * Test Center — one place to probe every integration a NAS depends on.
 *
 * Every test is a real backend call (Ping ICMP, API login, SNMP walk, CoA
 * UDP probe). RADIUS and Syslog rows are driven by real live state (server
 * health + received events), never invented. Latency is measured client-side
 * for the round trip and reported next to each status.
 */
import React from "react";
import { useNasDetail, TestResult } from "./context";
import { fmtTime } from "./lib";
import { Btn, Panel } from "./ui";

function TestRow({ result, onRun, running, latencyHint }: {
  result: TestResult | null;
  onRun: () => void;
  running: boolean;
  latencyHint?: string;
}) {
  const statusColor =
    result?.status === "ok" ? "#219653" :
    result?.status === "warn" ? "#B45309" :
    result?.status === "fail" ? "#D34053" :
    "var(--muted)";
  const statusText =
    result?.status === "ok" ? "OK" :
    result?.status === "warn" ? "WARN" :
    result?.status === "fail" ? "FAIL" :
    running ? "Running…" : "Not run";
  return (
    <div className="nd-test-row">
      <span className="t-label">{result?.label ?? "—"}</span>
      {running ? (
        <span className="t-status" style={{ color: "var(--muted)" }}>
          <span className="nd-spinner-ring" />
        </span>
      ) : (
        <span className="t-status" style={{ color: statusColor }}>{statusText}</span>
      )}
      <span className="t-msg" title={result?.message}>{result?.message ?? latencyHint ?? "Run the test to probe this integration."}</span>
      <span className="t-ms">
        {result?.latencyMs != null ? `${result.latencyMs} ms` : ""}
      </span>
      <Btn size="xs" variant="ghost" onClick={onRun} disabled={running || result?.status === "running"}>Test</Btn>
    </div>
  );
}

export function TestCenter() {
  const {
    nas, reach, radiusStats, events,
    pingResult, runPing, apiRoundTrip, runApiTest,
    snmpTest, runSnmpTest, coaTest, runCoaTest,
    runAllTests, clearTests, refreshReach, refreshEvents,
  } = useNasDetail();
  const snmpEnabled = !!nas?.snmpEnabled;

  const [busy, setBusy] = React.useState(false);

  const runAll = async () => {
    setBusy(true);
    try {
      await runAllTests();
      await refreshReach({ silent: true });
    } finally {
      setBusy(false);
    }
  };

  // Real RADIUS health from the backend's own server checks.
  const radiusUp = radiusStats?.alive ?? reach?.radiusPortOpen ?? null;
  const radiusResult: TestResult | null = {
    key: "radius",
    label: "RADIUS",
    status: radiusUp === null ? "running" : radiusUp ? "ok" : "fail",
    message: radiusUp === null
      ? "Checking server…"
      : radiusUp
        ? `${radiusStats?.serverIp ?? reach?.radiusIp ?? "?"}:${radiusStats?.radiusPort ?? 1812} — ${radiusStats?.activeSessionCount ?? 0} active session(s), ${radiusStats?.accepts ?? 0} accept(s) 24h`
        : `FreeRADIUS is not answering on UDP :1812`,
    ts: reach?.lastChecked ? String(reach.lastChecked) : new Date().toISOString(),
  };

  // Real syslog signal: is this NAS actually producing events?
  const syslogEnabled = !!nas?.syslogEnabled;
  const syslogCount = events.length;
  const syslogResult: TestResult | null = {
    key: "syslog",
    label: "Syslog",
    status: !syslogEnabled ? "warn" : syslogCount > 0 ? "ok" : "running",
    message: !syslogEnabled
      ? "Syslog not enabled on this device"
      : syslogCount > 0
        ? `Receiving events (${syslogCount} recent) — port ${nas?.syslogPort ?? 514}`
        : "Enabled, no events received yet",
    ts: new Date().toISOString(),
  };

  return (
    <Panel
      title="Test Center"
      sub="Live probes against the device and supporting services — every result is a real backend check."
      actions={
        <>
          <Btn size="xs" variant="ghost" onClick={clearTests}>Clear results</Btn>
          <Btn size="xs" variant="primary" onClick={runAll} disabled={busy}>{busy ? "Running…" : "Run all"}</Btn>
        </>
      }
    >
      <div className="nd-tests">
        <TestRow result={pingResult} onRun={runPing} running={pingResult?.status === "running"} latencyHint={nas?.nasIp ? `ICMP to ${nas.nasIp}` : "Configure an IP first"} />
        <TestRow result={apiRoundTrip} onRun={runApiTest} running={apiRoundTrip?.status === "running"} latencyHint="RouterOS API login" />
        <TestRow result={snmpTest} onRun={runSnmpTest} running={snmpTest?.status === "running"} latencyHint={snmpEnabled ? `SNMP v${nas?.snmpVersion ?? "2c"} walk` : "SNMP polling disabled"} />
        <TestRow result={coaTest} onRun={runCoaTest} running={coaTest?.status === "running"} latencyHint={`CoA probe on UDP :${nas?.incomingPort ?? 3799}`} />
        <TestRow result={radiusResult} onRun={() => refreshReach({ silent: true })} running={radiusUp === null} latencyHint="FreeRADIUS server health" />
        <TestRow result={syslogResult} onRun={refreshEvents} running={false} latencyHint={`Syslog UDP :${nas?.syslogPort ?? 514}`} />
      </div>

      <div className="nd-test-tail">
        Last checked <b>{fmtTime(reach?.lastChecked)}</b> · device {nas?.nasIp ?? "no IP"} · API port {nas?.apiPort ?? 8728} · CoA port {nas?.incomingPort ?? 3799}
      </div>
    </Panel>
  );
}