"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Icons } from "./icons";
import { subscribeSection, getSection, type Section } from "./section-nav";

/**
 * The active page publishes its available sub-tabs through section-nav.
 * Pages without contextual tabs intentionally have no dock; the hamburger
 * remains the way to switch between major modules.
 */

function tabIcon(id: string, label: string) {
  const key = `${id} ${label}`.toLowerCase();
  if (/dashboard|overview|home/.test(key)) return Icons.Dashboard;
  if (/subscriber|customer/.test(key)) return Icons.Subscribers;
  if (/invoice/.test(key)) return Icons.Invoices;
  if (/billing|account|payment|wallet|reversal|pricing|earning/.test(key)) return Icons.Payments;
  if (/user|role|team|organization/.test(key)) return Icons.Users;
  if (/report|analytics|insight|statistic/.test(key)) return Icons.Reports;
  if (/nas|router|server/.test(key)) return Icons.NAS;
  if (/network|monitor|traffic|operation|noc|fiber|pool|outage|gateway/.test(key)) return Icons.Network;
  if (/package|plan|stock|catalog|inventory/.test(key)) return Icons.Packages;
  if (/area|location|franchise/.test(key)) return Icons.Areas;
  if (/complaint|support|job/.test(key)) return Icons.Support;
  if (/log|activity/.test(key)) return Icons.Logs;
  if (/setting|security|admin|config/.test(key)) return Icons.Settings;
  return Icons.Dashboard;
}

export default function BottomNav() {
  return (
    <Suspense fallback={null}>
      <BottomNavInner />
    </Suspense>
  );
}

function BottomNavInner() {
  const pathname = usePathname() || "";
  const router = useRouter();
  const [section, setSection] = useState<Section>(getSection());

  useEffect(() => subscribeSection(setSection), []);

  if (!section || !pathname.startsWith(section.basePath)) return null;

  return (
    <nav className="jb-bottomnav section" aria-label="Section">
      <div className="jb-bn-scroll">
        {section.tabs.map((tab) => {
          const Icon = tabIcon(tab.id, tab.label);
          const active = section.activeId === tab.id;
          return (
          <button
            key={tab.id}
            onClick={() => {
              if (section.onSelect) {
                section.onSelect(tab.id);
                return;
              }
              const url = new URL(window.location.href);
              url.searchParams.set("tab", tab.id);
              router.replace(url.pathname + url.search, { scroll: false });
            }}
            aria-current={active ? "page" : undefined}
            aria-label={tab.label}
            className={active ? "on" : ""}
          >
            <span className="ico"><Icon width={20} height={20} /></span>
            <span className="lbl">{tab.label}</span>
          </button>
          );
        })}
      </div>
    </nav>
  );
}
