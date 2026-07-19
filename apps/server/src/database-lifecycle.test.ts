import type * as HarborDatabase from "@harbor/database";
import type { Db, Sql } from "@harbor/database";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return {
    ...actual,
    runMigrations: vi.fn(),
    ensureInstallationRow: vi.fn(),
  };
});

const { runMigrations, ensureInstallationRow } = await import("@harbor/database");
const {
  connectWithRetry,
  ensureDatabaseInitialized,
  refreshDatabaseReadiness,
} = await import("./database-lifecycle.js");
const { createRuntimeState } = await import("./state.js");
const { testEnv } = await import("./test-helpers.js");

function fakeLogger(): FastifyBaseLogger {
  return {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "silent",
    child: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

/** A fake `Sql` tagged-template callable that fails its first `failTimes` invocations. */
function makeSql(failTimes: number): Sql {
  let calls = 0;
  return ((..._args: unknown[]): Promise<unknown[]> => {
    calls += 1;
    if (calls <= failTimes) {
      return Promise.reject(new Error("simulated database outage"));
    }
    return Promise.resolve([{ "?column?": 1 }]);
  }) as unknown as Sql;
}

describe("connectWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off between attempts and resolves once the connection succeeds", async () => {
    const sql = makeSql(3);
    const logger = fakeLogger();

    const promise = connectWithRetry(sql, logger, {
      attempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it("gives up and rejects once the attempt bound is exhausted", async () => {
    const sql = makeSql(Number.POSITIVE_INFINITY);
    const logger = fakeLogger();

    const promise = connectWithRetry(sql, logger, {
      attempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
    });
    const assertion = expect(promise).rejects.toThrow("simulated database outage");

    await vi.runAllTimersAsync();
    await assertion;
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});

describe("deferred database initialization", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stays not-ready while the database is unreachable, then completes once it recovers", async () => {
    const state = createRuntimeState();
    const db = {} as Db;
    const logger = fakeLogger();

    vi.mocked(runMigrations).mockResolvedValue(undefined);
    vi.mocked(ensureInstallationRow).mockResolvedValue(undefined);

    // Outage: the probe fails, migrations never run.
    await refreshDatabaseReadiness(state, testEnv, db, makeSql(Number.POSITIVE_INFINITY), logger);
    expect(state.databaseReady).toBe(false);
    expect(state.migrationsApplied).toBe(false);
    expect(runMigrations).not.toHaveBeenCalled();

    // Recovery: force past the TTL cache and probe again with a healthy connection.
    state.databaseProbedAt = 0;
    await refreshDatabaseReadiness(state, testEnv, db, makeSql(0), logger);

    expect(state.databaseReady).toBe(true);
    expect(state.migrationsApplied).toBe(true);
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(ensureInstallationRow).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent in-process initialization attempts into a single migration run", async () => {
    const state = createRuntimeState();
    const db = {} as Db;
    const logger = fakeLogger();

    let resolveMigrate!: () => void;
    vi.mocked(runMigrations).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveMigrate = resolve;
        }),
    );
    vi.mocked(ensureInstallationRow).mockResolvedValue(undefined);

    const first = ensureDatabaseInitialized(state, testEnv, db, logger);
    const second = ensureDatabaseInitialized(state, testEnv, db, logger);

    // Same in-flight promise: no second migration run was started.
    expect(first).toBe(second);

    resolveMigrate();
    await first;
    await second;

    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(state.migrationsApplied).toBe(true);
    expect(state.initPromise).toBeNull();
  });

  it("is a no-op once migrations are already applied", async () => {
    const state = createRuntimeState();
    state.migrationsApplied = true;
    const db = {} as Db;
    const logger = fakeLogger();

    await ensureDatabaseInitialized(state, testEnv, db, logger);

    expect(runMigrations).not.toHaveBeenCalled();
    expect(ensureInstallationRow).not.toHaveBeenCalled();
  });
});
