"use client";

import Hub from "../components/hub";
import Users from "../users/page";
import Organization from "../organization/page";
import Hierarchy from "../hierarchy/page";
import Security from "../security/page";
import Settings from "../settings/page";

/**
 * Accounts and configuration. The reseller tree sits here rather than under
 * billing because adding a dealer is an administrative act — the money side
 * of that relationship lives in Billing.
 */
export default function AdminCenter() {
  return (
    <Hub
      storageKey="admin"
      tabs={[
        { id: "organization", label: "Organization", hint: "Franchises, dealers and retailers under you.", render: () => <Organization /> },
        { id: "hierarchy",    label: "Network Tree", hint: "The whole downline as a chart.", render: () => <Hierarchy /> },
        { id: "users",        label: "Users & Staff", hint: "Logins, roles and permissions.", render: () => <Users /> },
        { id: "security",     label: "Security",     hint: "API keys, webhooks and access control.", render: () => <Security /> },
        { id: "settings",     label: "Settings",     hint: "Currency, branding and system options.", render: () => <Settings /> },
      ]}
    />
  );
}
