import type { HarborEnv } from "@harbor/config";
import type { Db, Sql } from "@harbor/database";
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
  HARBOR_VERSION: "0.1.0-test",
  HARBOR_CACHE_MAX_SIZE: 2_147_483_648,
};

export interface FakeSqlHandle {
  /** Minimal `Sql`-shaped test double: callable as a tagged template. */
  sql: Sql;
  /** Number of times the fake was invoked (i.e. queries issued). */
  queryCount: () => number;
  /** Flip whether the next invocation resolves or throws. */
  setShouldFail: (shouldFail: boolean) => void;
}

/**
 * A minimal stand-in for the postgres.js `Sql` tagged-template callable.
 * Real `Sql` values are callable as `` sql`select 1` `` (a tagged template
 * invocation, i.e. `sql(strings, ...values)`), so the fake only needs to be
 * callable and thenable-compatible — it does not need to implement the rest
 * of the postgres.js surface, which the health probe never touches.
 */
export function createFakeSql(initialShouldFail = false): FakeSqlHandle {
  let count = 0;
  let shouldFail = initialShouldFail;
  const fn = ((..._args: unknown[]): Promise<unknown[]> => {
    count += 1;
    if (shouldFail) {
      return Promise.reject(new Error("simulated database outage"));
    }
    return Promise.resolve([{ "?column?": 1 }]);
  }) as unknown as Sql;

  return {
    sql: fn,
    queryCount: () => count,
    setShouldFail: (value: boolean) => {
      shouldFail = value;
    },
  };
}

export interface BuildTestAppOptions {
  ready?: boolean;
  sql?: Sql;
}

export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<HarborApp> {
  const state = createRuntimeState();
  if (options.ready) {
    state.databaseReady = true;
    state.migrationsApplied = true;
    state.dataDirectoryWritable = true;
  }
  // Default fake mirrors the boot-time flag so existing readiness
  // expectations hold without every test needing to supply its own probe.
  const sql = options.sql ?? createFakeSql(!options.ready).sql;
  return createApp({
    env: testEnv,
    logger: createLogger({ level: "silent", production: true }),
    db: {} as Db,
    sql,
    state,
  });
}
