# Harbor — Title Page Hero Redesign (Jellyfin-style)

**Date:** 2026-07-23
**Status:** Approved
**Depends on:** Phase 3c-2a (title detail), 3c-2b (home backdrop hero — the pattern this aligns to)

## Scope

A layout refinement to the movie/series detail page, from the manual
checkpoint. The current page centres the title, meta, and actions at the top,
then left-aligns the overview and genres far below, and — because the page is
`min-h-screen` with nothing to fill it for a movie — leaves a large empty void
beneath. The centred-top → left-bottom → void combination reads as unfinished.

This replaces the split with a full-viewport, Jellyfin-style cinematic hero:
a full-bleed backdrop with the title, meta, and actions centred in the lower
middle and the overview plus genres pinned bottom-left. (An earlier iteration
tried a left-aligned block; the user pointed at Jellyfin as the target, and the
design was revised to match it.) The title logo image, tagline, and rating that
round out Jellyfin's page are deferred to a follow-up -- they need provider and
schema work -- and this ships the layout with the data Harbor has today.

Presentational only. No data, endpoint, provider, or schema change. The
season selector and episode grid (for series) are untouched except that they
now flow beneath the new hero.

### Out of scope

- Any change to the detail data, the backdrop image pipeline, or the season /
  episode components themselves.
- The Play / Watchlist actions' behaviour — they stay visibly disabled with the
  existing "arrives in a later phase" affordance (keyboard-reachable, described).
- Rating / HD / Dolby chrome — Harbor has no such data (same decision as the
  home hero).

## Layout

`TitleHeader` (in `apps/web/src/components/TitleHero.tsx`) changes from a
centred column to a single **left-aligned block anchored at the bottom of the
backdrop**, mirroring the home hero. Top to bottom, within the page's max
width:

- A mono, uppercase type label: `FILM` or `SERIES` (the season name replaces it
  on a season view, where `seasonLabel` is set).
- The title in the display font (large; the existing `text-5xl sm:text-6xl`).
- The original title beneath, only when it differs from the title.
- A mono meta line: `metaLine([year, runtime])` (e.g. `2026 · 173 min`).
- Genre badges on their own row (the existing `Badge variant="secondary"`).
- The overview, clamped to ~3 lines at a comfortable reading width
  (`max-w-2xl`), not the full `max-w-4xl` band.
- The Play / Watchlist actions, unchanged.

Everything shares one left edge and one alignment. The type label replaces the
"Film / Series" token that currently sits inside the centred meta line.

## The backdrop and the void

`TitleBackdrop` is unchanged (full-bleed, blurred-poster fallback, the lightened
gradients from 3c-2b). The hero block sits **over** the lower portion of that
backdrop rather than in a separate centred column above it.

The page stops forcing `min-h-screen`. For a **movie**, the page ends a short
distance below the hero — just the small TMDB attribution — with no tall
emptiness. For a **series**, the season selector and episode grid flow directly
under the hero and fill the height naturally. The hero itself reserves a
clamped height (reusing the home hero's `clamp(...)` approach) so the content
sits low on the artwork and the page does not jump as the backdrop loads.

## Consistency

Same backdrop component, same gradient treatment and wash as the home hero, so
the home screen and a title page read as one product. The achromatic rules hold:
the artwork is the only colour; chrome stays neutral.

## Accessibility

Unchanged where it matters: the title stays an `h1`; the disabled Play/Watchlist
keep their `aria`-described "later phase" affordance and stay keyboard-reachable;
the decorative backdrop keeps `alt=""`. Left-aligning does not alter the reading
order or roles the e2e and any screen reader depend on.

## Testing

- The existing e2e title specs must stay green unchanged: a search/discover
  result opens the title page (`h1` with the title), the backdrop renders
  (`naturalWidth > 0`), and — for a series — the season selector switches
  episodes. These assert roles and text, not alignment, so the redesign does
  not touch them.
- The rendered result is verified with a screenshot from an e2e run before
  deploying — `naturalWidth` proves an image decoded, not that the layout is
  right, which is the lesson from the 3c-2b backdrop bugs (invisible hero,
  shell-hidden title backdrop) that only screenshots caught.
- No new unit test: this is a presentational rearrangement of an existing
  component with no new branching logic.

## Deliberate omissions

- **No new "hero" abstraction shared with the home screen.** The two heroes
  differ enough (the home hero fetches detail for a *featured* title and links
  out; this one *is* the detail page) that a shared component would be an
  over-fit. They share the backdrop component and the visual language, which is
  the right level of reuse.
- **No cast, trailer, or "more like this" rows.** Those are later features with
  their own data needs.
