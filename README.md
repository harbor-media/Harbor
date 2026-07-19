# Harbor

A self-hosted media server with a catalog-first library experience.

Harbor is deployed by the person hosting it. Every installation owns its own
users, configuration, library, and watch history. There is no central Harbor
service.

## Status

Phase 1 (foundation) — the server boots, migrates, serves the web application,
and reports health. There is no authentication, onboarding wizard, catalog, or
playback yet. Those arrive in later phases.

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
