import { roleRank, type UserRole } from "@harbor/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { HarborError } from "./errors.js";

/**
 * Returns a Fastify preHandler that enforces a minimum role. It runs AFTER the
 * global onRequest auth guard, so request.user is already populated (or the
 * guard returned 401 and this never runs). The null check is a defensive
 * backstop. On insufficient rank it fails closed with 403 FORBIDDEN.
 */
export function requireRole(minRole: UserRole) {
  return async function requireRoleHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (!request.user) {
      throw new HarborError("UNAUTHENTICATED", "Authentication required.", 401);
    }
    if (roleRank(request.user.role) < roleRank(minRole)) {
      throw new HarborError("FORBIDDEN", "You do not have permission to perform this action.", 403);
    }
  };
}
