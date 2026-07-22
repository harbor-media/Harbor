import { expect, test, type Page } from "@playwright/test";

// Same owner the setup-and-login spec creates earlier in the serial run.
const OWNER = {
  username: "e2eowner",
  password: "correct-horse-battery-staple",
};

const INVITEE = {
  username: "invitee1",
  email: "invitee1@example.com",
  password: "another-correct-horse-staple",
};

const ADMIN_INVITEE = {
  username: "admin1",
  email: "admin1@example.com",
  password: "yet-another-long-passphrase",
};

const OPEN_REGISTRANT = {
  username: "openuser1",
  email: "openuser1@example.com",
  password: "open-registration-long-pass",
};

test.describe.configure({ mode: "serial" });

/**
 * Picks a value from a shadcn/Radix Select.
 *
 * These are not native <select> elements: the trigger is a combobox button
 * and the choices are role="option" divs rendered in a portal, so
 * selectOption() and .locator("option") do not apply. Driving it by role is
 * also closer to what a person does -- open the control, then choose.
 */
async function chooseFrom(scope: Page, control: string, option: string): Promise<void> {
  await scope.getByRole("combobox", { name: control }).click();
  await scope.getByRole("option", { name: option, exact: true }).click();
}

/** The choices a Select offers, read by opening it. */
async function optionsOf(scope: Page, control: string): Promise<string[]> {
  await scope.getByRole("combobox", { name: control }).click();
  const items = await scope.getByRole("option").allInnerTexts();
  await scope.keyboard.press("Escape");
  return items;
}


const ALLOWED_CONSOLE_PATTERNS = [
  // Expected 400/401/403/409 fetch failures from deliberate negative cases
  // (invalid/spent invite tokens, unauthenticated /auth/me probes, etc).
  /Failed to load resource.*40[0139]/i,
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

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

let spentInviteToken: string;

test("owner invites a user who registers and lands signed in; owner sees the invite spent", async ({
  page,
  browser,
}) => {
  const consoleErrors = trackConsoleErrors(page);

  await signIn(page, OWNER.username, OWNER.password);

  await page.goto("/admin/invitations");
  await expect(page.getByRole("heading", { name: "Invitations", exact: true })).toBeVisible();

  // Owner may grant administrator; select the user role for this invite.
  await chooseFrom(page, "Role", "user");
  await page.getByRole("button", { name: "Create invitation" }).click();

  const inviteUrl = await page.getByLabel("Invite link").inputValue();
  expect(inviteUrl).toContain("/invite/");
  const invitePath = new URL(inviteUrl).pathname;
  spentInviteToken = invitePath.split("/invite/")[1] ?? "";
  expect(spentInviteToken).not.toEqual("");

  // A second, independent browser context: the new user. Using a fresh
  // context (rather than the owner's page) proves the invite works without
  // any shared cookie/session from the owner who minted it.
  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();
  const inviteeErrors = trackConsoleErrors(inviteePage);

  await inviteePage.goto(invitePath);
  await expect(inviteePage.getByRole("heading", { name: /invited as user/i })).toBeVisible();
  await inviteePage.getByLabel("Username").fill(INVITEE.username);
  await inviteePage.getByLabel("Email").fill(INVITEE.email);
  await inviteePage.getByLabel("Password").fill(INVITEE.password);
  await inviteePage.getByRole("button", { name: "Create account" }).click();

  await expect(inviteePage).toHaveURL(/\/home$/);
  await expect(inviteePage.getByText(`Signed in as ${INVITEE.username}`)).toBeVisible();

  const cookies = await inviteeContext.cookies();
  const session = cookies.find((c) => c.name === "harbor_session");
  expect(session?.httpOnly).toBe(true);

  // Owner refreshes the list and sees the invite marked spent.
  await page.reload();
  await expect(page.getByText(/user · spent/)).toBeVisible();

  expect(inviteeErrors).toEqual([]);
  await inviteeContext.close();
  expect(consoleErrors).toEqual([]);
});

test("the owner's create-invite dropdown offers administrator, user and guest", async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page);

  await signIn(page, OWNER.username, OWNER.password);
  await page.goto("/admin/invitations");
  await expect(page.getByRole("heading", { name: "Invitations", exact: true })).toBeVisible();

  const roleOptions = await optionsOf(page, "Role");
  expect(roleOptions).toEqual(expect.arrayContaining(["administrator", "user", "guest"]));

  expect(consoleErrors).toEqual([]);
});

test("an administrator cannot grant the administrator role (dropdown omits it)", async ({
  page,
  browser,
}) => {
  const consoleErrors = trackConsoleErrors(page);

  // Owner mints an administrator invite (owner CAN grant administrator).
  await signIn(page, OWNER.username, OWNER.password);
  await page.goto("/admin/invitations");
  await chooseFrom(page, "Role", "administrator");
  await page.getByRole("button", { name: "Create invitation" }).click();
  const adminInviteUrl = await page.getByLabel("Invite link").inputValue();

  // Register the administrator in a fresh context.
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const adminErrors = trackConsoleErrors(adminPage);
  await adminPage.goto(new URL(adminInviteUrl).pathname);
  await expect(adminPage.getByRole("heading", { name: /invited as administrator/i })).toBeVisible();
  await adminPage.getByLabel("Username").fill(ADMIN_INVITEE.username);
  await adminPage.getByLabel("Email").fill(ADMIN_INVITEE.email);
  await adminPage.getByLabel("Password").fill(ADMIN_INVITEE.password);
  await adminPage.getByRole("button", { name: "Create account" }).click();
  await expect(adminPage).toHaveURL(/\/home$/);

  // As that administrator, the invitations page must not offer "administrator".
  await adminPage.goto("/admin/invitations");
  await expect(adminPage.getByRole("heading", { name: "Invitations", exact: true })).toBeVisible();
  const roleOptions = await optionsOf(adminPage, "Role");
  expect(roleOptions).not.toContain("administrator");
  expect(roleOptions).toContain("user");

  expect(adminErrors).toEqual([]);
  await adminContext.close();
  expect(consoleErrors).toEqual([]);
});

test("open registration lets a visitor self-register without an invite, then the owner turns it back off", async ({
  page,
  browser,
}) => {
  const consoleErrors = trackConsoleErrors(page);

  // Owner enables open registration, confirming the risk acknowledgement.
  await signIn(page, OWNER.username, OWNER.password);
  await page.goto("/admin/invitations");
  await chooseFrom(page, "Mode", "open");
  await expect(
    page.getByRole("alert").filter({ hasText: "Open registration lets anyone" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm open registration" }).click();
  await expect(page.getByText(/Anyone can create an account/)).toBeVisible();

  // A fresh, signed-out context sees the "Create account" link on /login.
  const openContext = await browser.newContext();
  const openPage = await openContext.newPage();
  const openErrors = trackConsoleErrors(openPage);

  await openPage.goto("/login");
  const createAccountLink = openPage.getByRole("link", { name: "Create an account" });
  await expect(createAccountLink).toBeVisible();
  await createAccountLink.click();
  await expect(openPage).toHaveURL(/\/register$/);
  await expect(openPage.getByRole("heading", { name: "Create your account" })).toBeVisible();

  await openPage.getByLabel("Username").fill(OPEN_REGISTRANT.username);
  await openPage.getByLabel("Email").fill(OPEN_REGISTRANT.email);
  await openPage.getByLabel("Password").fill(OPEN_REGISTRANT.password);
  await openPage.getByRole("button", { name: "Create account" }).click();

  await expect(openPage).toHaveURL(/\/home$/);
  await expect(openPage.getByText(`Signed in as ${OPEN_REGISTRANT.username}`)).toBeVisible();

  expect(openErrors).toEqual([]);
  await openContext.close();

  // Cleanup: return to invitation-only mode so later assertions in the
  // serial suite aren't affected, and confirm the link disappears again.
  await page.goto("/admin/invitations");
  await chooseFrom(page, "Mode", "invitation-only");
  await expect(page.getByText(/Anyone can create an account/)).toHaveCount(0);

  const cleanupContext = await browser.newContext();
  const cleanupPage = await cleanupContext.newPage();
  await cleanupPage.goto("/login");
  await expect(cleanupPage.getByRole("link", { name: "Create an account" })).toHaveCount(0);
  await cleanupContext.close();

  expect(consoleErrors).toEqual([]);
});

test("an invalid or already-spent invite token shows no registration form", async ({
  page,
  browser,
}) => {
  const consoleErrors = trackConsoleErrors(page);

  const context = await browser.newContext();
  const invalidPage = await context.newPage();
  const invalidErrors = trackConsoleErrors(invalidPage);

  await invalidPage.goto(`/invite/${spentInviteToken}`);
  await expect(invalidPage.getByRole("alert")).toContainText("This invitation is no longer valid");
  await expect(invalidPage.getByLabel("Username")).toHaveCount(0);
  await expect(invalidPage.getByRole("button", { name: "Create account" })).toHaveCount(0);

  await invalidPage.goto("/invite/totally-fabricated-token-does-not-exist");
  await expect(invalidPage.getByRole("alert")).toContainText("This invitation is no longer valid");
  await expect(invalidPage.getByLabel("Username")).toHaveCount(0);

  expect(invalidErrors).toEqual([]);
  await context.close();
  expect(consoleErrors).toEqual([]);
});
