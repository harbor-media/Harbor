# Harbor

A self-hosted media server with a catalog-first library experience.

Harbor is deployed by the person hosting it. Every installation owns its own
users, configuration, library, and watch history. There is no central Harbor
service.

## Status

Phase 2b (invitations) — on top of first-run setup and session auth, roles
are now enforced server-side, and the owner or an administrator can invite
new users. There is still no user-management UI (listing or disabling
existing users), no profiles, no catalog, and no playback.

## Users & invitations

Registration is invitation-only by default. An owner or administrator opens
`/admin/invitations`, picks a role to grant (only roles below their own —
an administrator can offer `user` or `guest`, never `administrator`; nobody
can ever grant `owner`), optionally binds the invite to one email address,
sets a max-use count and an expiry, and creates it. Harbor never sends an
email: the page shows a one-time `/invite/<token>` link that the admin
copies and shares however they like. The recipient opens the link, sees the
role they're being offered, registers a username/email/password, and lands
signed in on `/home`. An email-bound invite only accepts that exact address.

The same admin page has a registration mode selector
(`GET`/`PATCH /api/v1/settings/registration`) with three modes:
`invitation-only` (default), `open` (anyone can self-register; the login
page then shows a "Create account" link — enabling it requires an explicit
risk acknowledgement), and `disabled` (no new accounts at all).

## Quick start

```bash
cp .env.example .env
# edit .env, then:
docker compose up -d
```

Open http://localhost:3000.

If you bind-mount `/data` to a host directory instead of using the default
named volume, you must `chown -R 100:100` that directory first — see
[docs/development.md](docs/development.md#persistent-data) for why.

## Development

See [docs/development.md](docs/development.md).

## License

GPL-2.0. See [LICENSE](LICENSE).
