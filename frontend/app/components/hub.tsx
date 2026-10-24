"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  // A deep link (?tab=nas) opens on that tab, so it must count as seen from the
  // start — otherwise only the first tab is ever rendered and the linked one
  // shows its title over an empty page.
  const [seen, setSeen] = useState<Set<string>>(() => new Set([active]));
  useEffect(() => {
    if (active && !seen.has(active)) setSeen((p) => new Set(p).add(active));
  }, [active, seen]);

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

  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className={styles.workspace}>
      <div className="hub-layout">
        {/* Mobile: the section sidebar collapses behind this trigger. */}
        <button
          type="button"
          className="hub-navtrigger"
          aria-expanded={navOpen}
          onClick={() => setNavOpen((v) => !v)}
        >
          <span>{current?.label ?? "Sections"}</span>
          <span className={`hub-navchev${navOpen ? " open" : ""}`}>▾</span>
        </button>

        {/* Left vertical navigation sidebar. */}
        <nav
          className={`hub-side${navOpen ? " open" : ""}`}
          role="tablist"
          aria-label="Section navigation"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); selectByOffset(1); }
            if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); selectByOffset(-1); }
            if (e.key === "Home") { e.preventDefault(); if (tabs[0]) select(tabs[0].id); }
            if (e.key === "End") { e.preventDefault(); if (tabs.at(-1)) select(tabs.at(-1)!.id); }
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === current?.id}
              tabIndex={t.id === current?.id ? 0 : -1}
              className={`hub-side-tab${t.id === current?.id ? " on" : ""}`}
              onClick={() => { select(t.id); setNavOpen(false); }}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Right content area. */}
        <div className="hub-body">
          {current?.hint && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>
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
      </div>

      <style jsx global>{`
        .hub-layout { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 18px; align-items: start; }
        .hub-body { min-width: 0; }
        .hub-side {
          position: sticky; top: 12px; display: flex; flex-direction: column; gap: 3px;
          background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
          padding: 9px; box-shadow: 0 1px 2px rgba(0,0,0,.05);
        }
        .hub-side-tab {
          border: none; background: transparent; padding: 9px 13px; border-radius: 9px;
          font-size: 12.5px; font-weight: 600; color: var(--muted); cursor: pointer;
          font-family: inherit; white-space: nowrap; text-align: left; width: 100%;
          transition: background .12s, color .12s;
        }
        .hub-side-tab:hover { color: var(--text); background: var(--surface-2); }
        .hub-side-tab.on {
          background: var(--accent); color: #fff;
          box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 40%, transparent);
        }
        .hub-navtrigger {
          display: none; align-items: center; justify-content: space-between; gap: 10px;
          width: 100%; padding: 11px 14px; border: 1px solid var(--border); border-radius: 12px;
          background: var(--surface); color: var(--text); font-size: 13px; font-weight: 700;
          font-family: inherit; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.05);
        }
        .hub-navchev { transition: transform .18s; color: var(--muted); }
        .hub-navchev.open { transform: rotate(180deg); }
        @media (max-width: 900px) {
          .hub-layout { grid-template-columns: 1fr; gap: 12px; }
          .hub-navtrigger { display: flex; }
          .hub-side { position: static; display: none; padding: 7px; }
          .hub-side.open { display: flex; }
          .hub-side-tab { padding: 11px 13px; }
        }
      `}</style>
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
