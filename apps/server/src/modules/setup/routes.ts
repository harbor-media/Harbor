import { SetupAlreadyCompleteError, completeSetupWithOwner, createSession } from "@harbor/database";
import type { AuthenticatedUser } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HarborError } from "../../plugins/errors.js";
import { setSessionCookie } from "../auth/cookies.js";
import { hashPassword } from "../auth/passwords.js";
import { generateSessionToken, hashSessionToken, sessionExpiry } from "../auth/tokens.js";

// Usernames must never contain "@": createUser() (used for later invitation
// flows) rejects this too, but completeSetupWithOwner normalizes the username
// inline rather than calling createUser, so it does not get that check for
// free. The database CHECK constraint (users_username_no_at) would still
// catch it, but only as a raw Postgres error instead of a clean 400. Forbidding
// "@" keeps usernames and emails in disjoint namespaces, so identifier lookup
// (username-or-email) can never be ambiguous.
const SetupSchema = z.object({
  language: z.string().min(2).max(16),
  serverName: z.string().min(1).max(100),
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9._-]+$/, "Username may only contain letters, numbers, dots, underscores, and hyphens.")
    .refine((value) => !value.includes("@"), "Username must not contain \"@\"."),
  email: z.email(),
  // The owner account guards an internet-exposed server, so the minimum is
  // higher than an ordinary user password floor.
  password: z.string().min(12).max(200),
});

export const setupRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/setup",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply): Promise<{ user: AuthenticatedUser }> => {
      // Validated before hashing: Argon2id at these parameters costs ~50ms,
      // and this route is unauthenticated by necessity, so rejecting garbage
      // input cheaply (before paying that cost) keeps it from becoming a
      // CPU-exhaustion lever.
      const parsed = SetupSchema.safeParse(request.body);
      if (!parsed.success) {
        // Field paths only — the payload contains a password.
        throw new HarborError("VALIDATION_FAILED", "Invalid setup details.", 400);
      }

      // No separate "is setup already complete" pre-check here on purpose:
      // that would be a check-then-act race, since a second request could
      // pass the check before the first commits. completeSetupWithOwner's
      // transaction is the sole authority — it claims the installation row
      // atomically and throws SetupAlreadyCompleteError for every loser.

      // Hashed outside the transaction so Argon2 does not hold it open.
      const passwordHash = await hashPassword(parsed.data.password);

      let owner;
      try {
        owner = await completeSetupWithOwner(fastify.db, {
          serverName: parsed.data.serverName,
          language: parsed.data.language,
          username: parsed.data.username,
          email: parsed.data.email,
          passwordHash,
        });
      } catch (error) {
        if (error instanceof SetupAlreadyCompleteError) {
          // Reveals nothing about the existing install beyond "setup is done".
          throw new HarborError("SETUP_ALREADY_COMPLETE", "Setup has already been completed.", 409);
        }
        throw error;
      }

      const token = generateSessionToken();
      await createSession(fastify.db, {
        userId: owner.id,
        tokenHash: hashSessionToken(token),
        expiresAt: sessionExpiry(),
        userAgent: request.headers["user-agent"] ?? null,
        ip: request.ip,
      });
      setSessionCookie(reply, token, fastify.env.HARBOR_BASE_URL);

      fastify.log.info({ userId: owner.id }, "setup completed, owner created");
      void reply.status(201);
      return {
        user: { id: owner.id, username: owner.username, email: owner.email, role: owner.role },
      };
    },
  );
};
