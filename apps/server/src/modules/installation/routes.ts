import { isSetupComplete } from "@harbor/database";
import type { InstallationState } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { HARBOR_VERSION } from "../health/routes.js";

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
        version: HARBOR_VERSION,
      };
    },
  );
};
