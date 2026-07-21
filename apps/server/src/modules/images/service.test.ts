import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { statCached } from "./cache.js";
import { ImageService, type ImageServiceOptions } from "./service.js";
import { ImageFetchError } from "./upstream.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "harbor-image-service-"));
});

const REQUEST = { provider: "tmdb" as const, size: "w342", file: "abc.jpg" };

function imageResponse(body = "imagebytes"): Response {
  return new Response(body, { status: 200, headers: { "content-type": "image/jpeg" } });
}

function service(
  fetchImpl: unknown,
  overrides: Partial<ImageServiceOptions> = {},
): ImageService {
  return new ImageService({
    cacheRoot: root,
    baseUrls: { tmdb: "https://cdn.example/t/p" },
    fetchImpl: fetchImpl as typeof fetch,
    ...overrides,
  });
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of body) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString("utf8");
}

const cachedPath = (): string => path.join(root, "tmdb", "w342", "abc.jpg");

describe("ImageService.serve", () => {
  it("fetches and caches on a miss", async () => {
    const fetchImpl = vi.fn(async () => imageResponse());

    const result = await service(fetchImpl).serve(REQUEST);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("file");
    expect(await readFile(cachedPath(), "utf8")).toBe("imagebytes");
  });

  it("builds the upstream URL from the configured base", async () => {
    const fetchImpl = vi.fn(async () => imageResponse());

    await service(fetchImpl).serve(REQUEST);

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://cdn.example/t/p/w342/abc.jpg");
  });

  // The load-bearing cache assertion: it counts upstream calls. Asserting only
  // that bytes came back would pass whether or not the cache exists at all.
  it("serves a second request without contacting upstream", async () => {
    const fetchImpl = vi.fn(async () => imageResponse());
    const subject = service(fetchImpl);

    await subject.serve(REQUEST);
    const second = await subject.serve(REQUEST);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.kind).toBe("file");
  });

  it("serves from a cache populated by a previous process", async () => {
    const fetchImpl = vi.fn(async () => imageResponse());
    await service(fetchImpl).serve(REQUEST);

    // A brand-new instance, as after a restart: the disk cache must survive.
    const fresh = vi.fn(async () => imageResponse());
    const result = await service(fresh).serve(REQUEST);

    expect(fresh).not.toHaveBeenCalled();
    expect(result.kind).toBe("file");
  });

  it("collapses concurrent misses into a single upstream fetch", async () => {
    const fetchImpl = vi.fn(async () => imageResponse());
    const subject = service(fetchImpl);

    await Promise.all([subject.serve(REQUEST), subject.serve(REQUEST), subject.serve(REQUEST)]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("remembers a 404 and does not re-request within the ttl", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 404, headers: { "content-type": "text/plain" } }),
    );
    const subject = service(fetchImpl);

    await expect(subject.serve(REQUEST)).rejects.toMatchObject({ kind: "not-found" });
    await expect(subject.serve(REQUEST)).rejects.toMatchObject({ kind: "not-found" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-requests once the negative entry expires", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 404, headers: { "content-type": "text/plain" } }),
    );
    let clock = 0;
    const subject = service(fetchImpl, { now: () => clock, negativeTtlMs: 1000 });

    await expect(subject.serve(REQUEST)).rejects.toThrow();
    clock = 2000;
    await expect(subject.serve(REQUEST)).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // A transient outage must not be remembered: only a definitive 404 is.
  it("does not negatively cache an unavailable upstream", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const subject = service(fetchImpl);

    await expect(subject.serve(REQUEST)).rejects.toThrow();
    await expect(subject.serve(REQUEST)).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("caches nothing when upstream returns a disallowed content type", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }),
    );

    await expect(service(fetchImpl).serve(REQUEST)).rejects.toMatchObject({
      kind: "rejected-type",
    });
    expect(await statCached(cachedPath())).toBeNull();
  });

  it("caches nothing when the body exceeds the byte cap", async () => {
    const oversized = "x".repeat(64);
    const fetchImpl = vi.fn(
      async () =>
        new Response(oversized, {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": String(20 * 1024 * 1024) },
        }),
    );

    await expect(service(fetchImpl).serve(REQUEST)).rejects.toMatchObject({ kind: "too-large" });
    expect(await statCached(cachedPath())).toBeNull();
  });

  it("propagates an unavailable upstream", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(service(fetchImpl).serve(REQUEST)).rejects.toBeInstanceOf(ImageFetchError);
  });

  // A filled or read-only disk must not take artwork offline. Serving degrades
  // to a pass-through stream rather than failing the request.
  it("streams through when the cache directory cannot be written", async () => {
    // Point the cache root at a regular file. Creating a subdirectory beneath
    // it fails with ENOTDIR on every platform, unlike a chmod-based read-only
    // directory, which does not restrict an administrator on Windows and so
    // would silently skip this behavior exactly where it is hardest to test.
    const blocker = path.join(root, "not-a-directory");
    await writeFile(blocker, "");

    const fetchImpl = vi.fn(async () => imageResponse("passthrough"));
    const result = await service(fetchImpl, { cacheRoot: blocker }).serve(REQUEST);

    expect(result.kind).toBe("stream");
    if (result.kind === "stream") {
      expect(await drain(result.body)).toBe("passthrough");
    }
    // Two fetches: the first body was consumed by the failed cache write, so
    // the pass-through has to request it again.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("logs an unwritable cache once, not per request", async () => {
    const blocker = path.join(root, "not-a-directory-either");
    await writeFile(blocker, "");
    const error = vi.fn();
    const logger = { error } as unknown as ImageServiceOptions["logger"];

    const subject = service(
      vi.fn(async () => imageResponse("passthrough")),
      { cacheRoot: blocker, logger },
    );
    await subject.serve(REQUEST);
    await subject.serve(REQUEST);

    // A full disk fails on every image. Logging per request would bury the
    // rest of the log under identical lines.
    expect(error).toHaveBeenCalledTimes(1);
  });
});
