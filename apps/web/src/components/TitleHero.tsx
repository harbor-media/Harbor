import type { TitleDetailResponse } from "@harbor/shared";
import type { JSX } from "react";
import { PlayIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { imageUrl } from "../images";
import { metaLine } from "../titles";

// The hero fills the viewport below the app-shell header (~3.5rem tall), so a
// title page opens as one cinematic frame the way Jellyfin's does.
const HERO_MIN_HEIGHT = "min-h-[calc(100dvh-3.5rem)]";

/** "117" -> "1h 57m", "48" -> "48m". Jellyfin's format reads more naturally
 *  than a raw minute count, and it is the only reformatting the meta line needs. */
function formatRuntime(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${String(mins)}m`;
  return mins === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(mins)}m`;
}

/**
 * Full-viewport backdrop behind the hero.
 *
 * The chrome is achromatic by design, so artwork supplies the only colour on
 * screen — the fallback is load-bearing, not cosmetic. Providers leave
 * backdropPath empty for many titles, so the poster (blurred and darkened) is
 * the common case, keeping the page cinematic rather than a flat panel.
 */
function Backdrop({ detail }: { detail: TitleDetailResponse }): JSX.Element {
  const backdrop = imageUrl(detail.backdropPath, "w1280");
  const poster = imageUrl(detail.posterPath, "w780");
  const src = backdrop ?? poster;

  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
      {src === null ? (
        <div className="h-full w-full bg-card" />
      ) : (
        <img
          src={src}
          alt=""
          className={
            backdrop === null
              ? "h-full w-full scale-110 object-cover object-top blur-2xl"
              : "h-full w-full object-cover object-top"
          }
        />
      )}
      {/* A gentle top-down darkening for the chrome, and a strong bottom fade so
          the centred title, meta, actions and the bottom-left overview all stay
          legible over whatever the provider returned — kept off a full blackout
          so the artwork still reads as artwork. */}
      <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-transparent to-background" />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-background/20 to-transparent" />
    </div>
  );
}

/**
 * A Jellyfin-style hero: a full-viewport backdrop with the title, meta and
 * actions centred in the lower middle, and the overview and genres pinned
 * bottom-left. Title logo art, tagline and rating are a later data-layer
 * addition; for now the title is styled text.
 */
export function TitleHero({
  detail,
  seasonLabel,
}: {
  detail: TitleDetailResponse;
  seasonLabel: string | null;
}): JSX.Element {
  const rating = detail.rating === null ? null : `★ ${detail.rating.toFixed(1)}`;
  const meta = metaLine([detail.year, formatRuntime(detail.runtime), rating]);

  return (
    <section className={`relative flex ${HERO_MIN_HEIGHT} flex-col overflow-hidden`}>
      <Backdrop detail={detail} />

      {/* Centred column, pushed to the lower middle. */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-end px-8 pb-6 text-center">
        {seasonLabel === null ? null : (
          <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            {seasonLabel}
          </p>
        )}

        <h1 className="mt-3 font-display text-5xl leading-tight tracking-tight sm:text-6xl">
          {detail.logoPath === null ? (
            detail.title
          ) : (
            <img
              src={imageUrl(detail.logoPath, "w500") ?? undefined}
              alt={detail.title}
              className="mx-auto max-h-32 w-auto max-w-full object-contain"
            />
          )}
        </h1>

        {detail.originalTitle !== null && detail.originalTitle !== detail.title ? (
          <p className="mt-2 text-sm text-muted-foreground">{detail.originalTitle}</p>
        ) : null}

        {meta === "" ? null : (
          <p className="mt-3 font-mono text-xs tracking-widest text-muted-foreground uppercase">
            {meta}
          </p>
        )}

        <div className="mt-6 flex items-center gap-3">
          {/* Visibly inert rather than dead handlers: playback arrives in Phase
              5 and the library in Phase 4. A button that silently does nothing
              reads as a bug; a disabled one with a reason reads as a roadmap.
              The explanation sits on a wrapping span because React Aria buttons
              do not forward a title attribute, and the span keeps it
              keyboard-reachable. */}
          <span title="Playback arrives in a later phase">
            <Button size="lg" className="rounded-full px-8" isDisabled>
              {/* An icon, not a bare U+25B6: the glyph would land in the
                  button's accessible name as "black right-pointing triangle,
                  Play". */}
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

      {/* Overview and genres, bottom-left. */}
      {detail.tagline !== null || detail.overview !== null || detail.genres.length > 0 ? (
        <div className="relative z-10 max-w-2xl px-8 pb-10">
          {detail.tagline === null ? null : (
            <p className="mb-2 text-sm text-muted-foreground italic">{detail.tagline}</p>
          )}
          {detail.overview === null ? null : (
            <p className="text-sm text-muted-foreground">{detail.overview}</p>
          )}
          {detail.genres.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {detail.genres.map((genre) => (
                <Badge key={genre} variant="secondary">
                  {genre}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Reserves the hero's shape so the page does not jump when data arrives. */
export function TitleHeroSkeleton(): JSX.Element {
  return (
    <section
      aria-hidden="true"
      className={`relative flex ${HERO_MIN_HEIGHT} flex-col overflow-hidden bg-card`}
    >
      <div className="flex flex-1 flex-col items-center justify-end px-8 pb-6">
        <Skeleton className="h-14 w-80 max-w-full" />
        <Skeleton className="mt-4 h-4 w-40" />
        <Skeleton className="mt-6 h-11 w-64 rounded-full" />
      </div>
      <div className="max-w-2xl px-8 pb-10">
        <Skeleton className="h-16 w-full" />
      </div>
    </section>
  );
}
