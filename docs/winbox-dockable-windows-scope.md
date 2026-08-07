# WinBox Dockable / Floating Tab Windows — Scoping Document

**Status:** proposal for review · **Author:** engineering · **Date:** 2026‑08

This document scopes the one remaining item from the WinBox redesign: turning the
panel's single‑page navigation into a **multi‑window workspace** like WinBox 4.x —
where Subscribers, NAS, Logs, etc. open as movable, resizable windows that can sit
side‑by‑side, be minimized to a taskbar, and be arranged into saved layouts.

Everything else from the WinBox prompt is already shipped (theme, compact tables,
flags, right‑click menus, status bar, Live refresh, toolbar strip, Log console,
command palette). This is the big, structural piece and is deliberately kept
separate because it changes *how pages mount*, not just how they look.

---

## 1. What "dockable windows" actually means here

Today each route (`/subscribers`, `/nas`, …) is a full‑page Next.js view. WinBox
instead keeps a **desktop** with many child windows open at once. To match it we
need a client‑side **window manager** layered over the app shell:

- Open a page as a **floating window** (title bar, body, close/minimize/maximize).
- **Drag** by the title bar; **resize** from edges/corners.
- **Z‑order**: clicking a window brings it to front.
- **Minimize** to a bottom taskbar; restore by clicking it.
- **Maximize/restore** (double‑click title bar).
- **Multiple windows** of different pages open simultaneously.
- **Workspaces**: save/restore a named arrangement of open windows per user.

## 2. Why it's materially harder than what we've built

- **Mounting model changes.** Pages currently assume they own the whole viewport
  and read the URL. In a window they must render inside an arbitrary box, and
  several can be alive at once — so global singletons (scroll position, `document`
  listeners, one‑at‑a‑time modals, `useSearchParams`) can collide.
- **Routing.** WinBox has no URL per window. We either (a) keep the URL for the
  "focused" window only, or (b) move to a windows‑in‑state model and give up
  per‑page deep links. Both have trade‑offs for bookmarks and refresh behavior.
- **State & data.** Ten open windows = ten live data subscriptions and polling
  loops. We need shared caches and to pause background refresh for minimized
  windows, or the browser will crawl at 300k‑subscriber scale.
- **Focus, keyboard, and accessibility.** Tab order, Esc, and shortcuts must be
  scoped to the focused window, not global.
- **Mobile.** Floating windows don't work on phones; mobile must fall back to the
  current single‑view stack. That's a second layout path to maintain.

## 3. Proposed architecture

```
<WindowManagerProvider>            ← holds open windows[] + focus + z-order in context
  <Desktop>                        ← the workspace surface
    <WBWindow id title>            ← chrome: title bar, drag, resize, min/max/close
      <PageHost route="/nas" />    ← renders the existing page component in a box
    </WBWindow> …
  </Desktop>
  <Taskbar>                        ← minimized windows + "open window" launcher
</WindowManagerProvider>
```

- **WindowManagerProvider** — React context: `windows`, `open(route)`, `close(id)`,
  `focus(id)`, `move/resize/min/max`, `saveWorkspace/loadWorkspace`. State persisted
  to `localStorage` per user (fixed‑position persistence, never in the URL).
- **WBWindow** — pure chrome: title bar, drag (pointer events), 8‑way resize,
  min/max/close, focus‑to‑front. No app logic.
- **PageHost** — renders an existing page component by key. Requires each page to be
  refactored from "route file" into a **self‑contained component** that takes props
  instead of reading the URL directly.
- **Desktop + Taskbar** — the surface and the minimized‑window strip.

Deep‑link compatibility: keep the current routes working (open that page as a single
maximized window on direct navigation), so bookmarks and the command palette are
unaffected.

## 4. Phased delivery (each phase independently shippable)

1. **Window shell, one window (behind a flag).** Build `WBWindow` + provider;
   open a single page in a floating, draggable, resizable window. No persistence.
   *Low risk — nothing else changes.*
2. **Multiple windows + taskbar + z‑order + minimize/maximize.**
3. **Page refactor to `PageHost`.** Convert Subscribers, NAS, Packages, IP Pools,
   Logs to prop‑driven components that render in a box. *Highest‑risk phase — this
   is where regressions hide; do it one page at a time with the old route intact.*
4. **Data hygiene.** Shared query cache; pause polling for minimized windows.
5. **Workspaces.** Save/restore named layouts per user.
6. **Mobile fallback** + focus/keyboard scoping + a11y pass.

## 5. Effort & risk

- **Effort:** roughly **3–5 focused days** for phases 1–3 (the visible win), plus
  **2–3 days** for 4–6 to make it production‑solid at scale.
- **Risk:** medium‑high, concentrated in phase 3 (page refactor). Mitigated by
  keeping every existing route working and converting one page at a time behind a
  feature flag, so we can ship or roll back per page.
- **Blast radius if it goes wrong:** the whole shell. This is why it's gated behind
  a flag and not merged into the default layout until each phase is verified.

## 6. Recommendation

Ship the current WinBox redesign as the default now (it's complete and stable).
Treat dockable windows as an **opt‑in "Workspace mode"** built in the phases above,
starting with phase 1 behind a feature flag. That gives you real WinBox multi‑window
behavior for power users **without** destabilizing the single‑view experience the
rest of your operators rely on.

**Decision needed:** proceed to phase 1 (window shell behind a flag), or hold and
keep the single‑view WinBox theme as the finished state?
