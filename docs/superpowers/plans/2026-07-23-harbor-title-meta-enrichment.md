# Harbor — Title Page Meta Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six provider-sourced fields — logo, tagline, rating, director, writers, studios — to the title page: the logo replaces the hero title, the rating and tagline enrich the hero, and director/writers/studios form a details table below it.

**Architecture:** Threads the six fields bottom-up through the existing detail pipeline — TMDB adapter (`append_to_response=credits,images`) → `titles` columns (additive migration) → `TitleDetailResponse` → the detail service → the web hero and a new details table. No new endpoint; logos reuse the already-allowlisted `w500` image proxy.

**Tech Stack:** TypeScript 6.0.3, Fastify 5.10.0, Drizzle 0.45.2, Zod 4.4.3, React 19.2.7, shadcn on the React Aria base, Vitest 4.1.10, Playwright 1.61.1.

## Global Constraints

- **Never** add `Co-Authored-By` trailers or any AI attribution to a commit message.
- `packages/*` and `apps/server` use `moduleResolution: nodenext` — relative imports need explicit `.js` extensions. `apps/web` uses `bundler` — extensionless.
- Strict TypeScript. No unjustified `any`. Runtime validation at every external boundary (TMDB payloads via Zod, permissively with `.nullish()`).
- Never pipe a verification command through `tail`/`grep` when its exit code matters; use `cmd >/dev/null && echo OK`.
- Every guard added must have a load-bearing test at the **unit** level (the e2e can run against a stale server `dist`). Break the guard, watch a specific test fail, restore it.
- Migrations are generated with `pnpm --filter @harbor/database exec drizzle-kit generate`, never hand-written; read the SQL and confirm it only adds columns.
- Run `pnpm --filter @harbor/database build` after changing `packages/database`; `pnpm --filter @harbor/shared build` after changing `packages/shared`.
- Test files are excluded from `tsc`, so an incomplete object-literal fake does not break `pnpm typecheck` — but it fails at runtime if a test reads the missing field. Update a fake in the task whose test first needs the new field.
- The rendered hero/logo is **screenshot-verified** before deploy — `naturalWidth` proves decode, not visibility.

---

### Task 1: Provider — parse credits, images, tagline, rating, studios

**Files:**
- Modify: `apps/server/src/modules/metadata/providers/types.ts` (`ProviderTitleDetail`)
- Modify: `apps/server/src/modules/metadata/providers/tmdb.ts`
- Modify: `apps/server/src/modules/metadata/providers/tmdb-detail.test.ts`

**Interfaces:**
- Produces on `ProviderTitleDetail`: `tagline: string | null`, `rating: number | null`, `logoPath: string | null`, `director: string | null`, `writers: string[]`, `studios: string[]`.

- [ ] **Step 1: Extend `ProviderTitleDetail`**

In `types.ts`, add the six fields to `ProviderTitleDetail` (after `genres`):

```ts
  tagline: string | null;
  /** vote_average, but null when TMDB reports 0 (its "no votes" value). */
  rating: number | null;
  logoPath: string | null;
  director: string | null;
  writers: string[];
  studios: string[];
```

- [ ] **Step 2: Write the failing provider tests**

Add to `tmdb-detail.test.ts` (its `MOVIE` fixture is a movie detail body; extend the calls to include the new payload). The tests:

```ts
describe("detail enrichment", () => {
  const enriched = {
    ...MOVIE,
    tagline: "More than meets the eye.",
    vote_average: 6.4,
    production_companies: [{ name: "Wayans Bros." }, { name: "Miramax" }],
    credits: {
      crew: [
        { job: "Director", name: "Michael Tiddes" },
        { job: "Screenplay", name: "Rick Alvarez" },
        { job: "Writer", name: "Rick Alvarez" },
        { job: "Story", name: "Marlon Wayans" },
        { job: "Editor", name: "Someone Else" },
      ],
    },
    images: {
      logos: [
        { file_path: "/xx-fr.png", iso_639_1: "fr" },
        { file_path: "/logo-en.png", iso_639_1: "en" },
      ],
    },
  };

  function providerFor(body: unknown) {
    return createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: (() => Promise.resolve(json(body))) as unknown as typeof fetch,
    });
  }

  it("pulls tagline, studios, director and deduped writers", async () => {
    const d = await providerFor(enriched).getMovie("78", "en-US", SIGNAL());
    expect(d.tagline).toBe("More than meets the eye.");
    expect(d.studios).toEqual(["Wayans Bros.", "Miramax"]);
    expect(d.director).toBe("Michael Tiddes");
    // Writer/Screenplay/Story only, editor excluded, "Rick Alvarez" once.
    expect(d.writers).toEqual(["Rick Alvarez", "Marlon Wayans"]);
  });

  it("prefers the English logo over an earlier non-English one", async () => {
    const d = await providerFor(enriched).getMovie("78", "en-US", SIGNAL());
    expect(d.logoPath).toBe("/logo-en.png");
  });

  it("treats a vote_average of 0 as no rating", async () => {
    const d = await providerFor({ ...enriched, vote_average: 0 }).getMovie("78", "en-US", SIGNAL());
    expect(d.rating).toBeNull();
  });

  it("passes a real vote_average through", async () => {
    const d = await providerFor(enriched).getMovie("78", "en-US", SIGNAL());
    expect(d.rating).toBe(6.4);
  });

  it("parses a detail body with no credits, images, or tagline", async () => {
    const d = await providerFor(MOVIE).getMovie("78", "en-US", SIGNAL());
    expect(d.tagline).toBeNull();
    expect(d.logoPath).toBeNull();
    expect(d.director).toBeNull();
    expect(d.writers).toEqual([]);
    expect(d.studios).toEqual([]);
    expect(d.rating).toBeNull();
  });

  it("requests credits and images in one call", async () => {
    const urls: string[] = [];
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: ((url: string) => {
        urls.push(url);
        return Promise.resolve(json(MOVIE));
      }) as unknown as typeof fetch,
    });
    await provider.getMovie("78", "en-US", SIGNAL());
    expect(urls[0]).toContain("append_to_response=credits%2Cimages");
  });
});
```

Note: `SIGNAL`, `json`, and `MOVIE` already exist in this file (from Phase 3c-2a). If `MOVIE` is not a bare movie-detail object, read the file and adapt `enriched` to spread whatever the existing movie fixture is named.

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/providers/tmdb-detail.test.ts`
Expected: FAIL — `d.tagline` etc. are undefined.

- [ ] **Step 4: Extend `detailSchema` and `toDetail`**

In `tmdb.ts`, extend `detailSchema` (add these keys inside the existing `z.object({...})`):

```ts
  tagline: z.string().nullish(),
  vote_average: z.number().nullish(),
  production_companies: z.array(z.object({ name: z.string() })).nullish(),
  credits: z
    .object({ crew: z.array(z.object({ job: z.string(), name: z.string() })).nullish() })
    .nullish(),
  images: z
    .object({
      logos: z
        .array(z.object({ file_path: z.string(), iso_639_1: z.string().nullish() }))
        .nullish(),
    })
    .nullish(),
```

Add these helpers above `toDetail`:

```ts
const WRITER_JOBS = new Set(["Writer", "Screenplay", "Story"]);

/** English logo if there is one, else the first, else null. TMDB returns
 *  logos in several languages; the English one is the right default here. */
function pickLogo(logos: { file_path: string; iso_639_1: string | null | undefined }[]): string | null {
  const en = logos.find((l) => l.iso_639_1 === "en");
  return (en ?? logos[0])?.file_path ?? null;
}
```

Add the six fields to the object `toDetail` returns (after `seasons`):

```ts
    tagline: textOrNull(payload.tagline),
    // TMDB uses 0.0 for "no votes"; a "star 0" badge would misread that as a
    // zero score, so 0 becomes null.
    rating: payload.vote_average == null || payload.vote_average === 0 ? null : payload.vote_average,
    logoPath: pickLogo(payload.images?.logos ?? []),
    director: (payload.credits?.crew ?? []).find((c) => c.job === "Director")?.name ?? null,
    writers: [
      ...new Set(
        (payload.credits?.crew ?? [])
          .filter((c) => WRITER_JOBS.has(c.job))
          .map((c) => c.name),
      ),
    ],
    studios: (payload.production_companies ?? []).map((c) => c.name),
```

- [ ] **Step 5: Add `append_to_response` to the detail calls**

In `getMovie` and `getSeries`, change the `URLSearchParams` from `{ language }` to include the append. Both call sites:

```ts
        new URLSearchParams({ language, append_to_response: "credits,images" }),
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/providers/tmdb-detail.test.ts`
Expected: PASS (the 6 new tests plus the existing ones).

- [ ] **Step 7: Prove the two guards are load-bearing**

Change `=== 0 ? null` to just `payload.vote_average` (drop the 0-guard); re-run → the "vote_average of 0" test fails. Restore.
Change `pickLogo` to `return logos[0]?.file_path ?? null` (drop the English preference); re-run → the "prefers the English logo" test fails. Restore.

- [ ] **Step 8: Update the full provider fakes that construct ProviderTitleDetail**

`apps/server/src/modules/metadata/detail.test.ts` builds a `DETAIL` object typed as `ProviderTitleDetail` (returned by its `fakeProvider`). Add the six fields to it so later tasks that read them from the fake work:

```ts
  tagline: null,
  rating: null,
  logoPath: null,
  director: null,
  writers: [],
  studios: [],
```

Run: `pnpm --filter @harbor/server test >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/modules/metadata/providers apps/server/src/modules/metadata/detail.test.ts
git commit -m "feat(metadata): provider parses logo, tagline, rating, credits, studios"
```

---

### Task 2: Storage — columns, accessors, and the service write

**Files:**
- Modify: `packages/database/src/schema.ts` (`titles` columns)
- Create: `packages/database/drizzle/00NN_*.sql` (generated)
- Modify: `packages/database/src/detail.ts` (`TitleDetailUpdate`, `StoredTitleDetail`, `saveTitleDetail`, `getTitleDetail`)
- Modify: `packages/database/src/detail.test.ts`
- Modify: `apps/server/src/modules/metadata/detail.ts` (the `saveTitleDetail` call site)

**Interfaces:**
- Consumes: the six `ProviderTitleDetail` fields from Task 1.
- Produces: the six fields on `StoredTitleDetail` and `TitleDetailUpdate`.

- [ ] **Step 1: Add the columns**

In `packages/database/src/schema.ts`, add to the `titles` table (before `detailFetchedAt`):

```ts
    tagline: text("tagline"),
    rating: real("rating"),
    logoPath: text("logo_path"),
    director: text("director"),
    writers: jsonb("writers").$type<string[]>().notNull().default([]),
    studios: jsonb("studios").$type<string[]>().notNull().default([]),
```

Confirm `real` is imported from `drizzle-orm/pg-core` at the top of the file; add it to the existing import if missing.

- [ ] **Step 2: Generate and inspect the migration**

Run: `pnpm --filter @harbor/database exec drizzle-kit generate`
Expected: a new `00NN_*.sql`. Read it — it must be `ALTER TABLE "titles" ADD COLUMN ...` for the six columns only, nothing else. If it drops or retypes an existing column, stop and report BLOCKED.

- [ ] **Step 3: Extend the accessor types and the failing test**

In `packages/database/src/detail.ts`, add the six fields to both `TitleDetailUpdate` and `StoredTitleDetail`:

```ts
  tagline: string | null;
  rating: number | null;
  logoPath: string | null;
  director: string | null;
  writers: string[];
  studios: string[];
```

Add a round-trip test to `detail.test.ts` (its `saveTitleDetail` helper/call passes a `TitleDetailUpdate` — extend it with the new fields, then assert they read back):

```ts
it("round-trips the enrichment fields", async () => {
  const id = await seedTitle();
  await saveTitleDetail(
    db,
    id,
    {
      originalTitle: "Blade Runner",
      year: 1982,
      overview: "x",
      posterPath: null,
      backdropPath: null,
      runtime: 117,
      genres: ["Science Fiction"],
      tagline: "More than meets the eye.",
      rating: 6.4,
      logoPath: "/logo.png",
      director: "Ridley Scott",
      writers: ["Hampton Fancher", "David Peoples"],
      studios: ["Warner Bros."],
    },
    [],
    new Date(),
  );

  const row = await getTitleDetail(db, id);
  expect(row?.tagline).toBe("More than meets the eye.");
  expect(row?.rating).toBe(6.4);
  expect(row?.logoPath).toBe("/logo.png");
  expect(row?.director).toBe("Ridley Scott");
  expect(row?.writers).toEqual(["Hampton Fancher", "David Peoples"]);
  expect(row?.studios).toEqual(["Warner Bros."]);
});
```

Adapt `seedTitle`/the existing `saveTitleDetail` test calls in this file: every existing `saveTitleDetail` call now needs the six new `TitleDetailUpdate` fields (they are required). Add them (nulls / empty arrays) to each existing call so the file compiles and runs.

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter @harbor/database exec vitest run src/detail.test.ts`
Expected: FAIL — the new columns are not written/read yet.

- [ ] **Step 5: Write the columns in `saveTitleDetail` and read them in `getTitleDetail`**

In `saveTitleDetail`, add the six fields to the `tx.update(titles).set({...})` object:

```ts
        tagline: update.tagline,
        rating: update.rating,
        logoPath: update.logoPath,
        director: update.director,
        writers: update.writers,
        studios: update.studios,
```

In `getTitleDetail`'s returned object, add:

```ts
    tagline: row.tagline,
    rating: row.rating,
    logoPath: row.logoPath,
    director: row.director,
    writers: row.writers,
    studios: row.studios,
```

- [ ] **Step 6: Run the DB tests**

Run: `pnpm --filter @harbor/database exec vitest run src/detail.test.ts`
Expected: PASS.

- [ ] **Step 7: Update the service call site so the server compiles**

`TitleDetailUpdate` now has six required fields, so the `saveTitleDetail` call in `apps/server/src/modules/metadata/detail.ts` (inside `fetchTitleDetail`) must pass them from `detail` (the `ProviderTitleDetail` from Task 1). Add to that call's update object:

```ts
      tagline: detail.tagline,
      rating: detail.rating,
      logoPath: detail.logoPath,
      director: detail.director,
      writers: detail.writers,
      studios: detail.studios,
```

- [ ] **Step 8: Build and verify**

Run: `pnpm --filter @harbor/database build >/dev/null && pnpm typecheck >/dev/null && pnpm --filter @harbor/server test >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 9: Commit**

```bash
git add packages/database/src/schema.ts packages/database/drizzle packages/database/src/detail.ts packages/database/src/detail.test.ts apps/server/src/modules/metadata/detail.ts
git commit -m "feat(database): store title logo, tagline, rating, credits, studios"
```

---

### Task 3: Shared response fields and the service mapping

**Files:**
- Modify: `packages/shared/src/index.ts` (`TitleDetailResponse`)
- Modify: `apps/server/src/modules/metadata/detail.ts` (`toResponse`)
- Modify: `apps/server/src/modules/metadata/detail.test.ts`

**Interfaces:**
- Consumes: the six `StoredTitleDetail` fields (Task 2).
- Produces: the six fields on `TitleDetailResponse`.

- [ ] **Step 1: Add the fields to `TitleDetailResponse`**

In `packages/shared/src/index.ts`, add to `TitleDetailResponse` (after `genres`):

```ts
  tagline: string | null;
  rating: number | null;
  logoPath: string | null;
  director: string | null;
  writers: string[];
  studios: string[];
```

- [ ] **Step 2: Write the failing service test**

In `apps/server/src/modules/metadata/detail.test.ts`, the `fakeProvider`'s `DETAIL` now carries the fields (Task 1 Step 8). Give it real values there for this assertion (change `DETAIL`'s six fields from null/[] to values), then assert the response carries them:

```ts
it("returns the enrichment fields on the response", async () => {
  await configure();
  const id = await seedSeries();
  const result = await fetchTitleDetail(deps(fakeProvider({ detail: 0, season: 0 })), id);

  expect(result.tagline).toBe(DETAIL.tagline);
  expect(result.rating).toBe(DETAIL.rating);
  expect(result.logoPath).toBe(DETAIL.logoPath);
  expect(result.director).toBe(DETAIL.director);
  expect(result.writers).toEqual(DETAIL.writers);
  expect(result.studios).toEqual(DETAIL.studios);
});
```

Set `DETAIL`'s fields to, e.g., `tagline: "t"`, `rating: 6.4`, `logoPath: "/l.png"`, `director: "Dir"`, `writers: ["W"]`, `studios: ["S"]`.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/detail.test.ts`
Expected: FAIL — `result.tagline` is undefined (`toResponse` does not map it).

- [ ] **Step 4: Map the fields in `toResponse`**

In `detail.ts`, add the six fields to the object `toResponse` returns (after `genres`):

```ts
    tagline: title.tagline,
    rating: title.rating,
    logoPath: title.logoPath,
    director: title.director,
    writers: title.writers,
    studios: title.studios,
```

- [ ] **Step 5: Build shared, run, verify**

Run: `pnpm --filter @harbor/shared build >/dev/null && pnpm typecheck >/dev/null && pnpm --filter @harbor/server test >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/index.ts apps/server/src/modules/metadata/detail.ts apps/server/src/modules/metadata/detail.test.ts
git commit -m "feat(metadata): expose enrichment fields on the title detail response"
```

---

### Task 4: Web — logo, rating, tagline, and the details table

**Files:**
- Modify: `apps/web/src/components/TitleHero.tsx`
- Create: `apps/web/src/components/TitleDetails.tsx`
- Create: `apps/web/src/components/TitleHero.test.tsx`
- Modify: `apps/web/src/pages/Title.tsx` (render `TitleDetails`)

**Interfaces:**
- Consumes: the six `TitleDetailResponse` fields; `imageUrl`, `metaLine`, `Badge`.
- Produces: `TitleDetails` component.

- [ ] **Step 1: Write the failing hero test**

Create `apps/web/src/components/TitleHero.test.tsx`. jsdom, no jest-dom (plain DOM assertions, as `AppShell.test.tsx` does). It needs a `MemoryRouter` only if the component uses router hooks — `TitleHero` does not, so render it directly. Build a base `TitleDetailResponse` and override per test:

```tsx
import type { TitleDetailResponse } from "@harbor/shared";
import { render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { describe, expect, it } from "vitest";
import { TitleHero } from "./TitleHero";

const BASE: TitleDetailResponse = {
  id: "a",
  type: "movie",
  title: "Blade Runner",
  originalTitle: null,
  year: 1982,
  overview: "A blade runner must pursue replicants.",
  posterPath: "/p.jpg",
  backdropPath: "/b.jpg",
  runtime: 117,
  genres: ["Science Fiction"],
  tagline: null,
  rating: null,
  logoPath: null,
  director: null,
  writers: [],
  studios: [],
  seasons: [],
  cached: false,
};

function renderHero(detail: TitleDetailResponse): void {
  const ui: JSX.Element = <TitleHero detail={detail} seasonLabel={null} />;
  render(ui);
}

describe("TitleHero", () => {
  it("shows the logo image in the heading when a logoPath exists", () => {
    renderHero({ ...BASE, logoPath: "/logo.png" });
    const heading = screen.getByRole("heading", { level: 1, name: "Blade Runner" });
    // The h1 keeps the title as its accessible name, but renders it as the logo.
    expect(heading.querySelector("img")).not.toBeNull();
  });

  it("shows the text title when there is no logo", () => {
    renderHero(BASE);
    const heading = screen.getByRole("heading", { level: 1, name: "Blade Runner" });
    expect(heading.querySelector("img")).toBeNull();
    expect(heading.textContent).toContain("Blade Runner");
  });

  it("shows the rating in the meta line only when present", () => {
    renderHero({ ...BASE, rating: 6.4 });
    expect(screen.getByText(/★\s*6\.4/)).toBeTruthy();
  });

  it("omits the rating when absent", () => {
    renderHero(BASE);
    expect(screen.queryByText(/★/)).toBeNull();
  });

  it("shows the tagline when present", () => {
    renderHero({ ...BASE, tagline: "More than meets the eye." });
    expect(screen.getByText("More than meets the eye.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @harbor/web exec vitest run src/components/TitleHero.test.tsx`
Expected: FAIL — the logo/rating/tagline are not rendered yet.

- [ ] **Step 3: Update the hero**

In `apps/web/src/components/TitleHero.tsx`:

Change the meta line to include the rating. Replace the `const meta = ...` line:

```tsx
  const rating = detail.rating === null ? null : `★ ${detail.rating.toFixed(1)}`;
  const meta = metaLine([detail.year, formatRuntime(detail.runtime), rating]);
```

Replace the `<h1>...{detail.title}...</h1>` block with a logo-or-text heading:

```tsx
        <h1 className="mt-3 font-display text-5xl leading-tight tracking-tight sm:text-6xl">
          {detail.logoPath === null ? (
            detail.title
          ) : (
            <img
              src={imageUrl(detail.logoPath, "w500") ?? undefined}
              alt={detail.title}
              className="mx-auto max-h-32 w-auto max-w-full object-contain"
            />
          )}
        </h1>
```

Add the tagline in the bottom-left block, just above the overview. Change the opening of that block so the tagline renders first:

```tsx
      {detail.tagline !== null || detail.overview !== null || detail.genres.length > 0 ? (
        <div className="relative z-10 max-w-2xl px-8 pb-10">
          {detail.tagline === null ? null : (
            <p className="mb-2 text-sm text-muted-foreground italic">{detail.tagline}</p>
          )}
          {detail.overview === null ? null : (
            <p className="text-sm text-muted-foreground">{detail.overview}</p>
          )}
```

(Keep the existing genres block and the closing tags of that div.)

- [ ] **Step 4: Run the hero test**

Run: `pnpm --filter @harbor/web exec vitest run src/components/TitleHero.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the hide-branches are load-bearing**

Temporarily make the rating always render (`const rating = "★ " + String(detail.rating ?? 0);`) → the "omits the rating when absent" test fails. Restore.
Temporarily always render the text title (drop the `logoPath === null` ternary, always `{detail.title}`) → the "shows the logo image" test fails. Restore.

- [ ] **Step 6: Write the details table**

Create `apps/web/src/components/TitleDetails.tsx`:

```tsx
import type { TitleDetailResponse } from "@harbor/shared";
import type { JSX } from "react";

/** A definition list of a title's flat metadata, below the hero. Each row is
 *  omitted when empty, so a sparse title shows a short table, not blank rows. */
export function TitleDetails({ detail }: { detail: TitleDetailResponse }): JSX.Element | null {
  const rows: { label: string; value: string }[] = [];
  if (detail.genres.length > 0) rows.push({ label: "Genres", value: detail.genres.join(", ") });
  if (detail.director !== null) rows.push({ label: "Director", value: detail.director });
  if (detail.writers.length > 0) rows.push({ label: "Writers", value: detail.writers.join(", ") });
  if (detail.studios.length > 0) rows.push({ label: "Studios", value: detail.studios.join(", ") });

  if (rows.length === 0) return null;

  return (
    <dl className="mt-12 divide-y divide-border/60 border-t border-border/60 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex gap-6 py-3">
          <dt className="w-32 shrink-0 text-muted-foreground">{row.label}</dt>
          <dd className="text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
```

- [ ] **Step 7: Render it in the page**

In `apps/web/src/pages/Title.tsx`, import it and render it inside the `max-w-7xl` content div, before the season section:

```tsx
import { TitleDetails } from "../components/TitleDetails";
```

```tsx
        {detail.data ? <TitleDetails detail={detail.data} /> : null}
```

(Place this line just inside `<div className="mx-auto w-full max-w-7xl px-8">`, above the season `<section>`.)

- [ ] **Step 8: Verify**

Run: `pnpm lint >/dev/null && pnpm typecheck >/dev/null && pnpm build >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/TitleHero.tsx apps/web/src/components/TitleHero.test.tsx apps/web/src/components/TitleDetails.tsx apps/web/src/pages/Title.tsx
git commit -m "feat(web): title logo, rating, tagline, and details table"
```

---

### Task 5: End-to-end coverage

**Files:**
- Modify: `e2e/scripts/tmdb-fixture.mjs`
- Modify: `e2e/tests/05-title-detail.spec.ts`

- [ ] **Step 1: Enrich the fixture's movie detail**

In `tmdb-fixture.mjs`, find `MOVIE_DETAIL` (the object served for `/movie/78`) and add:

```js
  tagline: "A blade runner must pursue replicants.",
  vote_average: 8.1,
  production_companies: [{ name: "Warner Bros." }],
  credits: { crew: [{ job: "Director", name: "Ridley Scott" }, { job: "Screenplay", name: "Hampton Fancher" }] },
  images: { logos: [{ file_path: "/backdrop.jpg", iso_639_1: "en" }] },
```

The logo `file_path` reuses `/backdrop.jpg`, which the image fixture already serves, so the `naturalWidth` assertion has real bytes.

- [ ] **Step 2: Add assertions to the movie-page test**

In `e2e/tests/05-title-detail.spec.ts`, in "a search result opens a real title page", after the existing assertions add:

```ts
  // Enrichment: the logo renders in the heading, the rating shows, and the
  // details table carries the director and studio.
  const heroLogo = page.getByRole("heading", { level: 1 }).locator("img");
  await expect
    .poll(async () =>
      heroLogo.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(page.getByText(/★\s*8\.1/)).toBeVisible();
  await expect(page.getByText("Ridley Scott")).toBeVisible();
  await expect(page.getByText("Warner Bros.")).toBeVisible();
```

- [ ] **Step 3: Run the suite**

Run: `pnpm test:e2e 2>&1 | grep -E "[0-9]+ (passed|failed)" | tail -1`
Expected: all passed (35).

Note: the title `h1` now renders the logo image (the fixture gives Blade Runner a logo), so the existing `getByRole("heading", { name: "Blade Runner" })` still matches — the `alt` is the title. If it fails, confirm the `<img alt={detail.title}>` supplies the accessible name.

- [ ] **Step 4: Commit**

```bash
git add e2e/scripts/tmdb-fixture.mjs e2e/tests/05-title-detail.spec.ts
git commit -m "test(e2e): title enrichment — logo, rating, details table"
```

---

### Task 6: Full verification, screenshot, and manual checkpoint

- [ ] **Step 1: Run everything**

```bash
pnpm lint >/dev/null && echo LINT_OK && \
pnpm typecheck >/dev/null && echo TYPECHECK_OK && \
pnpm test >/dev/null && echo UNIT_OK && \
pnpm build >/dev/null && echo BUILD_OK && \
pnpm test:e2e 2>&1 | grep -E "[0-9]+ (passed|failed)" | tail -1
```

Expected: every marker and all e2e passed.

- [ ] **Step 2: Screenshot the enriched movie hero + details table**

Temporarily add, in the movie-page e2e test, after the assertions: `await page.screenshot({ path: "<scratchpad>/enriched.png", fullPage: true });`. Run the suite, Read the PNG, confirm the logo shows in the hero, the rating is in the meta line, the tagline is above the overview, and the details table (Genres/Director/Writers/Studios) renders below. Restore the spec. Do NOT commit the screenshot edit.

- [ ] **Step 3: Docker build and smoke**

```bash
pnpm docker:build && pnpm docker:smoke
```

Expected: `SMOKE PASSED`.

- [ ] **Step 4: Deploy — recreate, never restart**

```bash
docker rm -f harbor-3c2c-app
docker tag harbor:dev harbor:enrich-live
docker run -d --name harbor-3c2c-app --restart unless-stopped \
  -p 3405:3000 -v harbor_3c2b_data:/data \
  -e DATABASE_URL="postgresql://harbor:harbor@host.docker.internal:55444/harbor_3c2b" \
  -e HARBOR_BASE_URL="http://localhost:3405" \
  -e HARBOR_SECRET="0123456789abcdef0123456789abcdef" \
  -e HARBOR_LOG_LEVEL=warn \
  --add-host host.docker.internal:host-gateway \
  harbor:enrich-live
```

- [ ] **Step 5: Verify the served bundle**

```bash
curl -s http://localhost:3405/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Compare against `ls apps/server/public/assets/`. Hashes must match.

- [ ] **Step 6: Hand to the user**

Ask them to confirm at http://localhost:3405: open a movie — the title shows as its logo (where TMDB has one), a ★ rating sits in the meta line, the tagline is above the overview, and a Genres/Director/Writers/Studios table is below the hero. A title with no logo still shows its text title.

---

## Self-Review Notes

Checked against the spec:

| Spec requirement | Task |
| --- | --- |
| Provider `append_to_response=credits,images`; parse the new sections | 1 |
| `tagline`, `rating` (0→null), `logoPath` (en-pick), `director`, `writers` (dedup), `studios` | 1 (load-bearing: rating-0, logo-en) |
| `titles` columns; additive migration; atomic write; read back | 2 |
| `TitleDetailResponse` fields; service maps them | 3 |
| Hero: logo replaces title (text fallback, h1 kept), rating in meta, tagline above overview | 4 |
| Details table (Genres/Director/Writers/Studios), rows hidden when empty | 4 |
| Logos via existing `w500` proxy — no proxy change | (no task needed; verified in fixture/e2e) |
| E2E: logo renders, director/studio/rating present | 5 |
| Screenshot verification | 6 |
