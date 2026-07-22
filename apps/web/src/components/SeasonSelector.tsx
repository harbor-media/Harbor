import type { SeasonSummary } from "@harbor/shared";
import type { JSX } from "react";
import { useNavigate } from "react-router";
import { cn } from "@/lib/utils";

/**
 * Season picker, sitting above the episode grid.
 *
 * A tab strip cannot hold a twenty-season show. Scrolling one needs
 * overflow-x, which Windows draws as a persistent bar and which per CSS also
 * forces overflow-y to auto; hiding both leaves later seasons unreachable
 * behind an invisible affordance; wrapping turns the strip into a wall. A
 * picker stays one line high however many seasons exist.
 *
 * The select is native rather than a custom listbox. The end-to-end suite
 * drives it with selectOption and reads its choices as option elements —
 * exactly as it already drives the invitations dropdowns — and a native
 * control is keyboard-operable and screen-reader correct without extra work.
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

  return (
    <nav aria-label="Seasons">
      <label className="sr-only" htmlFor="season">
        Season
      </label>
      <select
        id="season"
        className={cn(
          "h-9 rounded-lg border border-input bg-card px-3 text-sm font-medium",
          "outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
        value={active ?? ""}
        onChange={(event) => {
          void navigate(`/series/${titleId}/season/${event.target.value}`);
        }}
      >
        {seasons.map((season) => (
          <option key={season.seasonNumber} value={season.seasonNumber}>
            {season.name ?? `Season ${String(season.seasonNumber)}`}
          </option>
        ))}
      </select>
    </nav>
  );
}
