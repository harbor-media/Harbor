import {
  createSession,
  deleteSession,
  findSessionByTokenHash,
  findUserByIdentifier,
  recordFailedLogin,
  resetFailedLogins,
} from "@harbor/database";
import type { AuthenticatedUser } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HarborError } from "../../plugins/errors.js";
import { SESSION_COOKIE, clearSessionCookie, setSessionCookie } from "./cookies.js";
import { verifyAgainstDummy, verifyPassword } from "./passwords.js";
import {
  AttemptThrottle,
  FREE_ATTEMPTS,
  IP_FREE_ATTEMPTS,
  identifierKey,
  retryAfterSeconds,
} from "./throttle.js";
import { generateSessionToken, hashSessionToken, sessionExpiry } from "./tokens.js";

const LoginSchema = z.object({
  identifier: z.string().min(1).max(320),
  password: z.string().min(1).max(200),
});

/** One generic message for both unknown-user and wrong-password. */
const INVALID_CREDENTIALS = "Invalid credentials.";

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Two dimensions, two budgets. The IP dimension is generous (see throttle.ts)
   * because a misconfigured HARBOR_TRUST_PROXY collapses every client onto one
   * address.
   *
   * The unknown-identifier store exists solely so the 429 branch is reachable
   * when no account matches. Without it, a throttled real account answers 429
   * while an unknown identifier answers 401, and that difference enumerates
   * accounts. It is deliberately keyed by a SHA-256 of the identifier so the
   * process never holds a list of attempted usernames.
   */
  const ipThrottle = new AttemptThrottle(IP_FREE_ATTEMPTS);
  const unknownIdentifiers = new AttemptThrottle(FREE_ATTEMPTS);

  fastify.post(
    "/auth/login",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply): Promise<{ user: AuthenticatedUser }> => {
      // Ordering here is deliberate and has already been wrong once: a correct
      // password MUST be allowed through regardless of the identifier-dimension
      // throttle. `users.failed_login_count`/`last_failed_login_at` are
      // persistent and only reset on a successful login (below), so if a wrong
      // password is checked before the real one every ~30s (backoff saturates
      // there), an attacker who merely knows the owner's username can keep the
      // account perpetually throttled and lock the owner out indefinitely, with
      // no admin-unlock path in this phase. So: the password is now ALWAYS
      // verified first (dummy-hashed when the identifier is unknown, so timing
      // stays comparable), and only a WRONG (or dummy) result is subject to the
      // identifier throttle below. The IP-dimension throttle is unaffected and
      // still gates BEFORE the password check — it is generous
      // (`IP_FREE_ATTEMPTS`) and exists specifically to bound the cost of
      // Argon2 now running on every throttled identifier attempt too; that is
      // an accepted, deliberate tradeoff.
      //
      // Do not reorder the identifier-throttle check back above the password
      // check: the enumeration-parity test in routes.test.ts exists precisely
      // to catch that regression (a throttled real account and an unknown
      // identifier must still answer with the same status and Retry-After).
      const parsed = LoginSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", "Invalid credentials payload.", 400);
      }

      const ipWait = ipThrottle.retryAfter(request.ip);
      if (ipWait > 0) {
        void reply.header("Retry-After", String(ipWait));
        throw new HarborError("RATE_LIMITED", "Too many attempts. Try again shortly.", 429);
      }

      const user = await findUserByIdentifier(fastify.db, parsed.data.identifier);
      const key = identifierKey(parsed.data.identifier);

      // Computed up front (pure, no side effects) so it is available to gate a
      // WRONG password below, without gating whether the password is checked
      // at all. Existing accounts read the persistent counter; unknown
      // identifiers read the in-memory store — both feed the same 429 response
      // further down, so a throttled account and a throttled unknown
      // identifier stay indistinguishable.
      const identifierWait = user
        ? retryAfterSeconds(user.failedLoginCount, user.lastFailedLoginAt)
        : unknownIdentifiers.retryAfter(key);

      // Always runs, throttled or not, and constant work either way: a correct
      // password must still be checked on a throttled account (see comment
      // above), and hashing against the dummy keeps an unknown identifier's
      // timing indistinguishable from a real one.
      const authenticated = user
        ? await verifyPassword(user.passwordHash, parsed.data.password)
        : await verifyAgainstDummy().then(() => false);

      if (authenticated) {
        // Unreachable — `authenticated` is only true when a user was found —
        // but TypeScript cannot narrow `user` from it, and an explicit
        // fail-closed branch is better than a non-null assertion in an auth
        // path.
        if (!user) throw new HarborError("UNAUTHENTICATED", INVALID_CREDENTIALS, 401);

        // A correct password clears the throttle outright, regardless of how
        // deep into backoff the account was.
        await resetFailedLogins(fastify.db, user.id);
        unknownIdentifiers.reset(key);
        ipThrottle.reset(request.ip);

        const token = generateSessionToken();
        await createSession(fastify.db, {
          userId: user.id,
          tokenHash: hashSessionToken(token),
          expiresAt: sessionExpiry(),
          userAgent: request.headers["user-agent"] ?? null,
          ip: request.ip,
        });
        setSessionCookie(reply, token, fastify.env.HARBOR_BASE_URL);

        fastify.log.info({ userId: user.id }, "login succeeded");
        return {
          user: { id: user.id, username: user.username, email: user.email, role: user.role },
        };
      }

      // Wrong (or dummy) credentials: NOW the identifier throttle applies.
      if (identifierWait > 0) {
        void reply.header("Retry-After", String(identifierWait));
        throw new HarborError("RATE_LIMITED", "Too many attempts. Try again shortly.", 429);
      }

      if (user) {
        await recordFailedLogin(fastify.db, user.id);
        fastify.log.warn({ userId: user.id }, "failed login");
      } else {
        unknownIdentifiers.record(key);
        // No identifier in the log line — it may be someone's email address.
        fastify.log.warn("failed login for an unknown identifier");
      }
      ipThrottle.record(request.ip);
      throw new HarborError("UNAUTHENTICATED", INVALID_CREDENTIALS, 401);
    },
  );

  /**
   * Idempotent and allowlisted as public (see PUBLIC_ROUTES in plugins/auth.ts).
   * If logout were guarded, an expired or already-revoked session would get a
   * 401 and the browser would keep its stale cookie forever — the one state
   * where a user most needs logout to work. So: always clear the cookie, delete
   * the row only if one exists, and always answer 204. It reveals nothing,
   * because the response is the same whether or not the token matched.
   *
   * The session is resolved from the cookie rather than `request.session`,
   * which the guard leaves null on a public route.
   */
  fastify.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const found = await findSessionByTokenHash(fastify.db, hashSessionToken(token));
      if (found) await deleteSession(fastify.db, found.session.id);
    }
    clearSessionCookie(reply, fastify.env.HARBOR_BASE_URL);
    void reply.status(204);
    return null;
  });

  fastify.get("/auth/me", async (request): Promise<{ user: AuthenticatedUser }> => {
    // The guard already rejects unauthenticated requests, so this is defence in
    // depth against /auth/me ever being added to the public allowlist by mistake.
    if (!request.user) throw new HarborError("UNAUTHENTICATED", "Authentication required.", 401);
    return { user: request.user };
  });
};
