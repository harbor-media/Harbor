# Harbor Phase 3c-2a — Title Detail

**Date:** 2026-07-22
**Status:** Approved
**Depends on:** Phase 3a (metadata foundation), 3b (image proxy), 3c-1 (design system)

## Scope

Phase 3 was split into 3a (metadata foundation), 3b (image proxy), and 3c
(catalog UX). 3c was split again into 3c-1 (design system, complete) and 3c-2
(catalog UX). This spec covers the first half of that second half.

`CLAUDE.md`'s Phase 3 catalog work does not fit one phase, for two reasons
found while scoping it:

**Five of the nine home-screen rows are Phase 4 features.** Continue Watching,
My Library, Recently Watched, Recently Added to Library, and Recommended for
You each need library entries, watch history, or playback progress — none of
which exist until Phase 4. They cannot be built now at any effort. Only
Popular Movies, Popular Series, Trending, and New Releases are reachable, and
those need provider endpoints that do not exist yet either.

**Detail pages need a data layer of their own.** Phase 3a deliberately
implemented only `validateConfiguration` and `search`, and stored nine
columns with no genres, seasons, or episodes.

The remaining work therefore splits into two vertical slices:

| Slice | Scope |
| --- | --- |
| **3c-2a** (this spec) | `getMovie`/`getSeries`/`getSeason`, schema for seasons and episodes, detail endpoints, and the movie/series/season pages |
| **3c-2b** | Trending and popular provider methods, row endpoints with caching, the home and discover pages, and the real search UI |

3c-2a comes first because it finishes a flow that already half-exists —
search works today but its results go nowhere — and because the title card it
produces is what 3c-2b's rows are built from. Built the other way round, the
rows would link to pages that do not exist.

### Out of scope

Cast, crew, ratings, external links, genre browsing, collections, the home
and discover pages, and the real search UI. Also `getEpisode`; see below.

## Definition of Done

You search for a title, click a result, and get a real page: artwork,
overview, genres, runtime, and for a series, season tabs with episodes. A
second visit is served from Harbor's cache with no outbound request.

## Decisions

### The layout is a cinematic hero with season tabs

The title page uses a full-bleed backdrop fading into the canvas with the
poster overlapping it. Series present seasons as tabs, with the episode list
beneath, and switching a tab navigates to `/series/:id/season/:n` so a season
stays linkable and the back button behaves.

This is the strongest reading of `CLAUDE.md`'s "large cinematic artwork", and
it is what the achromatic chrome adopted in 3c-1 exists to serve: with no
brand hue anywhere, poster and backdrop art supply all the colour on screen.

Rejected: a split poster-left panel with no backdrop, which is calmer but
spends none of the artwork Harbor already pays to cache; and a season grid
that defers episodes to a second page, which loads less but puts two clicks
between a user and an episode.

### A missing backdrop falls back to the blurred poster

`backdropPath` is frequently empty in provider data. Rather than collapsing
the hero to a flat bar, the page uses the poster, blurred and darkened, as the
backdrop. Flat canvas applies only when both images are absent.

This keeps the layout's atmosphere for the many titles that have a poster but
no backdrop, which would otherwise be the common degraded case rather than a
rare one.

### `getEpisode` is not implemented

The provider interface gains `getMovie`, `getSeries`, and `getSeason` — three
methods, not four. TMDB's season endpoint returns the full episode list in one
response, so fetching episodes individually would issue more requests for the
same data.

`getEpisode` arrives if a future provider requires per-episode fetching. This
continues 3a's rule: declare only the methods that can be honored.

### Titles record when detail was fetched, separately from when they were seen

`titles` gains `detail_fetched_at` alongside the existing `fetched_at`.

A title row created by a search holds only summary fields. Without a separate
marker there is no way to distinguish "Harbor knows this title exists" from
"Harbor has the whole title", and the detail page would either refetch on
every visit or render a half-empty page from summary data.

### Genres are stored as a JSONB array, not a normalized table

The detail page renders genre chips. Genre *browsing* is a later phase, and
normalizing at that point is a migration rather than a rewrite.

A normalized `genres` + `title_genres` pair would be the right shape for
filtering, but building it now — shaped only around a chip list — risks
shaping it wrong for the feature that actually needs it.

### Cast is deliberately excluded

`CLAUDE.md` lists cast as a **search** requirement: "Search must support:
cast, director". Cast data therefore has a second, larger consumer arriving
later.

Building a `people` table and a credits join now, shaped only around a
detail-page strip, risks shaping it wrong for search. It is built once, in
the phase that has both consumers in view.

Consequence accepted: title pages show no cast, which is a visible gap on a
media product.

## Architecture

### Schema

```
titles                  + runtime            integer, minutes, nullable
                        + genres             jsonb string[], default []
                        + detail_fetched_at  timestamptz, nullable

seasons   id, title_id -> titles(id) on delete cascade,
          season_number integer, name text, overview text,
          poster_path text, episode_count integer, air_date date,
          fetched_at timestamptz
          unique (title_id, season_number)

episodes  id, season_id -> seasons(id) on delete cascade,
          episode_number integer, name text, overview text,
          still_path text, runtime integer, air_date date
          unique (season_id, episode_number)
```

`poster_path` and `still_path` store provider-relative paths, matching the
convention 3a established and 3b's image proxy consumes.

### Endpoints

```
GET /api/v1/titles/:id                    authenticated
GET /api/v1/titles/:id/seasons/:season    authenticated
```

`:id` is Harbor's own UUID, taken from a search result. The server maps it to
the provider's identifier internally, so provider IDs never reach the client —
the same boundary 3b enforces for image hosts.

**For a series, `GET /titles/:id` returns the season list** — number, name,
episode count, poster — but no episodes. The tabs cannot render without it,
and loading every season's episodes to draw a tab strip would fetch the whole
show to display its table of contents. Episodes arrive only from the season
endpoint, one season at a time.

Both follow 3a's cache-on-read shape: serve from PostgreSQL when fresh,
otherwise fetch, normalize, store, and serve. The detail TTL is **24 hours**:
a finished film's runtime and overview do not change hourly.

### Frontend

Routes, exactly as `CLAUDE.md` specifies:

```
/movie/:id
/series/:id
/series/:id/season/:season
```

Search results become clickable and route by their `type` field.

Three components: `TitleHero` (backdrop, poster, title, metadata, actions),
`SeasonTabs`, and `EpisodeList`. Episode rows show stills, which the 3b image
proxy already serves without backend changes.

Loading states use skeletons that reserve the hero's exact height, so the page
does not jump when artwork arrives. `CLAUDE.md` requires preserving layout
while images load.

## Failure handling

| Condition | Behavior |
| --- | --- |
| Title cached and detail fresh | Served from PostgreSQL, no outbound request |
| Detail stale or absent | Fetched, stored, served |
| Unknown title id | `404` |
| Provider unreachable, detail cached | Stale detail served rather than failing |
| Provider unreachable, nothing cached | `METADATA_PROVIDER_UNAVAILABLE`, retryable |
| Provider rejects the key | `METADATA_PROVIDER_UNAUTHORIZED` |
| No provider configured | `METADATA_NOT_CONFIGURED` |

These reuse the error codes 3a introduced rather than inventing new ones, so
the frontend's existing `describeMetadataError` keeps working unchanged.

Stale-on-outage matches 3a's search behavior, and for the same reason: expiry
is a freshness preference, while an outage is not a reason to withhold data
Harbor already holds.

## Testing

- **Adapter:** normalization of movie, series, and season payloads from
  recorded fixtures. No test contacts the real TMDB.
- **Cache:** a repeat detail request is proven cached by **asserting the
  absence of an outbound call**, not merely that data came back — the latter
  passes whether or not the cache works.
- **Detail-vs-summary:** a title known only from search must be detected as
  lacking detail and fetched, rather than rendering a half-empty page.
- **Season upsert:** re-fetching a season updates its episodes rather than
  duplicating them, keyed on `(season_id, episode_number)`.
- **Authorization:** unauthenticated requests to both endpoints are refused.
- **End to end:** search, click a result, land on the title page, switch a
  season tab, and see different episodes.
