import type { SeasonSummary } from "@harbor/shared";
import type { JSX } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";

/**
 * Each tab is a Link, never a button.
 *
 * A season lives in the URL so it stays shareable and the back button moves
 * between seasons rather than leaving the page. Rendering these as buttons
 * with local state would look identical and quietly break both.
 */
export function SeasonTabs({
  titleId,
  seasons,
  active,
}: {
  titleId: string;
  seasons: SeasonSummary[];
  active: number | null;
}): JSX.Element {
  return (
    <nav aria-label="Seasons" className="border-b border-border">
      {/* Scrolls rather than wraps: a twenty-season show must not push the
          episode list off the screen.

          overflow-y-hidden is required, not decorative. Per CSS, when
          overflow-x is anything but visible, overflow-y computes from visible
          to auto -- so overflow-x-auto alone renders a vertical scrollbar
          inside the tab strip. */}
      <ul className="flex gap-1 overflow-x-auto overflow-y-hidden">
        {seasons.map((season) => {
          const current = season.seasonNumber === active;
          return (
            <li key={season.seasonNumber} className="shrink-0">
              <Link
                to={`/series/${titleId}/season/${String(season.seasonNumber)}`}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "block border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  current
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {season.name ?? `Season ${String(season.seasonNumber)}`}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
