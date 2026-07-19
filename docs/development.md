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

## Notes

- TypeScript is pinned to 6.0.3 (see root `package.json`) because
  typescript-eslint does not yet support TypeScript 7. See the Phase 1 design
  spec.
- Install `react-router`, never `react-router-dom` — the latter was removed in v8.
