import type * as HarborDatabase from "@harbor/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../../test-helpers.js";
import { hashPassword } from "./passwords.js";
import { backoffMs, FREE_ATTEMPTS } from "./throttle.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return {
    ...actual,
    findUserByIdentifier: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    recordFailedLogin: vi.fn(),
    resetFailedLogins: vi.fn(),
    findSessionByTokenHash: vi.fn(),
    touchSession: vi.fn(),
  };
});

const db = await import("@harbor/database");

const PASSWORD = "correct-horse-battery";
let storedHash: string;

const user = () => ({
  id: "33333333-3333-3333-3333-333333333333",
  username: "owner",
  email: "owner@example.com",
  passwordHash: storedHash,
  role: "owner" as const,
  passwordChangedAt: new Date(),
  failedLoginCount: 0,
  lastFailedLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const validSession = () => ({
  session: {
    id: "44444444-4444-4444-4444-444444444444",
    userId: user().id,
    tokenHash: "hash",
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    userAgent: null,
    ip: null,
    createdAt: new Date(),
  },
  user: user(),
});

beforeEach(async () => {
  vi.clearAllMocks();
  storedHash ??= await hashPassword(PASSWORD);
  vi.mocked(db.createSession).mockResolvedValue({} as never);
  vi.mocked(db.deleteSession).mockResolvedValue(undefined);
  vi.mocked(db.recordFailedLogin).mockResolvedValue(1);
  vi.mocked(db.resetFailedLogins).mockResolvedValue(undefined);
});

async function login(body: unknown, app: Awaited<ReturnType<typeof buildTestApp>>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: body,
    headers: { origin: "http://localhost:3000" },
  });
}

describe("POST /api/v1/auth/login", () => {
  it("issues a session cookie for correct credentials", async () => {
    vi.mocked(db.findUserByIdentifier).mockResolvedValue(user());
    const app = await buildTestApp({ ready: true });

    const res = await login({ identifier: "owner", password: PASSWORD }, app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { username: "owner", role: "owner" } });

    const cookie = res.cookies.find((c) => c.name === "harbor_session");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe("lax");
    expect(res.body).not.toContain("passwordHash");
    await app.close();
  });

  it("returns an identical response for unknown user and wrong password", async () => {
    const app = await buildTestApp({ ready: true });

    vi.mocked(db.findUserByIdentifier).mockResolvedValue(null);
    const unknown = await login({ identifier: "ghost", password: "whatever" }, app);

    vi.mocked(db.findUserByIdentifier).mockResolvedValue(user());
    const wrong = await login({ identifier: "owner", password: "wrong-password" }, app);

    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    // Bodies differ only by requestId, so compare the meaningful parts.
    const strip = (b: string) => b.replace(/"requestId":"[^"]*"/, "");
    expect(strip(unknown.body)).toBe(strip(wrong.body));
    await app.close();
  });

  it("returns the same status and Retry-After for an account and an unknown identifier at equal failure counts", async () => {
    // THIS TEST IS THE POINT OF THE HANDLER'S ORDERING — do not "simplify" it
    // back to comparing two un-throttled responses. The 401-vs-401 case above
    // passes no matter how the handler is written, because with
    // failedLoginCount: 0 no 429 is reachable at all. The enumeration oracle
    // lives on the throttled path: if the backoff is computed only after the
    // `if (!user)` branch, a throttled real account answers 429 + Retry-After
    // while an unknown identifier answers 401, and anyone can tell which
    // usernames exist by mistyping a password three times.
    //
    // A differing Retry-After value is itself an oracle, one layer down from a
    // differing status code — so this test asserts both. To make that a fair
    // comparison, BOTH dimensions must be seeded to the SAME failure count
    // (N, here 6) before the comparison. `AttemptThrottle` and the persistent
    // `failed_login_count` share one formula (retryAfterSeconds/backoffMs), so
    // equal counts are guaranteed to produce equal backoffs — but only if the
    // counts really are equal. A naive loop of N synchronous attempts against
    // the unknown-identifier store does NOT reach count N: once the free-
    // attempt budget (FREE_ATTEMPTS) is spent, every further attempt in the
    // same instant is itself blocked by the 429 check before it can be
    // recorded (blocked attempts are deliberately never recorded — see
    // throttle.ts — otherwise an attacker could hold a victim account in
    // permanent lockout by hammering it during its own cooldown). So the loop
    // must advance a fake clock past each cooldown between recorded attempts,
    // or it freezes at FREE_ATTEMPTS and produces a small backoff while a
    // fixture-jammed account produces a large one — apples to oranges, not a
    // real parity check. Do not go back to comparing an unadvanced loop
    // against a hardcoded high `failedLoginCount`.
    // Only Date is faked. Faking setTimeout/setImmediate/process.nextTick too
    // would stall Fastify's internal scheduling and Argon2's native async
    // work, which do not advance on their own without manual ticking.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const app = await buildTestApp({ ready: true });
      const N = 6; // above FREE_ATTEMPTS (3), so a real backoff applies

      // Drive the unknown identifier through N real recorded failures,
      // advancing time past each opened cooldown so the next attempt is not
      // itself blocked (and thus actually gets recorded).
      vi.mocked(db.findUserByIdentifier).mockResolvedValue(null);
      let now = Date.now();
      let lastFailedAt = now;
      for (let i = 1; i <= N; i++) {
        vi.setSystemTime(now);
        const res = await login({ identifier: "ghost", password: "wrong" }, app);
        expect(res.statusCode).toBe(401); // must be a real recorded failure, not a 429
        lastFailedAt = now; // the instant the i-th failure was recorded
        now += backoffMs(i, FREE_ATTEMPTS) + 1000; // clear this attempt's cooldown with margin
      }
      // Probe at the exact instant the Nth failure was recorded (not the
      // advanced "now" used to clear it), so this request lands inside the
      // cooldown that failure just opened.
      vi.setSystemTime(lastFailedAt);
      const unknown = await login({ identifier: "ghost", password: "wrong" }, app);

      // Seed the account fixture at the exact same count and instant. System
      // time is unchanged since the probe above, so both computations read
      // an identical "now".
      vi.mocked(db.findUserByIdentifier).mockResolvedValue({
        ...user(),
        failedLoginCount: N,
        lastFailedLoginAt: new Date(lastFailedAt),
      });
      const throttled = await login({ identifier: "owner", password: "wrong" }, app);

      expect(unknown.statusCode).toBe(429);
      expect(throttled.statusCode).toBe(429);
      expect(unknown.headers["retry-after"]).toBe(throttled.headers["retry-after"]);
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a failed attempt on a wrong password", async () => {
    vi.mocked(db.findUserByIdentifier).mockResolvedValue(user());
    const app = await buildTestApp({ ready: true });
    await login({ identifier: "owner", password: "nope" }, app);
    expect(db.recordFailedLogin).toHaveBeenCalledOnce();
    await app.close();
  });

  it("returns 429 with Retry-After for a WRONG password once the account is throttled", async () => {
    // Throttling still applies to failures — only a correct password bypasses
    // it (see the next test).
    vi.mocked(db.findUserByIdentifier).mockResolvedValue({
      ...user(),
      failedLoginCount: 8,
      lastFailedLoginAt: new Date(),
    });
    const app = await buildTestApp({ ready: true });

    const res = await login({ identifier: "owner", password: "still-wrong" }, app);
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    await app.close();
  });

  it("lets a correct password through even when the account is throttled, and resets the counter", async () => {
    // The lockout fix: a persistent per-account throttle must never be able to
    // permanently lock out the real owner. An account far past the throttle
    // threshold, but with the CORRECT password, must still succeed.
    vi.mocked(db.findUserByIdentifier).mockResolvedValue({
      ...user(),
      failedLoginCount: 50,
      lastFailedLoginAt: new Date(),
    });
    const app = await buildTestApp({ ready: true });

    const res = await login({ identifier: "owner", password: PASSWORD }, app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { username: "owner", role: "owner" } });
    const cookie = res.cookies.find((c) => c.name === "harbor_session");
    expect(cookie).toBeDefined();
    expect(db.resetFailedLogins).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects a malformed payload without leaking the value", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await login({ identifier: "", password: "hunter2" }, app);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("hunter2");
    await app.close();
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("succeeds and clears the cookie even with an expired or unknown session", async () => {
    // Logout is idempotent and allowlisted. If it were guarded, an expired
    // session would get 401 and the browser would keep the stale cookie
    // forever — and the web client, which does not inspect res.ok, would
    // cheerfully report a successful sign-out.
    vi.mocked(db.findSessionByTokenHash).mockResolvedValue(null);
    const app = await buildTestApp({ ready: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { harbor_session: "expired-or-revoked" },
      headers: { origin: "http://localhost:3000" },
    });

    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === "harbor_session");
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe("");
    expect(db.deleteSession).not.toHaveBeenCalled();
    await app.close();
  });

  it("deletes the session row when the cookie matches one", async () => {
    vi.mocked(db.findSessionByTokenHash).mockResolvedValue(validSession());
    const app = await buildTestApp({ ready: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { harbor_session: "token" },
      headers: { origin: "http://localhost:3000" },
    });

    expect(res.statusCode).toBe(204);
    expect(db.deleteSession).toHaveBeenCalledOnce();
    await app.close();
  });
});

describe("GET /api/v1/auth/me", () => {
  it("requires authentication", async () => {
    vi.mocked(db.findSessionByTokenHash).mockResolvedValue(null);
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
