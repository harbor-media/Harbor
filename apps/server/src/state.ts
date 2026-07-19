export interface RuntimeState {
  startedAt: number;
  databaseReady: boolean;
  migrationsApplied: boolean;
  dataDirectoryWritable: boolean;
}

export function createRuntimeState(): RuntimeState {
  return {
    startedAt: Date.now(),
    databaseReady: false,
    migrationsApplied: false,
    dataDirectoryWritable: false,
  };
}

export function isReady(state: RuntimeState): boolean {
  return state.databaseReady && state.migrationsApplied && state.dataDirectoryWritable;
}
