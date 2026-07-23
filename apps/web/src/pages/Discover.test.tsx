import type { DiscoverResponse, GenreListResponse } from "@harbor/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type * as discoverModule from "../discover";
import { Discover } from "./Discover";

const genresState = vi.hoisted(() => ({ current: {} as Partial<UseQueryResult<GenreListResponse>> }));
const discoverState = vi.hoisted(() => ({ current: {} as Partial<UseQueryResult<DiscoverResponse>> }));

vi.mock("../discover", async (importOriginal) => {
  const actual = await importOriginal<typeof discoverModule>();
  return { ...actual, useGenres: () => genresState.current, useDiscover: () => discoverState.current };
});

function renderDiscover(entry = "/discover?type=movie&genre=28"): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: JSX.Element = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Discover />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(ui);
}

describe("Discover", () => {
  it("renders a poster grid for the selected genre", () => {
    genresState.current = { data: { type: "movie", genres: [{ id: "28", name: "Action" }], cached: false } };
    discoverState.current = {
      data: {
        type: "movie",
        genreId: "28",
        page: 1,
        totalPages: 1,
        titles: [{ id: "a", type: "movie", title: "Blade Runner", year: 1982, posterPath: "/p.jpg" }],
      },
    };
    renderDiscover();
    expect(screen.queryByRole("link", { name: /blade runner/i })).not.toBeNull();
  });

  it("shows Load more only when more pages remain", () => {
    genresState.current = { data: { type: "movie", genres: [{ id: "28", name: "Action" }], cached: false } };
    discoverState.current = {
      data: { type: "movie", genreId: "28", page: 1, totalPages: 3, titles: [] },
    };
    renderDiscover();
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeNull();
  });

  it("hides Load more on the last page", () => {
    genresState.current = { data: { type: "movie", genres: [{ id: "28", name: "Action" }], cached: false } };
    discoverState.current = {
      data: { type: "movie", genreId: "28", page: 3, totalPages: 3, titles: [] },
    };
    renderDiscover();
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });
});
