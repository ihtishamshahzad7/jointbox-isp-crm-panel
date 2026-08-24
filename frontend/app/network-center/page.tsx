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

/**
 * Everything that is "the network" in one place.
 *
 * These six screens are used together constantly — you look at who is online,
 * see a router misbehaving, check its pool, and end up assigning an address.
 * Previously that was four sidebar hops.
 */
export default function NetworkCenter() {
  return (
    <Hub
      storageKey="network"
      tabs={[
        { id: "ops",     label: "Operations",   hint: "Alerts, router health and what needs attention now.", render: () => <Operations /> },
        { id: "noc",     label: "NOC / Uptime", hint: "Segment health, uptime and the outage timeline.", render: () => <Noc /> },
        { id: "live",    label: "Live Network", hint: "Who is online right now, per router.", render: () => <LiveNetwork /> },
        { id: "nas",     label: "NAS / Routers", hint: "Your MikroTiks and their RADIUS settings.", render: () => <Nas /> },
        { id: "fiber",   label: "FTTH / Fiber", hint: "OLTs, PON ports, ONUs and fiber topology.", render: () => <Fiber /> },
        { id: "pools",   label: "IP Pools",     hint: "Address ranges handed out to customers automatically.", render: () => <IpPools /> },
        { id: "static",  label: "Static IPs",   hint: "Fixed addresses sold as a monthly add-on.", render: () => <StaticIps /> },
        { id: "prefixes", label: "Prefix Register", hint: "Routed blocks, VLANs and transit links for corporate clients.", render: () => <Prefixes /> },
        { id: "outages", label: "Outages & Power", hint: "Load-shedding, power cuts and network faults.", render: () => <Outages /> },
      ]}
    />
  );
}
