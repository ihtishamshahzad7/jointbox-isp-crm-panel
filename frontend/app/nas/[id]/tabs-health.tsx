"use client";

/**
 * Health tab — historical SNMP graphs (CPU / memory / temperature / SNMP
 * response), interface samples and the live SNMP test. Wraps the existing
 * DeviceHealth surface used on the NAS list (same real endpoints, same data).
 */
import React from "react";
import { useNasDetail } from "./context";
import { Panel, EmptyState } from "./ui";
import { DeviceHealth } from "../device-health";
import { MonitoringStatus } from "./monitoring-status";

export function HealthTab() {
  const { nasId, nas } = useNasDetail();
  return (
    <div className="nd-root">
      {/* Stage 2: per-device SNMP monitoring status, events and ack. */}
      <MonitoringStatus nasId={nasId} snmpEnabled={nas?.snmpEnabled} snmpVersion={nas?.snmpVersion} />
      <Panel title="Device health" sub="Stored SNMP poller data — every point is a real measurement" actions={
        <span className="nd-updated">sampled every {nas?.snmpPollSec ?? 30}s when enabled</span>
      }>
        {nas?.snmpEnabled === false ? (
          <EmptyState
            title="SNMP polling disabled"
            hint="Enable SNMP + the community string in Configuration, then the collector stores samples every 30s and graphs appear as data arrives."
          />
        ) : (
          <DeviceHealth nasId={nasId} nasName={nas?.shortname ?? nas?.nasname} />
        )}
      </Panel>
    </div>
  );
}