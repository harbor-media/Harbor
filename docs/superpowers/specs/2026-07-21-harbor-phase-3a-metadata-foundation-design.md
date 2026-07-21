# Harbor Phase 3a — Metadata Foundation

**Date:** 2026-07-21
**Status:** Approved
**Depends on:** Phase 2b (invitations, roles, `requireRole`)

## Scope

`CLAUDE.md` defines Phase 3 (Catalog) as one phase covering the metadata
provider interface, a first integration, search, movie and series pages, home
catalog rows, and the image proxy. That is three independent subsystems and
roughly forty tasks. Phases 1, 2a, and 2b were twelve to seventeen tasks each,
and plan review — which caught a Critical defect in 2b before any code was
written — stops being effective at that size.

Phase 3 is therefore split:

| Phase | Scope |
| --- | --- |
| **3a** (this spec) | Credential encryption, `MetadataProvider` interface, TMDB integration, canonical titles, metadata cache, admin metadata page |
| **3b** | Image proxy and cache, SSRF hardening, resizing, placeholders |
| **3c** | Search UI, home rows, discover, movie/series/season pages |

The dependency chain is 3a → 3b → 3c. Each phase gets its own spec, plan,
review cycle, and manual testing checkpoint.

Two findings shaped this split:

- `HARBOR_SECRET` is validated in `packages/config` but never used. No
  encryption helper exists anywhere in the codebase. `CLAUDE.md` requires
  provider credentials be encrypted at rest, so credential encryption is a
  prerequisite for storing a TMDB API key, not part of the catalog work.
- `CLAUDE.md` treats metadata availability and playability as separate
  concepts: a title may appear in the catalog before any source resolves.
  Phase 3 therefore never touches stream providers or playback.

### Out of scope for 3a

Genres, cast, crew, seasons, episodes, images, the catalog UI, and the
onboarding wizard step. Each is named below where it would otherwise be
assumed.

## Definition of Done

An administrator can open `/admin/metadata`, enter a TMDB API key, have it
validated before it is saved, and then search for a title and receive real
results — served from TMDB on first search and from Harbor's own cache on
the second.

The search UI in this phase is deliberately plain scaffolding. It exists to
prove the pipeline end to end and will be replaced in 3c. It must not
anticipate catalog layout decisions.

## Decisions

### Search is remote-first with cache-on-read

On a fresh install Harbor's metadata cache is empty. `CLAUDE.md` asks that
search "feel instant for cached metadata" and that PostgreSQL search be used
initially, but neither applies to an empty cache.

Every search queries TMDB. Results are normalized and upserted into Harbor's
own tables, so repeat searches within the TTL are served from PostgreSQL. The
catalog self-populates as the server is used.

Rejected alternatives:

- **Local-only search** backed by a background import job. Search would be
  genuinely instant and work offline, but a fresh install would show an empty
  catalog until the job ran, and nothing outside the imported set would ever
  be findable. That is a worse product for a self-hosted server that cannot
  predict what its users want to watch.
- **Hybrid** — query locally, then fall back to TMDB when results look thin
  or stale. This is the likely eventual design, but "thin or stale" is a
  tuning problem with no defensible default, and a wrong threshold produces
  confusing half-populated results. Remote-first already writes the
  normalized rows a hybrid would query, so it can be added later without
  redoing storage.

Consequence: Harbor stores normalized canonical rows rather than raw TMDB
JSON. This is what makes provider independence real, but adding a field later
requires a migration and a re-fetch rather than re-reading a stored blob.

### Metadata configuration is admin-only in 3a

`CLAUDE.md` lists "Authorized provider configuration" as step 9 of the
first-run onboarding wizard. That step is deferred.

Configuring a provider is an optional, changeable setting, and `CLAUDE.md` is
explicit that ordinary settings must not require container replacement.
Making metadata mandatory at install time would couple a local install to an
external service being reachable: a fresh install could not finish setup while
TMDB was down. The wizard step should be added later, designed as skippable,
once more than one provider type is worth prompting for.

Consequence: a fresh install shows an empty catalog until an administrator
visits `/admin/metadata`. This is mitigated with an empty state that points
there, not by reporting the catalog as broken.

### Only two adapter methods are implemented

`CLAUDE.md` sketches a six-method `MetadataProvider` interface. 3a implements
`validateConfiguration()` and `search()`. The four detail methods
(`getMovie`, `getSeries`, `getSeason`, `getEpisode`) are added in 3c alongside
the pages that consume them.

Declaring four methods that throw `NotImplemented` would make the contract a
lie and invite callers to code against stubs.

## Architecture

### Credential encryption

A new `packages/crypto` package provides authenticated encryption for
provider credentials.

- **Algorithm:** AES-256-GCM.
- **Key derivation:** HKDF-SHA256 from `HARBOR_SECRET` under the fixed info
  string `harbor:provider-credentials:v1`. `HARBOR_SECRET` is never used
  directly as a key.
- **IV:** 96 bits, randomly generated per encryption, never reused.
- **Envelope:** `v1:<iv>:<tag>:<ciphertext>`, each part base64. The version
  prefix makes a future algorithm change a migration rather than a guess.

`packages/crypto` is a separate package rather than part of
`packages/database` because it is security-critical code that warrants its own
focused test suite and has no database dependency.

Properties this must guarantee:

- The plaintext key is never returned by any API response, in any form —
  not masked, not truncated. The config endpoint returns `configured: boolean`
  and `lastVerifiedAt` only.
- The plaintext key never appears in logs.
- Tampering is detectable. GCM's authentication tag means a corrupted or
  hand-edited database row fails loudly rather than decrypting to garbage.
- Rotating `HARBOR_SECRET` invalidates stored credentials. This is inherent
  to deriving from it. Decryption failure must surface as a clear operator
  error instructing them to re-enter the key — never a crash loop, and never
  silently reported as "not configured", which would send an operator
  debugging the wrong problem.

### Schema

```
metadata_provider_config
  provider_id        text primary key      -- 'tmdb'
  enabled            boolean not null
  encrypted_api_key  text                  -- versioned envelope
  language           text not null
  last_verified_at   timestamptz

titles
  id                 uuid primary key
  type               enum('movie','series') not null
  title              text not null
  original_title     text
  year               integer
  overview           text
  poster_path        text
  backdrop_path      text
  fetched_at         timestamptz not null

title_external_ids
  title_id           uuid references titles(id) on delete cascade
  source             enum('tmdb','imdb') not null
  external_id        text not null
  unique (source, external_id)

metadata_search_cache
  query_hash         text not null
  language           text not null
  title_ids          uuid[] not null
  fetched_at         timestamptz not null
  primary key (query_hash, language)
```

`poster_path` and `backdrop_path` store provider-relative paths, not resolved
URLs. Resolving them is 3b's job.

Two points that would otherwise be ambiguous:

- `metadata_search_cache.title_ids` is an ordered array, and that order is
  the provider's relevance ranking. Serving a cached search must preserve it;
  reading the rows back with an unordered join would silently destroy result
  relevance while every test still passed.
- Titles are upserted on the natural key `(source, external_id)` from
  `title_external_ids`, not on the display title. Two films sharing a name
  are distinct titles, and re-searching must update the existing row rather
  than inserting a duplicate.

### Provider adapter

The adapter lives under `apps/server/src/modules/metadata/providers/`. TMDB
responses are normalized into Harbor DTOs at the adapter boundary; no
TMDB-shaped data escapes into the domain. That boundary is what makes a
second provider cheap to add.

### API surface

```
GET   /api/v1/admin/metadata/config     administrator
PUT   /api/v1/admin/metadata/config     administrator
POST  /api/v1/admin/metadata/test       administrator — validates before saving
GET   /api/v1/search?q=                 authenticated
```

`POST /test` validates a candidate key against TMDB without persisting it, so
an administrator cannot save a key that does not work.

## Security

**SSRF surface in 3a is minimal, and saying so plainly is more useful than
security theater.** Every outbound request goes to one hardcoded host with no
user-controlled URL component. The genuine SSRF risk arrives in 3b, where
image URLs derive from provider data and must be validated against loopback,
private, link-local, and cloud-metadata destinations, with every redirect
revalidated.

What 3a does require:

- Request timeouts with `AbortSignal` on every outbound call, and no retry
  storms against a failing provider.
- A rate limit on the search endpoint. `CLAUDE.md` requires rate limits for
  metadata search specifically.
- The API key kept out of logs and responses, covered by an explicit test.
  This is modeled on the request-log redaction test added at the end of 2b,
  which caught a real credential leak that a unit test alone had missed.

## Failure handling

Readiness must not fail when TMDB is unreachable. `CLAUDE.md` states this
directly, and a self-hosted server should not report itself unhealthy because
a third party is down.

| Condition | Behavior |
| --- | --- |
| Provider unreachable | Serve cached results if present; otherwise `METADATA_PROVIDER_UNAVAILABLE`, retryable |
| Key rejected | `METADATA_PROVIDER_UNAUTHORIZED`, requires administrator action |
| Not configured | A distinct state the UI points at `/admin/metadata` — not an error |

The "not configured" case is deliberately not an error. A new install has not
failed at anything; it has simply not been set up yet, and reporting that as
an error trains operators to ignore errors.

## Caching

Search results are cached for **one hour**, stored in the database so it is
tunable later without a redeploy. Title rows are upserted on every fetch with
`fetched_at` refreshed. Background refresh of stale titles belongs to the
background-jobs phase and is out of scope here.

## Attribution

TMDB's API terms require attribution: "This product uses the TMDB API but is
not endorsed or certified by TMDB", together with their logo. `CLAUDE.md`
commits to respecting provider attribution and licensing terms, so this ships
with the integration in 3a rather than as a 3c polish item.

## Testing

- **Encryption:** round-trip, tamper detection via the GCM auth tag, and
  failure under a wrong derived key.
- **Adapter:** normalization from recorded fixtures. No live network in tests.
- **Integration:** cold cache queries the provider; warm cache is served from
  PostgreSQL with no outbound call; provider-down falls back to cache.
- **Security:** the API key appears in neither API responses nor log output.
- **End to end:** an administrator configures a key, searches, and searches
  again.

The warm-cache test must assert the absence of an outbound call rather than
merely that results were returned — otherwise it passes whether or not
caching works.
