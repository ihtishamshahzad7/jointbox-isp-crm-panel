"use client";

import { useEffect, useState, Suspense } from "react";
import { motion } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { SPRING } from "../../lib/motion";
import { publishSection, clearSection } from "./section-nav";

export type HubTab = {
  id: string;
  label: string;
  /** One line explaining what this tab is for — shown under the title. */
  hint?: string;
  render: () => React.ReactNode;
};

/**
 * Hub — one page, several related screens behind tabs.
 *
 * The sidebar had grown to twenty-nine entries, which meant scrolling a list
 * to find things and jumping between pages that belong to the same job. NAS,
 * pools, static IPs and the live network are all "the network"; invoices,
 * payments and vouchers are all "money". Grouping them means the related
 * screen is one click away instead of a hunt down the sidebar.
 *
 * The active tab lives in the URL (?tab=), so a hub screen can still be
 * bookmarked, shared, and reached by the browser's back button.
 *
 * Tabs mount lazily and stay mounted once opened: the first click pays for the
 * fetch, and going back to a tab you have already seen is instant.
 */
function HubInner({
  tabs,
  storageKey,
}: {
  tabs: HubTab[];
  /** Remembers the last tab per hub, so returning lands where you left off. */
  storageKey?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const urlTab = params.get("tab");

  const [active, setActive] = useState(() => {
    if (urlTab && tabs.some((t) => t.id === urlTab)) return urlTab;
    return tabs[0]?.id;
  });
  const [seen, setSeen] = useState<Set<string>>(new Set([tabs[0]?.id]));

  // Restore the last tab only when the URL doesn't already ask for one —
  // an explicit link must always win over what was used last time.
  useEffect(() => {
    if (urlTab || !storageKey) return;
    const saved = localStorage.getItem(`hub:${storageKey}`);
    if (saved && tabs.some((t) => t.id === saved)) {
      setActive(saved);
      setSeen((p) => new Set(p).add(saved));
    }
  }, []);

  // Follow the URL when it changes underneath us (back button, or a link into
  // a specific tab from somewhere else in the app).
  useEffect(() => {
    if (urlTab && urlTab !== active && tabs.some((t) => t.id === urlTab)) {
      setActive(urlTab);
      setSeen((p) => new Set(p).add(urlTab));
    }
  }, [urlTab]);

  /**
   * Publish this hub's tabs so the mobile bottom bar becomes section-aware —
   * on Network it shows NAS / Pools / Outages, on Billing it shows Invoices /
   * Payments, and so on. Re-published whenever the tab set or active tab
   * changes, and cleared when the hub unmounts so the bar falls back to the
   * global menu on non-hub pages.
   */
  useEffect(() => {
    const basePath = typeof window !== "undefined" ? window.location.pathname : "";
    publishSection({
      basePath,
      activeId: active,
      tabs: tabs.map((t) => ({ id: t.id, label: t.label })),
    });
    return () => clearSection(basePath);
  }, [tabs, active]);

  const select = (id: string) => {
    setActive(id);
    setSeen((p) => new Set(p).add(id));
    if (storageKey) localStorage.setItem(`hub:${storageKey}`, id);
    // replace, not push — flipping tabs shouldn't fill the back history.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", id);
    router.replace(url.pathname + url.search, { scroll: false });
  };

  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div>
      {/* On a phone these eight labels wrapped onto five rows and ate half the
          screen — and the sliding underline, measured with offsetLeft, then
          drew itself under the wrong row. The mobile stylesheet turns this
          into a single swipeable row, which fixes both at once. */}
      <div
        className="hub-tabs"
        style={{
          display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center",
          borderBottom: "1px solid var(--border)", marginBottom: 18,
          position: "relative",
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`hub-tab ${t.id === current?.id ? "on" : ""}`}
            onClick={() => select(t.id)}
          >
            {t.label}
            {t.id === current?.id && (
              <motion.span
                className="hub-underline"
                layoutId="hub-underline"
                transition={SPRING}
              />
            )}
          </button>
        ))}
      </div>

      {current?.hint && (
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, marginTop: -6 }}>
          {current.hint}
        </div>
      )}

      {/* Every seen tab stays in the tree; only the active one is visible. This
          keeps scroll position and in-progress form state when switching. */}
      {tabs.map((t) =>
        seen.has(t.id) ? (
          <div key={t.id} style={{ display: t.id === current?.id ? "block" : "none" }}>
            {t.render()}
          </div>
        ) : null,
      )}
    </div>
  );
}

export default function Hub(props: { tabs: HubTab[]; storageKey?: string }) {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={<div style={{ padding: 24, color: "var(--muted)" }}>Loading…</div>}>
      <HubInner {...props} />
    </Suspense>
  );
}
