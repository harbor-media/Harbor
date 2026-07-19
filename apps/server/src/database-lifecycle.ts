import type { HarborEnv } from "@harbor/config";
import { ensureInstallationRow, runMigrations, type Db, type Sql } from "@harbor/database";
import type { FastifyBaseLogger } from "fastify";
import { MIGRATIONS_FOLDER } from "./paths.js";
import { READINESS_PROBE_TTL_MS, type RuntimeState } from "./state.js";

/**
 * Bound how long a hung database can make a readiness probe itself hang. A
 * dead-but-not-refusing connection (firewall black hole, overloaded host)
 * must still produce a prompt result rather than stalling the caller.
 */
const DATABASE_PROBE_TIMEOUT_MS = 2_000;

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** A handful of attempts over roughly 30 seconds: 0.5s, 1s, 2s, 4s, 8s, 8s. */
export const DEFAULT_CONNECT_RETRY: RetryOptions = {
  attempts: 6,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Opens the initial database connection with bounded exponential backoff.
 * Compose's `depends_on: service_healthy` usually means postgres already
 * accepts connections by the time Harbor starts, but this absorbs the
 * ordinary startup race where it briefly does not. Callers must invoke this
 * only after the HTTP listener is already bound (per boot design) so retrying
 * here never delays Harbor from being observable.
 */
export async function connectWithRetry(
  sql: Sql,
  logger: FastifyBaseLogger,
  options: RetryOptions = DEFAULT_CONNECT_RETRY,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      await sql`select 1`;
      return;
    } catch (error) {
      lastError = error;
      logger.warn(
        { err: error, attempt, attempts: options.attempts },
        "database connection attempt failed",
      );
      if (attempt < options.attempts) {
        const delayMs = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
        await delay(delayMs);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("database connection failed");
}

async function probeDatabase(sql: Sql, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sql`select 1`,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("database readiness probe timed out"));
        }, timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs migrations and seeds the installation row. Safe to call repeatedly:
 * `state.migrationsApplied` short-circuits once it has succeeded, and
 * `state.initPromise` collapses concurrent in-process callers (readiness
 * polls, the not-ready gate, boot) onto a single attempt. Cross-process
 * safety is handled separately by the migration runner's own PostgreSQL
 * advisory lock.
 */
export function ensureDatabaseInitialized(
  state: RuntimeState,
  env: HarborEnv,
  db: Db,
  logger: FastifyBaseLogger,
): Promise<void> {
  if (state.migrationsApplied) return Promise.resolve();
  if (state.initPromise) return state.initPromise;

  const promise = (async (): Promise<void> => {
    try {
      await runMigrations(env.DATABASE_URL, MIGRATIONS_FOLDER);
      state.migrationsApplied = true;
      await ensureInstallationRow(db);
      logger.info("migrations applied");
    } catch (error) {
      logger.error(
        { err: error },
        "database initialization failed; will retry on the next readiness check",
      );
    } finally {
      state.initPromise = null;
    }
  })();

  state.initPromise = promise;
  return promise;
}

/**
 * Refreshes `state.databaseReady` from a live probe when the cached result
 * has gone stale, and opportunistically completes deferred database
 * initialization once the database is reachable again. This is the single
 * refresh path shared by the readiness route and the not-ready request gate,
 * so a request arriving mid-outage and a request arriving after recovery
 * both observe the same state rather than a stale cached flag.
 */
export async function refreshDatabaseReadiness(
  state: RuntimeState,
  env: HarborEnv,
  db: Db,
  sql: Sql,
  logger: FastifyBaseLogger,
): Promise<void> {
  const now = Date.now();
  if (now - state.databaseProbedAt < READINESS_PROBE_TTL_MS) {
    return;
  }
  state.databaseReady = await probeDatabase(sql, DATABASE_PROBE_TIMEOUT_MS);
  state.databaseProbedAt = Date.now();

  if (state.databaseReady && !state.migrationsApplied) {
    await ensureDatabaseInitialized(state, env, db, logger);
  }
}
