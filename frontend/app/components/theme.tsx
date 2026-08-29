"use client";

import * as React from "react";
import { motion, useCalm, SPRING } from "./motion";

/**
 * THEME CONTROL — dark (default) / light / follow the system.
 *
 * THE HARD PART IS NOT THE TOGGLE, IT IS THE FLASH
 * A theme stored in localStorage cannot be read on the server, so a naive
 * implementation renders the default theme, hydrates, discovers the stored
 * preference, and repaints. On a dark-first app that is a full-brightness
 * white flash on every single page load — worse than having no toggle at all,
 * and genuinely unpleasant in a dark room, which is when someone picks a dark
 * theme in the first place.
 *
 * The fix is `THEME_BOOT_SCRIPT` below: a tiny synchronous script in <head>
 * that sets the attribute BEFORE the browser paints anything. It has to be
 * inline (an external file is another round-trip during which the page is
 * already painting) and it has to be blocking (`defer`/`async` both run too
 * late). Those two constraints are why this is a raw string rather than a
 * React component.
 */

export type ThemeChoice = "dark" | "light" | "system";
const STORAGE_KEY = "jb-theme";

/**
 * Runs before first paint. Deliberately tiny and dependency-free — it is
 * inlined into the HTML of every page, so every byte is paid for on every
 * load. Wrapped in try/catch because localStorage THROWS, not returns null,
 * in a browser configured to block site data; an unhandled throw here would
 * abort the script and leave the page unstyled.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{
var c=localStorage.getItem('${STORAGE_KEY}');
if(c==='light'||c==='dark'){document.documentElement.setAttribute('data-theme',c);}
else{document.documentElement.removeAttribute('data-theme');}
}catch(e){}})();`;

function apply(choice: ThemeChoice) {
  const el = document.documentElement;

  /**
   * The colour transition is switched on only for the duration of the change.
   *
   * Left permanently on, every hover and every row repaint would animate its
   * background over 320ms, so the whole UI would feel laggy and smeared. This
   * is the one moment a global colour transition is correct, so it is added,
   * used, and removed.
   */
  el.classList.add("ds-theming");

  if (choice === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", choice);

  try {
    if (choice === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* Private mode / blocked site data. The theme still applies for this
       session; it simply will not be remembered. That is a fair degradation
       and not worth an error message. */
  }

  window.setTimeout(() => el.classList.remove("ds-theming"), 340);
}

/**
 * localStorage is an external store, so it is read with the hook designed for
 * external stores rather than with useState + useEffect.
 *
 * The naive version (`useState` then `setState` inside an effect) works but is
 * wrong in two ways: it renders once with the wrong value and immediately
 * again with the right one — a cascading render on every mount of every page —
 * and React now flags it. `useSyncExternalStore` takes a separate server
 * snapshot, which is precisely the hydration-mismatch problem the effect was
 * there to dodge, and solves it without the extra render.
 */
const themeStore = {
  listeners: new Set<() => void>(),
  subscribe(fn: () => void) {
    themeStore.listeners.add(fn);
    // Another tab changing the theme should update this one.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) fn();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      themeStore.listeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  },
  emit() {
    themeStore.listeners.forEach((fn) => fn());
  },
  snapshot(): ThemeChoice {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch {
      return "system";
    }
  },
  // The server cannot know the preference, and must not guess: returning
  // "dark" here would make the server HTML disagree with a light-mode client.
  serverSnapshot(): ThemeChoice {
    return "system";
  },
};

export function useTheme() {
  const choice = React.useSyncExternalStore(
    themeStore.subscribe,
    themeStore.snapshot,
    themeStore.serverSnapshot,
  );

  const set = React.useCallback((next: ThemeChoice) => {
    apply(next);
    themeStore.emit();
  }, []);

  return { choice, set };
}

/**
 * The toggle itself.
 *
 * Three states, not two: "follow my system" is a real preference and squashing
 * it into a binary silently overrides an OS-level accessibility setting that
 * some people rely on.
 *
 * Built as a radiogroup rather than three buttons so a screen reader announces
 * it as one control with three options and arrow keys move between them —
 * which is what a segmented control actually is, semantically.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { choice, set } = useTheme();
  const calm = useCalm();

  const OPTIONS: Array<{ id: ThemeChoice; label: string; icon: React.ReactNode }> = [
    { id: "light", label: "Light", icon: <SunIcon /> },
    { id: "dark", label: "Dark", icon: <MoonIcon /> },
    { id: "system", label: "System", icon: <SystemIcon /> },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 3,
        borderRadius: "var(--r-pill)",
        background: "var(--glass-2)",
        border: "1px solid var(--glass-border)",
      }}
    >
      {OPTIONS.map((o) => {
        const active = choice === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            // The visible label is an icon, so the accessible name must be
            // supplied here or the control is unusable with a screen reader.
            aria-label={`${o.label} theme`}
            title={`${o.label} theme`}
            onClick={() => set(o.id)}
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: compact ? "5px 8px" : "6px 12px",
              border: "none",
              background: "transparent",
              color: active ? "var(--accent-ink)" : "var(--muted)",
              cursor: "pointer",
              borderRadius: "var(--r-pill)",
              fontSize: "var(--t-xs)",
              fontWeight: 650,
              lineHeight: 1,
            }}
          >
            {/* The moving pill is ONE element that travels between options,
                via layoutId — not three that cross-fade. That is what makes
                the selection feel like a physical thing being moved. */}
            {active && (
              <motion.span
                layoutId="ds-theme-pill"
                transition={calm ? { duration: 0 } : SPRING.snappy}
                aria-hidden
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: "var(--r-pill)",
                  background: "var(--accent)",
                  zIndex: 0,
                }}
              />
            )}
            <span style={{ position: "relative", zIndex: 1, display: "inline-flex" }}>{o.icon}</span>
            {!compact && <span style={{ position: "relative", zIndex: 1 }}>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* Icons are inline SVG rather than an icon-font import: three glyphs do not
   justify a network request, and `currentColor` makes them follow the theme
   for free. aria-hidden because the button already carries the label. */
const ico: React.SVGProps<SVGSVGElement> = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

function SunIcon() {
  return (
    <svg {...ico}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg {...ico}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
function SystemIcon() {
  return (
    <svg {...ico}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
