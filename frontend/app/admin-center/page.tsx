"use client";

import React from "react";
import Hub from "../components/hub";
import API from "../components/api";
import Users from "../users/page";
import Organization from "../organization/page";
import Hierarchy from "../hierarchy/page";
import Security from "../security/page";
import Settings from "../settings/page";
import Licence from "../licence/page";
import Companies from "../companies/page";

/**
 * Accounts and configuration. The reseller tree sits here rather than under
 * billing because adding a dealer is an administrative act — the money side of
 * that relationship lives in Billing.
 *
 * ── TWO AUDIENCES, ONE HUB ───────────────────────────────────────────────
 * This panel hosts several unrelated ISP companies. An ADMIN owns one of them;
 * the SUPER_ADMIN owns the installation they all run on. Two tabs belong only
 * to the second: Companies (the client list) and Licence (a contract about the
 * installation, whose subscriber count is the total across every tenant).
 *
 * The gate here is cosmetic and says so: the backend refuses both surfaces to
 * a non-owner on its own — /users/companies throws, every licence route throws.
 * Hiding them is about not advertising a door that is already locked. A tenant
 * who sees a tab and gets a 403 learns the feature exists and that someone else
 * controls it; a tenant who never sees it learns nothing at all.
 *
 * Role is read from /profile rather than from a token claim in localStorage,
 * because a claim is whatever the browser says it is and this list is one of
 * the places someone would try editing it first.
 */
export default function AdminCenter() {
  const [role, setRole] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    try {
      fetch(`${API}/profile`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token") || ""}` },
      })
        .then((r) => r.json())
        .then((d) => { if (live) setRole(d?.user?.role ?? ""); })
        .catch(() => { if (live) setRole(""); });
    } catch {
      setRole("");
    }
    return () => { live = false; };
  }, []);

  const isPlatformOwner = role === "SUPER_ADMIN";

  // Tabs render only once the role is known. An undecided moment that shows
  // the owner tabs and then removes them is worse than one that shows nothing:
  // the flash is what a tenant would screenshot.
  const ownerTabs = !isPlatformOwner ? [] : [
    { id: "companies", label: "Companies", hint: "The ISP businesses hosted on this panel.", render: () => <Companies /> },
  ];

  return (
    <Hub
      storageKey="admin"
      tabs={[
        ...ownerTabs,
        { id: "organization", label: "Organization", hint: "Franchises, dealers and retailers under you.", render: () => <Organization /> },
        { id: "hierarchy",    label: "Network Tree", hint: "The whole downline as a chart.", render: () => <Hierarchy /> },
        { id: "users",        label: "Users & Staff", hint: "Logins, roles and permissions.", render: () => <Users /> },
        { id: "security",     label: "Security",     hint: "API keys, webhooks and access control.", render: () => <Security /> },
        { id: "settings",     label: "Settings",     hint: "Currency, branding and system options.", render: () => <Settings /> },
        ...(!isPlatformOwner ? [] : [
          { id: "licence", label: "Licence", hint: "Activation, plan limits and expiry.", render: () => <Licence /> },
        ]),
      ]}
    />
  );
}
