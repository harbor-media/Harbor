import type { SeasonSummary } from "@harbor/shared";
import type { JSX } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Season picker: a native select flanked by previous and next.
 *
 * A tab strip cannot hold a twenty-season show. Scrolling it needs
 * overflow-x, which draws a persistent bar on Windows and (per CSS) forces
 * overflow-y to auto as well; hiding both leaves later seasons unreachable
 * behind an invisible affordance; wrapping turns the strip into a wall. A
 * picker is flat in height no matter how many seasons exist.
 *
 * The select stays native rather than a custom listbox. The end-to-end suite
 * drives it with selectOption and reads its choices via option elements, and
 * a native control is keyboard-operable and screen-reader correct for free.
 */
export function SeasonSelector({
  titleId,
  seasons,
  active,
}: {
  titleId: string;
  seasons: SeasonSummary[];
  active: number | null;
}): JSX.Element {
  const navigate = useNavigate();

  const index = seasons.findIndex((s) => s.seasonNumber === active);
  const previous = index > 0 ? seasons[index - 1] : undefined;
  const next = index >= 0 && index < seasons.length - 1 ? seasons[index + 1] : undefined;

  const go = (seasonNumber: number): void => {
    void navigate(`/series/${titleId}/season/${String(seasonNumber)}`);
  };

  const label = (season: SeasonSummary): string =>
    season.name ?? `Season ${String(season.seasonNumber)}`;

  return (
    <nav
      aria-label="Seasons"
      className="flex items-center gap-2 border-b border-border px-3 py-2"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={previous === undefined}
        onClick={() => {
          if (previous) go(previous.seasonNumber);
        }}
      >
        ‹ Prev
      </Button>

      <label className="sr-only" htmlFor="season">
        Season
      </label>
      <select
        id="season"
        className={cn(
          "h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 text-center text-sm",
          "outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "dark:bg-input/30",
        )}
        value={active ?? ""}
        onChange={(event) => {
          go(Number(event.target.value));
        }}
      >
        {seasons.map((season) => (
          <option key={season.seasonNumber} value={season.seasonNumber}>
            {label(season)}
          </option>
        ))}
      </select>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={next === undefined}
        onClick={() => {
          if (next) go(next.seasonNumber);
        }}
      >
        Next ›
      </Button>
    </nav>
  );
}
