import type { TitleDetailResponse } from "@harbor/shared";
import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { imageUrl } from "../images";
import { metaLine } from "../titles";

const POSTER_WIDTH = 150;
const POSTER_HEIGHT = 225;

/**
 * Full-bleed artwork behind the whole page.
 *
 * The chrome is achromatic by design, so artwork supplies the only colour on
 * screen — which makes the fallback load-bearing rather than cosmetic.
 * Providers leave backdropPath empty for a great many titles, so a missing
 * backdrop is the common case: falling back to the poster, blurred and
 * darkened, keeps the page feeling like a title page instead of collapsing
 * it to a flat panel.
 */
export function TitleBackdrop({ detail }: { detail: TitleDetailResponse }): JSX.Element | null {
  const backdrop = imageUrl(detail.backdropPath, "w780");
  const fallback = imageUrl(detail.posterPath, "w780");
  const src = backdrop ?? fallback;

  if (src === null) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <img
        src={src}
        alt=""
        className={
          backdrop === null
            ? "h-full w-full scale-110 object-cover blur-2xl"
            : "h-full w-full object-cover"
        }
      />
      {/* Two layers: a flat wash for overall legibility, and a left-weighted
          gradient so the information column stays readable over a busy
          image. Text over raw artwork is unreadable at some frames. */}
      <div className="absolute inset-0 bg-background/70" />
      <div className="absolute inset-0 bg-gradient-to-r from-background via-background/80 to-background/40" />
    </div>
  );
}

/** The information column: poster, title, metadata, genres, summary, actions. */
export function TitleInfo({ detail }: { detail: TitleDetailResponse }): JSX.Element {
  const poster = imageUrl(detail.posterPath, "w342");
  const runtime = detail.runtime === null ? null : `${String(detail.runtime)} min`;
  const meta = metaLine([runtime, detail.year, detail.type === "movie" ? "Film" : "Series"]);

  return (
    <div>
      <div className="flex gap-5">
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

        <div className="min-w-0">
          <h1 className="font-display text-4xl leading-tight">{detail.title}</h1>
          {detail.originalTitle !== null && detail.originalTitle !== detail.title ? (
            <p className="mt-1 text-sm text-muted-foreground">{detail.originalTitle}</p>
          ) : null}
          <p className="mt-3 font-mono text-xs tracking-widest text-muted-foreground uppercase">
            {meta}
          </p>
        </div>
      </div>

      {detail.genres.length > 0 ? (
        <div className="mt-8">
          <h2 className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            Genres
          </h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {detail.genres.map((genre) => (
              <Badge key={genre} variant="secondary">
                {genre}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {detail.overview === null ? null : (
        <div className="mt-8">
          <h2 className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            Summary
          </h2>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">{detail.overview}</p>
        </div>
      )}

      <div className="mt-8 flex gap-2">
        {/* Visibly inert rather than dead handlers: playback arrives in Phase
            5 and the library in Phase 4. A button that silently does nothing
            reads as a bug; a disabled one with a reason reads as a roadmap. */}
        <Button disabled title="Playback arrives in a later phase">
          Play
        </Button>
        <Button variant="secondary" disabled title="The library arrives in a later phase">
          Watchlist
        </Button>
      </div>
    </div>
  );
}

/** Reserves the information column's shape so the page does not jump when
 *  artwork and metadata arrive. */
export function TitleInfoSkeleton(): JSX.Element {
  return (
    <div aria-hidden="true">
      <div className="flex gap-5">
        <div
          className="shrink-0 rounded-xl bg-secondary"
          style={{ width: POSTER_WIDTH, height: POSTER_HEIGHT }}
        />
        <div className="w-full max-w-sm">
          <div className="h-10 w-2/3 rounded bg-secondary" />
          <div className="mt-3 h-3 w-1/3 rounded bg-secondary" />
        </div>
      </div>
      <div className="mt-8 h-3 w-24 rounded bg-secondary" />
      <div className="mt-3 h-16 w-full max-w-prose rounded bg-secondary" />
    </div>
  );
}
