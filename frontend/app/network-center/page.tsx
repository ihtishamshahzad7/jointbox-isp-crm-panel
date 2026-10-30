"use client";

import Hub from "../components/hub";
import Operations from "../operations/page";
import Noc from "../noc/page";
import LiveNetwork from "../network/page";
import Nas from "../nas/page";
import IpPools from "../ip-pools/page";
import StaticIps from "../static-ips/page";
import Prefixes from "../prefixes/page";
import Outages from "../outages/page";
import Fiber from "../fiber/page";
import React from "react";
import { tokenPayload } from "../components/platform";

/**
 * Frontend-only network workspace. Existing screens and data contracts stay
 * untouched; this page adds a faster visual command layer around them.
 */
export default function NetworkCenter() {
  // The prefix register is the ISP company's own address plan.
  const [isOwner, setIsOwner] = React.useState(false);
  React.useEffect(() => {
    const r = tokenPayload()?.role;
    setIsOwner(r === "ADMIN" || r === "SUPER_ADMIN");
  }, []);
  return (
    <div className="jb-network-workspace">
      <h1 className="jb-network-title">Network Center</h1>

      <Hub
        storageKey="network"
        tabs={[
          { id: "ops", label: "Operations", hint: "Alerts, router health and what needs attention now.", render: () => <Operations /> },
          { id: "noc", label: "NOC / Uptime", hint: "Segment health, uptime and the outage timeline.", render: () => <Noc /> },
          { id: "live", label: "Live Network", hint: "Who is online right now, per router.", render: () => <LiveNetwork /> },
          { id: "nas", label: "NAS / Routers", hint: "Your MikroTiks and their RADIUS settings.", render: () => <Nas /> },
          { id: "fiber", label: "FTTH / Fiber", hint: "OLTs, PON ports, ONUs and fiber topology.", render: () => <Fiber /> },
          { id: "pools", label: "IP Pools", hint: "Address ranges handed out to customers automatically.", render: () => <IpPools /> },
          { id: "static", label: "Static IPs", hint: "Fixed addresses sold as a monthly add-on.", render: () => <StaticIps /> },
          ...(isOwner ? [{ id: "prefixes", label: "Prefix Register", hint: "Routed blocks, VLANs and transit links for corporate clients.", render: () => <Prefixes /> }] : []),
          { id: "outages", label: "Outages & Power", hint: "Load-shedding, power cuts and network faults.", render: () => <Outages /> },
        ]}
      />

      <style jsx>{`
        .jb-network-workspace{width:100%;min-width:0}
        .jb-network-title{margin:0 0 8px;color:var(--text);font-size:18px;font-weight:800;letter-spacing:-.02em}
      `}</style>
    </div>
  );
}
