import { type FormEvent, type JSX, useState } from "react";
import { Link } from "react-router";
import { imageUrl } from "../images";
import { ApiError, describeMetadataError, useSearch } from "../metadata";

const TMDB_ATTRIBUTION =
  "This product uses the TMDB API but is not endorsed or certified by TMDB.";

/**
 * The box is always the same size whether or not an image loads, so results
 * never reflow as posters arrive.
 *
 * The placeholder lives here rather than on the server on purpose: a
 * placeholder served as a 200 image would be cached by the browser as though
 * it were the real poster, so one transient provider blip would pin a grey box
 * until the cache expired. The server returns an error status, and this
 * decides what to draw.
 */
function Poster({ path, title }: { path: string | null; title: string }): JSX.Element {
  const src = imageUrl(path);
  const [failed, setFailed] = useState(false);

  if (src === null || failed) {
    return (
      <div
        aria-hidden="true"
        className="h-[105px] w-[70px] shrink-0 rounded bg-harbor-800"
      />
    );
  }

  return (
    <img
      src={src}
      alt={`Poster for ${title}`}
      loading="lazy"
      width={70}
      height={105}
      className="h-[105px] w-[70px] shrink-0 rounded object-cover"
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

/**
 * Deliberately plain scaffolding. Its job is to prove the metadata pipeline
 * end to end — provider fetch, normalization, storage, cache hit — and it is
 * replaced by the real catalog in a later phase. Poster art, rows, and
 * hover states are catalog design decisions that have not been made yet, so
 * nothing here should be treated as a starting point for them.
 */
export function Search(): JSX.Element {
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState("");
  const results = useSearch(submitted);

  // Submit-only, never search-as-you-type: the endpoint is rate limited and
  // every cache miss costs an upstream provider call.
  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    setSubmitted(draft);
  }

  const notConfigured =
    results.error instanceof ApiError && results.error.code === "METADATA_NOT_CONFIGURED";

  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="font-display text-2xl text-accent-500">Search</h1>

        <form className="mt-6" onSubmit={onSubmit}>
          <label className="block text-sm" htmlFor="query">
            Title
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="query"
              className="flex-1 rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Blade Runner"
            />
            <button
              type="submit"
              className="rounded bg-accent-500 px-4 font-medium disabled:opacity-50"
              disabled={draft.trim() === "" || results.isFetching}
            >
              {results.isFetching ? "Searching…" : "Search"}
            </button>
          </div>
        </form>

        {results.isError ? (
          <p role="alert" aria-live="assertive" className="mt-6 text-sm text-red-400">
            {describeMetadataError(results.error)}
            {notConfigured ? (
              <>
                {" "}
                <Link className="underline" to="/admin/metadata">
                  Configure a metadata provider
                </Link>
                .
              </>
            ) : null}
          </p>
        ) : null}

        {results.data ? (
          <section className="mt-6">
            <p role="status" aria-live="polite" className="text-sm opacity-80">
              {results.data.results.length} result
              {results.data.results.length === 1 ? "" : "s"} ·{" "}
              {results.data.cached ? "served from cache" : "fetched from TMDB"}
            </p>

            {results.data.results.length === 0 ? (
              <p className="mt-4 text-sm">Nothing matched that search.</p>
            ) : null}

            <ul className="mt-4">
              {results.data.results.map((item) => (
                <li key={item.id} className="mt-2 flex gap-3 rounded bg-harbor-950 p-3">
                  <Poster path={item.posterPath} title={item.title} />
                  <div className="min-w-0">
                    <p className="text-sm">
                      {item.title}
                      {item.year === null ? "" : ` (${String(item.year)})`} · {item.type}
                    </p>
                    {item.overview === null ? null : (
                      <p className="mt-1 text-xs opacity-70">{item.overview}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="mt-8 text-xs opacity-70">{TMDB_ATTRIBUTION}</p>
      </div>
    </main>
  );
}
