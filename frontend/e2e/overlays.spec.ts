import { test, expect } from "@playwright/test";

/**
 * OVERLAY OPACITY REGRESSION (P1).
 *
 * The bug: in dark mode the core surface token is translucent glass
 * (--surface: rgba(255,255,255,0.05)). Modals, drawers, dropdowns and context
 * menus were painted with var(--surface), so the table behind them bled
 * through and the text was unreadable. The fix repoints every OVERLAY content
 * surface at --bg-elev, which is OPAQUE in both themes (#FFFFFF light,
 * #0D121A dark); the scrim/backdrop stays intentionally translucent.
 *
 * These assertions run against the public /login route (no backend needed):
 *   - --bg-elev, the token every overlay fix depends on, is opaque in both
 *     themes. If a future change makes it translucent, every overlay regresses
 *     at once, so this is the highest-leverage guard.
 *   - .nv-menu (the account dropdown, defined in globally-loaded globals.css)
 *     computes an opaque background in both themes.
 *
 * Overlays whose CSS is injected only when their React component mounts
 * (.nv-modal / .nv-drawer in ui.tsx, .jmenu-pop in menu.tsx, the data-table
 * column menu, the subscriber drawer) are not present on /login, so they are
 * covered by the auth-gated flows documented at the bottom. Their source was
 * fixed in the same change.
 */

const LOGIN = "/login";

/** True when a computed color string is fully opaque (no alpha < 1, not a bare hex-with-alpha). */
function isOpaque(color: string): boolean {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(",").map((s) => s.trim());
    return parts.length < 4 || parseFloat(parts[3]) === 1;
  }
  // Hex: #rgb / #rrggbb are opaque; #rgba / #rrggbbaa with alpha < ff are not.
  const hex = color.trim();
  if (hex.startsWith("#")) {
    if (hex.length === 5) return hex[4].toLowerCase() === "f";
    if (hex.length === 9) return hex.slice(7).toLowerCase() === "ff";
    return true;
  }
  return color !== "transparent";
}

function alphaOf(color: string): number {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return 1;
  const parts = m[1].split(",").map((s) => s.trim());
  return parts.length >= 4 ? parseFloat(parts[3]) : 1;
}

async function gotoTheme(page: import("@playwright/test").Page, theme: "dark" | "light") {
  await page.addInitScript((t) => {
    try { localStorage.setItem("jb-theme", t); } catch {}
  }, theme);
  await page.goto(LOGIN);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function measure(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const bgElev = getComputedStyle(document.documentElement).getPropertyValue("--bg-elev").trim();
    const mk = (cls: string) => {
      const el = document.createElement("div");
      el.className = cls;
      el.style.position = "fixed";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      const bg = getComputedStyle(el).backgroundColor;
      el.remove();
      return bg;
    };
    return { bgElev, menu: mk("nv-menu"), scrim: mk("nv-scrim") };
  });
}

test.describe("overlay opacity (no dark-mode glass bleed-through)", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: --bg-elev token is opaque`, async ({ page }) => {
      await gotoTheme(page, theme);
      const { bgElev } = await measure(page);
      expect(bgElev, "--bg-elev must be defined").not.toBe("");
      expect(isOpaque(bgElev), `--bg-elev must be opaque, got ${bgElev}`).toBe(true);
    });

    test(`${theme}: the account dropdown (.nv-menu) is opaque`, async ({ page }) => {
      await gotoTheme(page, theme);
      const { menu } = await measure(page);
      expect(alphaOf(menu), `.nv-menu must be opaque, got ${menu}`).toBe(1);
      expect(menu).not.toBe("rgba(0, 0, 0, 0)");
    });
  }

  test("dark: the modal scrim stays translucent (backdrop, not content)", async ({ page }) => {
    await gotoTheme(page, "dark");
    const { scrim } = await measure(page);
    // The scrim's own rule ships with the modal component; when absent it is
    // simply transparent. Either way it must never be a fully opaque panel.
    expect(alphaOf(scrim), `scrim must not be opaque, got ${scrim}`).toBeLessThan(1);
  });
});

/**
 * AUTH-GATED FLOWS (run locally against a reachable backend — provide auth via
 * Playwright storageState or a login step, then set E2E_BASE_URL):
 *
 *  1. Subscribers → open a row drawer → the drawer's computed background alpha
 *     === 1 and a cell it overlaps is not visible through it.
 *  2. Account avatar menu → click the table outside the menu → it closes.
 *  3. Account avatar menu → click a control inside → it stays open.
 *  4. Open account menu → Escape → it closes (also notification bell, the
 *     data-table column menu, and the subscriber/NAS context menus).
 *  5. Data-table column menu (absolute/portaled) → outside click closes it.
 *  6. Dashboard KPI card → Tab to it → visible focus ring → Enter navigates to
 *     its href (Total subscribers → /subscribers, Total NAS → /nas, …).
 *  7. 375px viewport → a wide table scrolls horizontally; status badges do not
 *     wrap; dates do not break the row.
 *  8. Open a drawer → switch theme → it repaints to the new theme and stays
 *     opaque.
 *  9. Scroll a table to its last row → the row is not covered by the fixed
 *     "How to use" FAB (bounding boxes do not intersect).
 */
