import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MetadataConfigStatus, SearchResponse } from "@harbor/shared";
import { ApiError, request } from "./api-client";

// Re-exported so existing consumers keep importing ApiError from here.
export { ApiError };

export interface MetadataConfigInput {
  apiKey: string;
  language: string;
  enabled: boolean;
}

export function useMetadataConfig() {
  return useQuery({
    queryKey: ["metadata-config"],
    queryFn: () => request<MetadataConfigStatus>("GET", "/api/v1/admin/metadata/config"),
  });
}

export function useTestMetadataKey() {
  return useMutation({
    mutationFn: (input: MetadataConfigInput) =>
      request<{ valid: true }>("POST", "/api/v1/admin/metadata/test", input),
  });
}

export function useSaveMetadataConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MetadataConfigInput) =>
      request<MetadataConfigStatus>("PUT", "/api/v1/admin/metadata/config", input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["metadata-config"] });
    },
  });
}

export function useSearch(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["search", trimmed],
    queryFn: () =>
      request<SearchResponse>("GET", `/api/v1/search?q=${encodeURIComponent(trimmed)}`),
    enabled: trimmed.length > 0,
    // The search endpoint is rate limited and every miss costs an upstream
    // call, so results are held rather than refetched on incidental events.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * Maps API error codes to advice a server owner can act on. The distinction
 * that matters: an unreachable provider is not the administrator's fault, and
 * telling them to check their key would send them to fix something that is
 * not broken.
 */
export function describeMetadataError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : "Something went wrong.";
  }
  switch (error.code) {
    case "METADATA_PROVIDER_UNAUTHORIZED":
      return "TMDB rejected this key. Check that you copied the API Read Access Token correctly.";
    case "METADATA_PROVIDER_UNAVAILABLE":
      return "TMDB could not be reached — this is not a problem with your key. Try again shortly.";
    case "METADATA_NOT_CONFIGURED":
      return "No metadata provider is configured yet.";
    case "METADATA_KEY_UNREADABLE":
      return "The stored key could not be decrypted, which happens when HARBOR_SECRET changes. Enter the TMDB key again to restore search.";
    default:
      return error.message;
  }
}
