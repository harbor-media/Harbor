import {
  createSession,
  createUser,
  deriveInvitationStatus,
  findInvitationByTokenHash,
  getRegistrationMode,
  InvitationUnusableError,
  InviteEmailMismatchError,
  redeemInvitation,
  type User,
} from "@harbor/database";
import type { InviteInspection, RegisterResponse } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HarborError } from "../../plugins/errors.js";
import { setSessionCookie } from "../auth/cookies.js";
import { hashPassword } from "../auth/passwords.js";
import { generateSessionToken, hashSessionToken, sessionExpiry } from "../auth/tokens.js";
import { hashInviteToken } from "../invitations/tokens.js";

const TokenParamsSchema = z.object({ token: z.string().min(1).max(512) });

// Usernames must never contain "@": redeemInvitation() and createUser() do
// not themselves reject this — they rely on the database CHECK constraint,
// which would surface as a raw 500 instead of a clean 400. Forbidding "@"
// here (mirrors the setup route) keeps usernames and emails in disjoint
// namespaces and rejects the bad input before either function is ever called.
const RegisterSchema = z.object({
  token: z.string().min(1).max(512).optional(),
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "Username may only contain letters, numbers, dots, underscores, and hyphens.",
    )
    .refine((v) => !v.includes("@"), 'Username must not contain "@".'),
  email: z.email(),
  password: z.string().min(12).max(200),
});

const NEGATIVE_INSPECTION: InviteInspection = { valid: false, role: null, emailBound: false };

export const registrationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/invitations/:token", async (request): Promise<InviteInspection> => {
    const parsed = TokenParamsSchema.safeParse(request.params);
    if (!parsed.success) return NEGATIVE_INSPECTION;

    const row = await findInvitationByTokenHash(fastify.db, hashInviteToken(parsed.data.token));
    // Invalid, spent, expired, revoked and never-existed all return the SAME
    // negative response so the endpoint cannot be used to enumerate tokens.
    if (!row || deriveInvitationStatus(row) !== "active") return NEGATIVE_INSPECTION;

    return { valid: true, role: row.role, emailBound: row.email !== null };
  });

  fastify.post(
    "/register",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply): Promise<RegisterResponse> => {
      const parsed = RegisterSchema.safeParse(request.body);
      if (!parsed.success) {
        // Generic message: this payload carries a password, so mirror the setup
        // route's stance and do not echo field-level detail from prettifyError.
        throw new HarborError("VALIDATION_FAILED", "Invalid registration details.", 400);
      }
      const { token, username, email, password } = parsed.data;

      const mode = await getRegistrationMode(fastify.db);
      if (mode === "disabled") {
        throw new HarborError("REGISTRATION_DISABLED", "Registration is disabled.", 403);
      }

      let user: User;

      if (mode === "invitation-only") {
        // Reject a missing token BEFORE paying the ~50ms Argon2 cost, matching
        // the setup route's "reject garbage before hashing" posture.
        if (!token) {
          throw new HarborError("INVITATION_INVALID", "A valid invitation is required.", 400);
        }
        const passwordHash = await hashPassword(password);
        try {
          user = await redeemInvitation(fastify.db, {
            tokenHash: hashInviteToken(token),
            username,
            email,
            passwordHash,
          });
        } catch (error) {
          if (error instanceof InvitationUnusableError) {
            throw new HarborError("INVITATION_INVALID", "This invitation is no longer valid.", 400);
          }
          if (error instanceof InviteEmailMismatchError) {
            throw new HarborError(
              "VALIDATION_FAILED",
              "This invitation is bound to a different email address.",
              400,
            );
          }
          throw error;
        }
      } else {
        // open: create a user-role account with no invite.
        const passwordHash = await hashPassword(password);
        user = await createUser(fastify.db, { username, email, passwordHash, role: "user" });
      }

      const sessionToken = generateSessionToken();
      await createSession(fastify.db, {
        userId: user.id,
        tokenHash: hashSessionToken(sessionToken),
        expiresAt: sessionExpiry(),
        userAgent: request.headers["user-agent"] ?? null,
        ip: request.ip,
      });
      setSessionCookie(reply, sessionToken, fastify.env.HARBOR_BASE_URL);

      void reply.status(201);
      return { user: { id: user.id, username: user.username, email: user.email, role: user.role } };
    },
  );
};
