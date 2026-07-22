import { CATALOG_KINDS } from "@harbor/shared";
import type { JSX } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useCatalogRow } from "../catalog";
import { CatalogRow } from "../components/CatalogRow";
import { imageUrl } from "../images";
import { ApiError } from "../metadata";

/**
 * The featured title is the first entry in Trending that has a backdrop --
 * deterministic, no rotation. Random or time-of-day selection makes the page
 * change under the reader between renders and makes the e2e assertion
 * unpinnable; rotation, if it is ever wanted, is a deliberate feature with its
 * own state rather than a side effect of rendering.
 */
function Hero(): JSX.Element | null {
  const trending = useCatalogRow("trending");
  const featured = trending.data?.titles[0];
  if (featured === undefined) return null;

  const src = imageUrl(featured.posterPath, "w780");

  return (
    <section className="relative">
      {src === null ? null : (
        <div aria-hidden="true" className="absolute inset-0 -z-10 overflow-hidden">
          <img src={src} alt="" className="h-full w-full scale-110 object-cover blur-2xl" />
          <div className="absolute inset-0 bg-background/80" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-background" />
        </div>
      )}
      <div className="px-6 pt-16 pb-10">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Featured
        </p>
        <h1 className="mt-2 font-display text-4xl tracking-tight sm:text-5xl">{featured.title}</h1>
        <Link
          to={`/${featured.type === "movie" ? "movie" : "series"}/${featured.id}`}
          className="mt-5 inline-block rounded-full bg-primary px-6 py-2 text-sm text-primary-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
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

  return (
    <main className="mx-auto max-w-[1600px] pb-16">
      <Hero />
      {CATALOG_KINDS.map((kind) => (
        <CatalogRow key={kind} kind={kind} />
      ))}
    </main>
  );
}
