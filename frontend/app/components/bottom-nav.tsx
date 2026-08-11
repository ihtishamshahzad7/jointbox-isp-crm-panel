"use client";

import { usePathname, useRouter } from "next/navigation";
import { Icons } from "./icons";

/**
 * BottomNav — the mobile navigation bar.
 *
 * A phone can't show a sidebar, and a hamburger drawer alone means every
 * navigation is two taps and a hunt. This is the pattern every operator already
 * knows from their phone: a fixed bottom bar with the handful of destinations
 * used all day, plus a "More" button that opens the full menu (the existing
 * drawer). Hidden on desktop by CSS — the sidebar owns navigation there.
 *
 * Five slots only. More than five stops being a glance and starts being a menu,
 * and the sixth destination is exactly what "More" is for.
 */

const TABS = [
  { id: "dashboard",   label: "Home",    href: "/dashboard",      Icon: Icons.Dashboard },
  { id: "subscribers", label: "Subs",    href: "/subscribers",    Icon: Icons.Subscribers },
  { id: "network",     label: "Network", href: "/network-center", Icon: Icons.Network },
  { id: "billing",     label: "Billing", href: "/billing-center", Icon: Icons.Payments },
];

export default function BottomNav({ onMore }: { onMore: () => void }) {
  const pathname = usePathname() || "";
  const router = useRouter();

  const active = (href: string) =>
    pathname === href || pathname.startsWith(href + "/") || pathname.startsWith(href.replace("-center", ""));

  return (
    <nav className="jb-bottomnav" aria-label="Primary">
      {TABS.map((t) => {
        const on = active(t.href);
        return (
          <button
            key={t.id}
            onClick={() => router.push(t.href)}
            aria-current={on ? "page" : undefined}
            aria-label={t.label}
            className={on ? "on" : ""}
          >
            <span className="ico"><t.Icon width={20} height={20} /></span>
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
