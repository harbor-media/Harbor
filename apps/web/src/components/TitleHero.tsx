import type { TitleDetailResponse } from "@harbor/shared";
import type { JSX } from "react";
import { PlayIcon } from "lucide-react";
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
      {/* A wash for legibility -- the centred title and controls sit over the
          artwork, and text over a raw frame is unreadable on some images --
          plus a fade to the canvas at the bottom. Kept lighter than a full
          blackout so the backdrop actually reads as artwork rather than a dark
          tint, matching the home hero. */}
      <div className="absolute inset-0 bg-background/45" />
      <div className="absolute inset-0 bg-gradient-to-b from-background/50 via-background/10 to-background" />
    </div>
  );
}

/** One clamped height for the hero, so it sits low on the backdrop and the
 *  page does not jump as the artwork loads -- the same measure the home hero
 *  uses. */
const HERO_HEIGHT = "h-[clamp(26rem,64vh,40rem)]";

/**
 * Left-aligned cinematic hero: a type label, the title, meta, genres, overview,
 * and actions in one block anchored at the bottom of the backdrop. Centring the
 * title while left-aligning the overview read as two designs; this is one, and
 * it matches the home hero so a title page and the home screen feel like one
 * product.
 */
export function TitleHeader({
  detail,
  seasonLabel,
}: {
  detail: TitleDetailResponse;
  seasonLabel: string | null;
}): JSX.Element {
  const runtime = detail.runtime === null ? null : `${String(detail.runtime)} min`;
  // The type ("Film"/"Series") is now the label above the title, so the meta
  // line carries only year and runtime.
  const meta = metaLine([detail.year, runtime]);
  // The season name, on a season view, stands in for the type label.
  const label = seasonLabel ?? (detail.type === "movie" ? "Film" : "Series");

  return (
    <div className={`flex ${HERO_HEIGHT} max-w-2xl flex-col justify-end`}>
      <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">{label}</p>

      <h1 className="mt-3 font-display text-5xl leading-tight tracking-tight sm:text-6xl">
        {detail.title}
      </h1>

      {detail.originalTitle !== null && detail.originalTitle !== detail.title ? (
        <p className="mt-2 text-sm text-muted-foreground">{detail.originalTitle}</p>
      ) : null}

      {meta === "" ? null : (
        <p className="mt-3 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          {meta}
        </p>
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

      {detail.overview === null ? null : (
        <p className="mt-4 line-clamp-3 text-sm text-muted-foreground">{detail.overview}</p>
      )}

      <div className="mt-6 flex items-center gap-3">
        {/* Visibly inert rather than dead handlers: playback arrives in Phase 5
            and the library in Phase 4. A button that silently does nothing reads
            as a bug; a disabled one with a reason reads as a roadmap. The
            explanation sits on a wrapping span because React Aria buttons do not
            forward a title attribute, and the span keeps it keyboard-reachable. */}
        <span title="Playback arrives in a later phase">
          <Button size="lg" className="rounded-full px-8" isDisabled>
            {/* An icon, not a bare U+25B6: the glyph would land in the button's
                accessible name as "black right-pointing triangle, Play". */}
            <PlayIcon className="size-4" aria-hidden="true" />
            Play
          </Button>
        </span>
        <span title="The library arrives in a later phase">
          <Button variant="secondary" size="lg" className="rounded-full" isDisabled>
            Watchlist
          </Button>
        </span>
      </div>
    </div>
  );
}

/** Reserves the hero's shape so the page does not jump when data arrives. */
export function TitleHeaderSkeleton(): JSX.Element {
  return (
    <div aria-hidden="true" className={`flex ${HERO_HEIGHT} max-w-2xl flex-col justify-end`}>
      <Skeleton className="h-3 w-16" />
      <Skeleton className="mt-3 h-14 w-2/3" />
      <Skeleton className="mt-4 h-16 w-full" />
      <Skeleton className="mt-6 h-11 w-64 rounded-full" />
    </div>
  );
}
