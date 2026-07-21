# Images

Harbor serves all provider artwork from its own origin through a caching
proxy. Browsers never contact the image provider directly.

## Why images are proxied

Three reasons, in order of how hard they are to work around:

1. **Harbor's Content Security Policy forbids third-party image origins**
   (`img-src 'self'`). A direct provider URL in an `<img>` tag is blocked by
   the browser.
2. **Direct requests would leak browsing activity.** Every poster a user
   loaded would tell the provider what that person was looking at.
3. **Caching.** A poster is fetched once and then served from local disk.

## How a request is shaped

```
GET /api/v1/images/:provider/:size/:file
```

For example `/api/v1/images/tmdb/w342/abc123.jpg`.

**No hostname is ever accepted from a client.** The provider segment is looked
up in a hardcoded map, so there is no field through which a request could be
steered at a loopback address, a private network, or a cloud metadata
endpoint. Server-side request forgery is not filtered here; it is
unrepresentable.

The filename must be a single segment matching
`[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)`. Because it cannot contain a slash, it
cannot describe another directory, so directory traversal is likewise
impossible rather than sanitized.

Image requests require authentication. Artwork is not secret, but an
unauthenticated proxy is an open relay: anyone on the internet could spend the
server owner's bandwidth fetching provider images.

## Sizes

Harbor passes through the size variants the provider already publishes rather
than resizing anything itself. For TMDB those are `w92`, `w154`, `w185`,
`w342`, `w500`, `w780`, and `original`.

This is why Harbor needs no native image-processing library, which in turn is
why the container builds cleanly for both `amd64` and `arm64`.

## What Harbor refuses to serve

Only `image/jpeg`, `image/png`, and `image/webp` are accepted, and the
response content type is set from that list rather than echoed from upstream.

**SVG is refused deliberately.** An SVG is an active document that may contain
`<script>`. Served from Harbor's own origin it would execute as first-party
JavaScript with access to the session cookie — stored cross-site scripting
delivered through something that looks like a static file cache.

Redirects are refused rather than followed. Provider CDNs serve images
directly, so refusing redirects removes the need to revalidate every redirect
destination, and closes the one route by which a request could otherwise reach
a host Harbor did not choose.

Responses larger than 10 MB are aborted mid-stream and nothing is cached.

## The cache

Cached images live under the Harbor data directory:

```
/data/cache/images/<provider>/<size>/<file>
```

Downloads are written to a temporary file and renamed into place. Renaming is
atomic, so an interrupted download leaves either nothing or a complete file —
never a truncated image that would be cached permanently and show up as a
randomly corrupt poster surviving restarts.

### Sizing and eviction

`HARBOR_CACHE_MAX_SIZE` caps the cache in bytes. The default is 2 GB.

A sweep runs every 15 minutes. When the cache exceeds the cap it deletes the
oldest files, by write time, until usage falls to 90% of the cap. Sweeping
below the cap rather than exactly to it stops the next cached image triggering
another sweep immediately.

The sweep never runs during a request: totalling the cache directory on the
request path would make image serving slower the more images you have cached.

Eviction is oldest-first rather than least-recently-used. Tracking reads would
require either file access times, which are unreliable because most systems
mount with `noatime` or `relatime`, or a database write on the hottest path in
a poster grid. A popular image that gets evicted costs one refetch.

### When the disk is full or read-only

Image serving degrades to a pass-through: Harbor fetches and streams the image
without caching it. Artwork keeps working, slower. The condition is logged
once per process rather than once per image, so it is visible without burying
the rest of the log.

## Configuration

`HARBOR_CACHE_MAX_SIZE` — maximum image cache size in bytes. Default
`2147483648` (2 GB).

`HARBOR_TMDB_IMAGE_BASE_URL` — overrides the image CDN base URL. Default
`https://image.tmdb.org/t/p`. Leave it unset unless you reach TMDB through a
mirror or an egress proxy.

> This is a **different** variable from `HARBOR_TMDB_BASE_URL`, which points at
> the metadata API. They are separate hosts: metadata comes from
> `api.themoviedb.org`, images from `image.tmdb.org`. Setting one to the
> other's value silently breaks whichever it was not meant for.

Both are environment variables rather than UI settings because they are
operator-controlled infrastructure, like `DATABASE_URL`. No Harbor user can
influence them, so they add no request-forgery surface.

## Failure behavior

| Condition | Result |
| --- | --- |
| Cached | Served from disk, no outbound request |
| Not cached, upstream healthy | Fetched, stored atomically, served |
| Missing upstream | `404`, remembered for an hour so it is not re-requested on every render |
| Upstream unreachable | `503`, retryable |
| Disallowed content type | `502`, nothing cached |
| Larger than 10 MB | Aborted, nothing cached, `502` |

Harbor returns an error status rather than a placeholder image. A placeholder
served as a `200` would be cached by the browser as though it were the real
poster, so one transient provider blip would pin a grey box in users' caches
until it expired. The web interface draws its own placeholder instead, which
also keeps the layout stable while images load.
