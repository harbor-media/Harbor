import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ImageRequest } from "./validate.js";

export interface CachedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export function cacheFilePath(root: string, request: ImageRequest): string {
  return path.join(root, request.provider, request.size, request.file);
}

export async function statCached(filePath: string): Promise<CachedFile | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    return { path: filePath, size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Streams `source` to a uniquely named temporary file in the destination
 * directory, then renames it into place.
 *
 * rename(2) is atomic within a filesystem, so a concurrent reader sees either
 * no file or a complete one -- never a partial download. Writing directly to
 * the target would cache a truncated image permanently if the process died
 * mid-write, and that corruption would survive restarts while looking like a
 * random provider glitch.
 *
 * The temporary file must live in the SAME directory as the target: a rename
 * across filesystems is not atomic and fails outright on most platforms.
 */
export async function writeAtomic(
  filePath: string,
  source: AsyncIterable<Uint8Array>,
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });

  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await pipeline(Readable.from(source), createWriteStream(temporary));
    await rename(temporary, filePath);
  } catch (error) {
    // Leave no orphan behind for the eviction sweep to trip over. `force`
    // keeps this quiet when the temp file was never created.
    await rm(temporary, { force: true });
    throw error;
  }
}
