import { CATALOG_KINDS, type TitleCard } from "@harbor/shared";
import type { JSX } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useCatalogRow } from "../catalog";
import { CatalogRow } from "../components/CatalogRow";
import { imageUrl } from "../images";
import { ApiError } from "../metadata";
import { metaLine, useTitleDetail } from "../titles";

// One clamped height for the hero, reserved whether or not the artwork has
// loaded, so the rows below never jump as the backdrop arrives.
const HERO_HEIGHT = "h-[clamp(28rem,70vh,44rem)]";

/**
 * The featured title is simply the first entry in Trending -- deterministic,
 * no rotation. Random or time-of-day selection makes the page change under the
 * reader between renders and makes the e2e assertion unpinnable; rotation, if
 * it is ever wanted, is a deliberate feature with its own state rather than a
 * side effect of rendering.
 *
 * The card alone carries only a poster, so the hero fetches full detail for the
 * featured title -- the same cached title-detail endpoint the title page uses --
 * to get its backdrop, genres, runtime, and overview.
 */
function Hero({ featured }: { featured: TitleCard }): JSX.Element {
  const detail = useTitleDetail(featured.id);
  const to = `/${featured.type === "movie" ? "movie" : "series"}/${featured.id}`;

  // A full-bleed backdrop when there is one; otherwise the poster blurred and
  // darkened, which is the fallback the title page uses too. `backdropPath`
  // only exists once detail has loaded, so until then this is the poster.
  const backdrop = imageUrl(detail.data?.backdropPath ?? null, "w1280");
  const poster = imageUrl(detail.data?.posterPath ?? featured.posterPath, "w780");
  const src = backdrop ?? poster;

  const runtime = detail.data?.runtime == null ? null : `${String(detail.data.runtime)} min`;
  const meta = metaLine([
    detail.data?.year,
    runtime,
    detail.data?.genres.slice(0, 2).join(", "),
  ]);

  return (
    <section className={`relative flex ${HERO_HEIGHT} flex-col justify-end overflow-hidden`}>
      {/* Plain absolute layer, no negative z-index: the backdrop paints above
          the page canvas and the content, being `relative` below, paints above
          the backdrop. Nothing can hide behind the root background. */}
      <div aria-hidden="true" className="absolute inset-0">
        {src === null ? (
          <div className="h-full w-full bg-card" />
        ) : (
          <img
            src={src}
            alt=""
            className={
              backdrop === null
                ? "h-full w-full scale-110 object-cover blur-2xl"
                : "h-full w-full object-cover object-top"
            }
          />
        )}
        {/* Gradients kept light so most of the backdrop stays visible even
            when the artwork is dark: the bottom fades to the canvas only near
            the very edge so the rows meet it softly, and the left darkens just
            enough under the text to keep it legible. */}
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/20 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-background/80 via-transparent to-transparent" />
      </div>

      <div className="relative max-w-2xl px-6 pb-12">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">Featured</p>
        <h1 className="mt-3 font-display text-5xl leading-tight tracking-tight sm:text-6xl">
          {featured.title}
        </h1>
        {meta === "" ? null : (
          <p className="mt-3 font-mono text-xs tracking-widest text-muted-foreground uppercase">
            {meta}
          </p>
        )}
        {detail.data?.overview == null ? null : (
          <p className="mt-4 line-clamp-3 text-sm text-muted-foreground">{detail.data.overview}</p>
        )}
        <Link
          to={to}
          className="mt-6 inline-block rounded-full bg-primary px-6 py-2.5 text-sm text-primary-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          View details
        </Link>
      </div>
    </section>
  );
}

export function Home(): JSX.Element {
  const trending = useCatalogRow("trending");

  // One panel, not four broken rows: with no provider configured every row
  // fails identically, and repeating the same message four times tells the
  // reader nothing extra while burying the action that fixes it.
  const notConfigured =
    trending.error instanceof ApiError && trending.error.code === "METADATA_NOT_CONFIGURED";

  if (notConfigured) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <Alert>
          <AlertDescription>
            Harbor has no metadata provider yet, so there is nothing to show here.{" "}
            <Link className="underline" to="/admin/metadata">
              Configure a metadata provider
            </Link>
            .
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  // No featured title (Trending empty or still loading) means no hero, but the
  // rows still render -- a missing hero must never blank the page.
  const featured = trending.data?.titles[0];

  return (
    <main className="pb-16">
      {featured === undefined ? null : <Hero featured={featured} />}
      <div className="mx-auto max-w-[1600px]">
        {CATALOG_KINDS.map((kind) => (
          <CatalogRow key={kind} kind={kind} />
        ))}
      </div>
    </main>
  );
}
