import { test, expect } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

const isLogResponse = (url: string, endpoint: string) => {
  const parsed = new URL(url);
  return parsed.pathname.endsWith(`/logs/${endpoint}`);
};

test.describe("Logs workspace tabs", () => {
  test("switches embedded Logs tabs and loads each category's data source", async ({ page }) => {
    test.setTimeout(90_000);
    const requestedPaths: string[] = [];
    const pageErrors: Error[] = [];
    const now = new Date().toISOString();
    const dataPaths = [
      "/logs/timeline",
      "/logs/radius-sessions",
      "/logs/radius-auth",
      "/logs/activity",
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
      "/logs/timeline": [],
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

    await page.goto("/insights?tab=logs");
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByRole("status")).toContainText("Loading connection events…");

    const views = [
      { label: "Connections", heading: "Connection events", endpoint: "/logs/timeline", empty: "No events match your filters." },
      { label: "Sessions", heading: "RADIUS accounting sessions", endpoint: "/logs/radius-sessions", empty: "No data found." },
      { label: "Authentication (AAA)", heading: "Subscriber RADIUS authentication", endpoint: "/logs/radius-auth", empty: "No records." },
      { label: "Audit Trail", heading: "Administrative activity", endpoint: "/logs/activity", empty: "No records." },
    ];

    for (const [index, view] of views.entries()) {
      const tab = page.getByRole("tab", { name: view.label });
      await expect(tab).toBeVisible();
      const box = await tab.boundingBox();
      if (!box) throw new Error(`The ${view.label} tab has no clickable bounds.`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(panel.getByRole("heading", { name: view.heading })).toBeVisible();
      if (index === 1) {
        await expect(panel).toContainText("Loading...");
      } else if (index > 1) {
        await expect(panel).toContainText("Loading…");
      }
      heldPaths.delete(view.endpoint);
      releaseGates.get(view.endpoint)?.();
      await expect(panel).toContainText(view.empty);
      await expect.poll(() => requestedPaths.includes(view.endpoint)).toBe(true);
    }

    expect(pageErrors).toEqual([]);
  });

  test("shows API failures in each Logs category", async ({ page }) => {
    const pageErrors: Error[] = [];
    const failingPaths = new Set([
      "/logs/timeline",
      "/logs/radius-sessions",
      "/logs/radius-auth",
      "/logs/activity",
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
      await route.fulfill({
        status: failed ? 503 : fixture === undefined ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify(fixture ?? { message: "Unavailable in this test." }),
      });
    });

    await page.goto("/insights?tab=logs");
    const views = [
      { label: "Connections", heading: "Connection events", error: "Unable to load connection events (HTTP 503)." },
      { label: "Sessions", heading: "RADIUS accounting sessions", error: "Unable to load log data (HTTP 503)." },
      { label: "Authentication (AAA)", heading: "Subscriber RADIUS authentication", error: "Unable to load records (HTTP 503)." },
      { label: "Audit Trail", heading: "Administrative activity", error: "Unable to load records (HTTP 503)." },
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

  test("switches each embedded tab and renders its real API response", async ({ page }) => {
    test.skip(
      !EMAIL || !PASSWORD,
      "Set E2E_EMAIL and E2E_PASSWORD for an authorized Logs account.",
    );

    await page.goto("/login");
    await page.getByLabel(/email/i).fill(EMAIL!);
    await page.getByLabel(/password/i).fill(PASSWORD!);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });

    const timelineResponse = page.waitForResponse((response) =>
      isLogResponse(response.url(), "timeline"),
    );
    const sessionsResponse = page.waitForResponse((response) =>
      isLogResponse(response.url(), "radius-sessions"),
    );
    await page.goto("/insights?tab=logs");

    const connectionsTab = page.getByRole("tab", { name: "Connections" });
    await expect(connectionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Connection events" })).toBeVisible();
    const timelineApiResponse = await timelineResponse;
    expect(timelineApiResponse.status()).toBe(200);
    const timeline = await timelineApiResponse.json();
    expect(Array.isArray(timeline)).toBe(true);

    const sessionsTab = page.getByRole("tab", { name: "Sessions" });
    await sessionsTab.click();
    await expect(sessionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "RADIUS accounting sessions" })).toBeVisible();
    const sessionsApiResponse = await sessionsResponse;
    expect(sessionsApiResponse.status()).toBe(200);
    const sessions = await sessionsApiResponse.json();
    expect(Array.isArray(sessions.items)).toBe(true);

    const authenticationTab = page.getByRole("tab", { name: "Authentication (AAA)" });
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
    await expect(page.getByRole("heading", { name: "Administrative activity" })).toBeVisible();
    const activityApiResponse = await activityResponse;
    expect(activityApiResponse.status()).toBe(200);
    const activity = await activityApiResponse.json();
    expect(Array.isArray(activity.logs)).toBe(true);

    await connectionsTab.click();
    await expect(connectionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Connection events" })).toBeVisible();
  });
});
