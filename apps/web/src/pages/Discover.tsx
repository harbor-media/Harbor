import type { DiscoverType, TitleCard } from "@harbor/shared";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDiscover, useGenres } from "../discover";
import { PosterCard } from "../components/PosterCard";
import { ApiError } from "../metadata";

const TYPES: { value: DiscoverType; label: string }[] = [
  { value: "movie", label: "Movies" },
  { value: "series", label: "Series" },
];

function parseType(raw: string | null): DiscoverType {
  return raw === "series" ? "series" : "movie";
}

export function Discover(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const type = parseType(params.get("type"));
  const genre = params.get("genre");

  const genres = useGenres(type);

  // Default the genre to the first in the list once it arrives and none is set.
  useEffect(() => {
    if (genre === null && genres.data && genres.data.genres.length > 0) {
      const next = new URLSearchParams(params);
      next.set("genre", genres.data.genres[0]!.id);
      setParams(next, { replace: true });
    }
  }, [genre, genres.data, params, setParams]);

  // Accumulated pages for the current (type, genre). Reset whenever either
  // changes, so switching genre does not show the previous genre's tail.
  const [maxPage, setMaxPage] = useState(1);
  useEffect(() => {
    setMaxPage(1);
  }, [type, genre]);

  const notConfigured =
    genres.error instanceof ApiError && genres.error.code === "METADATA_NOT_CONFIGURED";
  const unsupported =
    genres.error instanceof ApiError && genres.error.code === "DISCOVER_UNSUPPORTED";

  if (notConfigured || unsupported) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <Alert>
          <AlertDescription>
            {notConfigured ? (
              <>
                Harbor has no metadata provider yet.{" "}
                <Link className="underline" to="/admin/metadata">
                  Configure a metadata provider
                </Link>
                .
              </>
            ) : (
              "The configured provider does not support browsing by genre."
            )}
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  function onType(next: DiscoverType): void {
    const p = new URLSearchParams(params);
    p.set("type", next);
    p.delete("genre"); // genres differ per type; let the effect pick the first
    setParams(p);
  }

  function onGenre(id: string): void {
    const p = new URLSearchParams(params);
    p.set("genre", id);
    setParams(p);
  }

  return (
    <main className="mx-auto max-w-[1600px] px-6 py-8">
      <h1 className="font-display text-2xl">Discover</h1>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <div className="flex gap-1 rounded-full bg-card p-1" role="group" aria-label="Type">
          {TYPES.map((t) => (
            <Button
              key={t.value}
              size="sm"
              variant={t.value === type ? "secondary" : "ghost"}
              aria-pressed={t.value === type}
              onPress={() => {
                onType(t.value);
              }}
            >
              {t.label}
            </Button>
          ))}
        </div>

        <Select
          aria-label="Genre"
          selectedKey={genre}
          onSelectionChange={(key) => {
            onGenre(String(key));
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectPopover>
            <SelectList className="max-h-80">
              {(genres.data?.genres ?? []).map((g) => (
                <SelectItem key={g.id} id={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectList>
          </SelectPopover>
        </Select>
      </div>

      <DiscoverGrid
        type={type}
        genre={genre}
        maxPage={maxPage}
        onLoadMore={() => {
          setMaxPage((p) => p + 1);
        }}
      />
    </main>
  );
}

/** Renders pages 1..maxPage of a genre, concatenated. Each page is its own
 *  query, so React Query caches them independently and Load more only fetches
 *  the new page. */
function DiscoverGrid({
  type,
  genre,
  maxPage,
  onLoadMore,
}: {
  type: DiscoverType;
  genre: string | null;
  maxPage: number;
  onLoadMore: () => void;
}): JSX.Element {
  const pages = Array.from({ length: maxPage }, (_, i) => i + 1);
  return (
    <div className="mt-8">
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {pages.map((page) => (
          <DiscoverPage
            key={page}
            type={type}
            genre={genre}
            page={page}
            last={page === maxPage}
            onLoadMore={onLoadMore}
          />
        ))}
      </ul>
    </div>
  );
}

function DiscoverPage({
  type,
  genre,
  page,
  last,
  onLoadMore,
}: {
  type: DiscoverType;
  genre: string | null;
  page: number;
  last: boolean;
  onLoadMore: () => void;
}): JSX.Element {
  const q = useDiscover(type, genre, page);

  return (
    <>
      {(q.data?.titles ?? []).map((item: TitleCard) => (
        <PosterCard key={item.id} item={item} />
      ))}
      {/* The Load more button belongs to the last rendered page, shown only if
          the provider reports more pages remain. A full-row cell so it centres
          under the grid. */}
      {last && q.data && q.data.page < q.data.totalPages ? (
        <li className="col-span-full mt-4 flex justify-center">
          <Button variant="secondary" onPress={onLoadMore}>
            Load more
          </Button>
        </li>
      ) : null}
      {last && q.data && q.data.titles.length === 0 && page === 1 ? (
        <li className="col-span-full text-sm text-muted-foreground">Nothing in this genre yet.</li>
      ) : null}
    </>
  );
}
