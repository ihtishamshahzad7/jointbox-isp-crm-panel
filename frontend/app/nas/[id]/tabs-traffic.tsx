"use client";

/**
 * Traffic tab — whole-router MRTG-style graph + per-VLAN live breakdown +
 * ONU/link signals. Wraps the existing NasTraffic component (real endpoints).
 */
import React from "react";
import { useNasDetail } from "./context";
import { Panel } from "./ui";
import { InterfaceTraffic } from "./interface-traffic";

export function TrafficTab() {
  const { nasId, reach, sessions, radiusStats } = useNasDetail();
  // Total active PPPoE users — real, from the router /ppp/active (reach) with a
  // RADIUS accounting fallback. VLANs are deliberately NOT shown as a separate
  // dropdown: they are logical and flow through the physical interfaces below.
  const activePppoe = reach?.activeConnections ?? sessions?.length ?? radiusStats?.activeSessionCount ?? 0;
  return (
    <div className="nd-root">
      <Panel title="Per-interface traffic" sub="Individual SNMP ports — toggle interfaces in the legend. VLANs flow through these physical ports.">
        <InterfaceTraffic nasId={nasId} activePppoe={activePppoe} />
      </Panel>
    </div>
  );
}