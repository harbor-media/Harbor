import type { JSX } from "react";
import { Link, useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ApiError, describeMetadataError } from "../metadata";
import { EpisodeList } from "../components/EpisodeList";
import { SeasonSelector } from "../components/SeasonSelector";
import { TitleBackdrop, TitleInfo, TitleInfoSkeleton } from "../components/TitleHero";
import { useSeasonDetail, useTitleDetail } from "../titles";

const TMDB_ATTRIBUTION =
  "This product uses the TMDB API but is not endorsed or certified by TMDB.";

/**
 * Serves /movie/:id, /series/:id, and /series/:id/season/:season.
 *
 * One component rather than three pages: the routes differ only in whether a
 * season is named, and splitting them would duplicate the artwork, the
 * loading state, and the error handling three ways.
 */
export function Title(): JSX.Element {
  const params = useParams();
  const id = params["id"];
  const seasonParam = params["season"];

  const detail = useTitleDetail(id);

  // The season list arrives with the title, so the active season cannot be
  // resolved until then. Falling back to the first entry rather than
  // hardcoding 1 matters because the accessor sorts specials last -- the
  // first entry is the first real season, whatever it is numbered.
  const seasons = detail.data?.seasons ?? [];
  const requested = seasonParam === undefined ? null : Number(seasonParam);
  const active =
    requested !== null && Number.isFinite(requested)
      ? requested
      : (seasons[0]?.seasonNumber ?? null);

  const isSeries = detail.data?.type === "series";
  const season = useSeasonDetail(id, isSeries ? active : null);

  const notConfigured =
    detail.error instanceof ApiError && detail.error.code === "METADATA_NOT_CONFIGURED";

  return (
    <main className="relative min-h-screen p-8">
      {detail.data ? <TitleBackdrop detail={detail.data} /> : null}

      <div className="mx-auto w-full max-w-6xl">
        {detail.isError ? (
          <Alert variant="destructive" aria-live="assertive">
            <AlertDescription>
              {describeMetadataError(detail.error)}
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

        {/* Information left, episodes right -- the episode panel is a fixed
            column on wide screens and stacks beneath on narrow ones, so a
            phone reads title first and episodes after. */}
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div>
            {detail.isPending ? <TitleInfoSkeleton /> : null}
            {detail.data ? <TitleInfo detail={detail.data} /> : null}
          </div>

          {detail.data && isSeries && seasons.length > 0 ? (
            <aside className="self-start rounded-xl border border-border bg-card/80 backdrop-blur">
              <SeasonSelector titleId={detail.data.id} seasons={seasons} active={active} />

              {season.isError ? (
                <Alert variant="destructive" aria-live="assertive" className="m-3">
                  <AlertDescription>{describeMetadataError(season.error)}</AlertDescription>
                </Alert>
              ) : null}

              {season.isPending && active !== null ? (
                <p className="p-3 text-sm text-muted-foreground" role="status">
                  Loading episodes…
                </p>
              ) : null}

              {season.data ? <EpisodeList episodes={season.data.episodes} /> : null}
            </aside>
          ) : null}
        </div>

        <p className="mt-12 text-xs opacity-70">{TMDB_ATTRIBUTION}</p>
      </div>
    </main>
  );
}
