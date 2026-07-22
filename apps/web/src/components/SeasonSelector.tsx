import type { SeasonSummary } from "@harbor/shared";
import type { JSX } from "react";
import { useNavigate } from "react-router";
import {
  Select,
  SelectItem,
  SelectList,
  SelectPopover,
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
        aria-label="Season"
        selectedKey={active === null ? null : String(active)}
        onSelectionChange={(key) => {
          void navigate(`/series/${titleId}/season/${String(key)}`);
        }}
      >
        <SelectTrigger className="w-56">
          <SelectValue />
        </SelectTrigger>
        {/* Composed from the popover and list rather than SelectContent so
            the list itself can be capped. The list is the scroll container,
            and React Aria sizes the popover to the space available -- so on a
            tall screen an uncapped 25-season list simply claims the whole
            viewport. Capping the popover instead does not work: React Aria
            writes its own max-height inline, which beats any class. */}
        <SelectPopover>
          <SelectList className="max-h-80">
            {seasons.map((season) => (
              <SelectItem
                key={season.seasonNumber}
                id={String(season.seasonNumber)}
              >
                {label(season)}
              </SelectItem>
            ))}
          </SelectList>
        </SelectPopover>
      </Select>
    </nav>
  );
}
