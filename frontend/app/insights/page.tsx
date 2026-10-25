"use client";

import Hub from "../components/hub";
import Segments from "../segments/page";
import Analytics from "../analytics/page";
import Reports from "../reports/page";
import Logs, { LOG_VIEWS } from "../logs/page";

/**
 * Looking backwards — trends, printable reports, and the raw record when a
 * number needs explaining.
 *
 * Logs is an accordion: clicking it expands the individual log views inline in
 * the sidebar, and the Logs page renders EMBEDDED (no second sidebar) so the
 * table gets the full width — no more three-column squeeze.
 */
export default function Insights() {
  return (
    <Hub
      storageKey="insights"
      tabs={[
        { id: "segments",  label: "Segments",  hint: "Subscribers by VLAN, router, area and reseller — with how many are actually up.", render: () => <Segments /> },
        { id: "analytics", label: "Analytics", hint: "Growth, revenue and churn over time.", render: () => <Analytics /> },
        { id: "reports",   label: "Reports",   hint: "Exportable summaries for a period.", render: () => <Reports /> },
        {
          id: "logs",
          label: "Logs",
          hint: "RADIUS, system and audit records.",
          children: LOG_VIEWS,
          render: (sub) => <Logs embedded view={sub || "timeline"} />,
        },
      ]}
    />
  );
}
