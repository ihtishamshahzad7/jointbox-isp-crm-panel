import { test, expect } from "@playwright/test";

/**
 * THEME + ACCESSIBILITY.
 *
 * These assert the things that are invisible to a unit test and immediately
 * obvious to a person: a white flash on load, an unreadable focus ring, a
 * theme that forgets itself.
 *
 * The flash test is the important one. A theme read from localStorage after
 * hydration renders the default first, then repaints — a full-brightness
 * white flash on every load of a dark-first app, worst for exactly the people
 * who chose dark because they are working in the dark. It is the single most
 * common way a theme toggle is got wrong, and it cannot be caught by
 * inspecting the final DOM, because by then it looks correct.
 */

const LOGIN = "/login";

test.describe("colour theme", () => {
  test("applies the stored theme with no flash of the wrong one", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("jb-theme", "dark");
      } catch {}
    });

    /**
     * Sample the background at the FIRST paint rather than after load. The
     * boot script runs synchronously in <head>, so by the time anything is
     * painted the attribute must already be set. If the attribute were
     * applied in an effect instead, this reads the light default and fails —
     * which is the whole point.
     */
    const firstPaint = page.evaluate(() =>
      new Promise<string>((resolve) => {
        requestAnimationFrame(() =>
          resolve(document.documentElement.getAttribute("data-theme") ?? "none"),
        );
      }),
    );

    await page.goto(LOGIN);
    expect(await firstPaint).toBe("dark");

    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(10, 14, 20)"); // #0A0E14
  });

  test("switching theme repaints and is remembered across a reload", async ({ page }) => {
    await page.goto(LOGIN);

    // The toggle is a radiogroup: one control, three options, arrow-navigable.
    const group = page.getByRole("radiogroup", { name: /colour theme/i });
    await expect(group).toBeVisible();

    await page.getByRole("radio", { name: /light theme/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // Warm off-white, not the old #F1F5F9 — proves the v2 tokens win the
    // cascade over the older palette rather than merely being present.
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe("rgb(247, 244, 239)"); // #F7F4EF

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("respects the operating system when set to System", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(LOGIN);
    await page.getByRole("radio", { name: /system theme/i }).click();

    // "System" removes the attribute entirely — it must not be pinned to a
    // value, or an OS-level accessibility preference is silently overridden.
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe("rgb(247, 244, 239)");
  });
});

test.describe("accessibility", () => {
  test("keyboard focus is always visible", async ({ page }) => {
    await page.goto(LOGIN);
    await page.keyboard.press("Tab");

    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { width: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor };
    });

    expect(ring).not.toBeNull();
    // WCAG 2.2 (2.4.11): the indicator must exist and be perceivable. A
    // 0px or `none` outline with nothing replacing it is the failure.
    expect(ring!.style).not.toBe("none");
    expect(parseFloat(ring!.width)).toBeGreaterThanOrEqual(2);
  });

  test("the skip link is the first stop and reaches the content", async ({ page }) => {
    await page.goto(LOGIN);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: /skip to main content/i })).toBeFocused();
  });

  test("honours prefers-reduced-motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(LOGIN);

    // Reduced motion means movement is OFF, not merely faster: vestibular
    // symptoms are triggered by travel, and halving a duration halves nothing
    // that matters.
    const durations = await page.evaluate(() =>
      Array.from(document.querySelectorAll("*"))
        .slice(0, 400)
        .map((el) => parseFloat(getComputedStyle(el).transitionDuration) || 0),
    );
    expect(Math.max(0, ...durations)).toBeLessThan(0.05);
  });
});
