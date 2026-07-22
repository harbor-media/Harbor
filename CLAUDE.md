# CLAUDE.md — Harbor

## Project Overview

Harbor is a modern, self-hosted media server with a Stremio-style library and discovery experience.

It combines:

* Jellyfin’s self-hosted server model.
* Stremio’s catalog-driven library experience.
* The polished browsing experience of modern streaming platforms.
* A straightforward Docker and Dokploy installation process.

Every Harbor installation belongs to the person hosting it.

Harbor is not a central hosted SaaS. There is no shared Harbor cloud backend that stores every installation’s users or media configuration.

Each installation contains its own:

* User accounts.
* Profiles.
* Provider configuration.
* Media library.
* Watch history.
* Watchlists.
* Metadata cache.
* Streaming configuration.
* Administrative settings.

The finished product should allow someone to deploy Harbor on a VPS or home server, connect a domain, complete an onboarding flow, and invite users to stream through the Harbor web interface.

Harbor must only be designed for media and streaming sources that the server owner is legally authorized to access and distribute.

---

# Product Vision

Harbor should feel like:

> Jellyfin infrastructure with a Stremio-style library.

The server owner installs Harbor once.

Users then open the Harbor website, sign in, browse a visually rich catalog, select a title, and begin watching.

Users should not need to understand:

* Docker.
* Media providers.
* Metadata providers.
* Storage configuration.
* Stream resolution.
* Reverse proxies.
* Server infrastructure.

Those responsibilities belong to the server owner and Harbor backend.

---

# Product Model

Harbor has two main interfaces.

## User Interface

The normal streaming experience.

Users can:

* Browse movies and television shows.
* Search the available catalog.
* Open detailed title pages.
* Add titles to their library.
* Maintain a watchlist.
* Resume unfinished content.
* View recently watched content.
* Browse genres and collections.
* Select seasons and episodes.
* Choose audio tracks and subtitles.
* Stream content through the browser.
* Manage their own profile and playback preferences.

## Administration Interface

The server-management experience.

Administrators can:

* Configure Harbor.
* Manage users.
* Create and revoke invitations.
* Configure metadata services.
* Configure authorized streaming providers.
* Manage storage and caching.
* Inspect active streams.
* View server health.
* Review application logs.
* Configure registration policies.
* Set stream and bandwidth limits.
* Configure update channels.
* Create and restore backups.

The user and administration interfaces are part of the same web application.

Administration routes must require elevated permissions.

---

# Deployment Goal

Harbor must be extremely easy to self-host.

The recommended installation method is a Dokploy template backed by Docker Compose.

Harbor must also support plain Docker Compose without requiring Dokploy.

The deployment experience should eventually be:

1. Open Dokploy.
2. Select the Harbor template.
3. Enter the required environment variables.
4. Assign a domain.
5. Deploy.
6. Open Harbor.
7. Complete the onboarding wizard.
8. Create the owner account.
9. Configure metadata and streaming providers.
10. Invite users.

A fresh installation must not require the user to manually enter a running container or edit files inside it.

---

# Distribution

Harbor will publish versioned container images.

Example image:

```text
ghcr.io/harbor-media/harbor:latest
```

Stable releases must also use immutable version tags:

```text
ghcr.io/harbor-media/harbor:1.0.0
```

Do not rely exclusively on `latest`.

Recommended tags:

```text
latest
stable
beta
edge
1
1.0
1.0.0
```

Production installations should be able to pin an exact version.

---

# Recommended Architecture

Harbor should initially use a modular monolith.

Do not begin with microservices.

A self-hosted application should remain understandable and operationally simple. Users should not need to deploy ten containers to run a personal media server.

The initial production stack should contain:

```text
Harbor Application
PostgreSQL
```

Optional later services may include:

```text
Redis
Dedicated worker
External object storage
Monitoring stack
```

Do not make optional services mandatory without a clear need.

---

# High-Level Architecture

```text
Browser
   |
   v
Reverse Proxy / Dokploy
   |
   v
Harbor Application
   |
   |-- Web interface
   |-- REST API
   |-- Authentication
   |-- Catalog
   |-- Metadata
   |-- Library
   |-- Playback
   |-- Stream gateway
   |-- Administration
   |-- Background jobs
   |
   +------ PostgreSQL
   |
   +------ Persistent Harbor data volume
   |
   +------ Authorized external providers
```

The browser must never receive private provider credentials.

All provider communication happens through the Harbor backend.

---

# Technology Stack

## Monorepo

Use:

* pnpm.
* Turborepo.
* TypeScript.
* Shared ESLint configuration.
* Shared TypeScript configuration.

Suggested structure:

```text
harbor/
├── apps/
│   ├── server/
│   └── web/
├── packages/
│   ├── api-client/
│   ├── config/
│   ├── database/
│   ├── logger/
│   ├── shared/
│   ├── ui/
│   └── validation/
├── deploy/
│   ├── docker/
│   └── dokploy/
├── docs/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

---

# Backend

## Runtime

Use the current active Node.js LTS release.

Do not depend on experimental runtime features in production.

## Language

Use strict TypeScript.

Requirements:

* `strict: true`.
* No unjustified `any`.
* Runtime validation at all external boundaries.
* Explicit error handling.
* Structured logging.
* Graceful shutdown.
* Abort signals for cancellable work.

## Framework

Use Fastify.

Fastify is preferred over NestJS for Harbor because Harbor should remain:

* Lightweight.
* Fast to start.
* Easy to package.
* Explicit.
* Suitable for streaming responses.
* Simple enough for a modular monolith.

Do not introduce a large dependency-injection framework unless the project develops a genuine need for it.

## API

Use a versioned REST API.

Base path:

```text
/api/v1
```

Use:

* OpenAPI.
* Generated API documentation.
* Zod request and response schemas.
* A generated typed frontend client where practical.

Do not add GraphQL during the initial implementation.

---

# Frontend

Use:

* React.
* TypeScript.
* Vite.
* React Router.
* TanStack Query.
* Zustand.
* Tailwind CSS.
* Radix UI primitives.
* Lucide icons.
* Motion for intentional animations.
* React Hook Form.
* Zod.

Use a client-side application rather than requiring a separate Next.js server.

The production frontend must be compiled into static assets and served by the Harbor backend.

This allows the complete product to ship as one Harbor application image.

Do not require separate frontend and backend deployments.

---

# Database

Use PostgreSQL.

Use Drizzle ORM with SQL migrations.

PostgreSQL stores:

* Installation settings.
* Users.
* Sessions.
* Profiles.
* Invitations.
* Roles and permissions.
* Libraries.
* Library entries.
* Watchlists.
* Playback progress.
* Watch history.
* Provider configurations.
* Encrypted provider credentials.
* Metadata cache references.
* Subtitle preferences.
* Audit events.
* Background-job state.

Database migrations must run safely during startup or through a dedicated migration command.

Never destructively alter production data without an explicit migration path.

---

# Persistent Storage

Harbor requires a persistent data directory.

Default container path:

```text
/data
```

Suggested structure:

```text
/data/
├── cache/
│   ├── images/
│   ├── metadata/
│   ├── streams/
│   └── subtitles/
├── config/
├── logs/
├── temporary/
└── backups/
```

The application must treat temporary and persistent data differently.

Harbor must continue functioning after the application container is replaced.

Never store required application state only inside the container filesystem.

---

# Docker Image

Harbor should ship as one production application image.

Use a multi-stage Docker build.

Suggested stages:

```text
dependencies
builder
runtime
```

The image should:

* Build the web application.
* Build the backend.
* Include database migrations.
* Include only production dependencies.
* Include FFmpeg and FFprobe when media inspection or remuxing requires them.
* Run as a non-root user.
* Expose a single HTTP port.
* Provide a health-check endpoint.
* Handle `SIGTERM` correctly.
* Avoid unnecessary operating-system packages.

Default internal port:

```text
3000
```

Health endpoint:

```text
/api/v1/health
```

Readiness endpoint:

```text
/api/v1/health/ready
```

The image must support both `amd64` and `arm64` where dependencies permit it.

---

# Docker Compose

The default Compose deployment should contain:

```text
harbor
postgres
```

Example shape:

```yaml
services:
  harbor:
    image: ghcr.io/harbor-media/harbor:latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://harbor:${POSTGRES_PASSWORD}@postgres:5432/harbor
      HARBOR_BASE_URL: ${HARBOR_BASE_URL}
      HARBOR_SECRET: ${HARBOR_SECRET}
      HARBOR_DATA_DIRECTORY: /data
    volumes:
      - harbor_data:/data
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test:
        - CMD
        - wget
        - --spider
        - --quiet
        - http://localhost:3000/api/v1/health
      interval: 30s
      timeout: 5s
      retries: 5

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: harbor
      POSTGRES_USER: harbor
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - harbor_postgres:/var/lib/postgresql/data
    healthcheck:
      test:
        - CMD-SHELL
        - pg_isready -U harbor -d harbor
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  harbor_data:
  harbor_postgres:
```

Treat this as an architectural example rather than a final production file.

Secrets must not be committed to the repository.

---

# Dokploy Template

Provide a maintained Harbor Dokploy template.

The template should:

* Deploy the Harbor Compose stack.
* Create persistent volumes.
* Generate or request required secrets.
* Expose Harbor through one domain.
* Configure the internal Harbor port.
* Configure container health checks.
* Include PostgreSQL.
* Avoid exposing PostgreSQL publicly.
* support application updates without deleting volumes.
* Include short descriptions for all environment variables.

Required user-facing variables:

```text
HARBOR_BASE_URL
HARBOR_SECRET
POSTGRES_PASSWORD
```

Optional variables:

```text
HARBOR_LOG_LEVEL
HARBOR_REGISTRATION_MODE
HARBOR_DATA_DIRECTORY
HARBOR_CACHE_MAX_SIZE
HARBOR_STREAM_CONCURRENCY
HARBOR_TRUST_PROXY
HARBOR_TELEMETRY_ENABLED
```

The Dokploy template should use safe defaults.

---

# First-Run Onboarding

A fresh installation must open an onboarding wizard.

The wizard should collect:

1. Preferred language.
2. Server name.
3. Public server URL.
4. Owner username.
5. Owner email.
6. Owner password.
7. Metadata language.
8. Preferred subtitle languages.
9. Authorized provider configuration.
10. Registration and invitation policy.

The first account created becomes the owner.

After setup is complete, the onboarding endpoints must become inaccessible unless setup is explicitly reset from the server.

Use a database lock or transactional installation record to prevent two simultaneous owner creations.

---

# Authentication

Initial authentication should support:

* Username or email.
* Password.
* Secure server-side sessions.
* Invitation-based registration.
* Password reset through owner or administrator action.

Optional later support:

* Passkeys.
* OpenID Connect.
* LDAP.
* Authentik.
* Authelia.
* Google OAuth.
* Discord OAuth.

Do not prioritize external authentication before reliable local accounts work.

## Password Security

Use Argon2id for password hashing.

Requirements:

* Secure cookies.
* HTTP-only cookies.
* SameSite protection.
* CSRF protection where applicable.
* Login rate limiting.
* Session revocation.
* Password-change session invalidation.
* Optional administrator-enforced session expiry.

---

# User Roles

Initial roles:

```text
Owner
Administrator
User
Guest
```

## Owner

The owner can:

* Access every setting.
* Manage administrators.
* Configure providers.
* Manage backups.
* Change security settings.
* Transfer ownership.
* Shut down or restart Harbor where supported.

There must be exactly one active owner.

## Administrator

Administrators can:

* Manage users.
* Manage invitations.
* Inspect streams.
* Manage catalogs and metadata.
* View logs.
* Modify non-owner server settings.

## User

Users can:

* Browse.
* Search.
* Maintain a personal library.
* Maintain a watchlist.
* Stream.
* Manage their own profile.
* View their own history.

## Guest

Guest permissions are configurable and read-only by default.

---

# Profiles

Each user account may contain multiple viewing profiles.

A profile contains:

* Name.
* Avatar.
* Language.
* Subtitle preferences.
* Playback preferences.
* Watch history.
* Playback progress.
* Library.
* Watchlist.
* Maturity restrictions.
* Optional PIN.

Profiles must not share playback history unless explicitly configured.

---

# Catalog Philosophy

Harbor’s catalog is inspired by Stremio.

The primary experience is not based on manually browsing server folders.

Instead, the user browses a metadata-rich catalog containing:

* Movies.
* Television series.
* Seasons.
* Episodes.
* Collections.
* Genres.
* Trending titles.
* Popular titles.
* Recently released titles.
* Recommended titles.
* Personal library entries.
* Continue Watching entries.

Media availability and metadata are separate concepts.

A title can appear in the catalog before the server has resolved a playable source for it.

---

# Library Model

The user’s library stores title references rather than copied media files.

A library entry can represent:

```text
Movie
Series
Season
Episode
Collection
```

Each entry should reference a canonical metadata record.

Example:

```text
Profile
  -> Library entry
      -> Canonical title
          -> External metadata IDs
          -> Cached metadata
          -> Available playback sources
```

Adding a title to the library does not necessarily download it.

The library should feel immediate and lightweight.

---

# Home Screen

The default home screen should contain configurable horizontal catalog rows.

Initial rows:

* Continue Watching.
* My Library.
* Recently Watched.
* Popular Movies.
* Popular Series.
* Trending.
* New Releases.
* Recommended for You.
* Recently Added to Library.

Rows should use horizontal navigation on desktop and touch scrolling on mobile.

Do not display every available title in one unstructured grid.

---

# Search

Search must support:

* Title.
* Original title.
* Alternative titles.
* Cast.
* Director.
* Genre.
* Release year.

Search results should be grouped by content type.

Search should feel instant for cached metadata.

Use PostgreSQL search initially.

Do not introduce a separate search service before PostgreSQL becomes insufficient.

---

# Metadata System

Metadata providers must be implemented behind internal adapters.

Example interface:

```ts
interface MetadataProvider {
  search(query: MetadataSearchQuery): Promise<MetadataSearchResult[]>;
  getMovie(id: string): Promise<MovieMetadata>;
  getSeries(id: string): Promise<SeriesMetadata>;
  getSeason(id: string, season: number): Promise<SeasonMetadata>;
  getEpisode(
    id: string,
    season: number,
    episode: number
  ): Promise<EpisodeMetadata>;
}
```

Potential metadata integrations include:

* TMDB.
* TVDB.
* OMDb.
* Fanart.tv.
* Local metadata.

Do not tightly couple domain models to one metadata provider.

Store provider IDs in a normalized external-ID table.

Cache metadata to reduce API requests and improve browsing performance.

Respect every provider’s license, attribution requirements, and API terms.

---

# Provider Architecture

Streaming providers must use a plugin-like internal adapter architecture.

The first implementation can be built into Harbor while preserving a stable provider interface.

Example:

```ts
interface StreamProvider {
  id: string;
  name: string;

  validateConfiguration(): Promise<ProviderValidationResult>;

  search(
    request: StreamSearchRequest
  ): Promise<StreamCandidate[]>;

  resolve(
    candidate: StreamCandidate
  ): Promise<ResolvedStream>;
}
```

A provider may return:

* Direct HTTP streams.
* HLS manifests.
* DASH manifests.
* Local files.
* Remote files.
* Other legally authorized media sources.

Provider credentials must:

* Remain on the server.
* Be encrypted at rest.
* Never be returned through the API.
* Never be embedded in frontend JavaScript.
* Never be included in ordinary logs.

---

# Playback Resolution

The playback flow should be:

```text
User selects Play
        |
        v
Harbor identifies title or episode
        |
        v
Configured providers are queried
        |
        v
Candidates are normalized
        |
        v
Candidates are ranked
        |
        v
Harbor selects or displays a source
        |
        v
The source is resolved server-side
        |
        v
Playback session is created
        |
        v
Browser receives a Harbor playback URL
        |
        v
Harbor serves, redirects, or proxies the stream
```

The frontend should not contain provider-specific logic.

---

# Stream Gateway

The Harbor stream gateway is responsible for safely delivering authorized media to clients.

It must support:

* HTTP byte ranges.
* Seeking.
* HEAD requests.
* Correct content length.
* Content-type forwarding.
* Cancellation when clients disconnect.
* Connection timeout handling.
* Upstream timeout handling.
* Playback-session validation.
* Per-user concurrency limits.
* Per-server concurrency limits.
* Bandwidth logging.
* Private credential removal.
* URL expiry.
* Safe upstream redirects.

Avoid buffering entire media files in application memory.

Use streaming pipelines with backpressure.

Never load a complete video into a Node.js buffer.

---

# Direct Play, Remuxing and Transcoding

Prefer playback methods in this order:

1. Direct play.
2. Direct stream or remux.
3. Transcoding.

## Direct Play

Use direct play when the browser supports:

* The container.
* The video codec.
* The audio codec.
* The subtitle format.

## Remuxing

Use FFmpeg to change the media container without re-encoding when required.

Examples:

* MKV to fragmented MP4.
* Compatible streams to HLS.

## Transcoding

Transcoding is a later milestone.

Do not make full real-time transcoding a requirement for the first release.

Future support may include:

* Software transcoding.
* Intel Quick Sync.
* NVIDIA NVENC.
* VAAPI.
* AMD hardware acceleration.

Hardware acceleration must be optional and explicitly configured.

---

# Browser Player

Use a custom Harbor player built around browser media APIs.

Potential libraries:

* HLS.js.
* Shaka Player.
* Native HTML video.

Initial features:

* Play and pause.
* Timeline seeking.
* Volume.
* Fullscreen.
* Picture-in-picture.
* Playback speed.
* Subtitle selection.
* Audio-track selection where supported.
* Previous and next episode.
* Automatic next-episode playback.
* Resume playback.
* Playback error reporting.
* Quality and source information.

Later features:

* Skip intro.
* Skip credits.
* Chromecast.
* AirPlay.
* Watch Together.
* Stats for nerds.

Do not prioritize visual player customization over reliable playback.

---

# Playback Progress

Playback position should sync periodically.

Do not write to the database every second.

Recommended behavior:

* Update locally during playback.
* Send progress every 10–30 seconds.
* Send progress when paused.
* Send progress when seeking.
* Send progress before page unload where possible.
* Send final state when playback finishes.

A title becomes completed based on a configurable completion threshold.

Default threshold:

```text
90%
```

---

# Continue Watching

An item appears in Continue Watching when:

* Playback has started.
* It has not been marked complete.
* Enough content remains to justify resuming.

For series, Continue Watching should point to the next appropriate episode after an episode is completed.

Progress belongs to a profile, not globally to the server.

---

# Images

Harbor should proxy and cache metadata images.

Image types:

* Posters.
* Backdrops.
* Logos.
* Profile avatars.
* Cast photos.
* Episode stills.

The image service should support:

* Remote image fetching.
* Caching.
* Resizing.
* Format conversion.
* Cache expiration.
* Placeholder images.
* Upstream failure handling.

Do not send private image-provider credentials to browsers.

---

# Subtitles

Initial subtitle support should include:

* Embedded subtitles.
* External subtitle files.
* WebVTT.
* SRT conversion.
* Language preferences.
* Forced subtitle indicators.
* Hearing-impaired indicators.

External subtitle providers must use adapters.

Subtitle fetching must respect provider terms and user authorization.

---

# Administration Dashboard

The dashboard should show:

* Server status.
* Harbor version.
* Uptime.
* Database status.
* Storage usage.
* Cache usage.
* Active streams.
* Recent log events.
* Registered users.
* Recent playback activity.
* Available updates.

Avoid meaningless charts.

Every displayed metric should help operate the server.

---

# Active Streams

Administrators should be able to inspect:

* User.
* Profile.
* Title.
* Episode.
* Playback start time.
* Playback method.
* Video quality.
* Source.
* Approximate bandwidth.
* Client IP where permitted.
* Client user agent.

Administrators may terminate an active playback session.

Sensitive upstream URLs and credentials must never be displayed.

---

# Invitations

Default registration mode should be invitation-only.

Invitation configuration:

* Expiration.
* Maximum uses.
* Assigned role.
* Assigned restrictions.
* Optional email binding.
* Optional profile limit.

Supported registration modes:

```text
disabled
invitation-only
open
```

The owner must be warned before enabling open registration.

---

# Rate Limits

Implement rate limits for:

* Login attempts.
* Registration.
* Password reset.
* Metadata search.
* Provider search.
* Playback resolution.
* Stream-session creation.
* Image proxying.

Rate limits should be configurable without requiring recompilation.

Do not apply limits that disrupt normal media streaming.

---

# Security Requirements

Harbor is exposed to the internet in many installations.

Security is a core product requirement.

Required controls:

* Non-root Docker process.
* Encrypted provider credentials.
* Secure session cookies.
* CSRF protection.
* Input validation.
* Output encoding.
* SQL injection protection.
* SSRF protection.
* Safe URL validation.
* Login rate limiting.
* Permission checks.
* Audit logging.
* Secret redaction.
* Dependency scanning.
* Container vulnerability scanning.
* Content Security Policy.
* Trusted-proxy configuration.

## SSRF Protection

Provider and image proxy features create SSRF risk.

Harbor must reject unsafe upstream destinations, including:

* Loopback addresses.
* Private networks unless explicitly allowed.
* Link-local addresses.
* Cloud metadata addresses.
* Unsupported protocols.
* Redirects to blocked destinations.

Every redirect destination must be revalidated.

---

# Logging

Use structured JSON logs in production.

Use readable pretty logs during development.

Every log should include relevant context:

```text
requestId
userId
profileId
playbackSessionId
providerId
duration
status
```

Never log:

* Passwords.
* Session tokens.
* Provider API keys.
* Complete signed stream URLs.
* Authorization headers.
* Database credentials.

Support configurable log levels:

```text
error
warn
info
debug
trace
```

---

# Health Checks

Expose:

```text
GET /api/v1/health
GET /api/v1/health/live
GET /api/v1/health/ready
```

## Liveness

Confirms that the Harbor process is running.

## Readiness

Confirms that Harbor can serve requests.

Readiness may check:

* Database connectivity.
* Migration state.
* Data-directory writability.
* Required configuration.

Do not fail liveness because an external metadata provider is unavailable.

---

# Background Jobs

Initial background work can run inside the Harbor process.

Jobs include:

* Metadata refresh.
* Image-cache cleanup.
* Expired-session cleanup.
* Expired-invitation cleanup.
* Playback-session cleanup.
* Provider health checks.
* Database maintenance.
* Update checks.
* Backup scheduling.

Use database-backed job state where durability matters.

A dedicated worker container can be introduced later without changing domain logic.

---

# Backups

Harbor must support backups of:

* PostgreSQL data.
* Harbor configuration.
* Encrypted provider configuration.
* User data.
* Watch history.
* Libraries.
* Profiles.

Cached metadata and images should be optional.

Backups must not silently include plaintext secrets.

Administrators should be able to:

* Create a backup.
* Download a backup.
* Schedule backups.
* Configure retention.
* Restore from a backup.
* Validate a backup.

Document the restore process.

---

# Updates

Harbor must make version information visible in the administration interface.

The server can check whether a newer version exists.

Harbor must not automatically replace its own container.

Container updates should be controlled by:

* Dokploy.
* Docker Compose.
* Watchtower when explicitly configured.
* Another administrator-controlled deployment system.

Database migrations must remain compatible with the documented upgrade path.

---

# Telemetry

Telemetry must be disabled by default.

Harbor must function fully without telemetry.

When enabled, telemetry must be:

* Clearly documented.
* Anonymous where possible.
* Limited to operational product metrics.
* Visible in settings.
* Revocable.

Never collect:

* Viewed title names.
* Search queries.
* Provider credentials.
* Stream URLs.
* User email addresses.
* IP addresses for product analytics.

---

# Responsive Design

The web interface must work on:

* Desktop.
* Laptop.
* Tablet.
* Mobile browser.
* Television browser where possible.

Desktop is the initial priority.

Do not build a separate mobile application during the first phase.

The responsive web application should remain usable on mobile from the beginning.

---

# Visual Direction

Harbor should use a dark-first interface.

Brand direction:

* Achromatic surfaces. Every surface and text token has chroma exactly zero.
* One emphasis colour: Signal Off-White `oklch(0.922 0 0)`. On a dark canvas, high-contrast near-white *is* the accent. Harbor has no brand hue.
* Colour is semantic, never decorative. Red means error, green success, amber warning, sky information. A screen with nothing wrong is essentially greyscale, and that is correct.
* Never pure black or pure white. The canvas is `oklch(0.185 0 0)` and text is `oklch(0.985 0 0)`; the slight lift keeps the surface from reading as a void.
* Hairline borders `oklch(1 0 0 / 10%)` and tonal layering instead of shadows.
* Outfit for display, Geist for body, Geist Mono for labels and values that read as data. Fonts are bundled, never fetched from a CDN — the Content Security Policy sets `font-src 'self'`.
* Large cinematic artwork carries the colour. The chrome is neutral precisely so posters are the only saturated thing on screen.
* Strong contrast.
* Soft focus states.
* Minimal visual noise.

The interface can take inspiration from modern streaming applications but must not directly copy another product’s layout or protected visual identity.

## Design Rules

* Avoid excessive glassmorphism.
* Avoid gradients on every component.
* Avoid giant border radii.
* Avoid unnecessary dashboard cards.
* Avoid tiny low-contrast text.
* Avoid animation that delays interaction.
* Avoid horizontal scrolling without clear affordances.
* Use skeleton states for loading.
* Preserve layout while images load.
* Support keyboard navigation.
* Display visible focus states.

---

# Accessibility

Target WCAG 2.2 AA.

Requirements:

* Keyboard-accessible navigation.
* Correct semantic HTML.
* Visible focus indicators.
* Sufficient color contrast.
* Accessible dialogs.
* Accessible player controls.
* Screen-reader labels.
* Reduced-motion support.
* Captions and subtitle accessibility.
* No essential information communicated through color alone.

---

# Testing

Use:

* Vitest for unit tests.
* Testing Library for frontend behavior.
* Playwright for end-to-end tests.
* Testcontainers for database integration tests where appropriate.

Required end-to-end flows:

* First-time setup.
* Owner login.
* User invitation.
* User registration.
* Catalog browsing.
* Search.
* Adding a title to the library.
* Starting playback.
* Saving playback progress.
* Resuming playback.
* Permission enforcement.
* Backup creation.
* Container restart with persistent state.

Streaming tests must cover:

* Range requests.
* Seeking.
* Client disconnects.
* Upstream timeouts.
* Invalid playback sessions.
* Expired URLs.
* Concurrent requests.

---

# CI/CD

Use GitHub Actions.

Pipeline stages:

1. Install dependencies.
2. Lint.
3. Type-check.
4. Run unit tests.
5. Run integration tests.
6. Build web application.
7. Build backend.
8. Build Docker image.
9. Scan image.
10. Run container smoke test.
11. Publish tagged images.
12. Publish multi-architecture manifest.

Pull requests must not publish stable images.

Stable images should be created from version tags.

---

# Development Commands

Expected commands:

```bash
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm docker:build
pnpm docker:smoke
```

Local development should use Docker Compose for PostgreSQL.

The backend and web application should support local hot reload.

---

# Configuration Philosophy

Configuration must come from:

1. Environment variables for deployment-critical settings.
2. Database-backed administration settings for runtime product configuration.

Environment variables should be reserved for values such as:

* Database connection.
* Encryption secret.
* Public base URL.
* Data-directory path.
* Bind address.
* Port.
* Trust-proxy behavior.

Do not require container replacement for ordinary UI settings such as:

* Server name.
* Registration mode.
* Preferred metadata language.
* Library row configuration.
* Default subtitle language.

---

# API Error Format

Use a consistent error shape:

```json
{
  "error": {
    "code": "PLAYBACK_SOURCE_UNAVAILABLE",
    "message": "No playable source is currently available.",
    "requestId": "request-id"
  }
}
```

Do not expose internal stack traces in production responses.

Error codes should be stable and documented.

---

# Definition of MVP

The MVP is complete when a server owner can:

1. Deploy Harbor through Docker Compose or Dokploy.
2. Open Harbor through a configured domain.
3. Complete the onboarding wizard.
4. Create an owner account.
5. Configure one metadata provider.
6. Configure one authorized streaming provider.
7. Invite another user.
8. Browse a Stremio-style catalog.
9. Search for a movie or series.
10. Add it to a personal library.
11. Start browser playback.
12. Resume playback later.
13. Inspect the active stream as an administrator.
14. Restart or replace the Harbor container without losing state.

Do not call the project MVP-ready until this complete path works reliably.

---

# MVP Pages

## Public and Authentication

```text
/setup
/login
/invite/:token
```

## User Application

```text
/home
/discover
/search
/library
/watchlist
/movie/:id
/series/:id
/series/:id/season/:season
/watch/:playbackSessionId
/profile
/settings
```

## Administration

```text
/admin
/admin/users
/admin/invitations
/admin/providers
/admin/metadata
/admin/streams
/admin/storage
/admin/logs
/admin/backups
/admin/settings
/admin/system
```

---

# Implementation Phases

## Phase 1 — Foundation

Build:

* Monorepo.
* Backend.
* Frontend shell.
* PostgreSQL.
* Migrations.
* Docker image.
* Docker Compose deployment.
* Health checks.
* Logging.
* First-run installation state.

## Phase 2 — Authentication

Build:

* Owner setup.
* Login.
* Sessions.
* Roles.
* Invitations.
* User management.
* Profiles.

## Phase 3 — Catalog

Build:

* Metadata-provider interface.
* First metadata integration.
* Search.
* Movie pages.
* Series pages.
* Seasons and episodes.
* Home catalog rows.
* Image proxy and cache.

## Phase 4 — Personal Library

Build:

* Library entries.
* Watchlists.
* Playback history.
* Progress tracking.
* Continue Watching.
* Profile-specific preferences.

## Phase 5 — Playback

Build:

* Provider adapter.
* Candidate normalization.
* Playback-session creation.
* Stream gateway.
* Range requests.
* Browser player.
* Subtitle support.
* Playback progress synchronization.

## Phase 6 — Administration

Build:

* Server dashboard.
* Active streams.
* Provider settings.
* Storage settings.
* Logs.
* Stream termination.
* Backups.

## Phase 7 — Distribution

Build:

* Multi-architecture images.
* Version tags.
* Dokploy template.
* Upgrade documentation.
* Backup and restore documentation.
* Deployment smoke tests.

---

# Out of Scope for MVP

Do not include these in the first release:

* Native Windows application.
* Native mobile applications.
* Television applications.
* Microservices.
* Kubernetes.
* Multi-server federation.
* Social features.
* Watch parties.
* Comments.
* Public reviews.
* Machine-learning recommendations.
* Full real-time transcoding.
* Plugin marketplace.
* Theme marketplace.
* Built-in email server.
* Mandatory Redis.
* Mandatory S3 storage.
* Mandatory external search engine.

These can be considered after the self-hosted web product is reliable.

---

# Engineering Principles

## Keep Self-Hosting Simple

Every dependency increases deployment and support complexity.

Prefer one application container and one database.

## Preserve User Ownership

The server owner owns their:

* Database.
* Configuration.
* Account data.
* Watch history.
* Library.
* Backups.

Harbor should not require an external Harbor account.

## Protect Credentials

Provider credentials belong only on the server.

They must never appear in browser bundles, browser storage, API responses, screenshots, or normal logs.

## Prefer Direct Playback

Avoid unnecessary processing.

Do not transcode media when the client can play it directly.

## Build Stable Interfaces

Provider and metadata adapters should have explicit contracts.

Do not spread provider-specific behavior throughout the application.

## Optimize After Measurement

Do not add Redis, message brokers, microservices, or dedicated search infrastructure based on assumptions.

Measure first.

## Make Failure Understandable

Errors should explain:

* What failed.
* Whether retrying may help.
* Whether an administrator must act.
* Which request ID can be used when checking logs.

Never expose private upstream details to ordinary users.

---

# Instructions for Claude

When implementing Harbor:

1. Read this file before making architectural decisions.
2. Preserve the self-hosted modular-monolith architecture.
3. Do not introduce new infrastructure without explaining the operational cost.
4. Do not expose provider credentials to clients.
5. Validate every external input.
6. Design all server state to survive container replacement.
7. Keep Docker and Dokploy deployment working after every major change.
8. Add migrations for database changes.
9. Add tests for security-sensitive and playback-sensitive behavior.
10. Prefer straightforward, maintainable code over unnecessary abstraction.
11. Do not implement unrelated roadmap features during MVP work.
12. Update documentation whenever configuration or deployment behavior changes.
13. Treat stream proxying, SSRF prevention, authentication, and secret storage as security-critical code.
14. Ensure the web application can be compiled and served from the Harbor application image.
15. Ensure all major functionality works without any central Harbor-hosted service.

The goal is not to create a generic streaming SaaS.

The goal is to create the best possible self-hosted, catalog-first media server.
