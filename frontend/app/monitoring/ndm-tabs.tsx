"use client";

/**
 * Unified Network Monitoring navigation — one app, one tab bar.
 * Every monitoring page renders <NdmTabs active="…" /> so the whole module
 * (ping dashboard, SNMP devices, ports, events, syslog, alerts, settings)
 * lives under a single shell instead of disconnected screens.
 *
 * Purely client-side links — no router API involved.
 */
import React from "react";
import { NDMCSS } from "./ndm-ui";

export type NdmTabKey = "overview" | "devices" | "ports" | "events" | "syslog" | "alerts" | "settings";

const TABS: Array<{ key: NdmTabKey; label: string; href: string }> = [
  { key: "overview", label: "Overview", href: "/monitoring" },
  { key: "devices", label: "Devices", href: "/monitoring/devices" },
  { key: "ports", label: "Ports", href: "/monitoring/ports" },
  { key: "events", label: "Events", href: "/monitoring/events" },
  { key: "syslog", label: "Syslog", href: "/monitoring/syslog" },
  { key: "alerts", label: "Alerts & Rules", href: "/monitoring/alerts" },
  { key: "settings", label: "Settings", href: "/monitoring/settings" },
];

export function NdmTabs({ active }: { active: NdmTabKey }) {
  return (
    <>
      <style>{NDMCSS}</style>
      <nav className="ndm-tabs" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <a key={t.key} className={`ndm-tab${t.key === active ? " on" : ""}`} href={t.href}>
            {t.label}
          </a>
        ))}
      </nav>
    </>
  );
}