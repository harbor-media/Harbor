# Harbor — Home Backdrop Hero

**Date:** 2026-07-23
**Status:** Approved
**Depends on:** Phase 3c-2b (home catalog rows), 3c-2a (title detail), 3b (image proxy)

## Scope

A refinement to the home screen built in 3c-2b, from the manual checkpoint. The
current hero shows only a blurred, darkened poster behind the title — subtle to
the point of reading as "no image." This replaces it with a full-bleed
cinematic backdrop and a richer info block, in the spirit of streaming home
screens (Viaplay was the reference), without copying any product's identity.

Backdrop hero only; the catalog rows continue to flow beneath it. Overlapping
the first row onto the artwork is explicitly out of scope.

## Featured title

The first entry in Trending. Deterministic, no rotation — the same reasoning
the existing hero documents: rotation changes the page under the reader between
renders and makes the e2e assertion unpinnable, and belongs to a later feature
with its own state.

## Data

The catalog row DTO (`TitleCard`) carries only a poster. The hero instead
fetches full detail for the featured title through the existing
`useTitleDetail(id)` hook (`GET /api/v1/titles/:id`), which returns
`backdropPath`, `posterPath`, `genres`, `runtime`, `year`, `overview`, and
`type`. No schema change, no new endpoint; the request is served from the
server's 24h detail cache after the first hit.

This costs one extra request on home load, for the featured title only. The
trending row is already fetched, so the featured id is known without waiting.

## Layout

A full-bleed backdrop, height clamped (roughly `min(75vh, …)` with a sensible
floor), image anchored top so faces are not cropped. Two gradients over it:

- a left-to-right darkening, so the text stays legible over bright artwork;
- a bottom fade to the canvas colour, so the rows below blend in rather than
  meeting a hard image edge.

The info block sits bottom-left within the page's max width: the title in the
display font, a mono meta line (`metaLine([year, runtime, genres…])`, e.g.
`2025 · 104 min · Thriller, Drama`), the overview clamped to ~2–3 lines, and a
**View details** link to the title page.

### Deliberately honest to our data

No IMDb badge, no "HD / Dolby", no Play button. Harbor has no rating data, and
playback is Phase 5. The reference's chrome is inspiration, not a template; the
meta line shows only what we actually hold.

## Image size

The proxy allowlist tops out at `w780`, soft on a >1200px hero. TMDB publishes
`w1280` for backdrops; it is added to the allowlist (the same one-line change
that added `w300` for stills), and the hero requests the backdrop at `w1280`.
Posters keep their existing sizes.

## Fallbacks and states

| State | Behaviour |
| --- | --- |
| Backdrop present | Full-bleed `w1280` backdrop |
| No backdrop, poster present | The current blurred-and-darkened poster treatment, scaled to the hero |
| Detail still loading | The hero's height is reserved with a neutral panel, so the page does not jump |
| No featured title (empty Trending) | Hero renders nothing; rows still show |
| Detail fetch fails | Hero renders nothing (or the poster fallback if the card poster is known); a failed hero must never blank the rows |

## Testing

- The e2e TMDB fixture's featured series (`Supernatural`, first in the trending
  fixture) gains a non-null `backdrop_path`, so the hero renders a real
  backdrop end to end.
- The home spec asserts the hero backdrop actually renders — `naturalWidth > 0`,
  not mere visibility, since a broken image is still "visible" to Playwright
  (the lesson from the 3c-2a still-render regression).
- A web component/unit check is not added: the hero is a thin presentational
  wrapper over `useTitleDetail`, whose branches (loading, data, error) are
  already covered by the title page's usage; the e2e covers the rendered
  result. If the backdrop/fallback branching grows, it earns its own test then.

## Out of scope

- First-row overlap onto the backdrop.
- Backdrop rotation or a "featured" carousel.
- Any rating, quality, or audio-format chrome (no data source).
- Widening `TitleCard`/`catalog_entries` with a backdrop column — the detail
  fetch already carries it, and the row payload stays lean.
