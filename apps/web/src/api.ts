export interface InstallationState {
  setupComplete: boolean;
  version: string;
}

export async function fetchInstallationState(signal: AbortSignal): Promise<InstallationState> {
  const response = await fetch("/api/v1/installation/state", { signal });
  if (!response.ok) {
    throw new Error(`Installation state request failed with ${String(response.status)}`);
  }
  return (await response.json()) as InstallationState;
}
