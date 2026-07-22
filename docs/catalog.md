# Catalog

Search results link to a title page: artwork, overview, genres, runtime, and
for a series, season tabs with episodes.

## Routes

```
/movie/:id
/series/:id
/series/:id/season/:season
```

`:id` is **Harbor's own UUID**, not the provider's identifier. The server maps
one to the other internally, so a provider id never reaches the browser — the
same boundary the image proxy enforces for provider hosts.

A season lives in the URL rather than in component state, so a season is
shareable and the back button moves between seasons instead of leaving the
page.

## Endpoints

```
GET /api/v1/titles/:id                    authenticated
GET /api/v1/titles/:id/seasons/:season    authenticated
```

`GET /titles/:id` returns the title plus, for a series, its **season list** —
number, name, episode count, poster. It does **not** return episodes. Drawing
a tab strip must not fetch an entire show; episodes come one season at a time
from the season endpoint.

Both endpoints require authentication and are limited to 120 requests per
minute. That is higher than search's 60 because opening one title page issues
a detail request plus one for each season tab the viewer opens.

## Caching

Detail is held for **24 hours**, following the same cache-on-read shape as
search: serve from PostgreSQL when fresh, otherwise fetch, normalize, store,
and serve.

A `detail_fetched_at` column records when full detail was last retrieved,
separately from `fetched_at`, which records when the title was last seen at
all. Without the distinction there would be no way to tell a title Harbor
merely knows exists — created by a search — from one it holds in full, and a
title page would either refetch on every visit or render half-empty.

The cost of a day-long window: a currently-airing series' episode list can lag
by up to that long.

Re-fetching a season **replaces** its episodes rather than merging them. A
provider that drops an episode drops it here too; an upsert would leave a
phantom row that no refetch ever removes, and the stored season would slowly
drift from the provider's without anything appearing to fail.

## Failure behavior

| Condition | Result |
| --- | --- |
| Detail cached and fresh | Served from PostgreSQL, no outbound request |
| Detail stale or absent | Fetched, stored, served |
| Unknown title or season | `404 NOT_FOUND` |
| Provider unreachable, detail cached | **Stale detail served**, marked cached |
| Provider unreachable, nothing cached | `METADATA_PROVIDER_UNAVAILABLE`, retryable |
| Provider rejects the key | `METADATA_PROVIDER_UNAUTHORIZED` — stale detail is **not** served |
| No provider configured | `METADATA_NOT_CONFIGURED`, pointing at `/admin/metadata` |

The distinction in the last three rows is deliberate. An outage justifies
showing stale data, because expiry is a freshness preference and Harbor
already holds something worth rendering. A **rejected key does not**: serving
stale data over a broken credential would hide a problem only an
administrator can fix, and the catalog would appear to work while silently
going stale forever.

## Artwork

A title page uses the backdrop behind the poster, faded into the canvas.
Providers leave `backdrop_path` empty for a great many titles, so when it is
missing the page falls back to the **poster, blurred and darkened**. A flat
canvas appears only when both images are absent.

That fallback is load-bearing rather than cosmetic: Harbor's chrome is
achromatic, so artwork supplies the only colour on the page.

Episode stills are served through the same image proxy as posters and load
lazily — a full season is a full season's worth of image requests.

## Not yet available

**Play** and **Watchlist** are visibly disabled. Playback arrives in Phase 5
and the personal library in Phase 4. They are rendered as disabled controls
with an explanation rather than wired to handlers that do nothing, because a
button that silently does nothing reads as a bug.

Cast and crew are also absent. `CLAUDE.md` makes cast a **search**
requirement as well as a detail one, so the people schema is built once, in
the phase that has both consumers in view, rather than being shaped around a
detail strip and reshaped later.
