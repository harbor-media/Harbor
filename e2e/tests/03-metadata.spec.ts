import { expect, test, type Page } from "@playwright/test";

// Same owner the setup-and-login spec creates earlier in the serial run.
const OWNER = {
  username: "e2eowner",
  password: "correct-horse-battery-staple",
};

// A plain user created by the invitations spec that runs before this one.
const PLAIN_USER = {
  username: "invitee1",
  password: "another-correct-horse-staple",
};

// Recognized by e2e/scripts/tmdb-fixture.mjs. Anything else gets a 401 from
// the fixture, which is how the rejected-key path is exercised against a real
// HTTP status rather than a stubbed function.
const VALID_KEY = "e2e-valid-tmdb-token";
const REJECTED_KEY = "not-the-right-token";

const TMDB_ATTRIBUTION =
  "This product uses the TMDB API but is not endorsed or certified by TMDB.";

test.describe.configure({ mode: "serial" });

const ALLOWED_CONSOLE_PATTERNS = [
  // Deliberate negative cases below produce 4xx/5xx fetch failures.
  /Failed to load resource.*(40[0139]|50[23])/i,
];

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (ALLOWED_CONSOLE_PATTERNS.some((pattern) => pattern.test(text))) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function signIn(page: Page, user: { username: string; password: string }): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test("an administrator configures TMDB and search serves from cache on repeat", async ({
  page,
}) => {
  const errors = trackConsoleErrors(page);

  await signIn(page, OWNER);

  // Search before configuring: this must read as "not set up yet" and point
  // at the settings page, not as a server error.
  await page.goto("/search");
  await page.getByLabel("Title").fill("Blade Runner");
  await page.getByRole("button", { name: /^search$/i }).click();
  await expect(page.getByRole("alert")).toContainText(/no metadata provider is configured/i);
  await expect(page.getByRole("link", { name: /configure a metadata provider/i })).toBeVisible();

  await page.goto("/admin/metadata");
  await expect(page.getByText(/no metadata provider is configured/i)).toBeVisible();

  // A key the provider rejects must be reported as a key problem and must not
  // be saved.
  await page.getByLabel("TMDB API Read Access Token").fill(REJECTED_KEY);
  await page.getByRole("button", { name: /test connection/i }).click();
  await expect(page.getByRole("alert")).toContainText(/rejected this key/i);

  // A valid key validates and saves.
  await page.getByLabel("TMDB API Read Access Token").fill(VALID_KEY);
  await page.getByRole("button", { name: /test connection/i }).click();
  await expect(page.getByRole("status").filter({ hasText: /accepted this key/i })).toBeVisible();

  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByRole("status").filter({ hasText: /^saved\./i })).toBeVisible();

  // The key must never come back to the browser, in any form.
  const configBody = await page.evaluate(async () => {
    const res = await fetch("/api/v1/admin/metadata/config");
    return await res.text();
  });
  expect(configBody).not.toContain(VALID_KEY);
  expect(JSON.parse(configBody).configured).toBe(true);

  // Cold search: hits the provider.
  await page.goto("/search");
  await page.getByLabel("Title").fill("Blade Runner");
  await page.getByRole("button", { name: /^search$/i }).click();
  await expect(page.getByRole("status")).toContainText(/fetched from TMDB/i);
  await expect(page.getByText("Blade Runner (1982) · movie")).toBeVisible();

  // The fixture returns a person alongside the films; people are not
  // watchable and must not appear as titles.
  await expect(page.getByText("Ridley Scott")).toHaveCount(0);

  // Warm search: same query, served from Harbor's own cache. This is the
  // assertion the whole phase exists to make true.
  await page.reload();
  await page.getByLabel("Title").fill("Blade Runner");
  await page.getByRole("button", { name: /^search$/i }).click();
  await expect(page.getByRole("status")).toContainText(/served from cache/i);
  await expect(page.getByText("Blade Runner (1982) · movie")).toBeVisible();

  await expect(page.getByText(TMDB_ATTRIBUTION)).toBeVisible();

  expect(errors).toEqual([]);
});

test("a plain user cannot reach or change metadata configuration", async ({ page }) => {
  const errors = trackConsoleErrors(page);

  await signIn(page, PLAIN_USER);

  // The client-side guard sends a non-administrator away from /admin/*.
  await page.goto("/admin/metadata");
  await expect(page).toHaveURL(/\/home$/);

  // The guard that actually matters is the server's. A hand-crafted request
  // must be refused regardless of what the browser would allow.
  const statuses = await page.evaluate(async () => {
    const read = await fetch("/api/v1/admin/metadata/config");
    const write = await fetch("/api/v1/admin/metadata/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "attacker-key", language: "en-US", enabled: true }),
    });
    return { read: read.status, write: write.status };
  });

  expect(statuses.read).toBe(403);
  expect(statuses.write).toBe(403);

  expect(errors).toEqual([]);
});
