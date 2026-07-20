import { useQuery } from "@tanstack/react-query";
import type { InstallationState } from "@harbor/shared";

export type { InstallationState };

export async function fetchInstallationState(signal: AbortSignal): Promise<InstallationState> {
  const response = await fetch("/api/v1/installation/state", { signal });
  if (!response.ok) {
    throw new Error(`Installation state request failed with ${String(response.status)}`);
  }
  return (await response.json()) as InstallationState;
}

// Shared query definition/key so every consumer (route guard, Login,
// Register) reads the same TanStack Query cache entry instead of issuing
// independent fetches.
export function useInstallationState() {
  return useQuery({
    queryKey: ["installation-state"],
    queryFn: ({ signal }) => fetchInstallationState(signal),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 2,
  });
}
