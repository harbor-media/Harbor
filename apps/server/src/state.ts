export interface RuntimeState {
  startedAt: number;
  databaseReady: boolean;
  migrationsApplied: boolean;
  dataDirectoryWritable: boolean;
  /**
   * Epoch ms of the last live database readiness probe. 0 means "never
   * probed" so the very first readiness request always probes rather than
   * trusting a stale boot-time flag.
   */
  databaseProbedAt: number;
  /**
   * Set while a deferred database initialization (migrations + installation
   * row) is in flight, so concurrent in-process callers (readiness polls,
   * the not-ready request gate) await the same attempt instead of racing
   * duplicate migration runs. Cleared once the attempt settles, whether it
   * succeeded or failed.
   */
  initPromise: Promise<void> | null;
}

/**
 * How long a live readiness probe result is trusted before the next
 * `/health/ready` request triggers another database round-trip. Keeps
 * orchestrator polling (Docker/Compose probe every 30s) from hammering the
 * database while still catching an outage within a handful of seconds.
 */
export const READINESS_PROBE_TTL_MS = 5_000;

export function createRuntimeState(): RuntimeState {
  return {
    startedAt: Date.now(),
    databaseReady: false,
    migrationsApplied: false,
    dataDirectoryWritable: false,
    databaseProbedAt: 0,
    initPromise: null,
  };
}

export function isReady(state: RuntimeState): boolean {
  return state.databaseReady && state.migrationsApplied && state.dataDirectoryWritable;
}
