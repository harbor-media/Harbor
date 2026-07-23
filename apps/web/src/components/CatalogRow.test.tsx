import type { CatalogRowResponse } from "@harbor/shared";
import { render, screen } from "@testing-library/react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type * as catalogModule from "../catalog";
import { ApiError } from "../metadata";
import { CatalogRow } from "./CatalogRow";

// CatalogRow's branching (hide on unsupported, hide on empty, isolate on
// error, render on data) is decided from the query result. Mocking the query
// hook drives each branch directly; the fetch itself is covered by the server
// tests, and jsdom cannot exercise the scroll geometry regardless.
const rowState = vi.hoisted(() => ({ current: {} as Partial<UseQueryResult<CatalogRowResponse>> }));

vi.mock("../catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof catalogModule>();
  return { ...actual, useCatalogRow: () => rowState.current };
});

function renderRow(state: Partial<UseQueryResult<CatalogRowResponse>>): void {
  rowState.current = state;
  const ui: JSX.Element = (
    <MemoryRouter>
      <CatalogRow kind="trending" />
    </MemoryRouter>
  );
  render(ui);
}

const titles: CatalogRowResponse["titles"] = [
  { id: "a", type: "movie", title: "Blade Runner", year: 1982, posterPath: "/p.jpg" },
];

describe("CatalogRow", () => {
  it("renders posters when the row has titles", () => {
    renderRow({ data: { kind: "trending", titles, cached: false } });
    expect(screen.queryByRole("heading", { name: "Trending" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: /blade runner/i })).not.toBeNull();
  });

  it("hides itself when the provider cannot serve the kind", () => {
    // A 409 is not an error to show the user -- this installation's provider
    // simply does not offer this row, so the row disappears rather than
    // rendering a broken shelf.
    renderRow({ error: new ApiError("CATALOG_KIND_UNSUPPORTED", "nope"), isError: true });
    expect(screen.queryByRole("heading", { name: "Trending" })).toBeNull();
  });

  it("hides itself when the row is empty", () => {
    // An empty shelf communicates nothing.
    renderRow({ data: { kind: "trending", titles: [], cached: false } });
    expect(screen.queryByRole("heading", { name: "Trending" })).toBeNull();
  });

  it("shows a scoped error instead of vanishing when the fetch fails for another reason", () => {
    // A genuine failure keeps the heading and shows an inline alert, so one
    // failing row cannot blank the others -- the whole point of a query per row.
    renderRow({ error: new ApiError("INTERNAL_ERROR", "boom"), isError: true });
    expect(screen.queryByRole("heading", { name: "Trending" })).not.toBeNull();
    expect(screen.queryByRole("alert")).not.toBeNull();
  });
});
