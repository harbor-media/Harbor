import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Sweep down to this fraction of the cap rather than exactly to it, so the
 *  next few cached images do not immediately trigger another sweep. */
export const EVICTION_TARGET_RATIO = 0.9;

export interface SweepResult {
  bytesBefore: number;
  bytesAfter: number;
  deleted: number;
}

interface Entry {
  path: string;
  size: number;
  mtimeMs: number;
}

async function collect(directory: string, into: Entry[], temporaries: string[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    // A cache directory that does not exist yet is not an error: nothing has
    // been cached, so there is nothing to evict.
    return;
  }

  for (const name of names) {
    const full = path.join(directory, name);
    const info = await stat(full).catch(() => null);
    if (!info) continue;

    if (info.isDirectory()) {
      await collect(full, into, temporaries);
      continue;
    }
    // Leftovers from an interrupted download. They are not servable, so they
    // are removed outright rather than competing with real cache content for
    // the size budget.
    if (name.endsWith(".tmp")) {
      temporaries.push(full);
      continue;
    }
    into.push({ path: full, size: info.size, mtimeMs: info.mtimeMs });
  }
}

export async function sweepImageCache(root: string, maxBytes: number): Promise<SweepResult> {
  const entries: Entry[] = [];
  const temporaries: string[] = [];
  await collect(root, entries, temporaries);

  for (const temporary of temporaries) {
    await rm(temporary, { force: true });
  }

  const bytesBefore = entries.reduce((total, entry) => total + entry.size, 0);
  if (bytesBefore <= maxBytes) {
    return { bytesBefore, bytesAfter: bytesBefore, deleted: 0 };
  }

  // Oldest first. This is FIFO by write time, not true LRU: tracking reads
  // would need either atime -- unreliable under the noatime/relatime mounts
  // most systems use -- or a database write on the hottest path in a poster
  // grid, plus a second source of truth that can drift from the filesystem.
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const target = Math.floor(maxBytes * EVICTION_TARGET_RATIO);
  let current = bytesBefore;
  let deleted = 0;

  for (const entry of entries) {
    if (current <= target) break;
    await rm(entry.path, { force: true });
    current -= entry.size;
    deleted += 1;
  }

  return { bytesBefore, bytesAfter: current, deleted };
}
