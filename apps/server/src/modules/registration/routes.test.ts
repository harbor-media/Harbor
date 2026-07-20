import { describe, expect, it } from "vitest";
import { buildTestApp } from "../../test-helpers.js";
import { API_PREFIX } from "@harbor/shared";

// registrationRoutes is already wired into the real app (apps/server/src/app.ts),
// so buildTestApp's own createApp() call registers it — registering it again
// here would double-register the route and fault with "Method already declared".
async function appWithRegistration() {
  const app = await buildTestApp({ ready: true });
  await app.ready();
  return app;
}

describe("public reachability (PUBLIC_ROUTES wiring)", () => {
  it("GET /invitations/:token is reachable without a session (not 401)", async () => {
    const app = await appWithRegistration();
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/invitations/some-token` });
    // With the empty test db the handler will fault (5xx) reaching for the DB,
    // but the guard must NOT have blocked it with 401 — that is what proves the
    // route is public.
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });

  it("POST /register is reachable without a session (not 401) and validates its body first", async () => {
    const app = await appWithRegistration();
    const res = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/register`,
      headers: { origin: "http://localhost:3000" },
      payload: { username: "ab", email: "not-an-email", password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    await app.close();
  });

  it("rejects an @-containing username with 400 before any DB call", async () => {
    const app = await appWithRegistration();
    const res = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/register`,
      headers: { origin: "http://localhost:3000" },
      payload: {
        username: "not@allowed",
        email: "user@example.com",
        password: "correcthorsebatterystaple",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    await app.close();
  });
});
