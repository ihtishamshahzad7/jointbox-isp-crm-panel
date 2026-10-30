import { test, expect } from "@playwright/test";

test("Insights excludes Logs while the main Logs route remains available", async ({ page }) => {
  const now = new Date().toISOString();
  const report = {
    window: { sinceHours: 168, from: now, to: now, unit: "day" },
    totals: { ended: 0, openNow: 0, customers: 0, avgSessionSec: null, abnormal: 0, abnormalShare: 0, topCause: null },
    causes: [],
    categories: [],
    trend: { unit: "day", partial: false, buckets: [] },
    routers: [],
    customers: [],
    records: [],
    recordsTotal: 0,
    massDrops: [],
  };

  await page.addInitScript(() => localStorage.setItem("token", "insights-navigation-test-token"));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const fixtures: Record<string, unknown> = {
      "/profile": {},
      "/users": [],
      "/logs/network": { logs: [], total: 0 },
      "/logs/stats": { hourly: [] },
      "/logs/disconnects": report,
    };
    const fixture = fixtures[path];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture ?? []),
    });
  });

  await page.goto("/insights");
  if ((page.viewportSize()?.width ?? 1280) <= 640) {
    const sectionNav = page.getByRole("navigation", { name: "Section" });
    await expect(sectionNav.getByRole("button")).toHaveCount(3);
    for (const label of ["Segments", "Analytics", "Reports"]) {
      await expect(sectionNav.getByRole("button", { name: label })).toBeVisible();
    }
    await expect(sectionNav.getByRole("button", { name: "Logs" })).toHaveCount(0);
    await page.getByRole("button", { name: "Menu" }).click();
  } else {
    const insightsTabs = page.getByRole("tablist", { name: "Section navigation" });
    await expect(insightsTabs.getByRole("tab")).toHaveCount(3);
    for (const label of ["Segments", "Analytics", "Reports"]) {
      await expect(insightsTabs.getByRole("tab", { name: label })).toBeVisible();
    }
    await expect(insightsTabs.getByRole("tab", { name: "Logs" })).toHaveCount(0);
  }
  await expect(page.locator(".nav-section").getByRole("button", { name: "Logs" })).toHaveCount(1);

  await page.goto("/logs?logTab=overview&logFeature=disconnects");
  await expect(page).toHaveURL(/\/logs\?logTab=overview&logFeature=disconnects$/);
  await expect(page.getByRole("heading", { name: "Disconnect Analysis" })).toBeVisible();
});
