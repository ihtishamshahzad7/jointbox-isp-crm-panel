"use client";

/**
 * Traffic tab — whole-router MRTG-style graph + per-VLAN live breakdown +
 * ONU/link signals. Wraps the existing NasTraffic component (real endpoints).
 */
import React from "react";
import { useNasDetail } from "./context";
import { Panel } from "./ui";
import { NasTraffic } from "../nas-traffic";
import { InterfaceTraffic } from "./interface-traffic";

export function TrafficTab() {
  const { nasId } = useNasDetail();
  return (
    <div className="nd-root">
      <Panel title="Per-interface traffic" sub="Individual SNMP ports — toggle interfaces in the legend">
        <InterfaceTraffic nasId={nasId} />
      </Panel>

      <Panel title="Traffic" sub="Whole router (all interfaces & VLANs combined)" actions={
        <span className="nd-updated">sampled every 5 min</span>
      }>
        <NasTraffic nasId={nasId} />
      </Panel>
    </div>
  );
}