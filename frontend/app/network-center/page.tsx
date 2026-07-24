"use client";

import Hub from "../components/hub";
import LiveNetwork from "../network/page";
import Nas from "../nas/page";
import IpPools from "../ip-pools/page";
import StaticIps from "../static-ips/page";
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
        { id: "live",    label: "Live Network", hint: "Who is online right now, per router.", render: () => <LiveNetwork /> },
        { id: "nas",     label: "NAS / Routers", hint: "Your MikroTiks and their RADIUS settings.", render: () => <Nas /> },
        { id: "fiber",   label: "FTTH / Fiber", hint: "OLTs, PON ports, ONUs and fiber topology.", render: () => <Fiber /> },
        { id: "pools",   label: "IP Pools",     hint: "Address ranges handed out to customers automatically.", render: () => <IpPools /> },
        { id: "static",  label: "Static IPs",   hint: "Fixed addresses sold as a monthly add-on.", render: () => <StaticIps /> },
        { id: "outages", label: "Outages & Power", hint: "Load-shedding, power cuts and network faults.", render: () => <Outages /> },
      ]}
    />
  );
}
