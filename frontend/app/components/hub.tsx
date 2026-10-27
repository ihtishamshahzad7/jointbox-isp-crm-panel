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
  /** Optional accordion sub-items. When present, the sidebar expands this tab
     inline and `render` receives the active sub-item id. */
  children?: Array<{ id: string; label: string }>;
  render: (activeSubId?: string) => React.ReactNode;
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

  // An id is valid if it matches a top-level tab OR any tab's accordion child.
  const isValidId = (id?: string | null) =>
    !!id && tabs.some((t) => t.id === id || t.children?.some((c) => c.id === id));
  // The top-level tab that owns an id (the id itself, or the parent of a child).
  const topTabOf = (id?: string) =>
    tabs.find((t) => t.id === id) ??
    tabs.find((t) => t.children?.some((c) => c.id === id)) ??
    tabs[0];

  const [active, setActive] = useState(() => {
    if (isValidId(urlTab)) return urlTab as string;
    return tabs[0]?.id;
  });
  // A deep link (?tab=nas) opens on that tab, so it must count as seen from the
  // start — otherwise only the first tab is ever rendered and the linked one
  // shows its title over an empty page.
  const [seen, setSeen] = useState<Set<string>>(() => new Set([topTabOf(active)?.id ?? active]));
  useEffect(() => {
    const top = topTabOf(active)?.id ?? active;
    if (top && !seen.has(top)) setSeen((p) => new Set(p).add(top));
  }, [active, seen]);

  useEffect(() => {
    if (urlTab || !storageKey) return;
    const saved = localStorage.getItem(`hub:${storageKey}`);
    if (isValidId(saved)) {
      setActive(saved as string);
      setSeen((p) => new Set(p).add(saved as string));
    }
  }, []);

  useEffect(() => {
    if (urlTab && urlTab !== active && isValidId(urlTab)) {
      setActive(urlTab);
      setSeen((p) => new Set(p).add(urlTab));
    }
  }, [urlTab]);

  useEffect(() => {
    const basePath = typeof window !== "undefined" ? window.location.pathname : "";
    publishSection({
      basePath,
      activeId: topTabOf(active)?.id,
      tabs: tabs.map((t) => ({ id: t.id, label: t.label })),
    });
  }, [tabs, active]);

  useEffect(() => {
    const basePath = typeof window !== "undefined" ? window.location.pathname : "";
    return () => clearSection(basePath);
  }, []);

  const select = (id: string) => {
    setActive(id);
    setSeen((p) => new Set(p).add(id));
    if (storageKey) localStorage.setItem(`hub:${storageKey}`, id);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", id);
    router.replace(url.pathname + url.search, { scroll: false });
  };

  // The top-level tab currently shown (owns the active id).
  const current = topTabOf(active);

  const selectByOffset = (offset: number) => {
    if (!tabs.length || !current) return;
    const index = tabs.findIndex((t) => t.id === current.id);
    const next = (index + offset + tabs.length) % tabs.length;
    const t = tabs[next];
    // Landing on a tab with children opens its first child.
    select(t.children?.[0]?.id ?? t.id);
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
          {tabs.map((t) => {
            const hasChildren = !!t.children?.length;
            const expanded = current?.id === t.id;      // active id is this tab or its child
            const topActive = active === t.id;           // the top tab itself is the active id
            return (
              <div key={t.id}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={expanded}
                  aria-expanded={hasChildren ? expanded : undefined}
                  tabIndex={expanded ? 0 : -1}
                  className={`hub-side-tab${topActive ? " on" : ""}${hasChildren && expanded ? " expanded" : ""}`}
                  onClick={() => { select(hasChildren ? (t.children![0].id) : t.id); setNavOpen(false); }}
                >
                  <span>{t.label}</span>
                  {hasChildren && <span className={`hub-caret${expanded ? " open" : ""}`}>▸</span>}
                </button>
                {hasChildren && expanded && (
                  <div className="hub-subnav">
                    {t.children!.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="tab"
                        aria-selected={active === c.id}
                        className={`hub-side-sub${active === c.id ? " on" : ""}`}
                        onClick={() => { select(c.id); setNavOpen(false); }}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Right content area. */}
        <div className="hub-body">
          {current?.hint && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>
              {current.hint}
            </div>
          )}
          {tabs.map((t) =>
            (seen.has(t.id) || current?.id === t.id) ? (
              <div key={t.id} style={{ display: t.id === current?.id ? "block" : "none" }}>
                {t.render(t.children ? active : undefined)}
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
        .hub-side-tab { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .hub-side-tab:hover { color: var(--text); background: var(--surface-2); }
        .hub-side-tab.on {
          background: var(--accent); color: #fff;
          box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 40%, transparent);
        }
        /* A parent tab that is expanded (a child is active) stays highlighted,
           but softer than the purple of the active child. */
        .hub-side-tab.expanded:not(.on) { color: var(--text); background: var(--surface-2); font-weight: 700; }
        .hub-caret { font-size: 10px; color: var(--muted); transition: transform .15s; }
        .hub-side-tab.expanded .hub-caret, .hub-caret.open { transform: rotate(90deg); color: inherit; }
        /* Accordion children — indented under their parent. */
        .hub-subnav { display: flex; flex-direction: column; gap: 2px; margin: 3px 0 4px 10px;
          padding-left: 8px; border-left: 2px solid var(--border); }
        .hub-side-sub {
          border: none; background: transparent; padding: 7px 11px; border-radius: 8px;
          font-size: 12px; font-weight: 600; color: var(--muted); cursor: pointer;
          font-family: inherit; white-space: nowrap; text-align: left; width: 100%;
          overflow: hidden; text-overflow: ellipsis; transition: background .12s, color .12s;
        }
        .hub-side-sub:hover { color: var(--text); background: var(--surface-2); }
        .hub-side-sub.on {
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
