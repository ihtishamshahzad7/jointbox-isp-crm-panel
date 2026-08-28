"use client";

import { Suspense, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icons } from "./icons";
import { subscribeSection, getSection, type Section } from "./section-nav";

/**
 * BottomNav — the mobile navigation bar, section-aware.
 *
 * Two modes:
 *   • On a HUB page (Network, Billing, My Work…) it shows THAT section's tabs
 *     — NAS / Pools / Outages on Network, Invoices / Payments on Billing — so
 *     switching between related screens is one tap, and the bar always reflects
 *     where you are.
 *   • Everywhere else it shows the four top-level destinations plus More.
 *
 * The hub publishes its tabs through section-nav; this subscribes. Hidden on
 * desktop by CSS, where the sidebar owns navigation.
 */

const TABS = [
  { id: "dashboard",   label: "Home",    href: "/dashboard",      Icon: Icons.Dashboard },
  { id: "subscribers", label: "Subs",    href: "/subscribers",    Icon: Icons.Subscribers },
  { id: "network",     label: "Network", href: "/network-center", Icon: Icons.Network },
  { id: "billing",     label: "Billing", href: "/billing-center", Icon: Icons.Payments },
];

/** useSearchParams requires a Suspense boundary or the whole app fails to build. */
export default function BottomNav({ onMore }: { onMore: () => void }) {
  return (
    <Suspense fallback={null}>
      <BottomNavInner onMore={onMore} />
    </Suspense>
  );
}

function BottomNavInner({ onMore }: { onMore: () => void }) {
  const pathname = usePathname() || "";
  const params = useSearchParams();
  const router = useRouter();
  const [section, setSection] = useState<Section>(getSection());

  useEffect(() => subscribeSection(setSection), []);

  const globalActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/") || pathname.startsWith(href.replace("-center", ""));

  // ── Section mode: the current hub's tabs fill the bar ──────────────────────
  // Only when the published section actually belongs to the page we're on.
  const onHub = section && pathname.startsWith(section.basePath);
  if (onHub && section) {
    const activeId = params.get("tab") || section.activeId;
    const goTab = (id: string) => {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", id);
      router.replace(url.pathname + url.search, { scroll: false });
    };
    return (
      <nav className="jb-bottomnav section" aria-label="Section">
        {/* Section tabs scroll horizontally; More is pinned so the menu is
            always reachable. */}
        <div className="jb-bn-scroll">
          {section.tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => goTab(t.id)}
              aria-current={activeId === t.id ? "page" : undefined}
              className={activeId === t.id ? "on" : ""}
            >
              <span className="lbl">{t.label}</span>
            </button>
          ))}
        </div>
        <button className="jb-bn-more" onClick={onMore} aria-label="More menu">
          <span className="ico"><Icons.Menu width={20} height={20} /></span>
          <span className="lbl">Menu</span>
        </button>
      </nav>
    );
  }

  // ── Global mode: four destinations + More ──────────────────────────────────
  return (
    <nav className="jb-bottomnav" aria-label="Primary">
      {TABS.map((t) => {
        const on = globalActive(t.href);
        return (
          <button
            key={t.id}
            onClick={() => router.push(t.href)}
            aria-current={on ? "page" : undefined}
            aria-label={t.label}
            className={on ? "on" : ""}
          >
            {/* Active icon springs 1 → 1.18 → 1 each time the tab is chosen
                (framer replays the keyframes when the animate value flips). */}
            <motion.span
              className="ico"
              animate={on ? { scale: [1, 1.18, 1] } : { scale: 1 }}
              transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
            >
              <t.Icon width={20} height={20} />
            </motion.span>
            <span className="lbl">{t.label}</span>
          </button>
        );
      })}
      <button onClick={onMore} aria-label="More menu">
        <span className="ico"><Icons.Menu width={20} height={20} /></span>
        <span className="lbl">More</span>
      </button>
    </nav>
  );
}
