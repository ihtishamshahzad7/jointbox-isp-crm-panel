"use client";

import Hub from "../components/hub";
import Packages from "../packages/page";
import Areas from "../areas/page";
import Inventory from "../inventory/page";
import FranchiseGroups from "../franchise-groups/page";

/**
 * What you sell and where you sell it — plans, coverage areas, and the
 * equipment that goes out with an installation.
 */
export default function ServiceCatalog() {
  return (
    <Hub
      storageKey="catalog"
      tabs={[
        { id: "packages",        label: "Packages",        hint: "Speed, price, quota and FUP for each plan.", render: () => <Packages /> },
        { id: "areas",           label: "Areas",           hint: "Coverage areas and the customers in them.", render: () => <Areas /> },
        { id: "inventory",       label: "Inventory",       hint: "Routers, ONTs and cable stock, and who holds them.", render: () => <Inventory /> },
        { id: "franchiseGroups", label: "Franchise Groups", hint: "Organize franchises and control package visibility.", render: () => <FranchiseGroups /> },
      ]}
    />
  );
}
