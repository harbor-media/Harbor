import { describe, expect, it, vi } from "vitest";
import { createTmdbProvider } from "./tmdb.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SIGNAL = (): AbortSignal => AbortSignal.timeout(5000);

describe("tmdb discover capability", () => {
  it("advertises discover support", () => {
    expect(createTmdbProvider("key").supportsDiscover).toBe(true);
  });

  it("fetches the genre list for the right endpoint per type", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      urls.push(url);
      return Promise.resolve(json({ genres: [{ id: 28, name: "Action" }] }));
    }) as unknown as typeof fetch;
    const provider = createTmdbProvider("key", { baseUrl: "http://x", fetchImpl });

    const movie = await provider.getGenres("movie", "en-US", SIGNAL());
    await provider.getGenres("series", "en-US", SIGNAL());

    expect(urls[0]).toContain("/genre/movie/list");
    expect(urls[1]).toContain("/genre/tv/list");
    // ids are stringified for Harbor.
    expect(movie).toEqual([{ id: "28", name: "Action" }]);
  });

  it("drops a malformed genre entry without discarding the rest", async () => {
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: (() =>
        Promise.resolve(json({ genres: [{ id: 28, name: "Action" }, { id: 35 }] }))) as unknown as typeof fetch,
    });

    expect(await provider.getGenres("movie", "en-US", SIGNAL())).toEqual([{ id: "28", name: "Action" }]);
  });

  it("classifies a malformed genre payload as an outage", async () => {
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: (() => Promise.resolve(json({ genres: "nope" }))) as unknown as typeof fetch,
    });

    await expect(provider.getGenres("movie", "en-US", SIGNAL())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("discovers by genre, hitting the right endpoint and passing page + genre", async () => {
    const urls: string[] = [];
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: ((url: string) => {
        urls.push(url);
        return Promise.resolve(json({ page: 2, total_pages: 9, results: [{ id: 78, title: "Blade Runner" }] }));
      }) as unknown as typeof fetch,
    });

    const result = await provider.discoverByGenre("movie", "878", 2, "en-US", SIGNAL());

    expect(urls[0]).toContain("/discover/movie");
    expect(urls[0]).toContain("with_genres=878");
    expect(urls[0]).toContain("page=2");
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(9);
    // /discover/movie omits media_type; the adapter injects it so normalize keeps the title.
    expect(result.titles).toHaveLength(1);
    expect(result.titles[0]?.type).toBe("movie");
  });

  it("maps series to the tv discover endpoint", async () => {
    const urls: string[] = [];
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: ((url: string) => {
        urls.push(url);
        return Promise.resolve(json({ page: 1, total_pages: 1, results: [] }));
      }) as unknown as typeof fetch,
    });

    await provider.discoverByGenre("series", "18", 1, "en-US", SIGNAL());
    expect(urls[0]).toContain("/discover/tv");
  });
});
