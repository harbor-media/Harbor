import { access, constants, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "@harbor/config";
import { closeClient, createClient, isSetupComplete } from "@harbor/database";
import { createLogger, type Logger } from "@harbor/logger";
import { createApp, type HarborApp } from "./app.js";
import { connectWithRetry, ensureDatabaseInitialized } from "./database-lifecycle.js";
import { startEvictionSweep } from "./modules/images/scheduler.js";
import { createRuntimeState } from "./state.js";

export interface Bootstrapped {
  app: HarborApp;
  shutdown: () => Promise<void>;
}

async function ensureDataDirectory(directory: string, logger: Logger): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.W_OK);
    return true;
  } catch (error) {
    logger.error({ err: error, directory }, "data directory is not writable");
    return false;
  }
}

export async function bootstrap(): Promise<Bootstrapped> {
  // 1. Config. A failure here exits before anything else initializes.
  const env = loadEnv();

  // 2. Logger, with redaction installed before any other code can log.
  const logger = createLogger({
    level: env.HARBOR_LOG_LEVEL,
    production: env.NODE_ENV === "production",
  });

  const state = createRuntimeState();
  const { sql, db } = createClient(env.DATABASE_URL);

  // 3. Bind the listener early so startup progress is observable.
  const app = await createApp({ env, logger, db, sql, state });
  await app.listen({ port: env.HARBOR_PORT, host: env.HARBOR_HOST });
  logger.info({ port: env.HARBOR_PORT }, "listening, readiness pending");

  // 4-5. Database, retrying the initial connection with backoff, then
  // migrations under the advisory lock. If this fails after retrying, boot
  // continues rather than crashing the process: `ensureDatabaseInitialized`
  // is retried from the readiness path (see database-lifecycle.ts), so a
  // database that comes back later still lets Harbor become ready without a
  // manual restart.
  try {
    await connectWithRetry(sql, logger);
    state.databaseReady = true;
    state.databaseProbedAt = Date.now();
    logger.info("database connected");

    await ensureDatabaseInitialized(state, env, db, logger);
  } catch (error) {
    logger.error(
      { err: error },
      "database connection failed after retries; staying not-ready until it recovers",
    );
  }

  // 6. Data directory.
  state.dataDirectoryWritable = await ensureDataDirectory(env.HARBOR_DATA_DIRECTORY, logger);

  // 7. Log install state once. The endpoint queries live rather than caching,
  // because a cached flag goes stale as soon as a second container exists.
  if (state.migrationsApplied) {
    logger.info({ setupComplete: await isSetupComplete(db) }, "installation state");
  }

  logger.info({ ready: state.databaseReady && state.migrationsApplied && state.dataDirectoryWritable }, "boot complete");

  // Bounds the image cache on a timer. Started after the data directory
  // check so a broken volume is reported before a sweep touches it.
  const imageSweep = startEvictionSweep({
    root: path.join(env.HARBOR_DATA_DIRECTORY, "cache", "images"),
    maxBytes: env.HARBOR_CACHE_MAX_SIZE,
    logger,
  });

  const shutdown = async (): Promise<void> => {
    logger.info("shutting down");
    imageSweep.stop();
    await app.close();
    await closeClient(sql);
    logger.info("shutdown complete");
  };

  return { app, shutdown };
}
