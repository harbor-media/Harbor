import type { TitleDetailResponse } from "@harbor/shared";
import type { JSX } from "react";

/** A definition list of a title's flat metadata, below the hero. Each row is
 *  omitted when empty, so a sparse title shows a short table, not blank rows. */
export function TitleDetails({ detail }: { detail: TitleDetailResponse }): JSX.Element | null {
  const rows: { label: string; value: string }[] = [];
  if (detail.genres.length > 0) rows.push({ label: "Genres", value: detail.genres.join(", ") });
  if (detail.director !== null) rows.push({ label: "Director", value: detail.director });
  if (detail.writers.length > 0) rows.push({ label: "Writers", value: detail.writers.join(", ") });
  if (detail.studios.length > 0) rows.push({ label: "Studios", value: detail.studios.join(", ") });

  if (rows.length === 0) return null;

  return (
    <dl className="mt-12 divide-y divide-border/60 border-t border-border/60 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex gap-6 py-3">
          <dt className="w-32 shrink-0 text-muted-foreground">{row.label}</dt>
          <dd className="text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
