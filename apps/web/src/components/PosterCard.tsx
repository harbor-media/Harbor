import type { TitleCard } from "@harbor/shared";
import type { JSX } from "react";
import { useState } from "react";
import { Link } from "react-router";
import { imageUrl } from "../images";

/**
 * A 2:3 poster with its box reserved, so a row does not reflow as artwork
 * arrives -- the same reason the search results and episode grid reserve
 * theirs.
 */
export function PosterCard({ item }: { item: TitleCard }): JSX.Element {
  const src = imageUrl(item.posterPath, "w342");
  const [failed, setFailed] = useState(false);
  const to = `/${item.type === "movie" ? "movie" : "series"}/${item.id}`;

  return (
    <li className="w-[150px] shrink-0 snap-start">
      <Link
        to={to}
        className="block rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {src === null || failed ? (
          <div aria-hidden="true" className="aspect-2/3 w-full rounded-lg bg-secondary" />
        ) : (
          <img
            src={src}
            // Decorative: the title is rendered as text below and is already
            // the link's accessible name.
            alt=""
            loading="lazy"
            className="aspect-2/3 w-full rounded-lg object-cover"
            onError={() => {
              setFailed(true);
            }}
          />
        )}
        <p className="mt-2 line-clamp-2 text-sm">{item.title}</p>
        {item.year === null ? null : (
          <p className="font-mono text-xs text-muted-foreground">{item.year}</p>
        )}
      </Link>
    </li>
  );
}
