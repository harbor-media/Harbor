import { describe, expect, it, vi } from "vitest";
import { createTmdbProvider } from "./tmdb.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SIGNAL = (): AbortSignal => AbortSignal.timeout(5000);

describe("tmdb getCatalog", () => {
  it("advertises all four kinds", () => {
    const provider = createTmdbProvider("key");
    expect([...provider.catalogs].sort()).toEqual([
      "new-releases",
      "popular-movies",
      "popular-series",
      "trending",
    ]);
  });

  it("requests the right endpoint per kind", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      urls.push(url);
      return Promise.resolve(json({ results: [] }));
    }) as unknown as typeof fetch;
    const provider = createTmdbProvider("key", { baseUrl: "http://x", fetchImpl });

    await provider.getCatalog("trending", "en-US", SIGNAL());
    await provider.getCatalog("popular-movies", "en-US", SIGNAL());
    await provider.getCatalog("popular-series", "en-US", SIGNAL());
    await provider.getCatalog("new-releases", "en-US", SIGNAL());

    expect(urls[0]).toContain("/trending/all/week");
    expect(urls[1]).toContain("/movie/popular");
    expect(urls[2]).toContain("/tv/popular");
    expect(urls[3]).toContain("/movie/now_playing");
  });

  it("supplies media_type for single-type endpoints, which TMDB omits there", async () => {
    // /movie/popular and /tv/popular return no media_type at all. normalize()
    // drops anything that is not "movie" or "tv", so without this the row
    // would come back empty and look like an outage.
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: (() =>
        Promise.resolve(
          json({ results: [{ id: 78, title: "Blade Runner" }] }),
        )) as unknown as typeof fetch,
    });

    const results = await provider.getCatalog("popular-movies", "en-US", SIGNAL());

    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("movie");
  });

  it("trusts media_type on the trending endpoint, which mixes types", async () => {
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: (() =>
        Promise.resolve(
          json({
            results: [
              { id: 1, media_type: "tv", name: "A Series" },
              { id: 2, media_type: "movie", title: "A Film" },
              { id: 3, media_type: "person", name: "An Actor" },
            ],
          }),
        )) as unknown as typeof fetch,
    });

    const results = await provider.getCatalog("trending", "en-US", SIGNAL());

    // The person is dropped: people are not watchable and must not enter the
    // catalog.
    expect(results.map((r) => r.type)).toEqual(["series", "movie"]);
  });

  it("classifies a malformed payload as an outage", async () => {
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: (() => Promise.resolve(json({ results: "nope" }))) as unknown as typeof fetch,
    });

    await expect(provider.getCatalog("trending", "en-US", SIGNAL())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
