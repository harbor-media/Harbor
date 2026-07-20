# Harbor Phase 2b — Invitations & Role Authorization

**Date:** 2026-07-20
**Status:** Approved
**Scope:** Role-based authorization primitive, invitations (create/list/revoke), invite-redemption registration, and the three registration modes. Built on the merged Phase 2a identity core.

## Goal

Turn Harbor from a single-owner install into a usable multi-user server. An administrator can mint invitation links; anyone with a link can register and land signed in with the granted role; and the owner controls whether registration is disabled, invitation-only, or open.

This is MVP steps 7–8 ("invite a user", "user registration"). Success is: the owner creates an invite, copies the link, a second person redeems it in another browser and lands on `/home` as the invited role, and the owner sees the invite marked spent.

## Decisions

| Decision | Choice | Reasoning |
|---|---|---|
| Phase scope | Role primitive + invitations + redemption registration | One coherent slice; profiles and user management are separate subsystems deferred to later phases |
| Registration modes | All three (disabled / invitation-only / open), stored as an installation setting, default invitation-only | The spec requires all three; open mode is a few lines atop the redemption flow, so building together avoids a retrofit |
| Invite delivery | Copy-paste `/invite/<token>` link; Harbor never sends email | Harbor has no email server (out of MVP scope); matches Jellyfin/Authentik without SMTP |
| Email binding | Optional redemption restriction, not delivery | With no email sending, a bound email restricts *who* may redeem a link, it does not deliver it |
| Role granting | Cannot grant a role at or above your own; no invite grants owner | Least privilege; contains the blast radius of a compromised admin account |
| Authorization mechanism | Per-route `requireRole` preHandler | Fails closed, colocated with the route, composes with the existing rate-limit config |

Deferred: multiple viewing profiles (belong near the library/playback phases, since they hold watch history and playback preferences); user management — list/disable/change-role of existing users (leans on this phase's role primitive; slots into a later phase without rework).

## Architecture

Phase 2a built *authentication* — the global `onRequest` auth guard populates `request.user` or returns 401. Phase 2b adds *authorization* on top, plus two capabilities.

```
packages/shared      + FORBIDDEN error code; Invitation, RegistrationMode contract types
packages/database    + invitations table; registration_mode on installation; query modules
apps/server/plugins  + requireRole(minRole) preHandler factory
apps/server/modules  + invitations/  (admin: create, list, revoke)
                     + registration/ (public: inspect invite, redeem, open-register)
apps/web             + admin invitations page; /invite/:token redemption page
```

### The role hierarchy

A total order, one source of truth:

```
owner (3) > administrator (2) > user (1) > guest (0)
```

A single helper `roleRank(role): number` backs both consumers, so they cannot drift:

- `requireRole(minRole)` — is the caller's rank ≥ the required rank?
- The invite-granting rule — is the requested role's rank strictly below the creator's?

### `requireRole` as a preHandler

`requireRole(minRole)` returns a Fastify `preHandler`. Fastify runs `preHandler` hooks *after* the global `onRequest` auth guard, so `request.user` is guaranteed populated by the time it runs — or the guard already returned 401 and this never executes. A protected route declares:

```ts
app.post("/invitations", { preHandler: [requireRole("administrator")] }, handler)
```

A route that omits `requireRole` is still authenticated-only, never public — so forgetting it fails closed. On insufficient role it returns `403 FORBIDDEN`.

## Data model

### `registration_mode` on the installation singleton

```sql
CREATE TYPE registration_mode AS ENUM ('disabled', 'invitation-only', 'open');
ALTER TABLE installation
  ADD COLUMN registration_mode registration_mode NOT NULL DEFAULT 'invitation-only';
```

Delta migration `0004`, additive. The default gives the existing install the safe mode with no data step.

### `invitations`

```sql
CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  created_by   uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
  role         user_role NOT NULL,
  email        text,
  max_uses     integer NOT NULL DEFAULT 1,
  use_count    integer NOT NULL DEFAULT 0,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_max_uses_positive CHECK (max_uses >= 1),
  CONSTRAINT invitations_use_count_bounded CHECK (use_count >= 0 AND use_count <= max_uses)
);
CREATE INDEX invitations_created_by_idx ON invitations (created_by);
```

Design notes:

- **`token_hash` stores a SHA-256 hash, not the token** — the session-token model from 2a. The raw token lives only in the `/invite/<token>` link. A database leak exposes no usable invites. `UNIQUE` gives an indexed lookup.
- **`role` is `user_role` but never `owner`** — enforced in the creation handler (the granting rule is relative to the caller, which SQL cannot see), not by a CHECK.
- **`use_count` bounded by CHECK** — the database refuses `use_count > max_uses` structurally, so a logic bug cannot over-redeem.
- **No `status` column** — validity is derived at query time from `use_count`, `revoked_at`, `expires_at`. A stored status would be a second source of truth that could drift. An invite is *spendable* when `use_count < max_uses AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`.
- **`created_by` cascades on user delete** — removing an admin voids their outstanding invites, the safe default.

## Invitation endpoints

Admin (behind `requireRole("administrator")`, rate-limited):

```
POST   /api/v1/invitations       create → returns the invite plus the full /invite/<token> URL, ONCE
GET    /api/v1/invitations       list with derived status, role, email-bound flag, use counts, creator
DELETE /api/v1/invitations/:id   revoke (sets revoked_at; row is retained)
```

- The raw token appears **only** in the create response, never in the list. Same reasoning as passwords: stored hashed, uncoverable later, so the admin copies the link at creation.
- **The granting rule is enforced at creation**, before any write: the requested `role` must rank strictly below the caller's. An administrator requesting `administrator` or `owner` gets `403 FORBIDDEN`. Zod validates shape; the handler validates authority.
- List responses carry status (`active` / `spent` / `expired` / `revoked`), never a usable token.

Registration policy (behind `requireRole("administrator")`):

```
GET   /api/v1/settings/registration    read the current mode
PATCH /api/v1/settings/registration    set the mode (disabled | invitation-only | open)
```

Without this the mode would be stuck at its default. Switching *to* `open` requires an explicit confirmation flag in the request body (e.g. `{ mode: "open", acknowledgeOpenRisk: true }`); omitting it returns a validation error naming the risk. This is the server-side half of the spec's "the owner must be warned before enabling open registration" — the warning is surfaced in the UI, but the endpoint refuses to silently open registration without the acknowledgement, so the guard holds even against a hand-crafted request.

Public (unauthenticated, rate-limited):

```
GET  /api/v1/invitations/:token   inspect → { valid, role, emailBound } or an identical negative response
POST /api/v1/register             redeem, or open-register
```

The inspect endpoint returns the **minimum** for the redemption page to render "You've been invited as **user**": the granted role and a boolean `emailBound` — never the bound address itself, which would leak whose invite it is. Invalid, spent, expired, and revoked tokens all return an identical negative response, so the endpoint cannot probe which tokens exist.

## The redemption race

Two people redeeming an invite with one remaining use must not both succeed. Redemption is a single transaction, conditional-update-first — the pattern proved by the Phase 2a setup transaction:

```sql
UPDATE invitations SET use_count = use_count + 1
WHERE token_hash = $1
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now())
  AND use_count < max_uses
RETURNING role, email;
-- zero rows → invite unusable; abort with a generic error
-- then, in the SAME transaction: insert the user with the returned role, create the session
```

Under READ COMMITTED the second redeemer's UPDATE blocks on the row lock, re-evaluates `use_count < max_uses` after the first commits, matches zero rows, and fails. Because the user INSERT shares the transaction, a duplicate-username failure rolls back the use increment — a failed registration does not burn a use.

## Registration & the three modes

`POST /api/v1/register` reads the stored `registration_mode` first, then dispatches:

| Mode | Token | Behavior |
|---|---|---|
| `disabled` | — | `403 FORBIDDEN` regardless of token |
| `invitation-only` | required | redeem via the transaction above; missing/invalid token → reject |
| `open` | ignored | create a `user`-role account with no invite |

- **Mode is checked server-side on every request**, never inferred from the client. A stale form or a hand-crafted request hits the server's current mode. Flipping to `disabled` stops in-flight invite links immediately.
- **Email binding** is enforced here: a redeemed invite carrying an email requires the submitted email to match (normalized, case-insensitive, reusing 2a's `normalize`). Mismatch → validation error. Unbound invites and open registrations supply their own email.
- **Every successful registration ends signed in** — the account is created with the granted role (invited role, or `user` in open mode), a session is issued, and the same `HttpOnly` cookie as login is set. Redeeming lands on `/home` like the owner-setup flow. No separate login step.
- **Reused from 2a, not rebuilt:** Argon2id hashing, username rules (3–32 chars, no `@`), the 12-char password minimum, identifier normalization, session/cookie machinery. Registration is a new caller of those primitives.
- **Open mode makes `/register` an unauthenticated account-creation endpoint**, so it carries the same per-IP throttling posture as login. Invitation-only mode is naturally bounded by needing a valid token; open mode is bounded only by the rate limit, which is what stops mass account creation.

## Web UI

Two screens in 2a's dark-first placeholder style.

**Admin — `/admin/invitations`** (client-side role-gated, server-side enforced): a list of existing invites with status, role, uses, and a **Revoke** button; a create form with role (dropdown showing only roles the current user may grant), optional email binding, max-uses, optional expiration. On create, the full `/invite/<token>` URL appears with a **Copy** button, shown once.

**Public — `/invite/:token`**: calls inspect on load, renders "You've been invited as **user**", then a register form (username, password, email). When the invite is email-bound, the email field stays **editable with a note that a specific address is required** — the inspect endpoint deliberately never returns the bound address (that would leak whose invite it is), so the field cannot be pre-filled; the server rejects a mismatch on submit. Submit redeems and lands signed in on `/home`. Invalid/spent/expired tokens show "This invitation is no longer valid" rather than a form.

**Routing:** `/invite/:token` is reachable while signed out (how new users arrive); a signed-in user hitting it is redirected to `/home`. The login screen surfaces a "Create account" link only when the mode is `open`.

**The registration-policy control** lives on the admin invitations page (or an adjacent settings area): a mode selector. Choosing `open` shows an inline warning — anyone will be able to create an account without an invite — and the UI sends the `acknowledgeOpenRisk` flag only after the admin confirms. This satisfies the spec's requirement that the owner be warned before enabling open registration.

## Testing

- **Unit (Vitest):** `roleRank` ordering and the granting rule; `requireRole` returning 403 for insufficient and passing for sufficient roles; registration-mode dispatch across all three modes; email-binding match/mismatch; the registration-policy endpoint refusing `open` without the acknowledgement flag.
- **Integration (Testcontainers):** the redemption race — concurrent `Promise.allSettled` on a single-use invite asserting exactly one success and `use_count ≤ max_uses`; rollback leaving a use unspent on a failed user insert; each mode's end-to-end path against real PostgreSQL.
- **E2E (Playwright):** owner signs in → creates a user invite → copies the link → a second browser context opens `/invite/:token` → registers → lands signed in as the invited role → owner sees the invite marked spent. The full multi-user journey in one test.
- **Security-specific:** an administrator cannot create an administrator invite (403); inspect returns identical responses for invalid vs. spent vs. never-existed tokens; no raw token appears in any list response; `passwordHash` absent from every registration response.

## Out of scope

Multiple viewing profiles. User management (list, disable, change-role of existing users). Ownership transfer. Password reset. Email delivery of any kind. Guest read-only browsing behavior (the `guest` role can be granted but its permission surface is defined when catalog/library exist).

## Definition of Done

1. `registration_mode` stored on the installation, defaulting to `invitation-only`, changeable by an administrator.
2. `requireRole` protects admin routes; a `user`-role session gets 403 on invitation endpoints.
3. An owner or admin creates an invite and receives a one-time `/invite/<token>` URL.
4. The granting rule holds: an administrator cannot create an administrator or owner invite.
5. Redeeming a valid invite creates the account with the granted role and lands signed in.
6. Concurrent redemption of a single-use invite yields exactly one account; `use_count` never exceeds `max_uses`.
7. A failed registration rolls back the use increment.
8. Email-bound invites reject a mismatched registration email.
9. All three modes behave correctly, checked server-side.
10. No raw invite token appears in any list response; inspect cannot enumerate tokens; no `passwordHash` in any response.
11. The full owner-invites-user Playwright journey passes.
12. Lint, typecheck, unit, integration, and e2e all green.
