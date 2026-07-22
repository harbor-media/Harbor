import { expect, test, type Page } from "@playwright/test";

// Same owner the setup spec creates earlier in the serial run. The numeric
// filename prefix is load-bearing: the suite shares one database and this
// spec depends on 01 creating the owner and 03 configuring the provider.
const OWNER = {
  username: "e2eowner",
  password: "correct-horse-battery-staple",
};

const TMDB_FIXTURE = "http://127.0.0.1:3101";

test.describe.configure({ mode: "serial" });

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(OWNER.username);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function search(page: Page, term: string): Promise<void> {
  await page.goto("/search");
  await page.getByLabel("Title").fill(term);
  await page.getByRole("button", { name: /^search$/i }).click();
}

/**
 * Detail fetches the fixture has actually served.
 *
 * Queried through Playwright's Node-side request API, not page.evaluate:
 * Harbor's CSP sets connect-src 'self', so a fetch from the page to the
 * fixture's origin is blocked by the browser before it is ever sent.
 */
async function detailFetches(page: Page): Promise<number> {
  const res = await page.request.get(`${TMDB_FIXTURE}/count`);
  return ((await res.json()) as { detailFetches: number }).detailFetches;
}

test("a search result opens a real title page", async ({ page }) => {
  await signIn(page);
  await search(page, "Blade Runner");

  await page.getByRole("link", { name: /blade runner/i }).first().click();

  await expect(page).toHaveURL(/\/movie\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Blade Runner", level: 1 })).toBeVisible();
  await expect(page.getByText("A blade runner must pursue replicants.")).toBeVisible();
  // Genres come from the detail payload, so their presence proves the detail
  // endpoint ran rather than the page reusing the search result.
  await expect(page.getByText("Science Fiction")).toBeVisible();
  await expect(page.getByText("117 min")).toBeVisible();
});

test("a series page shows season tabs and switching changes the episodes", async ({ page }) => {
  await signIn(page);
  await search(page, "Supernatural");

  await page.getByRole("link", { name: /supernatural/i }).first().click();
  await expect(page).toHaveURL(/\/series\/[0-9a-f-]{36}$/);

  // Season 1 is the default: no season in the URL yet.
  await expect(page.getByRole("navigation", { name: "Seasons" })).toBeVisible();
  await expect(page.getByText("Pilot")).toBeVisible();

  await page.getByRole("link", { name: "Season 2" }).click();

  await expect(page).toHaveURL(/\/series\/[0-9a-f-]{36}\/season\/2$/);
  await expect(page.getByText("In My Time of Dying")).toBeVisible();
  // The previous season's episodes must be gone, not merely appended.
  await expect(page.getByText("Pilot")).toHaveCount(0);
});

test("a second visit is served from Harbor's cache", async ({ page }) => {
  await signIn(page);
  await search(page, "Blade Runner");
  await page.getByRole("link", { name: /blade runner/i }).first().click();
  await expect(page.getByRole("heading", { name: "Blade Runner", level: 1 })).toBeVisible();

  const before = await detailFetches(page);

  // A full reload, so nothing is served from the client's query cache.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Blade Runner", level: 1 })).toBeVisible();

  // The assertion the cache exists for. Without it this test would pass
  // whether or not anything was cached, since the page renders either way.
  expect(await detailFetches(page)).toBe(before);
});

test("title detail requires authentication", async ({ browser }) => {
  const anonymous = await browser.newContext();
  const response = await anonymous.request.get(
    "/api/v1/titles/3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  );

  expect(response.status()).toBe(401);
  await anonymous.close();
});
