import {
  createInvitation,
  deriveInvitationStatus,
  listInvitations,
  revokeInvitation,
  type InvitationStatus,
  type InvitationSummary,
} from "@harbor/database";
import { roleRank, type CreateInvitationResponse, type Invitation, type UserRole } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HarborError } from "../../plugins/errors.js";
import { requireRole } from "../../plugins/require-role.js";
import { generateInviteToken, hashInviteToken } from "./tokens.js";

const CreateInvitationSchema = z.object({
  role: z.enum(["administrator", "user", "guest"]),
  email: z.email().optional(),
  maxUses: z.int().min(1).max(1000).optional(),
  expiresInDays: z.int().min(1).max(365).optional(),
});

const IdParamsSchema = z.object({ id: z.uuid() });

function toDTO(v: {
  id: string;
  role: UserRole;
  email: string | null;
  status: InvitationStatus;
  useCount: number;
  maxUses: number;
  expiresAt: Date | null;
  createdAt: Date;
}): Invitation {
  return {
    id: v.id,
    role: v.role,
    emailBound: v.email !== null,
    status: v.status,
    uses: v.useCount,
    maxUses: v.maxUses,
    expiresAt: v.expiresAt === null ? null : v.expiresAt.toISOString(),
    createdAt: v.createdAt.toISOString(),
  };
}

export const invitationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/invitations",
    {
      preHandler: [requireRole("administrator")],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply): Promise<CreateInvitationResponse> => {
      const parsed = CreateInvitationSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
      }
      const actor = request.user;
      if (!actor) throw new HarborError("UNAUTHENTICATED", "Authentication required.", 401);

      const { role, email, maxUses, expiresInDays } = parsed.data;

      // THE GRANTING RULE: you cannot mint a role at or above your own. Schema
      // already excludes "owner"; this blocks an admin minting "administrator".
      if (roleRank(role) >= roleRank(actor.role)) {
        throw new HarborError(
          "FORBIDDEN",
          "You cannot create an invitation for a role at or above your own.",
          403,
        );
      }

      const token = generateInviteToken();
      const expiresAt =
        expiresInDays === undefined ? null : new Date(Date.now() + expiresInDays * 86_400_000);

      const row = await createInvitation(fastify.db, {
        tokenHash: hashInviteToken(token),
        createdBy: actor.id,
        role,
        email: email ?? null,
        maxUses: maxUses ?? 1,
        expiresAt,
      });

      void reply.status(201);
      return {
        invitation: toDTO({ ...row, status: deriveInvitationStatus(row) }),
        token,
        inviteUrl: `${fastify.env.HARBOR_BASE_URL}/invite/${token}`,
      };
    },
  );

  fastify.get(
    "/invitations",
    { preHandler: [requireRole("administrator")] },
    async (): Promise<{ invitations: Invitation[] }> => {
      const rows: InvitationSummary[] = await listInvitations(fastify.db);
      return { invitations: rows.map(toDTO) };
    },
  );

  fastify.delete(
    "/invitations/:id",
    { preHandler: [requireRole("administrator")] },
    async (request, reply): Promise<{ revoked: true }> => {
      const parsed = IdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", "Invalid invitation id.", 400);
      }
      const changed = await revokeInvitation(fastify.db, parsed.data.id);
      if (!changed) {
        throw new HarborError("NOT_FOUND", "Invitation not found or already revoked.", 404);
      }
      void reply.status(200);
      return { revoked: true };
    },
  );
};
