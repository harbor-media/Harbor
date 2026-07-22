import type { TitleDetailResponse } from "@harbor/shared";
import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { imageUrl } from "../images";
import { metaLine } from "../titles";

const POSTER_WIDTH = 160;
const POSTER_HEIGHT = 240;

/**
 * Cinematic hero: backdrop fading into the canvas with the poster overlapping
 * its lower edge.
 *
 * The chrome is achromatic by design, so artwork supplies the only colour on
 * the page. That makes the backdrop fallback load-bearing rather than
 * cosmetic: providers leave backdropPath empty for a great many titles, so a
 * missing backdrop is the common case, not a rare one. Falling back to the
 * poster — blurred and darkened — keeps the page feeling like a title page
 * instead of collapsing it to a flat bar.
 */
export function TitleHero({ detail }: { detail: TitleDetailResponse }): JSX.Element {
  const backdrop = imageUrl(detail.backdropPath, "w780");
  const posterFallback = imageUrl(detail.posterPath, "w780");
  const poster = imageUrl(detail.posterPath, "w342");

  const runtime = detail.runtime === null ? null : `${String(detail.runtime)} min`;
  const meta = metaLine([detail.year, runtime, detail.type === "movie" ? "Film" : "Series"]);

  return (
    <section className="relative">
      <div className="absolute inset-x-0 top-0 h-[320px] overflow-hidden">
        {backdrop === null && posterFallback === null ? null : (
          <img
            src={backdrop ?? posterFallback ?? ""}
            alt=""
            aria-hidden="true"
            className={
              backdrop === null
                ? "h-full w-full scale-110 object-cover opacity-40 blur-2xl"
                : "h-full w-full object-cover opacity-60"
            }
          />
        )}
        {/* Fades the artwork into the canvas rather than ending it on a hard
            edge, which is what makes the hero read as one surface. */}
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/70 to-background/20" />
      </div>

      <div className="relative flex flex-col gap-6 pt-[180px] sm:flex-row sm:items-end">
        {poster === null ? (
          <div
            aria-hidden="true"
            className="shrink-0 rounded-xl border border-border bg-secondary"
            style={{ width: POSTER_WIDTH, height: POSTER_HEIGHT }}
          />
        ) : (
          <img
            src={poster}
            alt={`Poster for ${detail.title}`}
            width={POSTER_WIDTH}
            height={POSTER_HEIGHT}
            className="shrink-0 rounded-xl border border-border object-cover"
            style={{ width: POSTER_WIDTH, height: POSTER_HEIGHT }}
          />
        )}

        <div className="min-w-0 pb-1">
          <h1 className="font-display text-3xl leading-tight">{detail.title}</h1>
          {detail.originalTitle !== null && detail.originalTitle !== detail.title ? (
            <p className="mt-1 text-sm text-muted-foreground">{detail.originalTitle}</p>
          ) : null}

          <p className="mt-2 font-mono text-xs tracking-widest text-muted-foreground uppercase">
            {meta}
          </p>

          {detail.genres.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {detail.genres.map((genre) => (
                <Badge key={genre} variant="secondary">
                  {genre}
                </Badge>
              ))}
            </div>
          ) : null}

          <div className="mt-5 flex gap-2">
            {/* Visibly inert rather than dead handlers: playback arrives in
                Phase 5 and the library in Phase 4. A button that silently does
                nothing reads as a bug; a disabled one with a reason reads as
                a roadmap. */}
            <Button disabled title="Playback arrives in a later phase">
              Play
            </Button>
            <Button variant="secondary" disabled title="The library arrives in a later phase">
              Watchlist
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Reserves the hero's exact height so the page does not jump when artwork
 *  and metadata arrive. */
export function TitleHeroSkeleton(): JSX.Element {
  return (
    <section className="relative" aria-hidden="true">
      <div className="absolute inset-x-0 top-0 h-[320px] bg-secondary/40" />
      <div className="relative flex flex-col gap-6 pt-[180px] sm:flex-row sm:items-end">
        <div
          className="shrink-0 rounded-xl bg-secondary"
          style={{ width: POSTER_WIDTH, height: POSTER_HEIGHT }}
        />
        <div className="w-full max-w-sm pb-1">
          <div className="h-8 w-2/3 rounded bg-secondary" />
          <div className="mt-3 h-3 w-1/3 rounded bg-secondary" />
          <div className="mt-4 h-8 w-40 rounded bg-secondary" />
        </div>
      </div>
    </section>
  );
}
