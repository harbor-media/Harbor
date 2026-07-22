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
      {/* Wraps rather than scrolls.

          A scrolling strip needs overflow-x: auto, which Windows draws as a
          persistent bar that eats vertical space -- and which also forces
          overflow-y from visible to auto, per CSS, adding a second scrollbar.
          Hiding both would leave a strip that scrolls with no visible
          affordance, so a long show's later seasons become unreachable
          unless you happen to guess.

          Wrapping costs a second line on a very long series and nothing at
          all on a typical one. */}
      <ul className="flex flex-wrap gap-1">
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
