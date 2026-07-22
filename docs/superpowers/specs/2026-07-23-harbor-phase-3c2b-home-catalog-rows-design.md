# Harbor Phase 3c-2b — Home Catalog Rows and App Shell

**Date:** 2026-07-23
**Status:** Approved
**Depends on:** Phase 3a (metadata foundation), 3b (image proxy), 3c-1 (design system), 3c-2a (title detail)

## Scope

The 3c-2a spec earmarked 3c-2b as "trending and popular provider methods, row
endpoints with caching, the home and discover pages, and the real search UI".
That is too much for one slice, and scoping it revealed why:

**Harbor has no app shell.** Every page today — Home, Search, Title, the admin
pages — is standalone, with no persistent navigation. `/home` is a card holding
link buttons, standing in for chrome that was never built. A row-based home
screen is the first page that genuinely needs the shell, and without it there
is no way to leave `/home` except the browser back button. The shell is real
work and belongs with the page that forces it.

3c-2b therefore covers **the app shell and the home screen's four
provider-backed rows**. Discover, genre browsing, and the real search UI move
to 3c-2c, which builds on the same row primitive this phase produces.

### Rows in scope

`CLAUDE.md` lists nine home rows. Five — Continue Watching, My Library,
Recently Watched, Recently Added to Library, Recommended for You — need library
entries, watch history, or playback progress, none of which exist before Phase
4. They are not deferred for effort reasons; there is no data to render.

The four reachable rows are **Trending**, **Popular Movies**, **Popular
Series**, and **New Releases**. Nothing on the home screen will be a stub.

### Out of scope

- Discover / genre browsing pages (3c-2c)
- The redesigned search UI (3c-2c); `/search` keeps its current scaffolding
- Any personal or profile-specific row (Phase 4)
- Admin-configurable row selection — see *Deliberate omissions*
- Infinite scroll or pagination within a row

## Provider layer

`MetadataProvider` gains a capability list and one method:

```ts
export type CatalogKind =
  | "trending"
  | "popular-movies"
  | "popular-series"
  | "new-releases";

export interface MetadataProvider {
  // ...existing members
  /** Kinds this provider can actually serve. */
  readonly catalogs: readonly CatalogKind[];
  getCatalog(
    kind: CatalogKind,
    language: string,
    signal: AbortSignal,
  ): Promise<NormalizedTitle[]>;
}
```

A capability list rather than four discrete methods, because `types.ts` already
states the rule: *declare only the methods that can be honored, because a
method that throws NotImplemented makes the contract a lie.* A future provider
that cannot serve New Releases omits the kind, and Harbor hides that row
instead of rendering an error.

TMDB mapping:

| Kind | Endpoint |
| --- | --- |
| `trending` | `/trending/all/week` |
| `popular-movies` | `/movie/popular` |
| `popular-series` | `/tv/popular` |
| `new-releases` | `/movie/now_playing` |

Responses reuse the `searchItemSchema` added in 3c-2a — the payload shape is
the same list-of-titles TMDB returns from multi-search. `/movie/*` and `/tv/*`
omit `media_type`, which multi-search supplies and `normalize()` depends on, so
the adapter supplies it per endpoint rather than trusting the payload.
`/trending/all/week` does include it and must be trusted, since the row mixes
both types.

## Storage

Two tables — membership and freshness are stored separately:

```sql
catalog_rows (
  kind        text primary key,
  fetched_at  timestamptz not null
)

catalog_entries (
  kind      text    not null references catalog_rows(kind) on delete cascade,
  position  integer not null,
  title_id  uuid    not null references titles(id) on delete cascade,
  primary key (kind, position)
)
```

Freshness lives on its own row rather than on the entries. If it were stamped
on the entries, a kind the provider returns **empty** would store nothing, have
no timestamp, and therefore look permanently stale — refetching on every single
request, forever, for the one case guaranteed to keep returning nothing. A
separate `catalog_rows` row records "this kind was fetched at T" independently
of how many titles came back, including zero.

Refresh, for one kind, in a single transaction:

1. `upsertTitles` the provider's titles — the same advisory-locked accessor
   search uses, so rows and search share one canonical title per external id.
2. Upsert `catalog_rows(kind, fetched_at = now)`.
3. Delete every `catalog_entries` row for the kind.
4. Insert the new entries with `position` from the provider's ordering.

Delete-then-insert, not upsert, for the reason `replaceEpisodes` documents: a
title that has dropped out of Trending must actually leave. An upsert would
leave stale entries no refresh ever removes.

`position` is load-bearing. Providers return *ranked* order — that ranking is
the entire information content of a "Popular" row — and a `SELECT` without an
explicit `ORDER BY position` is unordered in PostgreSQL regardless of insertion
sequence.

The whole write is one transaction, so the freshness stamp can never commit
ahead of the rows it describes. This is exactly the failure the 3c-2a pre-merge
review caught in `detailFetchedAt`; it is designed out here rather than
rediscovered.

### TTL

One constant, **6 hours**, for all four kinds. Four upstream calls per 6h for
the entire server, well inside any provider's limits. Per-kind tuning is a
second freshness concept for negligible benefit at this scale.

## API

```
GET /api/v1/catalog/:kind   ->  { kind, titles: TitleCard[], cached: boolean }
```

One endpoint per row, not one endpoint returning all four. Per-row means a slow
or failing row cannot block or blank the other three, and each kind refreshes
on its own schedule.

`CatalogKind` is exported from `@harbor/shared`, so the client knows all four
kinds statically and issues four parallel requests with no capability
round-trip first — no waterfall.

Behaviour matches the title-detail endpoint:

- Fresh cache → served from PostgreSQL, `cached: true`.
- Stale + provider reachable → refetch, `cached: false`.
- Stale + provider `unavailable` + something cached → serve stale,
  `cached: true`.
- Stale + provider `unauthorized` → error. A rejected key is an administrator
  problem and must not be hidden behind stale data.
- Kind not in the provider's `catalogs` → `CATALOG_KIND_UNSUPPORTED` (409). The
  client hides that row.
- No provider configured → the existing `METADATA_NOT_CONFIGURED`.

Authenticated like every other catalog route, and rate limited on the same
generous budget as title detail.

`TitleCard` is the minimum a poster card needs: `id`, `type`, `title`, `year`,
`posterPath`. Not the full detail payload — a row of 20 cards should not carry
20 overviews.

## Frontend

### Shell

A React Router layout route wrapping the signed-in pages, rendering a
persistent top bar: Harbor wordmark, Home / Discover / Library, a search
affordance, and a profile menu holding sign-out plus the admin links `/home`
currently shows as buttons. Discover and Library appear in the bar but are
disabled until those pages exist — a visible roadmap rather than dead links.
Whatever affordance conveys that must reach keyboard and screen-reader users,
which the title page's current `title`-on-a-wrapping-span does not (recorded in
`docs/deferred-minors.md`). This phase is where that gets solved properly,
because the pattern now appears in two places.

The bar sits over the hero backdrop on `/home` and on a solid surface
elsewhere.

### Home

Featured hero, then the four rows.

**Hero:** the first title in Trending that has a backdrop. Deterministic, no
rotation. Random or time-based selection makes the page flicker between renders
and makes tests non-deterministic; rotation, if wanted, is a deliberate later
feature with its own state.

**Rows:** each row is its own TanStack Query, so a failure degrades to an error
strip *inside that row* while the others render. Cards are 2:3 posters with a
reserved box, matching the search results and episode grid, so nothing reflows
as artwork arrives.

**Horizontal navigation.** `CLAUDE.md` forbids horizontal scrolling without a
clear affordance and requires keyboard access. Rows get explicit previous/next
buttons, native touch scrolling on mobile, and each card is a link so Tab walks
the row with scroll following focus.

Because explicit arrow buttons exist, the native scrollbar is hidden here. That
is the opposite of the decision taken for the season tabs in 3c-2a, and the
difference is the point: there, hiding the bar would have removed the *only*
affordance; here it removes a redundant one. The reasoning is recorded because
the two decisions look contradictory out of context.

## Failure and empty states

| Condition | Behaviour |
| --- | --- |
| No metadata provider configured | Home shows one guidance panel linking to `/admin/metadata`, not four broken rows |
| One row fails, others succeed | Error strip within that row; the rest render |
| Provider outage, cache present | All rows render from cache |
| Provider returns an empty row | Row hidden — an empty shelf communicates nothing |
| Kind unsupported by provider | Row hidden |

## Testing

**Database:** ordering by `position`; delete-then-insert dropping departed
titles; the freshness stamp and entries committing atomically; cascade on title
delete.

**Server:** cache-on-read and TTL expiry counting provider calls; degraded
stale serve on `unavailable`; refusal to serve stale on `unauthorized`;
unsupported kind; unconfigured provider. The `unauthorized` and unsupported
cases get load-bearing proofs — the 3c-2a review found the season degraded
branch had none, and this is the same branch shape.

**Provider:** each kind hitting the right endpoint; `media_type` supplied for
the single-type endpoints and trusted for trending; malformed payload
classified `unavailable`.

**E2E:** the TMDB fixture gains the four catalog endpoints. Home renders four
rows; a card click opens its title page; a row hides when its kind is
unsupported; the shell navigates. Poster rendering is asserted via
`naturalWidth`, since a broken image is still "visible" to Playwright.

## Deliberate omissions

**Row configurability.** `CLAUDE.md` describes the home rows as configurable.
With four provider-fixed rows there is nothing meaningful to configure — the
setting becomes real when personal rows exist and users want them ordered.
Deferred to Phase 4.

**Row pagination.** Each row shows what one provider page returns (~20 titles).
Infinite horizontal scroll is a discover-page concern.

**Negative caching on outage.** Carried forward from `docs/deferred-minors.md`:
the degraded path still re-attempts the provider on every request. It applies
equally to catalog rows and is deferred with them, to be designed once.
