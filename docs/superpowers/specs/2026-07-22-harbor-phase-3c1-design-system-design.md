# Harbor Phase 3c-1 — Design System

**Date:** 2026-07-22
**Status:** Approved
**Depends on:** Phase 3b (image proxy); restyles pages built in Phases 1–2b

## Scope

Phase 3 was split into 3a (metadata foundation), 3b (image proxy), and 3c
(catalog UX). 3c is itself split:

| Slice | Scope |
| --- | --- |
| **3c-1** (this spec) | Adopt the design system: tokens, fonts, shadcn primitives, restyle existing pages |
| **3c-2** | Catalog UX: home rows, discover, movie/series/season pages, real search |

The system comes first so the catalog is built on final components. Built the
other way round, the catalog gets written in the old `harbor-*` classes and
then torn out — which is how a codebase ends up with two half-migrated
styling systems side by side.

3c-1 changes **no behavior**: same routes, same requests, same states. Only
the paint changes.

### Source of the design

The system is taken from the operator's own project at
`C:\Users\Vecto\Desktop\github\Manage\Main` (`DESIGN.md` and
`app/globals.css`), which in turn follows efferd.com — a shadcn blocks
library. Both share the same Geist / Geist Mono / Outfit stack and the same
near-monochrome dark base, so "efferd and shadcn" is one coherent system
rather than two influences to reconcile.

### Out of scope

Catalog layout, new pages, new features, light mode, and the components no
current page needs.

## Definition of Done

Harbor wears the design system. Every existing unit and Playwright test
passes **unchanged**. No CSP violations appear in the browser console. The
Docker image builds and the container smoke test passes. `CLAUDE.md` no
longer contradicts the code.

## Decisions

### The palette is achromatic, and that is a change to the spec

`CLAUDE.md` currently mandates "deep navy surfaces" and "blue and violet
accent gradients", and `apps/web/src/index.css` implements exactly that:
`harbor-950/900/800` at hue 265, `accent-500` at chroma 0.19.

The adopted system rejects that directly — *"explicitly rejects the generic
blue/indigo 'gamer SaaS' palette"* — and is achromatic: every core color is
`oklch(L 0 0)` with chroma exactly zero.

The operator's instruction governs, so **`CLAUDE.md`'s Visual Direction
section is rewritten as part of this phase.** Changing the code while leaving
the spec asserting the opposite would hand the next phase a contradiction to
trip over.

The choice is also better suited to Harbor than to its source project.
Harbor's screens are wall-to-wall poster artwork, and `CLAUDE.md` already
asks for "large cinematic artwork" and "minimal visual noise". Achromatic
chrome means **the artwork supplies every bit of color on screen**; a navy
and violet frame competes with hundreds of differently coloured posters.

### No brand accent hue

The system's Semantic-Only Rule is applied literally: color appears only when
it carries meaning. Primary actions, focus rings, and the play affordance use
Signal Off-White `oklch(0.922 0 0)`. Red, green, amber, and sky are reserved
for status.

A white play affordance is also the established convention (Netflix, Stremio,
YouTube), so this costs no familiarity.

The tradeoff accepted: Harbor has no signature hue. If the product later
wants one, it is a single token change rather than a restyle.

### Old tokens are deleted, not aliased

`harbor-950/900/800` and `accent-500/400` are removed outright rather than
remapped onto the new scale. An alias would let the old palette survive one
`className` at a time, and the migration would never actually finish.

### Fonts are bundled, never fetched from a CDN

The source project uses `next/font/google`, which self-hosts at build time.
Harbor is Vite, where that mechanism does not exist.

A Google Fonts `<link>` **would be blocked by Harbor's own CSP**
(`font-src 'self'` in `apps/server/src/app.ts`). It would fail silently and
fall back to system sans, presenting as "the fonts didn't apply" rather than
as a policy violation.

Fonts therefore ship as `@fontsource/geist-sans`, `@fontsource/geist-mono`,
and `@fontsource/outfit` dependencies. This also suits self-hosted software:
no third-party request on every page load telling a font CDN when someone
opened their media server, and it works on a machine with no outbound
internet.

### Eight components now, not sixteen

shadcn supports Vite directly. Only the primitives the existing pages need
are installed: `button`, `input`, `label`, `card`, `select`, `badge`,
`separator`, `alert`.

`dialog`, `tabs`, `tooltip`, `scroll-area`, `avatar`, and `sonner` are added
in 3c-2 when the catalog calls for them. Installing all sixteen now is
inventory, not progress.

### Dark only

Harbor ships dark-only, matching the source project, which forces `dark` on
`<html>`. `CLAUDE.md` already specifies a dark-first interface. Light tokens
are not defined, so no half-supported light mode can be reached accidentally.

## Architecture

### Tokens

Taken from the source project's `.dark` block, into Tailwind 4's `@theme` in
`apps/web/src/index.css`. Two deliberate differences from a straight copy:

- `success`, `warning`, and `info` are named explicitly. The source carries
  them in `DESIGN.md` but expresses them in CSS only as chart series, which
  would leave Harbor's status colors undefined.
- The `sidebar-*` tokens are omitted. Harbor has no sidebar, and unused
  tokens invite someone to invent a use for them.

```
background          oklch(0.185 0 0)      canvas, never pure black
card / popover      oklch(0.225 0 0)      one step up, tonal layering
secondary/muted/    oklch(0.285 0 0)      hover fills, chips, input wells
  accent
foreground          oklch(0.985 0 0)      primary text
muted-foreground    oklch(0.715 0 0)      secondary text, captions
primary (signal)    oklch(0.922 0 0)      the single emphasis color
primary-foreground  oklch(0.205 0 0)      text on primary fills
border              oklch(1 0 0 / 10%)    hairline, never structural
input                oklch(1 0 0 / 15%)
ring                oklch(0.556 0 0)
destructive         oklch(0.704 0.191 22.216)
success             oklch(0.696 0.17 162.48)
warning             oklch(0.828 0.189 84.429)
info                oklch(0.746 0.16 232.661)
```

Radius base is `10px`, giving `sm 6 / md 8 / lg 10 / xl 14 / 2xl 18` through
the source project's multipliers.

Depth comes from tonal layering and hairline borders, not shadows.

### Typography

- **Outfit** — display and headings
- **Geist** — body and UI
- **Geist Mono** — labels and any value meant to read as data

### Pages restyled

`Setup`, `Login`, `Register`, `Invite`, `Home`, `Invitations`,
`AdminMetadata`, `Search`.

`Search` is restyled only to the extent that it stops using deleted tokens.
It is throwaway scaffolding that 3c-2 replaces outright, so investing in its
layout here would be work done twice.

## Testing

**The regression net already exists.** The 18 Playwright tests drive every one
of these pages through `getByLabel` and `getByRole` rather than CSS classes,
so a restyle that breaks a form association, drops a label, or removes
`role="alert"` fails the suite immediately. The semantics are pinned; only
the presentation is in play.

That is the central testing property of this phase: **every existing test must
pass unchanged.** A test that needs editing to accommodate the restyle is
evidence the restyle changed behavior, and the change should be reconsidered
rather than the test rewritten.

Additionally:

- Accessibility survives: `aria-live` on error regions, visible focus rings,
  every input associated with a label. `CLAUDE.md` targets WCAG 2.2 AA.
- No CSP violation appears in the console on any page, which is what proves
  the fonts are genuinely self-hosted rather than silently failing.
- The Docker image builds and the container smoke test passes.
