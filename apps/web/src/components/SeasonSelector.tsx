import type { SeasonSummary } from "@harbor/shared";
import type { JSX } from "react";
import { useNavigate } from "react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Season picker, sitting above the episode grid.
 *
 * A tab strip cannot hold a twenty-season show. Scrolling one needs
 * overflow-x, which Windows draws as a persistent bar and which per CSS also
 * forces overflow-y to auto; hiding both leaves later seasons unreachable
 * behind an invisible affordance; wrapping turns the strip into a wall. A
 * picker stays one line high however many seasons exist.
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

  const label = (season: SeasonSummary): string =>
    season.name ?? `Season ${String(season.seasonNumber)}`;

  return (
    <nav aria-label="Seasons">
      <Select
        value={active === null ? undefined : String(active)}
        onValueChange={(value) => {
          void navigate(`/series/${titleId}/season/${value}`);
        }}
      >
        <SelectTrigger className="w-56" aria-label="Season">
          <SelectValue placeholder="Select a season" />
        </SelectTrigger>
        <SelectContent>
          {seasons.map((season) => (
            <SelectItem key={season.seasonNumber} value={String(season.seasonNumber)}>
              {label(season)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </nav>
  );
}
