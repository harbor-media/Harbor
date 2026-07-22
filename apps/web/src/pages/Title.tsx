import type { JSX } from "react";
import { Link, useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ApiError, describeMetadataError } from "../metadata";
import { EpisodeList } from "../components/EpisodeList";
import { SeasonTabs } from "../components/SeasonTabs";
import { TitleHero, TitleHeroSkeleton } from "../components/TitleHero";
import { useSeasonDetail, useTitleDetail } from "../titles";

const TMDB_ATTRIBUTION =
  "This product uses the TMDB API but is not endorsed or certified by TMDB.";

/**
 * Serves /movie/:id, /series/:id, and /series/:id/season/:season.
 *
 * One component rather than three pages: the routes differ only in whether a
 * season is named, and splitting them would duplicate the hero, the loading
 * state, and the error handling three ways.
 */
export function Title(): JSX.Element {
  const params = useParams();
  const id = params["id"];
  const seasonParam = params["season"];

  const detail = useTitleDetail(id);

  // The season list arrives with the title, so the active season cannot be
  // resolved until then. Falling back to the first season rather than
  // hardcoding 1 matters for shows whose first entry is a specials season.
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
    <main className="min-h-screen p-8">
      <div className="mx-auto w-full max-w-3xl">
        {detail.isPending ? <TitleHeroSkeleton /> : null}

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

        {detail.data ? (
          <>
            <TitleHero detail={detail.data} />

            {detail.data.overview === null ? null : (
              <p className="mt-8 text-sm text-muted-foreground">{detail.data.overview}</p>
            )}

            {isSeries && seasons.length > 0 ? (
              <section className="mt-10">
                <SeasonTabs titleId={detail.data.id} seasons={seasons} active={active} />

                {season.isError ? (
                  <Alert variant="destructive" aria-live="assertive" className="mt-4">
                    <AlertDescription>{describeMetadataError(season.error)}</AlertDescription>
                  </Alert>
                ) : null}

                {season.isPending && active !== null ? (
                  <p className="mt-4 text-sm text-muted-foreground" role="status">
                    Loading episodes…
                  </p>
                ) : null}

                {season.data ? <EpisodeList episodes={season.data.episodes} /> : null}
              </section>
            ) : null}
          </>
        ) : null}

        <p className="mt-12 text-xs opacity-70">{TMDB_ATTRIBUTION}</p>
      </div>
    </main>
  );
}
