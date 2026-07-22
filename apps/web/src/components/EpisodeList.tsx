import type { EpisodeItem } from "@harbor/shared";
import type { JSX } from "react";
import { imageUrl } from "../images";
import { metaLine } from "../titles";

/**
 * Episodes as wide stills in a grid.
 *
 * Every card reserves a 16:9 box whether or not its image loads, so a
 * 22-episode season does not reflow row by row as stills arrive — the same
 * reason the search results reserve a poster box.
 */
function Still({ path, label }: { path: string | null; label: string }): JSX.Element {
  const src = imageUrl(path, "w300");

  if (src === null) {
    return <div aria-hidden="true" className="aspect-video w-full rounded-lg bg-secondary" />;
  }

  return (
    <img
      src={src}
      alt={label}
      // A full season is a full season's worth of image requests; only the
      // cards actually scrolled to should cost one.
      loading="lazy"
      className="aspect-video w-full rounded-lg object-cover"
    />
  );
}

export function EpisodeList({ episodes }: { episodes: EpisodeItem[] }): JSX.Element {
  if (episodes.length === 0) {
    return <p className="text-sm text-muted-foreground">No episodes listed for this season.</p>;
  }

  return (
    <ul className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {episodes.map((episode) => {
        const label = episode.name ?? `Episode ${String(episode.episodeNumber)}`;
        const runtime = episode.runtime === null ? null : `${String(episode.runtime)} min`;
        const meta = metaLine([runtime, episode.airDate]);

        return (
          <li key={episode.episodeNumber}>
            <Still path={episode.stillPath} label={label} />

            {/* Number and name on one line, as a viewer reads them aloud:
                "episode three, Chitty Chitty Death Bang". */}
            <p className="mt-3 text-sm">
              {episode.episodeNumber}. {label}
            </p>

            {meta === "" ? null : (
              <p className="mt-1 font-mono text-xs text-muted-foreground">{meta}</p>
            )}

            {episode.overview === null ? null : (
              <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{episode.overview}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
