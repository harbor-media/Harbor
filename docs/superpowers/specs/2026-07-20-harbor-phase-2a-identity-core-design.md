# Harbor Phase 2a — Identity Core

**Date:** 2026-07-20
**Status:** Approved
**Scope:** Users, Argon2id password hashing, the owner-setup wizard, login and logout, server-side sessions, session revocation, and a fail-closed authentication guard.

## Goal

Take a freshly deployed Harbor from "not set up" to "the owner is logged in." Phase 1 built the shell that redirects to `/setup`; this phase fills that route in and puts an authenticated session behind it.

Success is a fresh install where an operator completes the wizard, lands logged in, can log out and back in, and where every route that is not explicitly public refuses unauthenticated requests.

## Phase 2 decomposition

`CLAUDE.md` describes Phase 2 as one unit. It is too large for a single spec and mixes the most security-critical code in the project with routine CRUD, so it is split into three slices that each produce working software:

| Slice | Delivers | Ends when |
|---|---|---|
| **2a (this spec)** | Users, sessions, owner setup, login/logout, auth guard | A single-owner install can be set up and logged into |
| **2b** | Roles enforcement, permissions, invitations, registration modes | A second user can be invited, register, and log in with a role |
| **2c** | Admin user management, profiles subsystem | Admins manage users; users manage multiple profiles |

Each slice gets its own spec, plan, and review cycle.

## Decisions

| Decision | Choice | Reasoning |
|---|---|---|
| Wizard fields | Language, server name, owner username, email, password | Only fields with a consumer today; later phases append their own steps |
| Public URL | Displayed read-only from `HARBOR_BASE_URL`, not stored | Spec's config philosophy reserves the public base URL for environment variables |
| Sessions | Opaque token, SHA-256 hashed at rest, Postgres table | Revocable, listable, and a database read yields nothing usable |
| CSRF | `SameSite=Lax` plus Origin/Referer check on mutations | Same-origin SPA; Lax already blocks the attack, no token plumbing |
| Roles | Full `owner\|administrator\|user\|guest` enum now, enforcement in 2b | Read in 2a to guarantee one owner; avoids a data migration later |
| Brute force | Per-IP and per-account backoff, never a hard lock | Self-hosted has no support desk; a lockout is unrecoverable without SQL |
| Auth wiring | Global `onRequest` guard with a public allowlist | Only option that fails closed when someone forgets |
| Hashing | Argon2id via `@node-rs/argon2`, m=19456 t=2 p=1 | Prebuilt arm64/amd64 binaries; OWASP balanced parameters |

## Data model

```sql
CREATE TYPE user_role AS ENUM ('owner', 'administrator', 'user', 'guest');

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             text UNIQUE NOT NULL,          -- normalized lowercase
  email                text UNIQUE,                   -- nullable; 2b invites may omit
  password_hash        text NOT NULL,
  role                 user_role NOT NULL,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  failed_login_count   integer NOT NULL DEFAULT 0,
  last_failed_login_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text UNIQUE NOT NULL,
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  user_agent    text,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

The `installation` table gains `server_name` and `language`. It does **not** gain a base URL column — see Configuration below.

**Only the token hash is stored.** The raw token exists in the cookie and nowhere else, so a database dump or a SQL-injection read yields no usable sessions. This is the same reasoning that applies to passwords.

**`ON DELETE CASCADE`** makes deleting a user destroy their sessions in the same statement rather than relying on application code to remember.

**Failed-login state lives on the user row** rather than in a separate table. Per-account throttling then survives restarts without a new table, and without a database write per failed guess — which would itself be a denial-of-service vector.

**`user_agent` and `ip` are recorded** because Phase 6's admin session inspection needs them and backfilling is impossible.

## Module layout

```
apps/server/src/
├── modules/
│   ├── auth/
│   │   ├── routes.ts      POST /auth/login, POST /auth/logout, GET /auth/me
│   │   ├── service.ts     credential verification, session issuance, throttling
│   │   ├── passwords.ts   Argon2id hash and verify
│   │   └── sessions.ts    token generation, hashing, lookup, expiry
│   └── setup/
│       └── routes.ts      POST /setup
└── plugins/
    └── auth.ts            global onRequest guard + public allowlist

packages/database/src/     users.ts, sessions.ts
packages/shared/src/       adds UNAUTHENTICATED to the error union
```

## Endpoints

```
POST /api/v1/setup          { language, serverName, username, email, password }
                            → 201, sets session cookie
POST /api/v1/auth/login     { identifier, password }
                            → 200, sets session cookie
POST /api/v1/auth/logout    → 204, clears cookie
GET  /api/v1/auth/me        → 200 { id, username, email, role }
```

**`identifier` accepts either a username or an email address.** `CLAUDE.md` requires login by "username or email," so the lookup matches against both columns; each is already uniquely indexed. The field is deliberately named `identifier` rather than `username` so the client does not have to know or guess which was supplied.

**Email is required at setup but nullable in the schema.** The owner is a real operator who should be reachable, and the wizard collects the address. The column stays nullable because 2b's invitations may create accounts without one — `CLAUDE.md` lists email binding on invitations as optional. Requiring it at the boundary rather than in the schema keeps both facts true without a later migration.

`GET /api/v1/auth/me` returns only the four fields above. It never returns the password hash, session token, or failed-login counters.

## Authentication flow

A single `onRequest` hook authenticates every request:

1. Path matches the public allowlist? Continue unauthenticated.
2. Otherwise read the session cookie, hash it, look up the session by `token_hash`.
3. Session missing, expired, or its user deleted? `401 UNAUTHENTICATED`.
4. Otherwise decorate `request.user` and `request.session`, refresh `last_seen_at`.

**The allowlist uses exact matches, never prefixes.** A prefix entry such as `/api/v1/auth` would accidentally expose `/api/v1/auth/sessions`. Phase 2a's allowlist is:

```
GET  /api/v1/health, /api/v1/health/live, /api/v1/health/ready
GET  /api/v1/installation/state
POST /api/v1/setup
POST /api/v1/auth/login
```

Plus static assets and the SPA fallback, which are public by nature.

This design fails closed. A route added anywhere is authenticated by default; forgetting to allowlist a genuinely public route produces a loud 401 in development rather than a silent hole in production. The allowlist being a second place to maintain is the point — it is a short, security-relevant list reviewable in one screen.

## Auth mechanics

**Password hashing.** Argon2id via `@node-rs/argon2`, chosen over `argon2` because it ships prebuilt binaries for amd64 and arm64; `node-gyp` builds are a common cause of arm64 Docker failures and the spec requires multi-architecture images. Parameters m=19456 (19 MiB), t=2, p=1 — OWASP's balanced profile, appropriate for the home servers and small VPSes Harbor targets.

**Sessions.** 32 random bytes encoded base64url, SHA-256 hashed for storage. Absolute 30-day expiry with a sliding `last_seen_at`. Login mints a fresh session. Logout deletes one row. A password change deletes every session for that user, satisfying the spec's password-change invalidation requirement in a single statement.

**Cookie.**

```
harbor_session   HttpOnly   SameSite=Lax   Path=/   Max-Age=30d
Secure: derived from HARBOR_BASE_URL's protocol
```

`Secure` is conditional, not hardcoded. A hardcoded `true` breaks local development over plain http: the browser silently drops the cookie, so login appears to succeed while nothing persists. Phase 1 already constrains `HARBOR_BASE_URL` to `http` or `https`, so the value is derived rather than adding another environment variable.

**Throttling.** Requests inside a backoff window receive `429` with `Retry-After` immediately. They are never delayed by sleeping — held-open connections are themselves a denial-of-service vector.

Three free attempts, then backoff doubling from 1 second to a 30-second ceiling, tracked per-account on the user row and per-IP in an in-memory LRU. Success resets the counter. Nothing ever hard-locks: the owner who mistypes their password repeatedly can always get in by waiting, with no console or `psql` required.

**The per-IP dimension depends on `HARBOR_TRUST_PROXY` being set correctly.** Phase 1 already wires that environment variable into Fastify's `trustProxy`, so `request.ip` is the real client only when Harbor is told it sits behind a proxy. If it is misconfigured behind one, every request appears to originate from the proxy and per-IP throttling would degrade into throttling everyone at once. Per-account throttling is what makes that degradation survivable rather than an outage, which is the reason both dimensions exist. The same `request.ip` is what the `sessions.ip` column records, so a misconfiguration also makes Phase 6's session inspection show the proxy address.

**Username enumeration** is closed deliberately. Login returns one generic "Invalid credentials." for both unknown-user and wrong-password, and always performs an Argon2 verification — against a fixed dummy hash when no user matches — so response timing does not leak account existence.

**CSRF.** `SameSite=Lax` stops browsers attaching the session cookie to cross-site state-changing requests, which is the whole attack surface for a same-origin SPA. A strict Origin check, falling back to Referer, runs on every mutating request and covers the residue. Lax rather than Strict because Strict makes a user arriving from an external link appear logged out — a wart that would bite when 2b introduces invite links.

## Setup flow

A completed install with no owner is unrecoverable, so user creation and setup completion are atomic.

```
1. validate input
2. hash password                    ← outside the transaction (~100ms)
3. BEGIN
     UPDATE installation
       SET setup_completed_at = now(), server_name = $1, language = $2
       WHERE setup_completed_at IS NULL
       RETURNING *
     -- zero rows → SETUP_ALREADY_COMPLETE → rollback
     INSERT INTO users (role = 'owner', ...)
   COMMIT
4. create session, set cookie
```

**Update-first** means the race guard runs before any other work, and a failure at any point — duplicate username, constraint violation, crash — rolls back to *setup still incomplete*, which is recoverable. Hashing sits outside the transaction so two racing requests waste CPU rather than holding transactions open.

On success the response sets a session cookie, so the owner lands logged in rather than being bounced to a login form.

Repeat calls return `409 SETUP_ALREADY_COMPLETE`. This leaks nothing: `/api/v1/installation/state` already publishes `setupComplete` to unauthenticated callers by design.

## Configuration

`CLAUDE.md` lists "Public server URL" as a wizard field and `HARBOR_BASE_URL` as a required environment variable. Both cannot own that value.

The spec's own configuration philosophy resolves it: environment variables are reserved for deployment-critical settings, and it names the public base URL in that list. The wizard therefore **displays** `HARBOR_BASE_URL` read-only for confirmation and does not store it. A second copy in the database would create a split-brain where cookie `Secure` derivation, generated links, and the operator's reverse-proxy configuration could silently disagree.

No new environment variables are introduced in this phase.

## Error handling

| Condition | Response |
|---|---|
| No or invalid session on a guarded route | `401 UNAUTHENTICATED` |
| Bad credentials | `401 UNAUTHENTICATED`, generic message |
| Inside backoff window | `429 RATE_LIMITED` + `Retry-After` |
| Setup already complete | `409 SETUP_ALREADY_COMPLETE` |
| Invalid input | `400 VALIDATION_FAILED`, field paths only |

`UNAUTHENTICATED` is added to the shared error union. `FORBIDDEN` waits for 2b, when permissions exist to forbid anything.

Suppressing received values in validation errors stops being cosmetic here: the value may be a password. Phase 1's error handler already behaves this way, which keeps passwords out of both responses and logs.

**Logging.** Phase 1's redaction denylist already covers `password`, `token`, `sessionToken`, and related keys. This phase adds structured auth events — login success and failure, logout, setup completion — but defers an `audit_events` table until there is an admin interface to read it. A write-only audit table nobody can view is storage, not accountability.

## Testing

Two tests carry more weight than the rest.

**The guard fails closed.** Register a route that was never allowlisted and assert it returns 401. This is the executable form of the entire authentication design; without it, "fails closed" is an intention rather than a property.

**The setup race.** Against real PostgreSQL via Testcontainers, fire two concurrent `POST /setup` requests. Assert exactly one user exists, exactly one response succeeded, and the loser received 409. Then the rollback case: force the user insert to fail and assert `setup_completed_at` is still null, proving a failed setup leaves a retryable install rather than a bricked one.

Supporting coverage: password verification accepts correct and rejects wrong passwords; session lookup succeeds by raw token and rejects expired sessions; a password change deletes every session for that user; throttling returns 429 with `Retry-After` and resets on success; unknown-user and wrong-password responses are byte-identical; cookie flags are correct with `Secure` following the base-URL protocol; a cross-origin mutating request is rejected by the Origin check.

**End-to-end.** `CLAUDE.md` names "First-time setup" and "Owner login" as required Playwright flows. Phase 1 deferred Playwright because no flows existed to drive; both now exist and are the highest-value flows in the product, so Playwright is introduced here rather than accumulating the debt.

## Out of scope

Permission enforcement, invitations, and registration modes (2b). Admin user management and the profiles subsystem (2c). Password reset, passkeys, OpenID Connect, LDAP. Email delivery of any kind — the spec places a built-in email server out of scope for the MVP. The `audit_events` table.

## Definition of done

1. A fresh install serves `/setup`; completing the wizard creates the owner and lands them logged in.
2. Setup is atomic: concurrent attempts produce exactly one owner, and a failed attempt leaves the install retryable.
3. Repeat setup attempts return `409 SETUP_ALREADY_COMPLETE`.
4. Login and logout work; a session survives a page reload and a server restart.
5. Every route not on the public allowlist returns 401 without a valid session, including routes added without any explicit guard.
6. The session-invalidation mechanism a password change requires (`deleteSessionsForUser`) exists and is covered by tests. 2a exposes no password-change endpoint — that arrives with user management in 2c — so the end-to-end behavior is not exercisable in this slice.
7. Repeated failed logins return 429 with `Retry-After` and never permanently lock an account.
8. Unknown-user and wrong-password responses are indistinguishable.
9. Session cookies carry `HttpOnly` and `SameSite=Lax`, with `Secure` matching the base-URL protocol.
10. Playwright covers first-time setup and owner login.
11. Lint, typecheck, unit tests, integration tests, and end-to-end tests pass.
