import type { Logger } from "@harbor/logger";
import { sweepImageCache } from "./evict.js";

export const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export interface EvictionSweepOptions {
  root: string;
  maxBytes: number;
  intervalMs?: number;
  logger: Logger;
}

export interface EvictionSweepHandle {
  stop: () => void;
}

/**
 * Runs the sweep on a timer, never on a request. Totalling the cache
 * directory during a request would make image serving scale with cache size,
 * which is exactly backwards: the bigger the cache, the slower every hit.
 */
export function startEvictionSweep(options: EvictionSweepOptions): EvictionSweepHandle {
  const interval = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  let running = false;

  const timer = setInterval(() => {
    // Skip rather than queue. On a very large cache a sweep can outlast the
    // interval, and overlapping sweeps would race each other's deletions --
    // double-counting sizes and evicting more than the cap requires.
    if (running) return;
    running = true;

    void sweepImageCache(options.root, options.maxBytes)
      .then((result) => {
        if (result.deleted > 0) {
          options.logger.info(
            {
              deleted: result.deleted,
              bytesBefore: result.bytesBefore,
              bytesAfter: result.bytesAfter,
            },
            "image cache swept",
          );
        }
      })
      .catch((error: unknown) => {
        // A failed sweep must not crash the process; the cache simply stays
        // large until the next attempt.
        options.logger.error({ err: error }, "image cache sweep failed");
      })
      .finally(() => {
        running = false;
      });
  }, interval);

  // Never hold the process open. A pending sweep timer must not delay exit on
  // SIGTERM, which would turn a graceful shutdown into a killed container.
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
