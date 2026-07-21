import { cacheFilePath, statCached, writeAtomic } from "./cache.js";
import type { ImageProviderId } from "./providers.js";
import { fetchUpstreamImage, ImageFetchError, MAX_IMAGE_BYTES } from "./upstream.js";
import type { ImageRequest } from "./validate.js";

const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_NEGATIVE_TTL_MS = 60 * 60 * 1000;
/** Bounds the negative cache so a scan of nonexistent paths cannot grow it
 *  without limit. Oldest entries are dropped first. */
const NEGATIVE_CACHE_MAX_ENTRIES = 1000;

/**
 * The one logging call this service makes. Declared structurally rather than
 * as pino's `Logger` so it accepts both the root logger and Fastify's
 * per-request `FastifyBaseLogger`, which are different types for the same
 * thing -- and so tests can pass a two-line fake.
 */
export interface ImageServiceLogger {
  error: (details: Record<string, unknown>, message: string) => void;
}

export interface ImageServiceOptions {
  cacheRoot: string;
  baseUrls: Record<ImageProviderId, string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  negativeTtlMs?: number;
  /** Optional so tests can construct the service without one. */
  logger?: ImageServiceLogger;
}

export type ServedImage =
  | { kind: "file"; path: string; size: number; mtimeMs: number; contentType: string }
  | { kind: "stream"; contentType: string; body: AsyncIterable<Uint8Array> };

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function contentTypeForFile(file: string): string {
  const dot = file.lastIndexOf(".");
  return CONTENT_TYPE_BY_EXTENSION[file.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

export class ImageService {
  private readonly inFlight = new Map<string, Promise<ServedImage>>();
  private readonly negative = new Map<string, number>();
  /** A full or read-only disk fails on every single image. Logging per
   *  request would bury the rest of the log under identical lines, so the
   *  operator is told once per process. */
  private loggedCacheFailure = false;

  constructor(private readonly options: ImageServiceOptions) {}

  async serve(request: ImageRequest): Promise<ServedImage> {
    const now = this.options.now ?? Date.now;
    const target = cacheFilePath(this.options.cacheRoot, request);

    const cached = await statCached(target);
    if (cached) {
      return {
        kind: "file",
        path: cached.path,
        size: cached.size,
        mtimeMs: cached.mtimeMs,
        contentType: contentTypeForFile(request.file),
      };
    }

    const negativeUntil = this.negative.get(target);
    if (negativeUntil !== undefined && negativeUntil > now()) {
      throw new ImageFetchError("not-found", "The image does not exist upstream.");
    }

    // Two viewers opening the same title must not both fetch the same poster.
    const existing = this.inFlight.get(target);
    if (existing) return existing;

    const attempt = this.download(request, target).finally(() => {
      this.inFlight.delete(target);
    });
    this.inFlight.set(target, attempt);
    return attempt;
  }

  private async download(request: ImageRequest, target: string): Promise<ServedImage> {
    const now = this.options.now ?? Date.now;
    const url = `${this.options.baseUrls[request.provider]}/${request.size}/${request.file}`;

    let fetched;
    try {
      fetched = await this.fetch(url);
    } catch (error) {
      if (error instanceof ImageFetchError && error.kind === "not-found") {
        this.rememberMissing(target, now());
      }
      throw error;
    }

    try {
      await writeAtomic(target, fetched.body);
    } catch (error) {
      // A body that breached the cap or died mid-stream is a real failure, not
      // a cache problem -- retrying it would just fetch the same bad response.
      if (error instanceof ImageFetchError) throw error;

      if (!this.loggedCacheFailure) {
        this.loggedCacheFailure = true;
        this.options.logger?.error(
          { err: error, cacheRoot: this.options.cacheRoot },
          "image cache is not writable; serving images without caching",
        );
      }

      // A full or read-only disk must not take artwork offline. Refetch and
      // stream straight through: degraded, but the catalog still renders.
      const passthrough = await this.fetch(url);
      return { kind: "stream", contentType: passthrough.contentType, body: passthrough.body };
    }

    const written = await statCached(target);
    if (!written) {
      throw new ImageFetchError("unavailable", "The image could not be stored.");
    }

    return {
      kind: "file",
      path: written.path,
      size: written.size,
      mtimeMs: written.mtimeMs,
      contentType: fetched.contentType,
    };
  }

  private async fetch(url: string) {
    return fetchUpstreamImage(url, {
      fetchImpl: this.options.fetchImpl,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      maxBytes: MAX_IMAGE_BYTES,
    });
  }

  private rememberMissing(target: string, at: number): void {
    const ttl = this.options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    if (this.negative.size >= NEGATIVE_CACHE_MAX_ENTRIES) {
      const oldest = this.negative.keys().next();
      if (!oldest.done) this.negative.delete(oldest.value);
    }
    this.negative.set(target, at + ttl);
  }
}
