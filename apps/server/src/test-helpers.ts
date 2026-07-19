import type { HarborEnv } from "@harbor/config";
import type { Db } from "@harbor/database";
import { createLogger } from "@harbor/logger";
import { createApp, type HarborApp } from "./app.js";
import { createRuntimeState } from "./state.js";

export const testEnv: HarborEnv = {
  NODE_ENV: "test",
  HARBOR_PORT: 3000,
  HARBOR_HOST: "0.0.0.0",
  DATABASE_URL: "postgresql://harbor:pw@localhost:5432/harbor",
  HARBOR_BASE_URL: "http://localhost:3000",
  HARBOR_SECRET: "0123456789abcdef0123456789abcdef",
  HARBOR_DATA_DIRECTORY: "/data",
  HARBOR_LOG_LEVEL: "fatal",
  HARBOR_TRUST_PROXY: false,
};

export interface BuildTestAppOptions {
  ready?: boolean;
}

export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<HarborApp> {
  const state = createRuntimeState();
  if (options.ready) {
    state.databaseReady = true;
    state.migrationsApplied = true;
    state.dataDirectoryWritable = true;
  }
  return createApp({
    env: testEnv,
    logger: createLogger({ level: "silent", production: true }),
    db: {} as Db,
    state,
  });
}
