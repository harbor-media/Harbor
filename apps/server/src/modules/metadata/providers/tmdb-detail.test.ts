import { describe, expect, it, vi } from "vitest";
import { createTmdbProvider } from "./tmdb.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fake(impl: () => Promise<Response>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

const SIGNAL = (): AbortSignal => AbortSignal.timeout(5000);

const MOVIE = {
  id: 78,
  title: "Blade Runner",
  original_title: "Blade Runner",
  release_date: "1982-06-25",
  overview: "A blade runner must pursue replicants.",
  poster_path: "/poster.jpg",
  backdrop_path: "/backdrop.jpg",
  runtime: 117,
  genres: [
    { id: 878, name: "Science Fiction" },
    { id: 53, name: "Thriller" },
  ],
};

const SERIES = {
  id: 1622,
  name: "Supernatural",
  original_name: "Supernatural",
  first_air_date: "2005-09-13",
  overview: "Two brothers hunt monsters.",
  poster_path: "/sn.jpg",
  backdrop_path: null,
  episode_run_time: [44],
  genres: [{ id: 18, name: "Drama" }],
  seasons: [
    { season_number: 0, name: "Specials", overview: "", poster_path: null, episode_count: 5, air_date: null },
    { season_number: 1, name: "Season 1", overview: "", poster_path: "/s1.jpg", episode_count: 22, air_date: "2005-09-13" },
  ],
};

const SEASON = {
  season_number: 1,
  episodes: [
    { episode_number: 1, name: "Pilot", overview: "Sam and Dean.", still_path: "/e1.jpg", runtime: 48, air_date: "2005-09-13" },
    { episode_number: 2, name: "Wendigo", overview: "", still_path: null, runtime: 42, air_date: "2005-09-20" },
  ],
};

describe("getMovie", () => {
  it("normalizes a movie payload", async () => {
    const provider = createTmdbProvider("key", { fetchImpl: fake(async () => json(MOVIE)) });
    const detail = await provider.getMovie("78", "en-US", SIGNAL());

    expect(detail.runtime).toBe(117);
    expect(detail.year).toBe(1982);
    expect(detail.genres).toEqual(["Science Fiction", "Thriller"]);
    expect(detail.backdropPath).toBe("/backdrop.jpg");
    expect(detail.overview).toBe("A blade runner must pursue replicants.");
    // A movie has no seasons; the field exists so callers need no type test.
    expect(detail.seasons).toEqual([]);
  });

  it("requests the movie path for the given id", async () => {
    const fetchImpl = vi.fn(async () => json(MOVIE));
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await provider.getMovie("78", "en-US", SIGNAL());
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/movie/78");
  });

  it("maps a failure status to a provider error", async () => {
    const provider = createTmdbProvider("key", { fetchImpl: fake(async () => json({}, 404)) });
    await expect(provider.getMovie("0", "en-US", SIGNAL())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("getSeries", () => {
  it("normalizes a series payload including its seasons", async () => {
    const provider = createTmdbProvider("key", { fetchImpl: fake(async () => json(SERIES)) });
    const detail = await provider.getSeries("1622", "en-US", SIGNAL());

    expect(detail.year).toBe(2005);
    expect(detail.genres).toEqual(["Drama"]);
    // episode_run_time is an array; the first entry is representative.
    expect(detail.runtime).toBe(44);
    expect(detail.seasons.map((s) => s.seasonNumber)).toEqual([0, 1]);
    expect(detail.seasons[1]?.episodeCount).toBe(22);
    expect(detail.seasons[1]?.posterPath).toBe("/s1.jpg");
  });

  it("tolerates an empty episode_run_time", async () => {
    const provider = createTmdbProvider("key", {
      fetchImpl: fake(async () => json({ ...SERIES, episode_run_time: [] })),
    });
    const detail = await provider.getSeries("1622", "en-US", SIGNAL());
    expect(detail.runtime).toBeNull();
  });

  // Providers use "" for an unknown value as often as null. Storing "" would
  // make an empty overview render as a blank block rather than be skipped.
  it("converts empty strings to null", async () => {
    const provider = createTmdbProvider("key", { fetchImpl: fake(async () => json(SERIES)) });
    const detail = await provider.getSeries("1622", "en-US", SIGNAL());

    expect(detail.backdropPath).toBeNull();
    expect(detail.seasons[0]?.overview).toBeNull();
    expect(detail.seasons[0]?.airDate).toBeNull();
  });

  it("requests the tv path for the given id", async () => {
    const fetchImpl = vi.fn(async () => json(SERIES));
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await provider.getSeries("1622", "en-US", SIGNAL());
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/tv/1622");
  });
});

describe("getSeason", () => {
  it("normalizes episodes", async () => {
    const provider = createTmdbProvider("key", { fetchImpl: fake(async () => json(SEASON)) });
    const eps = await provider.getSeason("1622", 1, "en-US", SIGNAL());

    expect(eps).toHaveLength(2);
    expect(eps[0]).toEqual({
      episodeNumber: 1,
      name: "Pilot",
      overview: "Sam and Dean.",
      stillPath: "/e1.jpg",
      runtime: 48,
      airDate: "2005-09-13",
    });
    expect(eps[1]?.overview).toBeNull();
    expect(eps[1]?.stillPath).toBeNull();
  });

  it("requests the season path for the given number", async () => {
    const fetchImpl = vi.fn(async () => json(SEASON));
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await provider.getSeason("1622", 3, "en-US", SIGNAL());
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/tv/1622/season/3");
  });

  it("returns an empty list when the payload has no episodes", async () => {
    const provider = createTmdbProvider("key", { fetchImpl: fake(async () => json({})) });
    expect(await provider.getSeason("1622", 1, "en-US", SIGNAL())).toEqual([]);
  });

  // The credential travels in the Authorization header. A query string lands
  // in proxy logs, browser history, and Referer headers.
  it("never puts the api key in the url", async () => {
    const fetchImpl = vi.fn(async () => json(SEASON));
    const provider = createTmdbProvider("super-secret-key", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.getSeason("1622", 1, "en-US", SIGNAL());
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("super-secret-key");
  });
});

// TMDB is an external boundary. Before these, the payload was cast rather
// than parsed, so a malformed response was not a provider error at all --
// it was a TypeError or a NOT NULL violation raised somewhere downstream.
describe("provider payload validation", () => {
  it("reports a malformed detail payload as a provider outage, not a crash", async () => {
    const provider = createTmdbProvider("key", {
      fetchImpl: fake(() => Promise.resolve(json({ ...MOVIE, genres: { name: "nope" } }))),
    });

    // The cast version reached `genres.map` and threw a raw TypeError, which
    // escaped MetadataProviderError entirely and surfaced as a bare 500 with
    // no provider context.
    await expect(provider.getMovie("78", "en-US", SIGNAL())).rejects.toMatchObject({
      name: "MetadataProviderError",
      kind: "unavailable",
    });
  });

  it("rejects an episode with no episode number rather than storing undefined", async () => {
    const provider = createTmdbProvider("key", {
      fetchImpl: fake(() =>
        Promise.resolve(json({ episodes: [{ name: "Pilot", runtime: 48 }] })),
      ),
    });

    // episode_number is NOT NULL in the database. Casting let `undefined`
    // travel all the way into the insert, turning a provider quirk into a
    // database error on an ordinary read path.
    await expect(provider.getSeason("1622", 1, "en-US", SIGNAL())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("does not leak payload details into the error message", async () => {
    const provider = createTmdbProvider("key", {
      fetchImpl: fake(() => Promise.resolve(json({ episodes: [{ secret: "s3cret" }] }))),
    });

    // The message reaches the client, and validation issues quote the
    // offending value.
    await expect(provider.getSeason("1622", 1, "en-US", SIGNAL())).rejects.toThrow(
      /^The metadata provider returned an unexpected response\.$/,
    );
  });

  it("drops one unusable search result without discarding the page", async () => {
    const provider = createTmdbProvider("key", {
      fetchImpl: fake(() =>
        Promise.resolve(
          json({
            results: [
              { id: "not-a-number", media_type: "movie", title: "Broken" },
              { id: 78, media_type: "movie", title: "Blade Runner" },
            ],
          }),
        ),
      ),
    });

    const results = await provider.search({ query: "blade", language: "en-US" }, SIGNAL());

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Blade Runner");
  });

  it("accepts unknown fields, so a TMDB addition does not break Harbor", async () => {
    const provider = createTmdbProvider("key", {
      fetchImpl: fake(() =>
        Promise.resolve(json({ ...MOVIE, some_new_field: { nested: true } })),
      ),
    });

    const detail = await provider.getMovie("78", "en-US", SIGNAL());
    expect(detail.runtime).toBe(117);
  });
});

describe("detail enrichment", () => {
  const enriched = {
    ...MOVIE,
    tagline: "More than meets the eye.",
    vote_average: 6.4,
    production_companies: [{ name: "Wayans Bros." }, { name: "Miramax" }],
    credits: {
      crew: [
        { job: "Director", name: "Michael Tiddes" },
        { job: "Screenplay", name: "Rick Alvarez" },
        { job: "Writer", name: "Rick Alvarez" },
        { job: "Story", name: "Marlon Wayans" },
        { job: "Editor", name: "Someone Else" },
      ],
    },
    images: {
      logos: [
        { file_path: "/xx-fr.png", iso_639_1: "fr" },
        { file_path: "/logo-en.png", iso_639_1: "en" },
      ],
    },
  };

  function providerFor(body: unknown) {
    return createTmdbProvider("key", { fetchImpl: fake(async () => json(body)) });
  }

  it("pulls tagline, studios, director and deduped writers", async () => {
    const d = await providerFor(enriched).getMovie("78", "en-US", SIGNAL());
    expect(d.tagline).toBe("More than meets the eye.");
    expect(d.studios).toEqual(["Wayans Bros.", "Miramax"]);
    expect(d.director).toBe("Michael Tiddes");
    expect(d.writers).toEqual(["Rick Alvarez", "Marlon Wayans"]);
  });

  it("prefers the English logo over an earlier non-English one", async () => {
    const d = await providerFor(enriched).getMovie("78", "en-US", SIGNAL());
    expect(d.logoPath).toBe("/logo-en.png");
  });

  it("treats a vote_average of 0 as no rating", async () => {
    const d = await providerFor({ ...enriched, vote_average: 0 }).getMovie("78", "en-US", SIGNAL());
    expect(d.rating).toBeNull();
  });

  it("passes a real vote_average through", async () => {
    const d = await providerFor(enriched).getMovie("78", "en-US", SIGNAL());
    expect(d.rating).toBe(6.4);
  });

  it("parses a detail body with no credits, images, or tagline", async () => {
    const d = await providerFor(MOVIE).getMovie("78", "en-US", SIGNAL());
    expect(d.tagline).toBeNull();
    expect(d.logoPath).toBeNull();
    expect(d.director).toBeNull();
    expect(d.writers).toEqual([]);
    expect(d.studios).toEqual([]);
    expect(d.rating).toBeNull();
  });

  it("requests credits and images in one call", async () => {
    const urls: string[] = [];
    const provider = createTmdbProvider("key", {
      fetchImpl: ((url: string) => {
        urls.push(url);
        return Promise.resolve(json(MOVIE));
      }) as unknown as typeof fetch,
    });
    await provider.getMovie("78", "en-US", SIGNAL());
    expect(urls[0]).toContain("append_to_response=credits%2Cimages");
  });
});
