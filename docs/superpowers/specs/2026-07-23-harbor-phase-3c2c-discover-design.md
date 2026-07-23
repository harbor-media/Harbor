# Harbor Phase 3c-2c — Discover / Genre Browsing

**Date:** 2026-07-23
**Status:** Approved
**Depends on:** Phase 3a (metadata foundation), 3b (image proxy), 3c-1 (design system), 3c-2a (title detail), 3c-2b (home rows + app shell)

## Scope

The `/discover` page: browse the catalog by genre. A **Movies | Series**
toggle and a genre picker choose a genre; a poster grid shows that genre's
titles, with a **Load more** button for further pages. This is the last of the
three pieces the 3c-2b spec deferred (the other, the redesigned search UI,
remains a separate later slice).

It also activates the app shell's **Discover** navigation, which 3c-2b rendered
disabled with a "Soon" chip.

### Out of scope

- The redesigned search UI (`/search` keeps its 3c-2a scaffolding).
- Browsing by anything other than genre (cast, year, collections).
- Any personal or profile-specific view (Phase 4).
- Caching discover *results* — see *Storage*.
- Infinite scroll — an explicit Load more instead.

## Provider capability

TMDB separates genres and discovery by type: `/genre/movie/list` and
`/genre/tv/list` return different id sets, and `/discover/movie` and
`/discover/tv` are distinct endpoints. The interface reflects that.

`MetadataProvider` gains a capability flag and two methods, mirroring how
`catalogs`/`getCatalog` were added — declare only what a provider can honour,
so a future provider that cannot browse opts out rather than throwing:

```ts
export interface Genre {
  /** The provider's genre id, as a string (TMDB's are numeric). */
  id: string;
  name: string;
}

export interface DiscoverResult {
  titles: NormalizedTitle[];
  page: number;
  totalPages: number;
}

export type DiscoverType = "movie" | "series";

export interface MetadataProvider {
  // ...existing members
  readonly supportsDiscover: boolean;
  getGenres(type: DiscoverType, language: string, signal: AbortSignal): Promise<Genre[]>;
  discoverByGenre(
    type: DiscoverType,
    genreId: string,
    page: number,
    language: string,
    signal: AbortSignal,
  ): Promise<DiscoverResult>;
}
```

TMDB mapping:

| Call | Endpoint |
| --- | --- |
| `getGenres("movie")` | `/genre/movie/list` |
| `getGenres("series")` | `/genre/tv/list` |
| `discoverByGenre("movie", id, page)` | `/discover/movie?with_genres=<id>&page=<page>` |
| `discoverByGenre("series", id, page)` | `/discover/tv?with_genres=<id>&page=<page>` |

`/discover/*` omits `media_type`, which `normalize()` requires, so the adapter
injects it per type — the same handling the catalog rows use. Payloads are
parsed with the existing Zod schemas; a genre-list response gets its own small
schema. `DiscoverType` uses Harbor's vocabulary (`series`), mapped to TMDB's
`tv` inside the adapter, so the provider's naming does not leak outward.

## Storage

**Genre lists are cached; discover results are not.** The two have opposite
cache economics.

Genre lists are tiny and near-immutable, and read on every Discover load — an
ideal cache. One table:

```sql
genre_cache (
  type        text primary key,          -- 'movie' | 'series'
  genres      jsonb not null,            -- Genre[]
  fetched_at  timestamptz not null
)
```

One row per type, cache-on-read behind a 7-day TTL, with the same
degraded-stale-on-`unavailable` / refuse-on-`unauthorized` rule the rest of the
metadata module follows.

Discover results are **not** persisted. Their key space is type × genre × page
— hundreds of cold combinations, each browsed briefly and rarely re-hit, so a
cache would miss most of the time while growing unbounded and needing its own
eviction. Instead each browse proxies through to the provider, and the titles
it returns are upserted into `titles` via the advisory-locked `upsertTitles`
(so a card opens the detail page with no extra fetch). The one thing this gives
up — degraded-stale during a provider outage — matters little on an
exploratory browse page, where the home screen still renders from its own cache
regardless. If a genre is ever shown to be hammered, that is the measure-first
moment to add a cache; not before.

## API

```
GET /api/v1/genres/:type
    -> { type, genres: Genre[], cached: boolean }

GET /api/v1/discover/:type/:genreId?page=N
    -> { type, genreId, page, totalPages, titles: TitleCard[] }
```

- `type` validated by `z.enum(["movie", "series"])` — an unknown type is a 400
  from validation, not a miss deeper down.
- `genreId` is a numeric string; `page` is an integer clamped to `[1, 500]`
  (TMDB's own ceiling), defaulting to 1.
- Both authed like every catalog route and rate-limited on the existing
  `detailRateLimit` budget.
- `TitleCard` is reused (id, type, title, year, posterPath) — a browse grid
  needs no overviews.
- Errors flow through the existing `toHarborError`: `METADATA_NOT_CONFIGURED`,
  provider `unavailable` → 503, `unauthorized` → 502. A provider with
  `supportsDiscover: false` → `DISCOVER_UNSUPPORTED` (409), which the page
  treats like an unavailable feature rather than an error.

`DiscoverType`, `Genre`, and the two response shapes live in `@harbor/shared`.

## Web

- A new `/discover` route, and the app shell's Discover entry becomes a real
  `NavLink` (the `ComingSoon` treatment removed for it).
- The page:
  - a **Movies | Series** segmented toggle;
  - a genre picker (React Aria `Select`) populated by `useGenres(type)`;
  - a poster grid of `useDiscover(type, genreId, page)` results, reusing
    `PosterCard`;
  - a **Load more** button that appends the next page until `page === totalPages`.
- Selection is held in the URL: `/discover?type=movie&genre=28`. This makes a
  view shareable and the back button meaningful, and it is the source of truth
  the queries read from. Default on first visit: `type=movie`, first genre in
  the list.
- States: no provider configured → the same guidance panel the home screen
  shows; a genre that returns nothing → an empty note; a failed request → a
  scoped error, never a blank page.

## Testing

**Provider:**
- each method hits the right endpoint for its type;
- `media_type` injected for discover, so `normalize()` keeps the results;
- `series` mapped to TMDB `tv`;
- a malformed payload (genre list or discover) classified `unavailable`;
- the genre-list Zod schema drops a junk entry without discarding the rest.

**Server:**
- genre cache-on-read, TTL expiry (counting provider calls), degraded-stale on
  `unavailable`, refusal on `unauthorized` — the latter two load-bearing;
- discover upserts its titles and returns cards, passing `page`/`totalPages`
  through;
- validation: bad type → 400, non-numeric genre → 400, `page` below 1 or above
  the cap → 400/clamped;
- auth required (load-bearing against the guard);
- `supportsDiscover: false` → `DISCOVER_UNSUPPORTED`.

**Web:**
- a Discover component test: toggling type refetches genres; choosing a genre
  shows results; Load more appends a page and disappears on the last page.

**E2E:**
- the TMDB fixture gains `/genre/movie/list`, `/genre/tv/list`,
  `/discover/movie`, `/discover/tv` (the last with more than one page so Load
  more is exercised);
- pick a genre → grid renders; toggle Movies/Series; Load more appends;
- the shell's Discover nav reaches `/discover`;
- a poster renders (asserted by `naturalWidth`, since a broken image is still
  "visible" to Playwright);
- Discover requires authentication.

## Deliberate omissions

- **No discover-result cache** (rationale above).
- **No multi-genre / combined filters** — one genre at a time. Combining genres
  or adding year/rating filters is a later refinement.
- **No sort control** — TMDB's default popularity order. A sort selector is a
  later addition.
- **Genre browsing only, per type** — no merged movie+series view, which TMDB
  offers no single endpoint for and which would mean Harbor merging and
  re-ranking two result sets itself.

## Carried-forward deferrals (from docs/deferred-minors.md)

- The e2e suite can run against a stale server `dist` (turbo cache); server-side
  load-bearing proofs stay at the unit level until fixed.
- `naturalWidth` assertions prove decode, not visibility; visual regressions
  need screenshot/opacity checks the suite does not yet have.
