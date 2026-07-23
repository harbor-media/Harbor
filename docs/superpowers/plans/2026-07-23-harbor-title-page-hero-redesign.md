# Harbor — Title Page Hero Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the movie/series title page's centred-header-plus-empty-void layout with a single left-aligned cinematic hero anchored low on the backdrop, consistent with the home hero.

**Architecture:** Purely presentational. `TitleHeader` changes from a centred column to a left-aligned block inside a clamped-height, `justify-end` container so it sits over the lower backdrop; `TitleHeaderSkeleton` matches the new shape; `Title.tsx` drops `min-h-screen` so a movie has no trailing void. No data, endpoint, provider, or schema change.

**Tech Stack:** React 19.2.7, Tailwind 4.3.3, shadcn on the React Aria base, Vitest 4.1.10, Playwright 1.61.1.

## Global Constraints

- **Never** add `Co-Authored-By` trailers or any AI attribution to a commit message.
- `apps/web` uses `bundler` resolution — imports are extensionless.
- Strict TypeScript. No unjustified `any`.
- Never pipe a verification command through `tail`/`grep` when its exit code matters; use `cmd >/dev/null && echo OK`.
- Achromatic palette only — the artwork is the only colour; chrome stays neutral. Never pure black/white.
- Accessibility must hold: the title stays an `h1`; the disabled Play/Watchlist keep their `aria`-described "arrives in a later phase" affordance and stay keyboard-reachable (the `<span title>` wrapper + `isDisabled`); the decorative backdrop keeps `alt=""`.
- Verify the rendered layout with a **screenshot** from an e2e run before deploying — `naturalWidth` proves an image decoded, not that the layout is right (the lesson from the 3c-2b backdrop bugs).
- Deploy for manual review by **recreating** the container, never `docker restart` (which serves the image the container was created from), and verify the served bundle hash matches the local build.

---

### Task 1: Left-aligned title hero

**Files:**
- Modify: `apps/web/src/components/TitleHero.tsx` (`TitleHeader`, `TitleHeaderSkeleton`)
- Modify: `apps/web/src/pages/Title.tsx` (main wrapper — drop `min-h-screen`)

**Interfaces:**
- `TitleHeader({ detail, seasonLabel })` and `TitleHeaderSkeleton()` keep their exact signatures — only their internal markup changes.

- [ ] **Step 1: Rewrite `TitleHeader` left-aligned**

Replace the whole `TitleHeader` function in `apps/web/src/components/TitleHero.tsx` with:

```tsx
/** One clamped height for the hero, so it sits low on the backdrop and the
 *  page does not jump as the artwork loads -- the same measure the home hero
 *  uses. */
const HERO_HEIGHT = "h-[clamp(26rem,64vh,40rem)]";

/**
 * Left-aligned cinematic hero: a type label, the title, meta, genres, overview,
 * and actions in one block anchored at the bottom of the backdrop. Centring the
 * title while left-aligning the overview read as two designs; this is one, and
 * it matches the home hero so a title page and the home screen feel like one
 * product.
 */
export function TitleHeader({
  detail,
  seasonLabel,
}: {
  detail: TitleDetailResponse;
  seasonLabel: string | null;
}): JSX.Element {
  const runtime = detail.runtime === null ? null : `${String(detail.runtime)} min`;
  // The type ("Film"/"Series") is now the label above the title, so the meta
  // line carries only year and runtime.
  const meta = metaLine([detail.year, runtime]);
  // The season name, on a season view, stands in for the type label.
  const label = seasonLabel ?? (detail.type === "movie" ? "Film" : "Series");

  return (
    <div className={`flex ${HERO_HEIGHT} max-w-2xl flex-col justify-end`}>
      <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">{label}</p>

      <h1 className="mt-3 font-display text-5xl leading-tight tracking-tight sm:text-6xl">
        {detail.title}
      </h1>

      {detail.originalTitle !== null && detail.originalTitle !== detail.title ? (
        <p className="mt-2 text-sm text-muted-foreground">{detail.originalTitle}</p>
      ) : null}

      {meta === "" ? null : (
        <p className="mt-3 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          {meta}
        </p>
      )}

      {detail.genres.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {detail.genres.map((genre) => (
            <Badge key={genre} variant="secondary">
              {genre}
            </Badge>
          ))}
        </div>
      ) : null}

      {detail.overview === null ? null : (
        <p className="mt-4 line-clamp-3 text-sm text-muted-foreground">{detail.overview}</p>
      )}

      <div className="mt-6 flex items-center gap-3">
        {/* Visibly inert rather than dead handlers: playback arrives in Phase 5
            and the library in Phase 4. A button that silently does nothing reads
            as a bug; a disabled one with a reason reads as a roadmap. The
            explanation sits on a wrapping span because React Aria buttons do not
            forward a title attribute, and the span keeps it keyboard-reachable. */}
        <span title="Playback arrives in a later phase">
          <Button size="lg" className="rounded-full px-8" isDisabled>
            {/* An icon, not a bare U+25B6: the glyph would land in the button's
                accessible name as "black right-pointing triangle, Play". */}
            <PlayIcon className="size-4" aria-hidden="true" />
            Play
          </Button>
        </span>
        <span title="The library arrives in a later phase">
          <Button variant="secondary" size="lg" className="rounded-full" isDisabled>
            Watchlist
          </Button>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Match the skeleton to the new shape**

Replace `TitleHeaderSkeleton` so it reserves the same clamped height, left-aligned, and the page does not jump when data arrives:

```tsx
/** Reserves the hero's shape so the page does not jump when data arrives. */
export function TitleHeaderSkeleton(): JSX.Element {
  return (
    <div aria-hidden="true" className={`flex ${HERO_HEIGHT} max-w-2xl flex-col justify-end`}>
      <Skeleton className="h-3 w-16" />
      <Skeleton className="mt-3 h-14 w-2/3" />
      <Skeleton className="mt-4 h-16 w-full" />
      <Skeleton className="mt-6 h-11 w-64 rounded-full" />
    </div>
  );
}
```

- [ ] **Step 3: Drop the void in `Title.tsx`**

In `apps/web/src/pages/Title.tsx`, change the `<main>` wrapper so it no longer forces a full-screen height (which left a movie with a tall empty void). Change:

```tsx
    <main className="relative min-h-screen px-8 pb-16">
```

to:

```tsx
    <main className="relative px-8 pb-16 pt-8">
```

Everything else in `Title.tsx` (the backdrop, the max-w-7xl inner div, the season/episode section, the attribution) is unchanged.

- [ ] **Step 4: Lint, typecheck, build**

Run: `pnpm lint >/dev/null && pnpm typecheck >/dev/null && pnpm build >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 5: Confirm the e2e title specs still pass**

The `05-title-detail.spec.ts` assertions are on roles and text, not alignment: the `h1` title, the overview text, the genre text ("Science Fiction"), the runtime text ("117 min" — still present, since the meta line is now `1982 · 117 min`), the backdrop `naturalWidth`, and season switching. Run the suite:

Run: `pnpm test:e2e 2>&1 | grep -E "[0-9]+ (passed|failed)" | tail -1`
Expected: all passed (35).

If "117 min" fails, it means the meta line dropped the runtime — re-check `metaLine([detail.year, runtime])` in Step 1.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/TitleHero.tsx apps/web/src/pages/Title.tsx
git commit -m "feat(web): left-aligned cinematic title hero"
```

---

### Task 2: Screenshot verification, container smoke, and manual checkpoint

**Files:** none (verification only).

- [ ] **Step 1: Screenshot the rendered movie hero from an e2e run**

Temporarily add a screenshot to the movie-page test, run it, and Read the image to confirm the layout looks right (left-aligned block low on the backdrop, no void). Copy `e2e/tests/05-title-detail.spec.ts` first, edit the "a search result opens a real title page" test to add after the overview assertion:

```ts
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "<scratchpad>/title-hero.png", clip: { x: 0, y: 0, width: 1280, height: 720 } });
```

Run the suite, Read the PNG, confirm the layout, then restore the spec from the copy. Do NOT commit the screenshot edit.

- [ ] **Step 2: Full verification**

```bash
pnpm lint >/dev/null && echo LINT_OK && \
pnpm typecheck >/dev/null && echo TYPECHECK_OK && \
pnpm test >/dev/null && echo UNIT_OK && \
pnpm build >/dev/null && echo BUILD_OK && \
pnpm test:e2e 2>&1 | grep -E "[0-9]+ (passed|failed)" | tail -1
```

Expected: every marker prints and the e2e suite passes (35).

- [ ] **Step 3: Docker build and smoke**

```bash
pnpm docker:build && pnpm docker:smoke
```

Expected: `SMOKE PASSED`.

- [ ] **Step 4: Deploy for manual review — recreate, never restart**

```bash
docker rm -f harbor-3c2c-app
docker tag harbor:dev harbor:title-live
docker run -d --name harbor-3c2c-app --restart unless-stopped \
  -p 3405:3000 -v harbor_3c2b_data:/data \
  -e DATABASE_URL="postgresql://harbor:harbor@host.docker.internal:55444/harbor_3c2b" \
  -e HARBOR_BASE_URL="http://localhost:3405" \
  -e HARBOR_SECRET="0123456789abcdef0123456789abcdef" \
  -e HARBOR_LOG_LEVEL=warn \
  --add-host host.docker.internal:host-gateway \
  harbor:title-live
```

- [ ] **Step 5: Verify the served bundle**

```bash
curl -s http://localhost:3405/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Compare against `ls apps/server/public/assets/`. The hashes must match.

- [ ] **Step 6: Hand to the user**

Ask them to confirm at http://localhost:3405: open a movie from Discover or Home — the title/meta/genres/overview/actions are one left-aligned block low on the backdrop, no empty void below; open a series — the seasons and episodes flow under the hero.

---

## Self-Review Notes

Checked against the spec:

| Spec requirement | Task |
| --- | --- |
| Left-aligned block: type label, title, original title, meta, genres, overview, actions | 1 |
| Type label FILM/SERIES (season name on a season view) | 1 |
| Meta line = year · runtime (type moved to the label) | 1 |
| Overview at `max-w-2xl` | 1 |
| Clamped hero height; content low on the backdrop | 1 |
| Drop `min-h-screen` (kill the void) | 1 (Title.tsx) |
| Skeleton matches the new shape | 1 |
| Disabled Play/Watchlist affordance unchanged; h1; alt="" | 1 (carried verbatim) |
| Existing e2e title specs stay green | 1 (Step 5) |
| Screenshot verification before deploy | 2 |
