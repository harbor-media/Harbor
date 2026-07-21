import { expect, test, type Page } from "@playwright/test";

const OWNER = {
  serverName: "E2E Harbor",
  username: "e2eowner",
  email: "e2e@example.com",
  password: "correct-horse-battery-staple",
};

test.describe.configure({ mode: "serial" });

// The `pattern` bug that slipped past 124 unit tests only surfaced as a
// console message while the page still looked visually fine, so every test
// in this suite fails on any unexpected console error. Deliberate negative
// cases (wrong credentials -> 401, direct nav while signed out -> 401 on
// /auth/me) are expected to log failed fetches; those are allow-listed by
// message text below rather than suppressed wholesale.
const ALLOWED_CONSOLE_PATTERNS = [
  /Failed to load resource.*40[19]/i, // expected 401 (unauthenticated /auth/me) / 409 (setup-already-complete) responses
];

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (ALLOWED_CONSOLE_PATTERNS.some((pattern) => pattern.test(text))) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  return errors;
}

test("a fresh install redirects to setup and creates the owner", async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);

  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Welcome to Harbor" })).toBeVisible();

  await page.getByLabel("Server name").fill(OWNER.serverName);
  await page.getByLabel("Username").fill(OWNER.username);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Create owner account" }).click();

  // Setup issues a session, so the owner lands signed in rather than at /login.
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByText(`Signed in as ${OWNER.username}`)).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test("a configured install no longer serves setup", async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);

  await page.goto("/setup");
  await expect(page).not.toHaveURL(/\/setup$/);

  expect(consoleErrors).toEqual([]);
});

test("an unauthenticated visitor is sent to login without ever seeing home content", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  await context.clearCookies();

  // Assert the protected content never renders at all, not merely that we
  // eventually end up at /login. RootLayout resolves install/me queries
  // before deciding what to render, so a regression that renders Home first
  // and redirects afterward must be caught here rather than only checking
  // the final URL. `waitUntil: "commit"` returns as soon as navigation is
  // committed (before the SPA finishes its render/query cycle), so we can
  // inspect the DOM mid-redirect rather than only after it settles.
  await page.goto("/home", { waitUntil: "commit" });
  await expect(page.getByText(/Signed in as/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText(/Signed in as/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
});

test("wrong credentials are rejected with a visible error message", async ({ page, context }) => {
  const consoleErrors = trackConsoleErrors(page);
  await context.clearCookies();

  await page.goto("/login");
  await page.getByLabel("Username or email").fill(OWNER.username);
  await page.getByLabel("Password").fill("definitely-the-wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toContainText("Invalid credentials");
  await expect(page).toHaveURL(/\/login$/);

  expect(consoleErrors).toEqual([]);
});

test("correct credentials sign the owner in, the session survives reload, and sign-out via the UI button works", async ({
  page,
  context,
}) => {
  const consoleErrors = trackConsoleErrors(page);
  await context.clearCookies();

  await page.goto("/login");
  await page.getByLabel("Username or email").fill(OWNER.username);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/home$/);

  await page.reload();
  await expect(page).toHaveURL(/\/home$/);

  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === "harbor_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");

  // The gap manual testing found: a missing sign-out button was invisible to
  // API-level tests. Click the real button rather than calling the logout
  // endpoint directly, and confirm the app lands the user back at /login.
  const signOutButton = page.getByRole("button", { name: "Sign out" });
  await expect(signOutButton).toBeVisible();
  await signOutButton.click();

  await expect(page).toHaveURL(/\/login$/);

  const cookiesAfterSignOut = await context.cookies();
  const sessionAfterSignOut = cookiesAfterSignOut.find(
    (cookie) => cookie.name === "harbor_session",
  );
  expect(sessionAfterSignOut).toBeUndefined();

  // Confirm the sign-out is not merely a client-side navigation: reloading
  // /home after sign-out must not reveal any previously cached user content.
  await page.goto("/home");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText(/Signed in as/)).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
});
