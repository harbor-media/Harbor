import { expect, test, type Page } from "@playwright/test";

// Same owner the setup spec creates earlier in the serial run. The numeric
// filename prefix is load-bearing: the suite shares one database and this spec
// depends on 01 creating the owner and 03 configuring the provider.
const OWNER = { username: "e2eowner", password: "correct-horse-battery-staple" };

test.describe.configure({ mode: "serial" });

// One sign-in for the whole file, reused across tests. Signing in per test
// would add six owner logins to a suite that already logs in repeatedly, and
// /auth/login is rate limited to 30/minute -- enough of them land in the same
// minute to start returning 429 and stranding a test on /login. Serial mode
// makes a single shared page safe; each test navigates to /home itself.
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

test("home shows the catalog rows the provider can serve", async () => {
  await page.goto("/home");

  await expect(page.getByRole("heading", { name: "Trending" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Popular movies" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Popular series" })).toBeVisible();

  // The fixture returns nothing for now_playing. An empty shelf says nothing,
  // so the row is hidden rather than rendered blank.
  await expect(page.getByRole("heading", { name: "New releases" })).toHaveCount(0);
});

test("a poster opens its title page", async () => {
  await page.goto("/home");

  const trending = page.getByRole("region", { name: "Trending" });
  await trending.getByRole("link", { name: /blade runner/i }).first().click();

  await expect(page).toHaveURL(/\/movie\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Blade Runner", level: 1 })).toBeVisible();
});

test("posters actually render", async () => {
  await page.goto("/home");

  const poster = page
    .getByRole("region", { name: "Popular movies" })
    .getByRole("link")
    .first()
    .locator("img");

  // naturalWidth, not visibility: a broken image is still "visible" to
  // Playwright, which is how a size missing from the proxy allowlist slipped
  // through in 3c-2a.
  await expect
    .poll(async () =>
      poster.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth),
    )
    .toBeGreaterThan(0);
});

test("row scroll buttons reflect position", async () => {
  await page.goto("/home");

  const trending = page.getByRole("region", { name: "Trending" });
  const left = trending.getByRole("button", { name: /scroll trending left/i });

  // At rest the row is at its start, so "left" has nowhere to go. Without
  // this the enable/disable logic is untested anywhere -- jsdom does not
  // implement scroll geometry, so a unit test cannot cover it either.
  await expect(left).toBeDisabled();
});

test("the shell reaches search and marks unbuilt destinations", async () => {
  await page.goto("/home");

  await expect(page.getByRole("button", { name: /discover/i })).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  await page.getByRole("link", { name: /^search$/i }).click();
  await expect(page).toHaveURL(/\/search$/);
});

test("catalog rows require authentication", async ({ browser }) => {
  const anonymous = await browser.newContext();
  const response = await anonymous.request.get("/api/v1/catalog/trending");
  expect(response.status()).toBe(401);
  await anonymous.close();
});
