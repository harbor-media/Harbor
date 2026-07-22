import type { CatalogKind, CatalogRowResponse } from "@harbor/shared";
import { useQuery } from "@tanstack/react-query";
import { request } from "./api-client";

export const CATALOG_LABELS: Record<CatalogKind, string> = {
  trending: "Trending",
  "popular-movies": "Popular movies",
  "popular-series": "Popular series",
  "new-releases": "New releases",
};

export function useCatalogRow(kind: CatalogKind) {
  return useQuery({
    queryKey: ["catalog", kind],
    queryFn: () => request<CatalogRowResponse>("GET", `/api/v1/catalog/${kind}`),
    // The server already caches for six hours; refetching on every window
    // focus would spend requests to receive the identical payload.
    refetchOnWindowFocus: false,
    retry: false,
  });
}
