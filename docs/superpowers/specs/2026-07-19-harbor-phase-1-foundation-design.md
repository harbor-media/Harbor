# Harbor Phase 1 — Foundation

**Date:** 2026-07-19
**Status:** Approved
**Scope:** Monorepo, Fastify backend, React shell, PostgreSQL with Drizzle migrations, Docker image, Compose deployment, health checks, structured logging, first-run installation state.

## Goal

Produce a deployable Harbor container that boots, migrates its own schema, serves the compiled web application, reports health accurately, and knows whether it has been set up. Phase 2 fills in the onboarding wizard and authentication; this phase builds the foundation those land on.

Success is a single command bringing up a working stack, the container surviving replacement without losing state, and readiness never reporting true while the application cannot actually serve.

## Decisions

| Decision | Choice | Reasoning |
|---|---|---|
| Phase boundary | Skeleton plus setup-state routing | Exercises the whole stack end to end and makes Phase 2 a pure fill-in-the-wizard job |
| Packages | `config`, `database`, `logger`, `shared` only | Every package holds real code; empty packages attract code that does not belong in them |
| Migrations | Automatic at boot under an advisory lock, plus a CLI entrypoint | A fresh install must never require exec-ing into a container |
| Image namespace | `ghcr.io/harbor-media/harbor` | Matches the root specification; the org now exists |
| Backend structure | Feature modules as Fastify plugins | Idiomatic Fastify, scoped injection without a DI framework, serves the modular-monolith goal |
| Tests | Vitest units plus one Testcontainers integration test | Covers the only Phase 1 behavior that can silently corrupt an install |
| TypeScript version | 6.0.3, not 7.0.2 | `typescript-eslint@8.64.0` requires `<6.1.0`; TS 7.0 ships no compiler API until 7.1 and its watch mode is a prototype |

TypeScript 7.0.2 is the current `latest` and is 8-12x faster, but the surrounding toolchain has not caught up. Microsoft's stated compatibility rule is that code compiling cleanly under TS 6 without deprecation suppressions compiles identically under 7, so the eventual upgrade is close to free. Revisit once 7.1 restores the compiler API and typescript-eslint widens its range.

Deferred packages: `api-client` (no API surface worth generating from yet), `ui` (web is a shell, no shared components), `validation` (too few schemas to justify a package; they live beside what they validate).

## Repository layout

```
harbor/
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── health/
│   │       │   └── installation/
│   │       ├── plugins/
│   │       ├── app.ts
│   │       ├── server.ts
│   │       └── cli.ts
│   └── web/
│       └── src/
├── packages/
│   ├── config/
│   ├── database/
│   ├── logger/
│   └── shared/
├── deploy/docker/
├── docs/
├── docker-compose.yml
├── docker-compose.dev.yml
├── Dockerfile
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

Each module owns its routes, schemas, and service logic. Cross-cutting concerns (database pool, logger, config, error handler) are Fastify plugins registered in `app.ts`. Plugins that expose decorators to sibling modules are wrapped with `fastify-plugin` so encapsulation does not hide them.

## Boot sequence

Ordering is load-bearing. The listener binds early so that startup progress is observable, but readiness reports true only after every dependency check has passed.

1. Parse and validate `HARBOR_*` environment variables. On failure, log the specific problem and exit non-zero. Never boot half-configured.
2. Construct the logger with redaction rules installed before any other code can log.
3. Register the health module and bind the listener on the configured port. Readiness reports false. The application is now observable but serves nothing else.
4. Open the PostgreSQL pool, retrying with backoff. Compose ordering does not guarantee the database is accepting connections.
5. Acquire a PostgreSQL advisory lock, apply pending migrations, release the lock. Concurrent containers block rather than race.
6. Verify the data directory exists and is writable.
7. Read the installation record once and log whether setup is complete.
8. Register remaining plugins and modules, then a static-asset handler scoped to non-API paths. Readiness flips true.
9. On `SIGTERM`: stop accepting connections, drain in-flight requests against a timeout, close the pool, exit zero.

Binding before dependencies are ready is deliberate. An orchestrator polling readiness during a slow migration sees an honest "starting" signal rather than a connection refusal indistinguishable from a crash. Requests to non-health routes during this window return `503 SERVICE_UNAVAILABLE`.

The static-asset fallback returns `index.html` for unmatched non-API paths so client-side routing works, and explicitly does not match `/api/v1/*`, which must return JSON errors.

## Migrations

Drizzle generates SQL migration files committed to `packages/database`. The runner applies pending migrations in order inside a PostgreSQL advisory lock held for the duration, so a container that boots while another is mid-migration waits rather than racing.

**The lock must run on a dedicated single connection.** `pg_advisory_lock` is session-scoped, meaning it is held by the specific connection that acquired it. Running it through the pooled application client would allow the lock and the unlock to land on different connections, silently defeating the guard. The runner therefore opens its own `postgres()` client with `max: 1`, acquires the lock, migrates, releases, and closes that client — separate from the pool the application serves requests from.

The same runner is exposed two ways:

- **Automatically at boot**, as step 5 above. This is the normal path and the reason a fresh install never requires exec-ing into a container.
- **As a CLI subcommand**, `node dist/cli.js migrate`, which runs migrations against `DATABASE_URL` and exits without starting the HTTP server. This exists for restore-from-backup and manual recovery, where the schema must be brought current without booting the application.

There is no environment variable to disable automatic migration. Adding one is easy if a real need appears; inventing the toggle now would mean supporting a configuration nobody has asked for.

## Data model

```sql
CREATE TABLE installation (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  setup_completed_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
```

The boolean primary key with a `CHECK` constraint makes a second row impossible at the database level rather than by convention. Phase 2 adds `server_name`, `base_url`, and language columns by migration.

### Concurrency guard

Setup completion uses a conditional update rather than a lock:

```sql
UPDATE installation SET setup_completed_at = now()
WHERE setup_completed_at IS NULL RETURNING *;
```

Zero rows returned means another request completed setup first; that caller receives a `SETUP_ALREADY_COMPLETE` error. The statement is atomic under PostgreSQL's default isolation level. Phase 2 wraps owner-account creation into the same transaction.

This is a distinct mechanism from the migration advisory lock. Migrations must serialize across separate processes at boot; setup completion is one statement inside one transaction.

## Endpoints

| Endpoint | Checks | Fails when |
|---|---|---|
| `GET /api/v1/health/live` | Process is responsive | Only a hung event loop |
| `GET /api/v1/health/ready` | Database reachable, migrations applied, data directory writable | Any check false |
| `GET /api/v1/health` | Summary plus version and uptime | Never; always 200 with a status body |

Liveness touches no dependency. An unavailable metadata provider must never cause a container restart.

```
GET /api/v1/installation/state → { setupComplete: boolean, version: string }
```

Necessarily unauthenticated, since no account exists before setup. Rate-limited, and returns the minimum: no server name, no base URL, no counts, nothing aiding fingerprinting beyond what loading the page reveals. Queried live on each request rather than cached, because a cached flag goes stale as soon as a second container exists and the query is a single-row primary-key lookup.

## Frontend

The shell fetches `/api/v1/installation/state` on load via TanStack Query.

- Not complete, not on `/setup` → redirect to `/setup`
- Complete, on `/setup` → redirect to `/home`

Both are placeholder screens in Phase 1. The production build compiles to static assets served by the backend; there is no separate frontend deployment.

## Error handling

All failures pass through one Fastify error handler producing:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "requestId": "..." } }
```

Error codes are a string-literal union in `packages/shared`, so emitting an unknown code is a type error. The request ID is generated per request, attached to every log line for that request, and returned in both the body and a response header.

- Zod failures → `400 VALIDATION_FAILED`, including the field path but not the received value, which may contain secrets.
- Unhandled errors → `500 INTERNAL_ERROR` with a generic message. Stacks are logged, never serialized into responses.
- Database unavailable after boot → readiness false, requests `503`, pool retries with backoff, container stays alive. Restarting the application does not fix a database outage.

### Logging

Structured JSON in production, pretty in development, level from `HARBOR_LOG_LEVEL`. Redaction is configured at logger construction. Denylisted at any depth: `authorization` and `cookie` headers, and keys matching `password`, `token`, `secret`, `apiKey`, `DATABASE_URL`.

## Configuration

Phase 1 validates only variables that something consumes:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection |
| `HARBOR_BASE_URL` | Yes | Public URL |
| `HARBOR_SECRET` | Yes | Validated as present and at least 32 characters; consumed by sessions in Phase 2 |
| `HARBOR_DATA_DIRECTORY` | No, defaults `/data` | Persistent storage root |
| `HARBOR_LOG_LEVEL` | No, defaults `info` | One of error, warn, info, debug, trace |
| `HARBOR_PORT` | No, defaults `3000` | Bind port |
| `HARBOR_TRUST_PROXY` | No, defaults false | Reverse-proxy header handling |

`HARBOR_SECRET` is validated now despite being unused until Phase 2, so a misconfigured deployment fails at first boot rather than at first login.

Variables listed in the root specification but not consumed yet (`HARBOR_REGISTRATION_MODE`, `HARBOR_CACHE_MAX_SIZE`, `HARBOR_STREAM_CONCURRENCY`, `HARBOR_TELEMETRY_ENABLED`) are not parsed in Phase 1 and arrive with the features that read them.

## Testing

**Unit (Vitest).** The config parser across valid, missing-required, malformed, and defaulted inputs. The redaction rules, treated as security-critical: log an object containing a fake password and API key, capture the output stream, assert the secrets are absent and surrounding fields survived.

**Integration (Testcontainers).** Boot a real PostgreSQL. Open two connections and run migrations concurrently; assert the advisory lock serialized them, the schema applied exactly once, and no duplicate-object errors occurred. Assert readiness reads false before migrations and true after.

**CI (GitHub Actions).** install → lint → typecheck → test → build → docker build → container smoke test (boot against PostgreSQL, curl all three health endpoints, send `SIGTERM`, assert clean exit). No publishing step; pull requests must never publish images.

## Docker

Multi-stage build: `dependencies` → `builder` → `runtime`. The runtime stage carries production dependencies only, runs as a non-root user, exposes port 3000, and includes a health check. FFmpeg is not installed in Phase 1; it arrives in Phase 5 when media inspection needs it.

Two Compose files: `docker-compose.yml` for production against the pinned published image, and `docker-compose.dev.yml` running PostgreSQL alone for local development with hot reload.

## Out of scope

Authentication, sessions, and password hashing. The onboarding wizard form. Users, roles, profiles, invitations. Any metadata or streaming provider. The image proxy. Playwright and Testing Library. Multi-architecture builds, version tags, and the Dokploy template, which are Phase 7.

## Definition of done

1. `pnpm install && pnpm dev` runs server and web with hot reload against Compose PostgreSQL.
2. `docker compose up` produces a working stack from a clean volume.
3. A fresh install serves `/setup`; a completed install redirects away from it.
4. All three health endpoints return correct values in healthy and degraded states.
5. Migrations apply exactly once under concurrent boot, and `cli.js migrate` brings a schema current without starting the server.
6. `SIGTERM` drains and exits zero.
7. Logs are structured JSON with no secrets present.
8. Container replacement preserves all state.
9. Lint, typecheck, and tests pass in CI.
