import { expect, test, type Page } from "@playwright/test";

// Same owner the setup spec creates earlier in the serial run. The numeric
// filename prefix is load-bearing: this spec depends on 01 creating the owner
// and 03 configuring the provider, and signs in once for the whole file so the
// suite stays under the login rate limit.
const OWNER = { username: "e2eowner", password: "correct-horse-battery-staple" };

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(OWNER.username);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/home$/);
});

test.afterAll(async () => {
  await page.close();
});

test("the shell nav reaches discover", async () => {
  await page.goto("/home");
  await page.getByRole("link", { name: /^discover$/i }).click();
  await expect(page).toHaveURL(/\/discover/);
  await expect(page.getByRole("heading", { name: "Discover", level: 1 })).toBeVisible();
});

test("shows a grid, renders posters, and appends pages with Load more", async () => {
  // One navigation covering the grid, poster rendering, and pagination. Each
  // discover load is a proxy-through call, so this keeps the sequence short.
  await page.goto("/discover?type=movie&genre=878");

  const blade = page.getByRole("link", { name: /blade runner/i });
  await expect(blade).toBeVisible();

  // naturalWidth, not visibility: a broken image is still "visible" to
  // Playwright, which is how a size missing from the proxy allowlist slipped
  // through in 3c-2a.
  await expect
    .poll(async () =>
      blade.first().locator("img").evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth),
    )
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: /load more/i }).click();
  await expect(page.getByRole("link", { name: /pulp fiction/i })).toBeVisible();
});

test("switching to series browses tv genres", async () => {
  await page.goto("/discover?type=movie&genre=878");
  await page.getByRole("button", { name: "Series" }).click();
  await expect(page).toHaveURL(/type=series/);
  await expect(page.getByRole("link", { name: /supernatural/i })).toBeVisible();
});

test("discover requires authentication", async ({ browser }) => {
  const anon = await browser.newContext();
  const res = await anon.request.get("/api/v1/discover/movie/878");
  expect(res.status()).toBe(401);
  await anon.close();
});
