import { useQuery } from "@tanstack/react-query";
import type { SeasonResponse, TitleDetailResponse } from "@harbor/shared";
import { request } from "./api-client";

export function useTitleDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["title", id],
    queryFn: () => request<TitleDetailResponse>("GET", `/api/v1/titles/${id ?? ""}`),
    enabled: id !== undefined && id !== "",
    // Detail is held for a day on the server, so re-requesting it on every
    // remount would only add round trips to reach the same cached answer.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useSeasonDetail(id: string | undefined, season: number | null) {
  return useQuery({
    queryKey: ["season", id, season],
    queryFn: () =>
      request<SeasonResponse>(
        "GET",
        `/api/v1/titles/${id ?? ""}/seasons/${String(season ?? 0)}`,
      ),
    // A movie has no seasons, and a series page renders before its season
    // list is known, so this must stay idle until there is a season to ask for.
    enabled: id !== undefined && id !== "" && season !== null,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** Joins the parts of a metadata line, dropping absent values so no stray
 *  separators appear when a provider omits a field. */
export function metaLine(parts: (string | number | null | undefined)[]): string {
  return parts
    .filter((p): p is string | number => p !== null && p !== undefined && p !== "")
    .join(" · ");
}
