# Deferred minors

Issues found during review that were consciously **not** fixed in the phase
that surfaced them. Each entry records the concrete failure, so a later phase
can judge urgency without re-deriving it.

This file exists because these had previously been tracked only in
conversation, where they do not survive.

## From Phase 3c-2c — discover / genre browsing

- **Repeated full-reloads of the proxy-through discover page hung on "Starting
  Harbor…".** In the e2e, a fourth sequential `page.goto` to the same
  `/discover?...` URL left the app stuck with install/currentUser pending. Not
  root-caused; the discover tests were consolidated to fewer navigations to
  avoid it. A real SPA client-side-navigates without refetching the session, so
  this is most likely a repeated-full-reload artifact rather than an app bug --
  but if users ever report a hung Discover, the proxy-through path (each load
  does upsertTitles in a transaction) and the DB pool under load are where to
  look first.

## From Phase 3c-2b — home catalog rows

- **The e2e suite can run against a stale server `dist`.** `pnpm test:e2e`
  starts the built server (`node ../apps/server/dist/server.js`) via turbo's
  `^build`. When turbo restores a cached server build, the running server is
  not the code just changed — a load-bearing check for the `w1280` allowlist
  passed while it should have failed for exactly this reason, because the
  server under test was a stale build. The web bundle has the analogous
  guard (`@harbor/web#build` declares `../server/public/**`); the server dist
  needs the same treatment, or the runner should force a clean server build.
  Until then, server-side load-bearing proofs must be done at the unit level,
  not trusted through the e2e.

- **Visibility is not covered by `naturalWidth` assertions.** Both backdrop
  bugs this phase (home hero, then the title page hidden by the shell) passed
  the e2e's `naturalWidth > 0` checks — the image decoded but was painted over
  or gradient-washed to black. A meaningful guard would assert computed
  opacity/stacking or compare a screenshot region, neither of which the suite
  does today. The fixes were verified by eye from e2e screenshots instead.

- **`CatalogRow` scroll geometry is untested.** The prev/next buttons enable
  and disable from `scrollLeft`/`clientWidth`/`scrollWidth`, none of which
  jsdom implements, so a component test cannot exercise them. The e2e only
  asserts the left button is disabled at rest; the `atEnd` transition and the
  one-pixel rounding slack have no assertion. A real browser-driven test (or a
  Playwright test scrolling the row) would close it.

- **`CatalogRow` does not re-measure on window resize.** `atStart`/`atEnd`
  update on scroll and on new data only. After a viewport resize — a row that
  now fits, say — the buttons can be stale (an enabled "next" with nowhere to
  go). Cosmetic; a `resize` listener calling `measure` would fix it.

## From Phase 3a — metadata foundation

- **Secondary external ids are not covered by the upsert advisory lock.**
  `upsertTitles` locks on `source:externalId` of the *first* id. A title
  matched on a secondary id can still race. Not reachable today: TMDB is the
  only provider, so every title carries exactly one id. Becomes real the
  moment a second metadata provider lands.

- **`upsertTitles` is not atomic across items.** Each title is its own
  statement. A failure midway leaves the earlier titles written. Harmless for
  search results, which are re-fetchable, but worth revisiting if the same
  accessor is ever used for something authoritative.

- **No TTL boundary test.** Freshness is tested well inside and well outside
  the window, never at exactly `fetchedAt + TTL`. An off-by-one in the
  comparison would pass.

- **`hashSearchQuery` does not normalize internal whitespace.** `"blade
  runner"` and `"blade  runner"` produce different cache keys, so the second
  spelling costs an upstream call. Cosmetic; wastes a request, returns correct
  results.

## From Phase 3c-2a — title detail

- **The degraded path does not dampen upstream retries.** During a provider
  outage every request re-attempts TMDB; with the deliberately generous
  120/minute limit, one user can drive 120 upstream calls per minute per
  title, precisely when the provider is failing. Harbor degrades *correctly*
  today — this is amplification, not breakage. Deferred to Phase 4 on purpose:
  a negative cache introduces a second freshness concept, and Phase 4 adds far
  more metadata traffic, so it deserves one deliberate design pass rather than
  two.

- **`saveTitleDetail` never updates `titles.title` or `titles.type`.** A name
  the provider corrects at the detail endpoint stays overridden by whatever
  multi-search returned. Arguably right — search is how users find the title —
  but it is currently accidental rather than decided.

- **The disabled Play / Watchlist explanation is mouse-only.** The reason sits
  in a `title` attribute on a wrapping `span`; a disabled button is not
  focusable, so keyboard and screen-reader users get no explanation at all.
  Both buttons become real in Phases 4 and 5, which is when the affordance
  should be built properly rather than patched.

- **No `role="status"` for the initial title load.** The season change
  announces; the first load does not, so a screen-reader user gets silence
  while the page fetches. `TitleHeaderSkeleton` is `aria-hidden`.

- **Migration `0006_sleepy_juggernaut.sql` has no trailing newline.**
