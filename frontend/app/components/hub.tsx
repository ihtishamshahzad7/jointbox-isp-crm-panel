"use client";

import { useEffect, useState, Suspense } from "react";
import { motion } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { SPRING } from "../../lib/motion";
import { publishSection, clearSection } from "./section-nav";
import styles from "./advanced-ui.module.css";

export type HubTab = {
  id: string;
  label: string;
  /** One line explaining what this tab is for — shown under the title. */
  hint?: string;
  render: () => React.ReactNode;
};

function HubInner({
  tabs,
  storageKey,
}: {
  tabs: HubTab[];
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

  useEffect(() => {
    if (urlTab || !storageKey) return;
    const saved = localStorage.getItem(`hub:${storageKey}`);
    if (saved && tabs.some((t) => t.id === saved)) {
      setActive(saved);
      setSeen((p) => new Set(p).add(saved));
    }
  }, []);

  useEffect(() => {
    if (urlTab && urlTab !== active && tabs.some((t) => t.id === urlTab)) {
      setActive(urlTab);
      setSeen((p) => new Set(p).add(urlTab));
    }
  }, [urlTab]);

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
    const url = new URL(window.location.href);
    url.searchParams.set("tab", id);
    router.replace(url.pathname + url.search, { scroll: false });
  };

  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  const selectByOffset = (offset: number) => {
    if (!tabs.length || !current) return;
    const index = tabs.findIndex((t) => t.id === current.id);
    const next = (index + offset + tabs.length) % tabs.length;
    select(tabs[next].id);
  };

  return (
    <div className={styles.workspace}>
      <div
        className="hub-tabs"
        role="tablist"
        aria-label="Section navigation"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") { e.preventDefault(); selectByOffset(1); }
          if (e.key === "ArrowLeft") { e.preventDefault(); selectByOffset(-1); }
          if (e.key === "Home") { e.preventDefault(); if (tabs[0]) select(tabs[0].id); }
          if (e.key === "End") { e.preventDefault(); if (tabs.at(-1)) select(tabs.at(-1)!.id); }
        }}
        style={{
          display: "flex",
          gap: 4,
          flexWrap: "nowrap",
          alignItems: "center",
          overflowX: "auto",
          overscrollBehaviorX: "contain",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
          borderBottom: "1px solid var(--border)",
          marginBottom: 18,
          position: "relative",
          padding: "2px 2px 0",
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === current?.id}
            tabIndex={t.id === current?.id ? 0 : -1}
            className={`hub-tab ${t.id === current?.id ? "on" : ""}`}
            onClick={() => select(t.id)}
            onFocus={(e) => e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}
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
  return (
    <Suspense fallback={<div style={{ padding: 24, color: "var(--muted)" }}>Loading…</div>}>
      <HubInner {...props} />
    </Suspense>
  );
}
