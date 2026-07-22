import { type FormEvent, type JSX, useState } from "react";
import { Link } from "react-router";
import { imageUrl } from "../images";
import { ApiError, describeMetadataError, useSearch } from "../metadata";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
        className="h-[105px] w-[70px] shrink-0 rounded bg-secondary"
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
    <main className="min-h-screen bg-background p-8">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="font-display text-2xl text-foreground">Search</h1>

        <form className="mt-6" onSubmit={onSubmit}>
          <Label htmlFor="query">Title</Label>
          <div className="mt-1 flex gap-2">
            <Input
              id="query"
              className="flex-1"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Blade Runner"
            />
            <Button type="submit" isDisabled={draft.trim() === "" || results.isFetching}>
              {results.isFetching ? "Searching…" : "Search"}
            </Button>
          </div>
        </form>

        {results.isError ? (
          <Alert variant="destructive" aria-live="assertive" className="mt-6">
            <AlertDescription>
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
            </AlertDescription>
          </Alert>
        ) : null}

        {results.data ? (
          <section className="mt-6">
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {results.data.results.length} result
              {results.data.results.length === 1 ? "" : "s"} ·{" "}
              {results.data.cached ? "served from cache" : "fetched from TMDB"}
            </p>

            {results.data.results.length === 0 ? (
              <p className="mt-4 text-sm text-foreground">Nothing matched that search.</p>
            ) : null}

            <ul className="mt-4">
              {results.data.results.map((item) => (
                <li key={item.id} className="mt-2">
                  {/* The whole row is the target: a small text-only link is a
                      poor hit area, and the poster is what people aim at. */}
                  <Link
                    to={`/${item.type === "movie" ? "movie" : "series"}/${item.id}`}
                    className="flex gap-3 rounded-xl bg-card p-3 transition-colors hover:bg-secondary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <Poster path={item.posterPath} title={item.title} />
                    <div className="min-w-0">
                      <p className="text-sm text-foreground">
                        {item.title}
                        {item.year === null ? "" : ` (${String(item.year)})`} · {item.type}
                      </p>
                      {item.overview === null ? null : (
                        <p className="mt-1 text-xs text-muted-foreground">{item.overview}</p>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="mt-8 text-xs text-muted-foreground">{TMDB_ATTRIBUTION}</p>
      </div>
    </main>
  );
}
