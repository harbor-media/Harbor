import { createServer } from "node:http";

// A stand-in for the TMDB API, so the end-to-end suite never touches the real
// service. Depending on TMDB here would make the suite fail on a third
// party's outage, need a real credential in CI, and put load on someone
// else's servers on every run.
//
// It is deliberately minimal: it answers only the two endpoints Harbor calls
// in this phase, and it is NOT a general TMDB emulator.

const PORT = Number(process.env["TMDB_FIXTURE_PORT"] ?? 3101);

// Matches the key the e2e spec enters in the admin form. Anything else is
// rejected with a 401, which is what exercises Harbor's "TMDB rejected this
// key" path with a real HTTP status rather than a mocked function.
const VALID_KEY = "e2e-valid-tmdb-token";

const SEARCH_RESULTS = {
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
      id: 335984,
      media_type: "movie",
      title: "Blade Runner 2049",
      original_title: "Blade Runner 2049",
      release_date: "2017-10-04",
      overview: "A young blade runner uncovers a secret.",
      poster_path: "/2049.jpg",
      backdrop_path: null,
    },
    {
      // The series used for season navigation. Its detail payload lives in
      // SERIES_DETAIL below, keyed by this same id.
      id: 1622,
      media_type: "tv",
      name: "Supernatural",
      original_name: "Supernatural",
      first_air_date: "2005-09-13",
      overview: "Two brothers hunt monsters.",
      poster_path: "/sn.jpg",
      backdrop_path: null,
    },
    // A person result, included on purpose: Harbor must drop it rather than
    // list an actor as a watchable title.
    { id: 999, media_type: "person", name: "Ridley Scott" },
  ],
};

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Detail payloads. Supernatural (1622) is the series used for season
// navigation. Seasons 1 and 2 carry distinct episode names so a season switch
// is observable rather than merely rendering something; the remaining 22 plus
// Specials exist so the season picker is a genuinely long list. A short list
// would let an unbounded popover pass -- it only overflows the viewport once
// there are more options than fit on screen.
const MOVIE_DETAIL = {
  id: 78,
  title: "Blade Runner",
  original_title: "Blade Runner",
  release_date: "1982-06-25",
  overview: "A blade runner must pursue replicants.",
  poster_path: "/poster.jpg",
  backdrop_path: "/backdrop.jpg",
  runtime: 117,
  genres: [{ id: 878, name: "Science Fiction" }, { id: 53, name: "Thriller" }],
};

const SERIES_DETAIL = {
  id: 1622,
  name: "Supernatural",
  original_name: "Supernatural",
  first_air_date: "2005-09-13",
  overview: "Two brothers hunt monsters.",
  poster_path: "/sn.jpg",
  // Non-null so the home backdrop hero -- featured on the first trending title,
  // which is Supernatural -- renders a real backdrop the spec can assert on.
  backdrop_path: "/backdrop.jpg",
  episode_run_time: [44],
  genres: [{ id: 18, name: "Drama" }],
  seasons: [
    { season_number: 0, name: "Specials", overview: "", poster_path: null, episode_count: 1, air_date: null },
    ...Array.from({ length: 24 }, (_, i) => ({
      season_number: i + 1,
      name: `Season ${String(i + 1)}`,
      overview: "",
      poster_path: "/s1.jpg",
      episode_count: 2,
      air_date: "2005-09-13",
    })),
  ],
};

const SEASON_EPISODES = {
  1: [
    { episode_number: 1, name: "Pilot", overview: "Sam and Dean.", still_path: "/e1.jpg", runtime: 48, air_date: "2005-09-13" },
    { episode_number: 2, name: "Wendigo", overview: "", still_path: null, runtime: 42, air_date: "2005-09-20" },
  ],
  2: [
    { episode_number: 1, name: "In My Time of Dying", overview: "", still_path: null, runtime: 42, air_date: "2006-09-28" },
    { episode_number: 2, name: "Everybody Loves a Clown", overview: "", still_path: null, runtime: 42, air_date: "2006-10-05" },
  ],
};

const CATALOG = {
  "/trending/all/week": [
    {
      id: 1622,
      media_type: "tv",
      name: "Supernatural",
      poster_path: "/sn.jpg",
      first_air_date: "2005-09-13",
    },
    {
      id: 78,
      media_type: "movie",
      title: "Blade Runner",
      poster_path: "/poster.jpg",
      release_date: "1982-06-25",
    },
  ],
  "/movie/popular": [
    { id: 78, title: "Blade Runner", poster_path: "/poster.jpg", release_date: "1982-06-25" },
  ],
  "/tv/popular": [
    { id: 1622, name: "Supernatural", poster_path: "/sn.jpg", first_air_date: "2005-09-13" },
  ],
  "/movie/now_playing": [],
};

/** Counts detail fetches so a spec can prove Harbor served from its own
 *  cache rather than re-fetching. Without it the cached assertion would only
 *  be checking that data came back, which passes either way. */
let detailFetches = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${String(PORT)}`);

  // Harbor must send the credential as a bearer token, never in the query
  // string. Reading it from the header here means a regression that moved it
  // into the URL would fail the suite rather than pass silently.
  if (url.pathname === "/count") {
    send(res, 200, { detailFetches });
    return;
  }

  if (url.pathname === "/reset") {
    detailFetches = 0;
    send(res, 200, { detailFetches });
    return;
  }

  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${VALID_KEY}`) {
    send(res, 401, { status_message: "Invalid API key" });
    return;
  }

  if (url.pathname === "/authentication") {
    send(res, 200, { success: true });
    return;
  }

  if (url.pathname === "/search/multi") {
    send(res, 200, SEARCH_RESULTS);
    return;
  }

  if (url.pathname === "/movie/78") {
    detailFetches += 1;
    send(res, 200, MOVIE_DETAIL);
    return;
  }

  if (url.pathname === "/tv/1622") {
    detailFetches += 1;
    send(res, 200, SERIES_DETAIL);
    return;
  }

  const season = /^\/tv\/1622\/season\/(\d+)$/.exec(url.pathname);
  if (season) {
    detailFetches += 1;
    send(res, 200, { season_number: Number(season[1]), episodes: SEASON_EPISODES[season[1]] ?? [] });
    return;
  }

  // Catalog rows. /movie/* and /tv/* deliberately omit media_type, exactly as
  // TMDB does -- the adapter has to supply it, and a fixture that helpfully
  // included it would hide that bug. /movie/now_playing returns an empty list
  // on purpose, exercising both the empty-row-is-hidden rule and the
  // empty-row-freshness case.
  if (CATALOG[url.pathname]) {
    send(res, 200, { results: CATALOG[url.pathname] });
    return;
  }

  if (url.pathname === "/genre/movie/list") {
    send(res, 200, { genres: [{ id: 28, name: "Action" }, { id: 878, name: "Science Fiction" }] });
    return;
  }
  if (url.pathname === "/genre/tv/list") {
    send(res, 200, { genres: [{ id: 18, name: "Drama" }] });
    return;
  }
  if (url.pathname === "/discover/movie") {
    // Two pages, so Load more is exercised. media_type omitted, as TMDB does.
    const page = Number(url.searchParams.get("page") ?? "1");
    const results =
      page === 1
        ? [{ id: 78, title: "Blade Runner", poster_path: "/poster.jpg", release_date: "1982-06-25" }]
        : [{ id: 680, title: "Pulp Fiction", poster_path: "/pf.jpg", release_date: "1994-10-14" }];
    send(res, 200, { page, total_pages: 2, results });
    return;
  }
  if (url.pathname === "/discover/tv") {
    send(res, 200, {
      page: 1,
      total_pages: 1,
      results: [{ id: 1622, name: "Supernatural", poster_path: "/sn.jpg", first_air_date: "2005-09-13" }],
    });
    return;
  }

  send(res, 404, { status_message: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`tmdb fixture listening on http://127.0.0.1:${String(PORT)}`);
});
