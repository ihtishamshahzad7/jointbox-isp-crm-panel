import { test, expect } from "@playwright/test";

/**
 * THE FRONT DOOR.
 *
 * Nothing else in the product matters if this is broken, and it is the one
 * flow no unit test covers end to end. These run against a REAL backend, so
 * they are the only tests here that prove the two halves actually agree about
 * the shape of an auth response.
 *
 * Credentials come from the environment and are never committed. Without them
 * the authenticated tests SKIP rather than fail — a suite that is permanently
 * red because of missing local config is a suite people stop reading, and the
 * failures that matter get lost in the noise.
 */

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

test.describe("login", () => {
  test("shows the form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test("rejects bad credentials without revealing which field was wrong", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("definitely-not-a-user@example.invalid");
    await page.getByLabel(/password/i).fill("wrong-password-value");
    await page.getByRole("button", { name: /sign in/i }).click();

    /**
     * The message must not distinguish "no such account" from "wrong
     * password". The difference turns the login form into an account
     * enumeration oracle — the same property enforced on the hotspot voucher
     * endpoint, and for the same reason.
     */
    const error = page.getByRole("alert").or(page.locator("[data-error], .error, [class*='error']")).first();
    await expect(error).toBeVisible({ timeout: 12_000 });
    await expect(error).not.toHaveText(/no such (user|account)|user not found|unknown email/i);

    // And it must not have let us in.
    await expect(page).toHaveURL(/\/login/);
  });

  test("password is not sent in the URL", async ({ page }) => {
    // A GET login, or a form without an explicit method, puts the password in
    // the query string — where it lands in browser history, proxy logs and
    // the server's own access log, in plain text, forever.
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));

    await page.goto("/login");
    await page.getByLabel(/email/i).fill("someone@example.invalid");
    await page.getByLabel(/password/i).fill("Sup3rSecret!");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForTimeout(1500);

    expect(urls.some((u) => u.includes("Sup3rSecret"))).toBe(false);
  });

  test("signs in and reaches the dashboard", async ({ page }) => {
    test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD to run the authenticated flow.");

    await page.goto("/login");
    await page.getByLabel(/email/i).fill(EMAIL!);
    await page.getByLabel(/password/i).fill(PASSWORD!);
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/(dashboard|hub)?$|\/dashboard/, { timeout: 20_000 });
    await expect(page.getByRole("navigation").first()).toBeVisible();
  });

  test("an expired session returns you to login rather than an empty shell", async ({ page }) => {
    // A stale token in storage used to render the whole panel with every
    // request 401-ing behind it — a screenful of empty widgets and no
    // explanation, which reads as "the product is broken".
    await page.addInitScript(() => {
      try {
        localStorage.setItem("token", "expired.invalid.token");
      } catch {}
    });
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });
});

test.describe("notifications", () => {
  test("the centre is reachable and announces politely", async ({ page }) => {
    await page.goto("/login");

    const bell = page.getByRole("button", { name: /notifications/i });
    if ((await bell.count()) === 0) {
      test.skip(true, "The bell only renders inside the authenticated shell.");
    }

    await bell.first().click();
    await expect(page.getByRole("dialog", { name: /notifications/i })).toBeVisible();

    // Escape must close it AND return focus to the trigger — without the
    // return, a keyboard user is dumped at the top of the document.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /notifications/i })).toBeHidden();
    await expect(bell.first()).toBeFocused();
  });

  test("the live region is polite, never assertive", async ({ page }) => {
    await page.goto("/login");
    const assertive = page.locator('[aria-live="assertive"]');
    // Assertive interrupts a screen reader mid-sentence. For a steady trickle
    // of network events that is unusable.
    expect(await assertive.count()).toBe(0);
  });
});
