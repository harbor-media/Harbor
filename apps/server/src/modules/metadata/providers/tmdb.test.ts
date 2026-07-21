import { describe, expect, it, vi } from "vitest";
import { createTmdbProvider } from "./tmdb.js";
import { MetadataProviderError } from "./types.js";

const SEARCH_PAYLOAD = {
  results: [
    {
      id: 78,
      media_type: "movie",
      title: "Blade Runner",
      original_title: "Blade Runner",
      release_date: "1982-06-25",
      overview: "A blade runner must pursue replicants.",
      poster_path: "/poster.jpg",
      backdrop_path: "/backdrop.jpg",
    },
    {
      id: 1622,
      media_type: "tv",
      name: "Supernatural",
      original_name: "Supernatural",
      first_air_date: "2005-09-13",
      overview: "Two brothers hunt monsters.",
      poster_path: "/sn.jpg",
      backdrop_path: null,
    },
    { id: 999, media_type: "person", name: "Ridley Scott" },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createTmdbProvider.search", () => {
  it("normalizes movies and series into Harbor titles", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SEARCH_PAYLOAD));
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });

    const results = await provider.search(
      { query: "blade runner", language: "en-US" },
      AbortSignal.timeout(5000),
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      type: "movie",
      title: "Blade Runner",
      originalTitle: "Blade Runner",
      year: 1982,
      overview: "A blade runner must pursue replicants.",
      posterPath: "/poster.jpg",
      backdropPath: "/backdrop.jpg",
      externalIds: [{ source: "tmdb", externalId: "78" }],
    });
    expect(results[1]?.type).toBe("series");
    expect(results[1]?.title).toBe("Supernatural");
    expect(results[1]?.year).toBe(2005);
  });

  // People are not titles. Passing them through would put actors in the
  // catalog as if they were watchable.
  it("drops person results", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SEARCH_PAYLOAD));
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = await provider.search({ query: "x", language: "en-US" }, AbortSignal.timeout(5000));
    expect(results.every((r) => r.type === "movie" || r.type === "series")).toBe(true);
  });

  it("never puts the api key in the query string", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SEARCH_PAYLOAD));
    const provider = createTmdbProvider("super-secret-key", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.search({ query: "x", language: "en-US" }, AbortSignal.timeout(5000));

    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).not.toContain("super-secret-key");
  });

  it("maps a 401 to an unauthorized failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status_message: "Invalid API key" }, 401));
    const provider = createTmdbProvider("bad", { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      provider.search({ query: "x", language: "en-US" }, AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("maps a network failure to an unavailable failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      provider.search({ query: "x", language: "en-US" }, AbortSignal.timeout(5000)),
    ).rejects.toBeInstanceOf(MetadataProviderError);
  });

  // A provider outage must not surface the upstream error text to users, and
  // must never echo the credential.
  it("keeps the api key out of thrown error messages", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect failed for key=super-secret-key");
    });
    const provider = createTmdbProvider("super-secret-key", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      provider.search({ query: "x", language: "en-US" }, AbortSignal.timeout(5000)),
    ).rejects.toSatisfy((error: Error) => !error.message.includes("super-secret-key"));
  });
});

describe("createTmdbProvider.validateConfiguration", () => {
  it("resolves on a successful response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true }));
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.validateConfiguration(AbortSignal.timeout(5000))).resolves.toBeUndefined();
  });

  it("throws unauthorized on a 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const provider = createTmdbProvider("bad", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.validateConfiguration(AbortSignal.timeout(5000))).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });
});
