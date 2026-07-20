import { getRegistrationMode, setRegistrationMode } from "@harbor/database";
import type { RegistrationMode } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HarborError } from "../../plugins/errors.js";
import { requireRole } from "../../plugins/require-role.js";

const RegistrationPatchSchema = z.object({
  mode: z.enum(["disabled", "invitation-only", "open"]),
  acknowledgeOpenRisk: z.boolean().optional(),
});

export const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/settings/registration",
    { preHandler: [requireRole("administrator")] },
    async (): Promise<{ mode: RegistrationMode }> => {
      return { mode: await getRegistrationMode(fastify.db) };
    },
  );

  fastify.patch(
    "/settings/registration",
    { preHandler: [requireRole("administrator")] },
    async (request): Promise<{ mode: RegistrationMode }> => {
      const parsed = RegistrationPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
      }
      const { mode, acknowledgeOpenRisk } = parsed.data;

      // Server-side half of "the owner must be warned before enabling open
      // registration": refuse to silently open registration, even against a
      // hand-crafted request that skips the UI warning.
      if (mode === "open" && acknowledgeOpenRisk !== true) {
        throw new HarborError(
          "VALIDATION_FAILED",
          "Enabling open registration lets anyone create an account without an invitation. Resend with acknowledgeOpenRisk: true to confirm.",
          400,
        );
      }

      await setRegistrationMode(fastify.db, mode);
      return { mode };
    },
  );
};
