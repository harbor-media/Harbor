import type { TitleDetailResponse } from "@harbor/shared";
import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { imageUrl } from "../images";
import { metaLine } from "../titles";

/**
 * Full-bleed artwork behind the whole page.
 *
 * The chrome is achromatic by design, so artwork supplies the only colour on
 * screen — which makes the fallback load-bearing rather than cosmetic.
 * Providers leave backdropPath empty for a great many titles, so a missing
 * backdrop is the common case: falling back to the poster, blurred and
 * darkened, keeps the page feeling like a title page instead of collapsing
 * to a flat panel.
 */
export function TitleBackdrop({ detail }: { detail: TitleDetailResponse }): JSX.Element | null {
  const backdrop = imageUrl(detail.backdropPath, "w780");
  const fallback = imageUrl(detail.posterPath, "w780");
  const src = backdrop ?? fallback;

  if (src === null) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[70vh] overflow-hidden">
      <img
        src={src}
        alt=""
        className={
          backdrop === null
            ? "h-full w-full scale-110 object-cover blur-2xl"
            : "h-full w-full object-cover"
        }
      />
      {/* Heavy wash plus a fade to the canvas. Title and controls sit on top
          of the artwork, and text over a raw frame is unreadable on some
          images -- the darkening is what makes the layout survive whatever
          the provider happens to return. */}
      <div className="absolute inset-0 bg-background/80" />
      <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-transparent to-background" />
    </div>
  );
}

/** Centred title block: name, season, actions, then the summary beneath. */
export function TitleHeader({
  detail,
  seasonLabel,
}: {
  detail: TitleDetailResponse;
  seasonLabel: string | null;
}): JSX.Element {
  const runtime = detail.runtime === null ? null : `${String(detail.runtime)} min`;
  const meta = metaLine([detail.year, runtime, detail.type === "movie" ? "Film" : "Series"]);

  return (
    <div>
      <div className="flex flex-col items-center pt-16 text-center">
        <h1 className="font-display text-5xl leading-tight tracking-tight sm:text-6xl">
          {detail.title}
        </h1>

        {detail.originalTitle !== null && detail.originalTitle !== detail.title ? (
          <p className="mt-2 text-sm text-muted-foreground">{detail.originalTitle}</p>
        ) : null}

        {seasonLabel === null ? null : (
          <p className="mt-3 font-display text-2xl text-muted-foreground">{seasonLabel}</p>
        )}

        <p className="mt-3 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          {meta}
        </p>

        <div className="mt-8 flex items-center gap-3">
          {/* Visibly inert rather than dead handlers: playback arrives in
              Phase 5 and the library in Phase 4. A button that silently does
              nothing reads as a bug; a disabled one with a reason reads as a
              roadmap. */}
          {/* The explanation sits on a wrapping span: React Aria buttons do
              not forward a title attribute, and a disabled control gives no
              hint on its own about why. */}
          <span title="Playback arrives in a later phase">
            <Button size="lg" className="rounded-full px-8" isDisabled>
              ▶ Play
            </Button>
          </span>
          <span title="The library arrives in a later phase">
            <Button variant="secondary" size="lg" className="rounded-full" isDisabled>
              Watchlist
            </Button>
          </span>
        </div>
      </div>

      {detail.overview === null ? null : (
        <p className="mt-14 max-w-4xl text-sm text-muted-foreground">{detail.overview}</p>
      )}

      {detail.genres.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {detail.genres.map((genre) => (
            <Badge key={genre} variant="secondary">
              {genre}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Reserves the header's shape so the page does not jump when data arrives. */
export function TitleHeaderSkeleton(): JSX.Element {
  return (
    <div aria-hidden="true" className="flex flex-col items-center pt-16">
      <Skeleton className="h-14 w-2/3 max-w-xl" />
      <Skeleton className="mt-4 h-4 w-40" />
      <Skeleton className="mt-8 h-11 w-64 rounded-full" />
      <Skeleton className="mt-14 h-16 w-full max-w-4xl" />
    </div>
  );
}
