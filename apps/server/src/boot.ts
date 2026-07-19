import { access, constants, mkdir } from "node:fs/promises";
import { loadEnv } from "@harbor/config";
import { closeClient, createClient, ensureInstallationRow, isSetupComplete, runMigrations } from "@harbor/database";
import { createLogger, type Logger } from "@harbor/logger";
import { createApp, type HarborApp } from "./app.js";
import { MIGRATIONS_FOLDER } from "./paths.js";
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

  // 4-5. Database, then migrations under the advisory lock.
  try {
    await sql`select 1`;
    state.databaseReady = true;
    logger.info("database connected");

    await runMigrations(env.DATABASE_URL, MIGRATIONS_FOLDER);
    state.migrationsApplied = true;
    logger.info("migrations applied");

    await ensureInstallationRow(db);
  } catch (error) {
    logger.error({ err: error }, "database initialization failed; staying not-ready");
  }

  // 6. Data directory.
  state.dataDirectoryWritable = await ensureDataDirectory(env.HARBOR_DATA_DIRECTORY, logger);

  // 7. Log install state once. The endpoint queries live rather than caching,
  // because a cached flag goes stale as soon as a second container exists.
  if (state.migrationsApplied) {
    logger.info({ setupComplete: await isSetupComplete(db) }, "installation state");
  }

  logger.info({ ready: state.databaseReady && state.migrationsApplied && state.dataDirectoryWritable }, "boot complete");

  const shutdown = async (): Promise<void> => {
    logger.info("shutting down");
    await app.close();
    await closeClient(sql);
    logger.info("shutdown complete");
  };

  return { app, shutdown };
}
