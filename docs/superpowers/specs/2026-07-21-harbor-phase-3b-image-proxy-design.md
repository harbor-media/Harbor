# Harbor Phase 3b — Image Proxy and Cache

**Date:** 2026-07-21
**Status:** Approved
**Depends on:** Phase 3a (metadata foundation, canonical titles storing provider-relative image paths)

## Scope

Phase 3 was split into 3a (metadata foundation), 3b (this spec), and 3c
(catalog UX). 3b delivers the image proxy and its on-disk cache.

`CLAUDE.md` names image proxying as an SSRF risk explicitly, which is why it
is its own phase rather than a corner of a larger one: bundled into a
forty-task phase, this is the part that gets shortchanged.

### Why a proxy is mandatory, not a convenience

Harbor's Content Security Policy sets `imgSrc: ["'self'", "data:"]`
(`apps/server/src/app.ts`). A direct `https://image.tmdb.org/...` URL in an
`<img>` tag is blocked by the browser. Images must be served from Harbor's
own origin.

Two further reasons reinforce it: `CLAUDE.md` forbids sending private
image-provider credentials to browsers, and an unproxied catalog would leak
every user's browsing activity to the provider through direct requests.

### Out of scope for 3b

Image resizing and format conversion (see the decision below), user-uploaded
avatars, arbitrary-URL proxying, and all catalog layout. The search page
gains poster thumbnails only as proof the pipeline works.

## Definition of Done

Poster images appear in search results. Reloading serves them from Harbor's
disk cache with no outbound request. Killing the server mid-download leaves
no corrupt file behind.

## Decisions

### Requests carry a provider-relative path, never a URL

```
GET /api/v1/images/:provider/:size/:file
```

`provider` maps to a hardcoded base URL. `size` is an allowlist per provider.
`file` must match `^[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$` — a single segment
containing no `/`.

**No hostname ever comes from the client, so classic SSRF is not filtered but
unrepresentable.** There is no field that accepts a host, so no request can
reach `169.254.169.254`, a loopback address, or a private range. For the same
reason, path traversal is impossible rather than sanitized: a segment that
cannot contain `/` cannot escape its directory.

Phase 3a already stores `posterPath` and `backdropPath` as provider-relative
paths precisely so this phase could resolve them, so this costs nothing.

Rejected alternatives:

- **Full URL with validation** (`?url=https://…`) — the conventional
  image-proxy shape and the one `CLAUDE.md` warns about. It requires
  blocking loopback, private ranges, link-local, cloud metadata, and
  non-HTTP schemes, then revalidating every redirect — and remains
  vulnerable to DNS rebinding unless resolution and connection are bound to
  the same IP. It buys flexibility nothing currently needs.
- **Signed opaque tokens** — safest, and prevents the proxy being used as a
  relay even by authenticated users, but requires minting tokens on every
  response carrying a poster and complicates caching through expiry. Worth
  revisiting only if the proxy is abused.

### Provider sizes are passed through; Harbor does not process images

TMDB publishes pre-sized variants (`w92`, `w154`, `w185`, `w342`, `w500`,
`w780`, `original`). Harbor's `size` segment maps onto them.

This avoids `sharp` — a native module that would bring musl/glibc variance,
an arm64 build story, and a larger image, against a `CLAUDE.md` commitment to
support both `amd64` and `arm64`. It also avoids spending CPU on a box that
may later be remuxing video.

Fetching `original` and resizing locally was rejected: `original` posters are
several megabytes where `w342` is roughly 30 KB, so it is worse on bandwidth,
CPU, and cache footprint simultaneously.

Consequence: Harbor can serve only the sizes its providers publish, and
cannot transcode to WebP if a provider offers only JPEG. Acceptable for
catalog artwork. The route names a size, so local processing can be added
behind the same interface later if a provider without variants appears.

### Upstream failures return an error, not a placeholder image

`CLAUDE.md` lists "placeholder images" among image-service features. This
spec departs from that, deliberately.

A placeholder served as `200 image/png` is cached by the browser as though it
were the real poster, so a transient provider blip pins a grey box in users'
caches until it expires. Returning `502`/`503` lets the frontend render its
own skeleton, keeps layout stable, and lets the real image appear as soon as
upstream recovers.

The placeholder still exists — it is drawn by the frontend, where it belongs.

### Eviction is size-capped FIFO, not LRU

A scheduled sweep totals the cache directory and, when it exceeds
`HARBOR_CACHE_MAX_SIZE` (default 2 GB), deletes oldest-by-`mtime` until usage
falls to 90% of the cap. The hysteresis prevents re-sweeping on every run.
Sweeps never run on the request path, which would make image serving scale
with cache size.

True LRU was rejected: tracking last *read* time requires either `atime`,
which is unreliable because many mounts use `noatime` or `relatime`, or a
database row updated on every image read — a write on the hottest path in a
poster grid, plus a second source of truth that can drift from the
filesystem. That drift produces confusing bugs.

FIFO can evict a popular image; the cost is one upstream fetch and it returns
immediately. `CLAUDE.md` is explicit about not optimizing before measuring.

## Architecture

### Security controls

**Content-type allowlist.** Only `image/jpeg`, `image/png`, and `image/webp`
are accepted. The response `Content-Type` is set from that allowlist rather
than echoed from upstream, and every response carries
`X-Content-Type-Options: nosniff`.

**SVG is excluded on purpose.** An SVG is an active document and may contain
`<script>`. Served from Harbor's origin it would execute as first-party
JavaScript with access to the session cookie — stored XSS delivered through
something that looks like a static file cache.

**Redirects are refused** (`redirect: "error"`) rather than followed and
revalidated. TMDB's CDN serves images directly, so refusing redirects removes
the revalidation requirement instead of implementing it. A provider that
needs redirects is the trigger to build that validation, not before.

**Byte cap and timeouts.** Downloads stream to disk with a 10 MB cap enforced
during the stream and aborted on breach, under an `AbortSignal` timeout.
Nothing is buffered whole in memory, so a hostile or malfunctioning upstream
cannot exhaust it.

**Authentication required.** Not because artwork is secret, but because an
unauthenticated proxy is an open relay: anyone on the internet could spend
the server owner's bandwidth fetching provider images. Same-origin cookies
make this invisible to the frontend.

### Cache

```
/data/cache/images/<provider>/<size>/<file>
```

Downloads write to a temporary name in the same directory and `rename()` into
place. Rename is atomic, so a reader observes either a complete file or none,
even if the process is killed mid-download. Without this, an interrupted
download caches a truncated image permanently — surfacing as randomly corrupt
posters that survive restarts.

Responses carry `Cache-Control: private` with a long `max-age` and an `ETag`.
`private` because the route is authenticated: an intermediary must never
serve one user's response to another.

The `ETag` is derived from the cached file's size and modification time, not
from hashing its bytes. Hashing every response would read the whole file on
every request purely to produce a header. Provider image paths are
content-addressed and effectively immutable, so a weak validator is
sufficient here.

### Concurrency and negative caching

Concurrent requests for the same uncached image collapse into a single
upstream fetch through an in-process single-flight map, so a grid loading the
same poster twice does not fetch it twice.

A bounded in-memory table remembers upstream 404s for one hour, so a path
that no longer exists upstream does not trigger a request on every render.
It is in-memory rather than persisted because it is an optimization, and
losing it on restart is harmless.

## Failure handling

| Condition | Behavior |
| --- | --- |
| Cached | Served from disk, no outbound request |
| Not cached, upstream OK | Fetched, stored atomically, served |
| Upstream 404 | `404`, remembered for one hour |
| Upstream unreachable or timed out | `503`, retryable |
| Upstream returns a disallowed content type | `502`; nothing is cached |
| Response exceeds the byte cap | Aborted, partial file discarded, `502` |
| Cache directory unwritable | Image is still served by streaming through; the failure is logged once, not per request |

The last row matters for a self-hosted box whose disk filled: image serving
degrades to a pass-through rather than failing outright.

## Configuration

`HARBOR_CACHE_MAX_SIZE` — maximum image cache size, default 2 GB. Already
listed in `CLAUDE.md` as an optional Dokploy variable.

`HARBOR_TMDB_IMAGE_BASE_URL` — overrides the image CDN base URL, defaulting
to `https://image.tmdb.org/t/p`.

This is a **second, separate** variable from Phase 3a's
`HARBOR_TMDB_BASE_URL`. They address different hosts: 3a's points at the
metadata API (`api.themoviedb.org`), while images are served from a distinct
CDN (`image.tmdb.org`). Reusing 3a's variable would silently send image
requests to the API host. Like its counterpart it is operator-set
infrastructure with no user influence, so it adds no request-forgery
surface, and it is what lets the end-to-end suite serve images from a local
fixture.

## Testing

- **Path validation:** traversal (`../`), encoded traversal (`%2e%2e%2f`),
  absolute URLs, and null bytes are all rejected.
- **Content type:** `image/svg+xml` and `text/html` responses are refused and
  not cached.
- **Redirects:** a redirecting upstream produces an error, never a fetch of
  the redirect target.
- **Byte cap:** an oversized response is aborted and leaves no cached file.
- **Cache hit:** proven by asserting the *absence* of an outbound request,
  not merely that bytes came back — the latter passes whether or not caching
  works.
- **Atomicity:** a download interrupted mid-write leaves no servable file.
- **Eviction:** a cache over the cap is swept below it, and the sweep does
  not delete while under it.
- **Authorization:** unauthenticated requests are refused.

No test may contact the real TMDB. Unit and integration tests inject a fake
fetch; the end-to-end suite points `HARBOR_TMDB_IMAGE_BASE_URL` at a local
fixture serving real image bytes, alongside the metadata fixture Phase 3a
added.
