import { test, expect } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

const isLogResponse = (url: string, endpoint: string) => {
  const parsed = new URL(url);
  return parsed.pathname.endsWith(`/logs/${endpoint}`);
};

test.describe("Logs workspace tabs", () => {
  test("opens Overall Stats from the app navigation and keeps all cause cards usable on mobile", async ({ page }) => {
    const now = new Date().toISOString();
    const causeNames = [
      "User Request", "Lost Carrier", "Lost Service", "Idle Timeout", "Session Timeout",
      "Admin Reset", "Admin Reboot", "Port Error", "NAS Error", "NAS Request", "NAS Reboot",
      "Port Unneeded", "Port Preempted", "Port Suspended", "Service Unavailable", "Callback",
      "User Error", "Host Request",
    ];
    const causes = causeNames.map((label, index) => ({
      code: index + 1,
      key: label.replaceAll(" ", "-"),
      label,
      description: `Definition for ${label}.`,
      meaning: `Meaning for ${label}.`,
      action: `Check ${label}.`,
      category: "customer",
      severity: "normal",
      standard: true,
      count: index + 1,
      share: (index + 1) / 171,
      customers: index + 1,
      avgSessionSec: 60,
      lastAt: now,
    }));
    const requestedUrls: string[] = [];

    await page.addInitScript(() => localStorage.setItem("token", "logs-disconnects-test-token"));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      requestedUrls.push(url.toString());
      const path = url.pathname.replace(/^\/api/, "");
      const report = {
        window: { sinceHours: 168, from: now, to: now, unit: "day" },
        totals: { ended: 171, openNow: 0, customers: 171, avgSessionSec: 60, abnormal: 0, abnormalShare: 0, topCause: null },
        causes,
        categories: [],
        trend: { unit: "day", partial: false, buckets: [] },
        routers: [],
        customers: [],
        records: [],
        recordsTotal: 0,
        massDrops: [],
      };
      const fixtures: Record<string, unknown> = {
        "/profile": {},
        "/users": [],
        "/logs/network": { logs: [], total: 0 },
        "/logs/stats": { hourly: [] },
        "/logs/disconnects": report,
      };
      const fixture = fixtures[path];
      await route.fulfill({
        status: fixture === undefined ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify(fixture ?? { message: "No test fixture for this API path." }),
      });
    });

    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await expect(page).toHaveURL(/\/logs(?:\?.*)?$/);
    const panel = page.getByRole("tabpanel");
    const overallTab = page.getByRole("tab", { name: "Overall Stats" });
    await expect(overallTab).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("heading", { name: "Disconnect Analysis" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "All 18 termination causes" })).toBeVisible();

    const causeSection = panel.getByRole("heading", { name: "All 18 termination causes" }).locator("xpath=../..");
    const cards = causeSection.getByRole("button");
    await expect(cards).toHaveCount(18);
    const cardText = await cards.allTextContents();
    for (const [index, label] of causeNames.entries()) {
      expect(cardText[index]).toContain(label);
      expect(cardText[index]).toContain(String(index + 1));
    }

    const filteredRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname.endsWith("/logs/disconnects") && url.searchParams.get("cause") === "User-Request";
    });
    await cards.first().click();
    await filteredRequest;
    await expect(cards.first()).toHaveAttribute("aria-pressed", "true");

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
      { width: 768, height: 900 },
      { width: 430, height: 844 },
      { width: 375, height: 812 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )).toBe(true);
      const box = await cards.first().boundingBox();
      expect(box?.width).toBeLessThanOrEqual(viewport.width);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      if (viewport.width <= 430) {
        const bottomNav = page.getByRole("navigation", { name: "Section" });
        await expect(bottomNav.getByRole("button")).toHaveCount(5);
        for (const label of ["Overall Stats", "Connections", "Sessions", "AAA", "Audit Trail"]) {
          await expect(bottomNav.getByRole("button", { name: label })).toBeVisible();
        }
      }
    }
    await page.goto("/logs/session/disconnect-analysis");
    await expect(page).toHaveURL(/\/logs\?logTab=overview&logFeature=disconnects$/);
    await expect(page.getByRole("tab", { name: "Overall Stats" })).toHaveAttribute("aria-selected", "true");
    expect(requestedUrls.some((url) => new URL(url).pathname.endsWith("/logs/disconnects"))).toBe(true);
  });

  test("keeps section URLs in sync with refresh and browser history", async ({ page }) => {
    const now = new Date().toISOString();
    const fixtures: Record<string, unknown> = {
      "/logs/disconnects": {
        window: { sinceHours: 24, from: now, to: now, unit: "hour" },
        totals: { ended: 0, openNow: 0, customers: 0, avgSessionSec: null, abnormal: 0, abnormalShare: 0, topCause: null },
        causes: [], categories: [], trend: { unit: "hour", partial: false, buckets: [] },
        routers: [], customers: [], records: [], recordsTotal: 0, massDrops: [],
      },
      "/logs/network": { logs: [], total: 0 },
      "/logs/radius-sessions": { items: [] },
      "/logs/sessions": [],
    };

    await page.addInitScript(() => localStorage.setItem("token", "logs-history-test-token"));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      const fixture = fixtures[path] ?? { logs: [], total: 0, items: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
    });

    await page.goto("/logs");
    const overallTab = page.getByRole("tab", { name: "Overall Stats" });
    const connectionsTab = page.getByRole("tab", { name: "Connections" });
    const sessionsTab = page.getByRole("tab", { name: "Sessions" });
    await expect(overallTab).toHaveAttribute("aria-selected", "true");
    await connectionsTab.click();
    await expect(page).toHaveURL(/logTab=connections&logFeature=console/);
    await sessionsTab.click();
    await expect(page).toHaveURL(/logTab=sessions&logFeature=live/);

    await page.goBack();
    await expect(connectionsTab).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(sessionsTab).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await expect(sessionsTab).toHaveAttribute("aria-selected", "true");
  });

  test("switches main Logs sections and loads each category's data source", async ({ page }) => {
    test.setTimeout(90_000);
    const requestedPaths: string[] = [];
    const pageErrors: Error[] = [];
    const now = new Date().toISOString();
    const dataPaths = [
      "/logs/network",
      "/logs/radius-sessions",
      "/logs/radius-auth",
      "/logs/activity",
      "/logs/disconnects",
    ];
    const heldPaths = new Set(dataPaths);
    const gates = new Map<string, Promise<void>>();
    const releaseGates = new Map<string, () => void>();
    for (const path of dataPaths) {
      let release!: () => void;
      gates.set(path, new Promise<void>((resolve) => { release = resolve; }));
      releaseGates.set(path, release);
    }
    const fixtures: Record<string, unknown> = {
      "/profile": {},
      "/users": [],
      "/logs/network": { logs: [], total: 0 },
      "/logs/stats": { hourly: [] },
      "/logs/system": { logs: [] },
      "/logs/sessions": [],
      "/logs/radius-sessions": { items: [] },
      "/logs/failed-activations": [],
      "/logs/activity": { logs: [], total: 0 },
      "/logs/radius-auth": { logs: [], total: 0 },
      "/logs/login": { logs: [], total: 0 },
      "/logs/radius/diagnostics": {
        summary: { ok: 0, warnings: 0, failures: 0 },
        checks: [],
        staleSessions: [],
      },
      "/logs/disconnects": {
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
      },
      "/logs/failed-logins": {
        totals: { attempts: 0, bursts: 0, customers: 0, capped: false },
        reasons: [],
        items: [],
        total: 0,
      },
    };

    await page.addInitScript(() => localStorage.setItem("token", "logs-tabs-test-token"));
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      requestedPaths.push(path);
      if (heldPaths.has(path)) await gates.get(path);
      const fixture = fixtures[path];
      await route.fulfill({
        status: fixture === undefined ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify(fixture ?? { message: "No test fixture for this API path." }),
      });
    });

    await page.goto("/logs");
    const panel = page.getByRole("tabpanel");
    await expect(page.getByRole("tablist", { name: "Logs sections" }).getByRole("tab")).toHaveCount(5);
    await expect.poll(() => requestedPaths.includes("/logs/disconnects")).toBe(true);

    const views = [
      { label: "Overall Stats", heading: "Disconnect Analysis", endpoint: "/logs/disconnects", empty: "All 18 termination causes" },
      { label: "Connections", heading: "Connection events", endpoint: "/logs/network", empty: "No records." },
      { label: "Sessions", heading: "Live PPPoE sessions", endpoint: "/logs/radius-sessions", empty: "No records." },
      { label: "AAA", heading: "Subscriber RADIUS authentication", endpoint: "/logs/radius-auth", empty: "No records." },
      { label: "Audit Trail", heading: "User activity", endpoint: "/logs/activity", empty: "No records." },
    ];

    for (const view of views) {
      const tab = page.getByRole("tab", { name: view.label });
      await expect(tab).toBeVisible();
      const box = await tab.boundingBox();
      if (!box) throw new Error(`The ${view.label} tab has no clickable bounds.`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(panel.getByRole("heading", { name: view.heading })).toBeVisible();
      heldPaths.delete(view.endpoint);
      releaseGates.get(view.endpoint)?.();
      await expect(panel).toContainText(view.empty);
      await expect.poll(() => requestedPaths.includes(view.endpoint)).toBe(true);

      if (view.label === "Connections") {
        const subtabs = page.getByRole("navigation", { name: "Connections pages" });
        await expect(subtabs.getByRole("button")).toHaveCount(4);
        for (const label of ["Connection Events", "NAS & Network", "Failed Connections", "Connection Diagnostics"]) {
          await expect(subtabs.getByRole("button", { name: label })).toBeVisible();
        }
        await subtabs.getByRole("button", { name: "NAS & Network" }).click();
        await expect(subtabs.getByRole("button", { name: "NAS & Network" })).toHaveAttribute("aria-current", "page");
        await subtabs.getByRole("button", { name: "Connection Events" }).click();
      }
      if (view.label === "Sessions") {
        const subtabs = page.getByRole("navigation", { name: "Sessions pages" });
        await expect(subtabs.getByRole("button")).toHaveCount(4);
        for (const label of ["Active Sessions", "Accounting Logs", "Session History", "Disconnect Analysis"]) {
          await expect(subtabs.getByRole("button", { name: label })).toBeVisible();
        }
        await subtabs.getByRole("button", { name: "Disconnect Analysis" }).click();
        await expect(subtabs.getByRole("button", { name: "Disconnect Analysis" })).toHaveAttribute("aria-current", "page");
        await subtabs.getByRole("button", { name: "Active Sessions" }).click();
      }
      if (view.label === "AAA") {
        const subtabs = page.getByRole("navigation", { name: "AAA pages" });
        await expect(subtabs.getByRole("button")).toHaveCount(3);
        for (const label of ["Authentication Records", "AAA / RADIUS Server", "Disconnect Analysis"]) {
          await expect(subtabs.getByRole("button", { name: label })).toBeVisible();
        }
        await subtabs.getByRole("button", { name: "AAA / RADIUS Server" }).click();
        await expect(panel.getByRole("heading", { name: "RADIUS diagnostics" })).toBeVisible();
        await subtabs.getByRole("button", { name: "Authentication Records" }).click();
      }
      if (view.label === "Audit Trail") {
        const subtabs = page.getByRole("navigation", { name: "Audit Trail pages" });
        await expect(subtabs.getByRole("button")).toHaveCount(4);
        for (const label of ["User Activity", "CRUD & Record Changes", "Security & Access", "System & Configuration"]) {
          await expect(subtabs.getByRole("button", { name: label })).toBeVisible();
        }
      }
    }

    expect(pageErrors).toEqual([]);
  });

  test("renders only the selected category's records", async ({ page }) => {
    const now = new Date().toISOString();
    const requestedPaths: string[] = [];
    const fixtures: Record<string, unknown> = {
      "/profile": {},
      "/users": [],
      "/logs/network": { logs: [{
        id: "network-connection",
        loggedAt: now,
        username: "connection-only-subscriber",
        eventType: "PPP_SESSION_START",
        severity: "INFO",
        message: "Connection-only event",
      }], total: 1 },
      "/logs/stats": { hourly: [], totals: { login: 0, activity: 0, network: 1, system: 0 } },
      "/logs/failed-activations": [],
      "/logs/sessions": [],
      "/logs/radius-sessions": {
        items: [{
          id: "session-record",
          username: "session-only-subscriber",
          sessionId: "session-only-id",
          sessionState: "unknown",
          start: now,
        }],
      },
      "/logs/radius-auth": {
        logs: [{
          id: "aaa-record",
          username: "aaa-only-subscriber",
          authdate: now,
          result: "Reject",
          reason: "Access-Reject",
        }],
        total: 1,
      },
      "/logs/login": { logs: [], total: 0 },
      "/logs/radius/diagnostics": {
        summary: { ok: 0, warnings: 0, failures: 0 },
        checks: [],
        staleSessions: [],
      },
      "/logs/activity": {
        logs: [{
          id: "audit-record",
          action: "AUDIT_ONLY_ACTION",
          entity: "Subscriber",
          entityId: 7,
          createdAt: now,
        }],
        total: 1,
      },
      "/logs/system": { logs: [], total: 0 },
      "/logs/disconnects": {
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
      },
      "/logs/failed-logins": {
        totals: { attempts: 0, bursts: 0, customers: 0, capped: false },
        reasons: [],
        items: [],
        total: 0,
      },
    };

    await page.addInitScript(() => localStorage.setItem("token", "logs-tab-isolation-test-token"));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      requestedPaths.push(path);
      const fixture = fixtures[path];
      await route.fulfill({
        status: fixture === undefined ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify(fixture ?? { message: "No test fixture for this API path." }),
      });
    });

    await page.goto("/logs");
    const panel = page.getByRole("tabpanel");
    await expect.poll(() => requestedPaths.includes("/logs/disconnects")).toBe(true);
    await expect(panel.getByRole("heading", { name: "All 18 termination causes" })).toBeVisible();
    expect(requestedPaths).not.toContain("/logs/network");
    expect(requestedPaths).not.toContain("/logs/radius-sessions");
    expect(requestedPaths).not.toContain("/logs/radius-auth");
    expect(requestedPaths).not.toContain("/logs/activity");

    await page.getByRole("tab", { name: "Connections" }).click();
    await expect.poll(() => requestedPaths.includes("/logs/network")).toBe(true);
    await expect(panel).toContainText("connection-only-subscriber");
    await expect(panel).not.toContainText("session-only-subscriber");
    await expect(panel).not.toContainText("aaa-only-subscriber");
    await expect(panel).not.toContainText("AUDIT_ONLY_ACTION");

    await page.getByRole("tab", { name: "Sessions" }).click();
    await expect(panel).toContainText("session-only-subscriber");
    await expect(panel).not.toContainText("connection-only-subscriber");
    await expect(panel).not.toContainText("aaa-only-subscriber");
    await expect(panel).not.toContainText("AUDIT_ONLY_ACTION");

    await page.getByRole("tab", { name: "AAA" }).click();
    await expect(panel.getByRole("heading", { name: "Subscriber RADIUS authentication" })).toBeVisible();
    await expect(panel).toContainText("aaa-only-subscriber");
    await expect(panel).not.toContainText("session-only-subscriber");
    await expect(panel).not.toContainText("AUDIT_ONLY_ACTION");

    await page.getByRole("tab", { name: "Audit Trail" }).click();
    await expect(panel).toContainText("AUDIT_ONLY_ACTION");
    await expect(panel).not.toContainText("aaa-only-subscriber");
    await expect(panel).not.toContainText("session-only-subscriber");

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )).toBe(true);
      for (const tab of [
        "Overall Stats",
        "Connections",
        "Sessions",
        "AAA",
        "Audit Trail",
      ]) {
        await page.getByRole("tab", { name: tab }).click();
        await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
      }
      if (viewport.width <= 390) {
        const bottomNav = page.getByRole("navigation", { name: "Section" });
        for (const tab of ["Overall Stats", "Connections", "Sessions", "AAA", "Audit Trail"]) {
          await bottomNav.getByRole("button", { name: tab }).click();
          await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
        }
      }
    }
  });

  test("applies category filters, shared search, refresh, pagination, and event details", async ({ page }) => {
    const now = new Date().toISOString();
    const requestedUrls: string[] = [];
    const auditRows = Array.from({ length: 51 }, (_, index) => ({
      id: `audit-${index + 1}`,
      action: index === 50 ? "AUDIT_LAST_PAGE_ACTION" : index === 0 ? "AUDIT_FIRST_ACTION" : `AUDIT_ACTION_${index + 1}`,
      entity: "Subscriber",
      entityId: index + 1,
      details: `recorded audit detail ${index + 1}`,
      createdAt: now,
      user: { id: 8, name: "Test Actor", role: "ADMIN" },
      ipAddress: "192.0.2.10",
      traceId: `trace-${index + 1}`,
    }));
    const fixtures: Record<string, unknown> = {
      "/profile": {},
      "/users": [],
      "/logs/network": { logs: [{
        id: "network-detail",
        loggedAt: now,
        username: "details-subscriber",
        eventType: "PPP_SESSION_START",
        severity: "INFO",
        message: "Selected connection detail",
        nas: { nasname: "test-router", nasIp: "192.0.2.1" },
        nasIp: "192.0.2.1",
        callerId: "00:11:22:33:44:55",
        sessionId: "session-detail",
      }], total: 1 },
      "/logs/stats": { hourly: [], totals: { login: 0, activity: 0, network: 1, system: 0 } },
      "/logs/failed-activations": [],
      "/logs/sessions": [],
      "/logs/radius-sessions": { items: [] },
      "/logs/radius-auth": { logs: [], total: 0 },
      "/logs/login": { logs: [], total: 0 },
      "/logs/radius/diagnostics": {
        summary: { ok: 0, warnings: 0, failures: 0 },
        checks: [],
        staleSessions: [],
      },
      "/logs/activity": { logs: auditRows, total: auditRows.length },
      "/logs/system": { logs: [], total: 0 },
      "/logs/disconnects": {
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
      },
      "/logs/failed-logins": {
        totals: { attempts: 0, bursts: 0, customers: 0, capped: false },
        reasons: [],
        items: [],
        total: 0,
      },
    };

    await page.addInitScript(() => localStorage.setItem("token", "logs-controls-test-token"));
    await page.route("**/api/**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const path = requestUrl.pathname.replace(/^\/api/, "");
      requestedUrls.push(requestUrl.toString());
      let fixture = fixtures[path];
      if (path === "/logs/activity") {
        const offset = Number(requestUrl.searchParams.get("offset") || 0);
        const limit = Number(requestUrl.searchParams.get("limit") || 50);
        fixture = { logs: auditRows.slice(offset, offset + limit), total: auditRows.length };
      }
      await route.fulfill({
        status: fixture === undefined ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify(fixture ?? { message: "No test fixture for this API path." }),
      });
    });

    await page.goto("/logs");
    const panel = page.getByRole("tabpanel");
    await page.getByRole("tab", { name: "Connections" }).click();
    await expect(panel).toContainText("details-subscriber");
    await panel.getByText("details-subscriber").click();
    await expect(panel).toContainText("Selected connection detail");
    await expect(panel).toContainText("test-router");
    await expect(panel).toContainText("00:11:22:33:44:55");
    await page.getByRole("button", { name: "Close event details" }).click();

    await page.getByRole("button", { name: /filters/i }).click();
    await page.getByRole("button", { name: "ERROR", exact: true }).click();
    await expect.poll(() => requestedUrls.some((url) => {
      const parsed = new URL(url);
      return parsed.pathname.endsWith("/logs/network") && parsed.searchParams.get("severity") === "ERROR";
    })).toBe(true);

    await page.getByRole("tab", { name: "Sessions" }).click();
    await page.getByLabel("Time range").selectOption("6h");
    await expect.poll(() => requestedUrls.some((url) => {
      const parsed = new URL(url);
      return parsed.pathname.endsWith("/logs/radius-sessions") && parsed.searchParams.get("sinceHours") === "6";
    })).toBe(true);

    await page.getByRole("tab", { name: "Audit Trail" }).click();
    await expect(panel).toContainText("AUDIT_FIRST_ACTION");
    const search = page.getByRole("textbox", { name: "Search logs" });
    await search.fill("AUDIT_QUERY");
    await expect.poll(() => requestedUrls.some((url) => {
      const parsed = new URL(url);
      return parsed.pathname.endsWith("/logs/activity") && parsed.searchParams.get("q") === "AUDIT_QUERY";
    })).toBe(true);

    const priorAuditRequests = requestedUrls.filter((url) => new URL(url).pathname.endsWith("/logs/activity")).length;
    await page.getByRole("button", { name: /refresh/i }).click();
    await expect.poll(() => requestedUrls.filter((url) =>
      new URL(url).pathname.endsWith("/logs/activity"),
    ).length).toBeGreaterThan(priorAuditRequests);

    await page.getByRole("button", { name: "2", exact: true }).click();
    await expect(panel).toContainText("AUDIT_LAST_PAGE_ACTION");
    await expect.poll(() => requestedUrls.some((url) => {
      const parsed = new URL(url);
      return parsed.pathname.endsWith("/logs/activity") && parsed.searchParams.get("offset") === "50";
    })).toBe(true);
    await panel.getByText("AUDIT_LAST_PAGE_ACTION").click();
    if (await panel.getByLabel("Selected event details").isVisible()) {
      await expect(panel.getByLabel("Selected event details")).toBeVisible();
    } else {
      await expect(page.getByRole("dialog", { name: "Record details" })).toBeVisible();
    }
    await expect(panel).toContainText("recorded audit detail 51");
  });

  test("shows API failures in each Logs category", async ({ page }) => {
    const pageErrors: Error[] = [];
    const failingPaths = new Set([
      "/logs/network",
      "/logs/radius-sessions",
      "/logs/radius-auth",
      "/logs/activity",
      "/logs/disconnects",
    ]);
    const fixtures: Record<string, unknown> = {
      "/profile": {},
      "/users": [],
      "/logs/stats": { hourly: [] },
      "/logs/system": { logs: [] },
      "/logs/sessions": [],
      "/logs/failed-activations": [],
      "/logs/login": { logs: [], total: 0 },
      "/logs/radius/diagnostics": {
        summary: { ok: 0, warnings: 0, failures: 0 },
        checks: [],
        staleSessions: [],
      },
    };

    await page.addInitScript(() => localStorage.setItem("token", "logs-tabs-error-test-token"));
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      const failed = failingPaths.has(path);
      const fixture = fixtures[path];
      const body = failed && path === "/logs/disconnects"
        ? {}
        : fixture ?? { message: "Unavailable in this test." };
      await route.fulfill({
        status: failed ? 503 : fixture === undefined ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    await page.goto("/logs");
    const views = [
      { label: "Overall Stats", heading: "Disconnect Analysis", error: "Could not load disconnects (HTTP 503)." },
      { label: "Connections", heading: "Connection events", error: "Unable to load records (HTTP 503)." },
      { label: "Sessions", heading: "Live PPPoE sessions", error: "Unable to load records (HTTP 503)." },
      { label: "AAA", heading: "Subscriber RADIUS authentication", error: "Unable to load records (HTTP 503)." },
      { label: "Audit Trail", heading: "User activity", error: "Unable to load records (HTTP 503)." },
    ];

    for (const view of views) {
      const tab = page.getByRole("tab", { name: view.label });
      await expect(tab).toBeVisible();
      const box = await tab.boundingBox();
      if (!box) throw new Error(`The ${view.label} tab has no clickable bounds.`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel").getByRole("heading", { name: view.heading })).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: view.error })).toBeVisible();
    }
    expect(pageErrors).toEqual([]);
  });

  test("switches each main Logs section and renders its real API response", async ({ page }) => {
    test.skip(
      !EMAIL || !PASSWORD,
      "Set E2E_EMAIL and E2E_PASSWORD for an authorized Logs account.",
    );

    await page.goto("/login");
    await page.getByLabel(/email/i).fill(EMAIL!);
    await page.getByLabel(/password/i).fill(PASSWORD!);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });

    await page.goto("/logs");

    const connectionsTab = page.getByRole("tab", { name: "Connections" });
    const networkResponse = page.waitForResponse((response) =>
      isLogResponse(response.url(), "network"),
    );
    await connectionsTab.click();
    await expect(connectionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Connection events" })).toBeVisible();
    const networkApiResponse = await networkResponse;
    expect(networkApiResponse.status()).toBe(200);
    const network = await networkApiResponse.json();
    expect(Array.isArray(network.logs)).toBe(true);

    const sessionsTab = page.getByRole("tab", { name: "Sessions" });
    const sessionsResponse = page.waitForResponse((response) =>
      isLogResponse(response.url(), "radius-sessions"),
    );
    await sessionsTab.click();
    await expect(sessionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Live PPPoE sessions" })).toBeVisible();
    const sessionsApiResponse = await sessionsResponse;
    expect(sessionsApiResponse.status()).toBe(200);
    const sessions = await sessionsApiResponse.json();
    expect(Array.isArray(sessions.items)).toBe(true);

    const authenticationTab = page.getByRole("tab", { name: "AAA" });
    const radiusAuthResponse = page.waitForResponse((response) =>
      isLogResponse(response.url(), "radius-auth"),
    );
    await authenticationTab.click();
    await expect(authenticationTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Subscriber RADIUS authentication" })).toBeVisible();
    const radiusAuthApiResponse = await radiusAuthResponse;
    expect(radiusAuthApiResponse.status()).toBe(200);
    const radiusAuth = await radiusAuthApiResponse.json();
    expect(Array.isArray(radiusAuth.logs)).toBe(true);
    expect(JSON.stringify(radiusAuth)).not.toMatch(/subscriber-password|chap-response/i);

    const auditTab = page.getByRole("tab", { name: "Audit Trail" });
    const activityResponse = page.waitForResponse((response) =>
      isLogResponse(response.url(), "activity"),
    );
    await auditTab.click();
    await expect(auditTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "User activity" })).toBeVisible();
    const activityApiResponse = await activityResponse;
    expect(activityApiResponse.status()).toBe(200);
    const activity = await activityApiResponse.json();
    expect(Array.isArray(activity.logs)).toBe(true);

    await connectionsTab.click();
    await expect(connectionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Connection events" })).toBeVisible();
  });
});
