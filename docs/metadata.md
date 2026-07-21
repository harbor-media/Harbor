# Metadata

Harbor uses an external metadata provider to describe movies and series. The
catalog is metadata-driven, so until a provider is configured Harbor cannot
search for titles.

The first supported provider is [TMDB](https://www.themoviedb.org/).

> This product uses the TMDB API but is not endorsed or certified by TMDB.

## Getting a TMDB API key

1. Create a free account at <https://www.themoviedb.org/signup>.
2. Open **Settings → API** and request an API key. Personal, non-commercial
   use is normally approved immediately.
3. Copy the **API Read Access Token** — the long token, not the short v3 API
   key. Harbor sends it as a bearer token.

## Configuring Harbor

Sign in as an owner or administrator and open **`/admin/metadata`**.

Paste the token, choose a metadata language such as `en-US`, and use **Test
connection** to confirm TMDB accepts it before saving. Saving also validates:
Harbor refuses to store a key that does not work, so a broken key cannot sit
in the database looking configured.

Configuration is deliberately not part of first-run setup. A metadata
provider is an optional, changeable setting, and requiring one at install
time would mean a fresh installation could not finish onboarding while TMDB
was unreachable.

## How the key is stored

The key is encrypted with AES-256-GCM before it is written to the database.
The encryption key is derived from `HARBOR_SECRET` using HKDF-SHA256, so
`HARBOR_SECRET` is never used directly as a cipher key.

The plaintext key is never returned by the API, never written to logs, and
never sent to the browser. The configuration endpoint reports only whether a
key is present.

### Rotating `HARBOR_SECRET` invalidates the stored key

Because the encryption key is derived from `HARBOR_SECRET`, changing that
value makes every stored provider credential undecryptable. This is expected,
not a bug.

After rotating `HARBOR_SECRET` you must re-enter the TMDB key at
`/admin/metadata`. Harbor reports this as a decryption failure rather than
silently reporting "not configured", so the cause is visible in the logs.

Take a backup before rotating `HARBOR_SECRET`.

## Search behavior

Search is remote-first with cache-on-read:

1. A search first looks in Harbor's own cache.
2. On a miss, Harbor queries TMDB, normalizes the results into its own
   tables, and stores them.
3. Repeat searches within the cache lifetime are served from PostgreSQL with
   no outbound request.

Search results are cached for **one hour**. Titles themselves are kept and
refreshed whenever they are fetched again.

Queries are normalized for casing and surrounding whitespace, so `Blade
Runner` and `  blade runner  ` share one cache entry.

## When TMDB is unavailable

| Situation | What happens |
| --- | --- |
| TMDB unreachable, results cached | The cached results are served, even if past their normal one-hour lifetime. Stale data beats no data during an outage. |
| TMDB unreachable, nothing cached | The search fails with `METADATA_PROVIDER_UNAVAILABLE`, marked retryable. |
| TMDB rejects the key | The search fails with `METADATA_PROVIDER_UNAUTHORIZED`. An administrator must update the key. Stale results are **not** served here — that would hide a broken credential. |
| No provider configured | `METADATA_NOT_CONFIGURED`, pointing at `/admin/metadata`. This is not an error state; a new installation simply has not been set up yet. |
| Stored key will not decrypt | `METADATA_KEY_UNREADABLE`, naming `HARBOR_SECRET` as the cause. Distinct from "not configured" on purpose: the credential is still there, it just cannot be read, and the fix is to re-enter it. |

A metadata outage never affects Harbor's readiness check. The server does not
report itself unhealthy because a third party is down, since that would make
an orchestrator restart a working container.

## Optional: pointing Harbor at a TMDB mirror

`HARBOR_TMDB_BASE_URL` overrides the TMDB API endpoint. Leave it unset unless
you reach TMDB through a mirror or an egress proxy.

```
HARBOR_TMDB_BASE_URL=https://tmdb-proxy.internal/3
```

This is an environment variable rather than a UI setting on purpose. Like
`DATABASE_URL`, it is infrastructure the server owner controls; no Harbor
user can influence it, so it carries no request-forgery exposure. Harbor's
end-to-end suite uses it to point at a local fixture so tests never call the
real TMDB.

## Rate limits

The search endpoint is limited to 60 requests per minute per client, and the
configuration and test endpoints to 10 per minute. The web interface searches
on submit rather than on each keystroke for the same reason.
