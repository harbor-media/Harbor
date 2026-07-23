import type { DiscoverResponse, DiscoverType, GenreListResponse } from "@harbor/shared";
import { useQuery } from "@tanstack/react-query";
import { request } from "./api-client";

export function useGenres(type: DiscoverType) {
  return useQuery({
    queryKey: ["genres", type],
    queryFn: () => request<GenreListResponse>("GET", `/api/v1/genres/${type}`),
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useDiscover(type: DiscoverType, genreId: string | null, page: number) {
  return useQuery({
    queryKey: ["discover", type, genreId, page],
    queryFn: () =>
      request<DiscoverResponse>("GET", `/api/v1/discover/${type}/${genreId ?? ""}?page=${String(page)}`),
    // Only run once a genre is chosen.
    enabled: genreId !== null && genreId !== "",
    refetchOnWindowFocus: false,
    retry: false,
  });
}
