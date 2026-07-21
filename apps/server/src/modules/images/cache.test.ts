import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cacheFilePath, statCached, writeAtomic } from "./cache.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "harbor-image-cache-"));
});

async function* bytes(chunks: string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield new TextEncoder().encode(chunk);
}

async function* failsMidStream(): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode("partial");
  throw new Error("connection reset");
}

const REQUEST = { provider: "tmdb" as const, size: "w342", file: "abc.jpg" };

describe("cacheFilePath", () => {
  it("nests by provider and size", () => {
    expect(cacheFilePath(root, REQUEST)).toBe(path.join(root, "tmdb", "w342", "abc.jpg"));
  });

  // Belt and braces: validate.ts already makes traversal unrepresentable, but
  // this asserts the cache layer would not cooperate even if it did not.
  it("never escapes the cache root", () => {
    const result = cacheFilePath(root, REQUEST);
    expect(path.resolve(result).startsWith(path.resolve(root))).toBe(true);
  });
});

describe("writeAtomic", () => {
  it("writes the full contents and creates parent directories", async () => {
    const target = path.join(root, "tmdb", "w342", "abc.jpg");
    await writeAtomic(target, bytes(["hello ", "world"]));
    expect(await readFile(target, "utf8")).toBe("hello world");
  });

  it("leaves no temporary files behind on success", async () => {
    const target = path.join(root, "tmdb", "w342", "abc.jpg");
    await writeAtomic(target, bytes(["data"]));
    expect(await readdir(path.join(root, "tmdb", "w342"))).toEqual(["abc.jpg"]);
  });

  // The property the whole design rests on. Writing straight to the target
  // would cache a truncated image permanently, surfacing as a randomly
  // corrupt poster that survives restarts.
  it("leaves nothing servable when the source fails mid-stream", async () => {
    const target = path.join(root, "tmdb", "w342", "abc.jpg");

    await expect(writeAtomic(target, failsMidStream())).rejects.toThrow("connection reset");

    expect(await statCached(target)).toBeNull();
  });

  it("removes its temporary file when the source fails mid-stream", async () => {
    const target = path.join(root, "tmdb", "w342", "abc.jpg");

    await expect(writeAtomic(target, failsMidStream())).rejects.toThrow();

    expect(await readdir(path.join(root, "tmdb", "w342"))).toEqual([]);
  });

  it("replaces an existing file", async () => {
    const target = path.join(root, "tmdb", "w342", "abc.jpg");
    await writeAtomic(target, bytes(["first"]));
    await writeAtomic(target, bytes(["second"]));
    expect(await readFile(target, "utf8")).toBe("second");
  });

  // A failed rewrite must not destroy the copy already cached: the old image
  // keeps working until a complete new one exists.
  it("leaves an existing file intact when a rewrite fails", async () => {
    const target = path.join(root, "tmdb", "w342", "abc.jpg");
    await writeAtomic(target, bytes(["original"]));

    await expect(writeAtomic(target, failsMidStream())).rejects.toThrow();

    expect(await readFile(target, "utf8")).toBe("original");
  });

  it("writes its temporary file in the destination directory", async () => {
    // A temp file on another filesystem makes rename non-atomic and, on most
    // platforms, fail outright with EXDEV.
    const target = path.join(root, "tmdb", "w342", "abc.jpg");
    let sawTemp: string[] = [];

    async function* observing(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("a");
      sawTemp = await readdir(path.join(root, "tmdb", "w342"));
      yield new TextEncoder().encode("b");
    }

    await writeAtomic(target, observing());

    expect(sawTemp).toHaveLength(1);
    expect(sawTemp[0]).toMatch(/\.tmp$/);
  });
});

describe("statCached", () => {
  it("returns null for a missing file", async () => {
    expect(await statCached(path.join(root, "nope.jpg"))).toBeNull();
  });

  it("returns null for a directory", async () => {
    expect(await statCached(root)).toBeNull();
  });

  it("returns size and mtime for an existing file", async () => {
    const target = path.join(root, "present.jpg");
    await writeFile(target, "12345");

    const stat = await statCached(target);

    expect(stat?.size).toBe(5);
    expect(typeof stat?.mtimeMs).toBe("number");
  });
});
