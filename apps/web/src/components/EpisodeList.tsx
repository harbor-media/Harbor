import type { EpisodeItem } from "@harbor/shared";
import type { JSX } from "react";
import { imageUrl } from "../images";
import { metaLine } from "../titles";

const STILL_WIDTH = 128;
const STILL_HEIGHT = 72;

function Still({ path, label }: { path: string | null; label: string }): JSX.Element {
  const src = imageUrl(path, "w185");

  // The box is the same size whether or not an image loads, so a 22-episode
  // season does not reflow line by line as stills arrive.
  if (src === null) {
    return (
      <div
        aria-hidden="true"
        className="shrink-0 rounded-md bg-secondary"
        style={{ width: STILL_WIDTH, height: STILL_HEIGHT }}
      />
    );
  }

  return (
    <img
      src={src}
      alt={label}
      // A full season is a full season's worth of image requests; only the
      // rows actually scrolled to should cost one.
      loading="lazy"
      width={STILL_WIDTH}
      height={STILL_HEIGHT}
      className="shrink-0 rounded-md object-cover"
      style={{ width: STILL_WIDTH, height: STILL_HEIGHT }}
    />
  );
}

export function EpisodeList({ episodes }: { episodes: EpisodeItem[] }): JSX.Element {
  if (episodes.length === 0) {
    return <p className="p-3 text-sm text-muted-foreground">No episodes listed for this season.</p>;
  }

  return (
    <ul>
      {episodes.map((episode) => {
        const label = episode.name ?? `Episode ${String(episode.episodeNumber)}`;
        const runtime = episode.runtime === null ? null : `${String(episode.runtime)} min`;
        const meta = metaLine([runtime, episode.airDate]);

        return (
          <li
            key={episode.episodeNumber}
            className="flex gap-3 border-b border-border px-3 py-3 last:border-b-0"
          >
            <Still path={episode.stillPath} label={label} />

            <div className="min-w-0">
              {/* Number and name on one line, as a viewer reads them aloud:
                  "episode three, Chitty Chitty Death Bang". */}
              <p className="text-sm">
                {episode.episodeNumber}. {label}
              </p>
              {meta === "" ? null : (
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">{meta}</p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
