import { expect, test, type Page } from "@playwright/test";

// Same owner the setup spec creates earlier in the serial run. The numeric
// filename prefix is load-bearing: the suite shares one database and this
// spec depends on 01 creating the owner and 03 configuring the provider.
const OWNER = {
  username: "e2eowner",
  password: "correct-horse-battery-staple",
};

const IMAGE_FIXTURE = "http://127.0.0.1:3102";

test.describe.configure({ mode: "serial" });

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(OWNER.username);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/home$/);
}

/**
 * How many times the upstream fixture has actually served image bytes.
 *
 * Queried through Playwright's Node-side request API, not page.evaluate:
 * Harbor's CSP sets connect-src 'self', so a fetch from the page to the
 * fixture's origin is blocked by the browser before it is ever sent.
 */
async function upstreamServed(page: Page): Promise<number> {
  const res = await page.request.get(`${IMAGE_FIXTURE}/count`);
  const body = (await res.json()) as { served: number };
  return body.served;
}

async function resetUpstream(page: Page): Promise<void> {
  await page.request.get(`${IMAGE_FIXTURE}/reset`);
}

test("posters render in search results", async ({ page }) => {
  await signIn(page);

  await page.goto("/search");
  await page.getByLabel("Title").fill("Blade Runner");
  await page.getByRole("button", { name: /^search$/i }).click();

  const poster = page.getByRole("img", { name: /poster for blade runner/i }).first();
  await expect(poster).toBeVisible();

  // A broken image is still "visible" to Playwright, so assert the browser
  // actually decoded bytes rather than rendering the alt text.
  await expect
    // Structural cast rather than HTMLImageElement: this package's tsconfig
    // has no DOM lib, and the evaluated function runs in the browser anyway.
    .poll(async () => poster.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth))
    .toBeGreaterThan(0);
});

test("a second request for the same image is served from Harbor's cache", async ({ page }) => {
  await signIn(page);
  await resetUpstream(page);

  // Two direct requests with caching disabled in the browser, so anything the
  // fixture avoids serving was avoided by HARBOR's cache, not the browser's.
  const statuses = await page.evaluate(async () => {
    const url = "/api/v1/images/tmdb/w342/poster.jpg";
    const first = await fetch(url, { cache: "no-store" });
    const second = await fetch(url, { cache: "no-store" });
    return [first.status, second.status];
  });

  expect(statuses).toEqual([200, 200]);
  // At most one upstream fetch for two requests. This is the assertion the
  // cache exists for; without it the test would pass whether or not anything
  // was cached.
  expect(await upstreamServed(page)).toBeLessThanOrEqual(1);
});

test("an image missing upstream returns 404 rather than a placeholder body", async ({ page }) => {
  await signIn(page);

  const status = await page.evaluate(async () => {
    const res = await fetch("/api/v1/images/tmdb/w342/missing.jpg", { cache: "no-store" });
    return res.status;
  });

  // A placeholder served as 200 would be cached by the browser as though it
  // were the real poster. The frontend draws the placeholder instead.
  expect(status).toBe(404);
});

test("an SVG from upstream is refused and never served", async ({ page }) => {
  await signIn(page);

  const result = await page.evaluate(async () => {
    const res = await fetch("/api/v1/images/tmdb/w342/evil.jpg", { cache: "no-store" });
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
  });

  // An SVG served from Harbor's origin executes as first-party script.
  expect(result.status).not.toBe(200);
  expect(result.type).not.toContain("svg");
  expect(result.body).not.toContain("<script>");
});

test("a filename that escapes its directory is rejected", async ({ page }) => {
  await signIn(page);

  const status = await page.evaluate(async () => {
    const res = await fetch("/api/v1/images/tmdb/w342/..%2f..%2fetc%2fpasswd", {
      cache: "no-store",
    });
    return res.status;
  });

  expect(status).toBe(400);
});

test("images require authentication", async ({ browser }) => {
  // A fresh context with no session cookie: the proxy must not be usable by
  // strangers, or the server owner's bandwidth is available to the internet.
  const anonymous = await browser.newContext();
  const response = await anonymous.request.get("/api/v1/images/tmdb/w342/poster.jpg");

  expect(response.status()).toBe(401);
  await anonymous.close();
});
