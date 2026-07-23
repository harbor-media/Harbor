# Harbor — Title Page Meta Enrichment

**Date:** 2026-07-23
**Status:** Approved
**Depends on:** Phase 3c-2a (title detail), the title-page hero redesign (the hero this fills in)

## Scope

Section A of the Jellyfin-style title page enrichment: the data that finishes
the hero and adds the details table. Six new provider-sourced fields, all from
the TMDB detail payload (no new image pipeline, no new endpoint):

- **logo** image — the "SCARY MOVIE" title treatment; replaces the text title
  in the hero when present, falling back to text.
- **tagline** — the italic line above the overview.
- **rating** — `vote_average`, shown as `★ 6.4` in the meta line.
- **director**, **writers**, **studios** — the details table below the hero.

The remaining Jellyfin sections — **Cast & Crew** (needs a profile-image proxy)
and **More Like This** (needs a recommendations endpoint) — are later phases,
and the **stream selectors** belong to Phase 5 (playback). This phase does not
touch them.

## Provider

`getMovie`/`getSeries` in `apps/server/src/modules/metadata/providers/tmdb.ts`
add `append_to_response=credits,images` to the existing `/movie/{id}` and
`/tv/{id}` calls — one request, not three. `detailSchema` extends to parse the
new payload sections, all permissively (`.nullish()`), so a title missing any
of them still parses:

- `tagline: string`
- `vote_average: number`
- `production_companies: [{ name: string }]`
- `credits: { crew: [{ job: string, name: string }] }`
- `images: { logos: [{ file_path: string, iso_639_1: string | null }] }`

`toDetail` produces six new fields on `ProviderTitleDetail`:

| Field | Type | Derivation |
| --- | --- | --- |
| `tagline` | `string \| null` | `textOrNull(tagline)` |
| `rating` | `number \| null` | `vote_average`, but **0 → null** — TMDB uses 0.0 for "no votes", and a `★ 0` badge would misrepresent that as a zero score |
| `logoPath` | `string \| null` | the `iso_639_1 === "en"` logo's `file_path`, else the first logo's, else null |
| `director` | `string \| null` | the first crew member whose `job` is `Director` |
| `writers` | `string[]` | crew whose `job` is in `{Writer, Screenplay, Story}`, de-duplicated by name in first-seen order |
| `studios` | `string[]` | `production_companies` names |

Two derivations are **load-bearing** and get their own tests: the `0 → null`
rating, and the logo-language preference (an `en` logo chosen over an earlier
non-`en` one).

### Series

A movie fills Director/Writers from `credits.crew`. `append_to_response=credits`
works for `/tv` too, but a series often has no crew `Director`, so that row is
simply absent (the table hides empty rows). Studios, tagline, rating, and logo
work for both types.

## Storage

A migration adds six columns to `titles`, all nullable / defaulted so it is
additive:

```sql
tagline    text
rating     real
logo_path  text
director   text
writers    jsonb not null default '[]'
studios    jsonb not null default '[]'
```

`saveTitleDetail` (`packages/database/src/detail.ts`) writes them inside its
existing single-transaction detail write — the same atomic guarantee the season
list already has, so a partial detail can never be cached as complete.
`getTitleDetail` / `StoredTitleDetail` return them.

## Shared

`TitleDetailResponse` gains `tagline`, `rating`, `logoPath`, `director`,
`writers`, `studios`. `detail.ts`'s `toResponse` maps them through from the
stored title.

## Web

**Hero (`TitleHero`).**
- **Title:** when `logoPath` is present, the `h1` contains an `<img>` of the
  logo (`imageUrl(logoPath, "w500")`, `alt={detail.title}`, a capped height so a
  wide logo does not dominate); otherwise the `h1` holds the styled text title.
  The `h1` stays in both cases, so the accessible name and the e2e title
  assertion hold.
- **Meta line:** `metaLine([year, runtime, rating])` where rating renders as
  `★ 6.4` only when non-null.
- **Tagline:** italic, in the bottom-left block just above the overview.

**Details table (`TitleDetails`, new component).** A definition list rendered
below the hero, in the existing `max-w-7xl` content area: Genres, Director,
Writers (joined by `, `), Studios (joined by `, `). Each row is omitted when its
value is empty, so a sparse title shows a short table rather than blank rows.
Left label, value to the right — the Jellyfin details layout, achromatic.

**Image proxy:** unchanged. Logos serve at `w500`, already in the allowlist,
and are PNGs the proxy already permits.

## Testing

**Provider (`tmdb-detail` tests):**
- credits → director (first `Director`) and writers (the writing jobs,
  deduped);
- `production_companies` → studios;
- logo language pick — an `en` logo is chosen over an earlier non-`en` one
  (load-bearing);
- `vote_average` of 0 → `rating` null (load-bearing); a real average passes
  through;
- a payload missing credits/images/tagline still parses (no throw).

**Database (`detail` tests):** the new columns round-trip through
`saveTitleDetail` / `getTitleDetail`; the migration is additive (CREATE/ALTER
only adds columns).

**Service (`detail` service tests):** the response carries the new fields.

**Web:**
- `TitleHero` renders the logo image when `logoPath` is set and the text title
  when it is not (both keep the `h1`); the rating shows as `★ x.x` only when
  present; the tagline renders when set — a component test with each branch,
  the hide-branches proven load-bearing.

**E2E:** the TMDB fixture's movie detail gains `credits`, `images.logos`,
`tagline`, `vote_average`, `production_companies`. The title page asserts: the
logo renders (`naturalWidth > 0`, since a broken image is still "visible"); the
director and a studio name appear in the details table; the rating shows.

## Deliberate omissions

- **Cast & Crew** and **More Like This** — separate later phases (B and C).
- **Stream selectors** — Phase 5 (playback).
- **No separate credits/studios tables.** These are 1:1 with a title and small;
  columns on `titles` are the right weight. A normalized people/company model is
  a Cast-&-Crew-phase concern, if it earns one.
- **No writer/director profile links.** Names as text this phase; linking people
  is a Cast-&-Crew concern.

## Carried-forward deferrals (docs/deferred-minors.md)

- The e2e suite can run against a stale server `dist` (turbo cache) — server-side
  load-bearing proofs stay at the unit level.
- `naturalWidth` proves decode, not visibility — the hero/logo rendering is
  screenshot-verified before deploy.
