import { getRegistrationMode, isSetupComplete } from "@harbor/database";
import type { InstallationState } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";

export const installationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/installation/state",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (): Promise<InstallationState> => {
      return {
        setupComplete: await isSetupComplete(fastify.db),
        version: fastify.env.HARBOR_VERSION,
        // Not sensitive: whether open registration is allowed is discoverable
        // by attempting to register, so exposing it here (unauthenticated)
        // lets the signed-out login screen decide whether to show a
        // "Create account" link.
        registrationMode: await getRegistrationMode(fastify.db),
      };
    },
  );
};
