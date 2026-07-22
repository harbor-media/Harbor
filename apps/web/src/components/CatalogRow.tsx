import type { CatalogKind } from "@harbor/shared";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CATALOG_LABELS, useCatalogRow } from "../catalog";
import { ApiError } from "../metadata";
import { PosterCard } from "./PosterCard";

const SCROLL_FRACTION = 0.8;

export function CatalogRow({ kind }: { kind: CatalogKind }): JSX.Element | null {
  const row = useCatalogRow(kind);
  const scroller = useRef<HTMLUListElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (el === null) return;
    setAtStart(el.scrollLeft <= 1);
    // The one-pixel slack absorbs sub-pixel layout rounding, which otherwise
    // leaves the "next" button enabled at the true end of the row.
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }, []);

  useEffect(measure, [measure, row.data]);

  function scrollBy(direction: -1 | 1): void {
    const el = scroller.current;
    if (el === null) return;
    el.scrollBy({ left: direction * el.clientWidth * SCROLL_FRACTION, behavior: "smooth" });
  }

  // A row this installation's provider cannot serve is hidden, not broken.
  if (row.error instanceof ApiError && row.error.code === "CATALOG_KIND_UNSUPPORTED") return null;
  // An empty shelf communicates nothing.
  if (row.data && row.data.titles.length === 0) return null;

  const label = CATALOG_LABELS[kind];

  return (
    <section className="mt-10" aria-labelledby={`row-${kind}`}>
      <div className="flex items-center gap-3 px-6">
        <h2 id={`row-${kind}`} className="font-display text-xl">
          {label}
        </h2>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Scroll ${label} left`}
          isDisabled={atStart}
          onPress={() => {
            scrollBy(-1);
          }}
        >
          <ChevronLeftIcon className="size-4" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Scroll ${label} right`}
          isDisabled={atEnd}
          onPress={() => {
            scrollBy(1);
          }}
        >
          <ChevronRightIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {row.isError ? (
        // Scoped to this row on purpose: one failing provider call must not
        // blank the other three rows.
        <p role="alert" className="mt-3 px-6 text-sm text-muted-foreground">
          This row could not be loaded.
        </p>
      ) : (
        <ul
          ref={scroller}
          onScroll={measure}
          className="no-scrollbar mt-3 flex snap-x gap-4 overflow-x-auto overflow-y-hidden px-6 pb-2"
        >
          {row.isPending
            ? Array.from({ length: 8 }, (_, i) => (
                <li key={i} className="w-[150px] shrink-0" aria-hidden="true">
                  <Skeleton className="aspect-2/3 w-full rounded-lg" />
                </li>
              ))
            : (row.data?.titles ?? []).map((item) => <PosterCard key={item.id} item={item} />)}
        </ul>
      )}
    </section>
  );
}
