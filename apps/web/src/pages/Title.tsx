import type { JSX } from "react";
import { Link, useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ApiError, describeMetadataError } from "../metadata";
import { EpisodeList } from "../components/EpisodeList";
import { SeasonSelector } from "../components/SeasonSelector";
import { TitleDetails } from "../components/TitleDetails";
import { TitleHero, TitleHeroSkeleton } from "../components/TitleHero";
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

  const activeSeason = seasons.find((s) => s.seasonNumber === active);
  const seasonLabel = isSeries
    ? (activeSeason?.name ?? (active === null ? null : `Season ${String(active)}`))
    : null;

  const notConfigured =
    detail.error instanceof ApiError && detail.error.code === "METADATA_NOT_CONFIGURED";

  return (
    <main className="relative pb-16">
      {detail.isError ? (
        <div className="mx-auto w-full max-w-7xl px-8 pt-8">
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
        </div>
      ) : null}

      {detail.isPending ? <TitleHeroSkeleton /> : null}
      {detail.data ? <TitleHero detail={detail.data} seasonLabel={seasonLabel} /> : null}

      <div className="mx-auto w-full max-w-7xl px-8">
        {detail.data ? <TitleDetails detail={detail.data} /> : null}

        {detail.data && isSeries && seasons.length > 0 ? (
          <section className="mt-12">
            <SeasonSelector titleId={detail.data.id} seasons={seasons} active={active} />

            <div className="mt-6">
              {season.isError ? (
                <Alert variant="destructive" aria-live="assertive">
                  <AlertDescription>{describeMetadataError(season.error)}</AlertDescription>
                </Alert>
              ) : null}

              {season.isPending && active !== null ? (
                <p className="text-sm text-muted-foreground" role="status">
                  Loading episodes…
                </p>
              ) : null}

              {season.data ? <EpisodeList episodes={season.data.episodes} /> : null}
            </div>
          </section>
        ) : null}

        <p className="mt-16 text-xs opacity-70">{TMDB_ATTRIBUTION}</p>
      </div>
    </main>
  );
}
