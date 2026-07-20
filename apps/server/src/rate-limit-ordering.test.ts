import type * as HarborDatabase from "@harbor/database";
import { describe, expect, it, vi } from "vitest";
import { buildTestApp } from "./test-helpers.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, findSessionByTokenHash: vi.fn(), touchSession: vi.fn() };
});

const { findSessionByTokenHash } = await import("@harbor/database");

/**
 * Guards against the ordering regression: rate limiting must run BEFORE the
 * auth guard's session lookup. `findSessionByTokenHash` is a real Postgres
 * round-trip, and it must not be reachable an unbounded number of times just
 * by replaying a bogus session cookie against a guarded route — that is
 * connection-pool exhaustion on a small self-hosted deployment. If the guard
 * were still registered ahead of the rate limiter, every one of these
 * requests would reach the (mocked, but representative) database lookup and
 * this test would never observe a 429.
 */
describe("rate limiting runs ahead of the auth guard", () => {
  it("eventually answers 429 instead of unlimited 401s when hammered with a bogus cookie", async () => {
    // Uses a real route registered through the normal boot sequence
    // (GET /auth/me) rather than a route added ad hoc after buildTestApp():
    // @fastify/rate-limit's `global: true` mode attaches its per-route hook
    // via Fastify's `onRoute` event, which fires synchronously at route
    // declaration time — so it only covers routes declared through the
    // ordinary plugin boot, same as every real Harbor route.
    vi.mocked(findSessionByTokenHash).mockResolvedValue(null);
    const app = await buildTestApp({ ready: true });

    let sawRateLimited = false;
    const attempts = 150; // above the 100/minute default global budget
    for (let i = 0; i < attempts; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        cookies: { harbor_session: "not-a-real-token" },
      });
      if (res.statusCode === 429) {
        sawRateLimited = true;
        break;
      }
      expect(res.statusCode).toBe(401);
    }

    expect(sawRateLimited).toBe(true);
    // The DB lookup must not have run for every attempt: once the limiter
    // trips, requests are rejected before the guard's session lookup runs.
    expect(vi.mocked(findSessionByTokenHash).mock.calls.length).toBeLessThan(attempts);
    await app.close();
  });

  it("keeps health endpoints exempt from the global rate limit", async () => {
    const app = await buildTestApp({ ready: true });
    for (let i = 0; i < 150; i += 1) {
      const res = await app.inject({ method: "GET", url: "/api/v1/health/live" });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });
});
