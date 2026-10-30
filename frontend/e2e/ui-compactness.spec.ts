import { test, expect } from "@playwright/test";

test("Network Center stays compact and IP Pool help works across screen sizes", async ({ page }) => {
  const token = "eyJhbGciOiJub25lIn0.eyJyb2xlIjoiQURNSU4ifQ.test";
  await page.addInitScript((value) => localStorage.setItem("token", value), token);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const fixtures: Record<string, unknown> = {
      "/auth/profile": { user: { id: 1, role: "ADMIN" } },
      "/auth/platform-hint": {},
      "/profile": { user: { id: 1, role: "ADMIN" } },
      "/telemetry/nas-health": { nas: [] },
      "/telemetry/ops-alerts": [],
      "/outages/status": [],
      "/ip-pools": [],
      "/ip-pools/stats": { total: 0, withNas: 0, packages: 0 },
      "/ip-pools/verify": { ok: true, brokenCount: 0, unreachableRouters: [], pools: [] },
      "/groups/options": [],
      "/users": [],
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtures[path] ?? {}),
    });
  });

  await page.goto("/network-center");
  await expect(page.getByRole("heading", { name: "Network Center" })).toBeVisible();
  for (const phrase of ["Network command center", "Fast workspace", "Live-first", "Responsive"]) {
    await expect(page.getByText(phrase, { exact: true })).toHaveCount(0);
  }

  const requiredTabs = [
    "Operations", "NOC / Uptime", "Live Network", "NAS / Routers", "FTTH / Fiber",
    "IP Pools", "Static IPs", "Prefix Register", "Outages & Power", "VPN Servers",
  ];

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);

    if (viewport.width <= 767) {
      const nav = page.getByRole("navigation", { name: "Section" });
      for (const label of requiredTabs) await expect(nav.getByRole("button", { name: label })).toBeVisible();
      await nav.getByRole("button", { name: "IP Pools" }).click();
    } else {
      const tabs = page.getByRole("tablist", { name: "Section navigation" });
      if (viewport.width <= 900) await page.locator(".hub-navtrigger").click();
      for (const label of requiredTabs) await expect(tabs.getByRole("tab", { name: label })).toBeVisible();
      await tabs.getByRole("tab", { name: "IP Pools" }).click();
    }

    await expect(page.getByText("One pool can be assigned to only one package.")).toBeVisible();
    const help = page.locator('button[aria-controls="ip-pool-help-body"]');
    await expect(help).toHaveAttribute("aria-expanded", "false");
    await help.click();
    await expect(help).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(/Create the pool with the exact same name/)).toBeVisible();
    await page.getByRole("button", { name: "Hide help" }).click();
    await expect(page.getByText(/Create the pool with the exact same name/)).toBeHidden();
  }
});
