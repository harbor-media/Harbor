# Development

## Requirements

- Node >= 22.22 (24 recommended)
- pnpm 10.33.4
- Docker

## Setup

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d
```

This starts a PostgreSQL container on `localhost:5432` (user/password/db all
`harbor`).

### Configuration

The server reads configuration from process environment variables only —
nothing in this repo loads a `.env` file for local development (`loadEnv()`
in `packages/config/src/index.ts` parses `process.env` directly, and
`apps/server` has no dotenv-style loader). Export the variables in your shell
before running `pnpm dev`, for example:

```bash
export DATABASE_URL=postgresql://harbor:harbor@localhost:5432/harbor
export HARBOR_BASE_URL=http://localhost:5173
export HARBOR_SECRET=0123456789abcdef0123456789abcdef
export HARBOR_DATA_DIRECTORY=./.data
export HARBOR_LOG_LEVEL=debug
export NODE_ENV=development
```

(PowerShell: `$env:DATABASE_URL = "..."`, etc.)

Turborepo's default `envMode` is `strict`, which strips exported shell
variables from task environments unless a task declares them. Since Harbor
reads configuration purely from `process.env` (no `.env` loader), `turbo.json`
declares the variables the `dev` and `test` tasks legitimately need in each
task's `env` array, so plain `pnpm dev` works with no extra flags.

If port 3000 is already taken on your machine, set `HARBOR_PORT` to move the
server. When you do, also update `HARBOR_BASE_URL` to match — the origin
check compares the incoming request's `Origin` header against
`HARBOR_BASE_URL` on every mutating API request, and a mismatch (e.g. the
server listening on `:3001` while `HARBOR_BASE_URL` still says `:3000`)
silently rejects every login and setup POST as cross-origin, with no
indication beyond a `VALIDATION_FAILED` 403.

## Running

```bash
pnpm dev
```

The API runs on :3000 and the web dev server on :5173 (Vite falls back to the
next free port if 5173 is taken), which proxies `/api` to the backend. Open
http://localhost:5173.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Server and web with hot reload |
| `pnpm build` | Build all packages |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript, no emit |
| `pnpm test` | Vitest (database tests need Docker) |
| `pnpm test:e2e` | Playwright end-to-end tests (needs Docker) |
| `pnpm docker:build` | Build the production image |
| `pnpm docker:smoke` | Run the container smoke test |

## Database

Migrations apply automatically at boot, under a PostgreSQL advisory lock, so
starting multiple containers concurrently is safe — only one applies
migrations while the others wait. To generate a new migration after changing
`packages/database/src/schema.ts`:

```bash
pnpm --filter @harbor/database db:generate
```

Commit the generated SQL. To apply migrations without starting the server —
for example after restoring a backup:

```bash
pnpm --filter @harbor/server migrate
```

Database integration tests (`packages/database`) start a real PostgreSQL
container via Testcontainers, so `pnpm test` requires a working Docker
daemon. The first run pulls `postgres:17-alpine`.

## Health endpoints

Harbor exposes three health endpoints, and they answer different questions:

- `GET /api/v1/health/live` — checks nothing external and always returns
  `200`. This is a process-liveness check only: a database outage or
  unwritable data directory must never make an orchestrator restart the
  container.
- `GET /api/v1/health/ready` — returns `200` only once the database is
  reachable, migrations have been applied, and the data directory is
  writable; otherwise `503`. The database check is a live query capped at a
  short timeout, cached for about 5 seconds so polling doesn't turn into a
  database round-trip on every request.
- `GET /api/v1/health` — always returns `200` with a status summary
  (`ok`/`degraded`, version, uptime). It is informational, not a probe.

The Docker image's `HEALTHCHECK` and the Compose `healthcheck` both probe
`/api/v1/health/ready`, with a 60-second `start_period` to cover first-boot
migrations.

## Persistent data

The container runs as a non-root user with UID 100. Docker named volumes
(the default in `docker-compose.yml`) pick up that ownership automatically,
so the default setup works out of the box. A bind mount does not: if you
mount a host directory to `/data`, Harbor will fail to write to it unless you
prepare the directory first:

```bash
mkdir -p /path/to/harbor-data
chown -R 100:100 /path/to/harbor-data
```

## Invitations and registration

Registration defaults to `invitation-only`. An owner or administrator creates
an invite from `POST /api/v1/invitations` (also `GET /api/v1/invitations` to
list, `DELETE /api/v1/invitations/:id` to revoke), choosing a `role`, an
optional `email` binding, `maxUses`, and `expiresInDays`. The response
includes the raw token and an `inviteUrl` of
`${HARBOR_BASE_URL}/invite/<token>` — that's the only time the token is ever
returned; only its hash is stored, and list responses never include it.

The granting rule is enforced server-side in the route (`roleRank(role) >=
roleRank(actor.role)` is rejected): you can only grant a role ranked below
your own (`owner` > `administrator` > `user` > `guest`), so an administrator
can invite a `user` or `guest` but never an `administrator`, and no invite
can ever grant `owner`. The web admin page at `/admin/invitations` filters
its role dropdown to match.

`GET /api/v1/invitations/:token` is a public, unauthenticated inspection
endpoint (used by the `/invite/:token` page) that returns the same negative
response for a missing, spent, expired, or revoked token, so it can't be used
to enumerate valid tokens. `POST /api/v1/register` redeems the token,
creates the account with the granted role, and signs the user in — matching
against an email-bound invite is required if one was set.

Registration mode is read/written via `GET`/`PATCH
/api/v1/settings/registration` (`disabled` | `invitation-only` | `open`).
Switching to `open` requires `acknowledgeOpenRisk: true` in the request body,
enforced server-side regardless of what the UI sends; in `open` mode
`/register` is reachable and the login page shows a "Create account" link.

## End-to-end tests

Playwright drives a real browser against a built server on port 3100 (chosen
to sidestep the common port-3000 conflict). The suite is self-contained:
`pnpm test:e2e` (`e2e/scripts/run-e2e.mjs`) starts its own disposable
PostgreSQL container, runs Playwright against a server it boots itself, and
tears the container down afterward — no manual `docker compose` step is
required. The suite now covers the invitation journey (owner invites a
user, role-dropdown restrictions, email-bound and spent/invalid tokens) and
the open-registration journey, alongside the original setup-and-login flow.

```bash
pnpm build
pnpm --filter @harbor/e2e exec playwright install chromium
pnpm test:e2e
```

This needs a working Docker daemon (for the disposable database) and a build
(`pnpm build`) first, since Playwright's `webServer` runs the compiled
`apps/server/dist/server.js` rather than a dev server. The suite's first test
is the setup wizard, so it needs a database with no owner already — the
self-managed container starts empty on every run, so this just works.

If you'd rather point the suite at a database you manage yourself — for
example to inspect state after a run — set `E2E_DATABASE_URL` and the script
will use it instead of starting its own container. You then own resetting
that database between runs, since the suite still assumes no owner exists
yet:

```bash
docker compose -f docker-compose.dev.yml up -d
E2E_DATABASE_URL=postgresql://harbor:harbor@localhost:5432/harbor pnpm test:e2e

# reset between runs:
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d
```

## Auth model, briefly

- Passwords are hashed with Argon2id (OWASP's balanced profile).
- Session tokens are 32 random bytes; only their SHA-256 hash is stored
  server-side, so a database read never yields a usable token.
- Session cookies are `HttpOnly` and `SameSite=Lax`, with `Secure` derived
  from whether `HARBOR_BASE_URL` is `https`.
- Login is throttled per-account and per-IP, and unknown-user vs.
  wrong-password responses are indistinguishable, including on the throttled
  path.
- Mutating API requests are origin-checked against `HARBOR_BASE_URL` as a
  second layer behind `SameSite=Lax` (see the `HARBOR_PORT` note above for the
  most common way to trip this in local dev).

## Owner setup

The first account created via `POST /api/v1/setup` becomes the owner. Exactly
one owner can ever be created — concurrent attempts produce one owner and
leave the others to fail cleanly, and the endpoint returns `409
SETUP_ALREADY_COMPLETE` permanently afterward.

## Notes

- TypeScript is pinned to 6.0.3 (see root `package.json`) because
  typescript-eslint does not yet support TypeScript 7. See the Phase 1 design
  spec.
- Install `react-router`, never `react-router-dom` — the latter was removed in v8.
