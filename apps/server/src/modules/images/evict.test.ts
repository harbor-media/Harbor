import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sweepImageCache } from "./evict.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "harbor-evict-"));
  await mkdir(path.join(root, "tmdb", "w342"), { recursive: true });
});

/** Writes a file of `bytes` length with an explicit mtime, so eviction order
 *  is deterministic rather than dependent on how fast the test ran. */
async function seed(name: string, bytes: number, ageSeconds: number): Promise<void> {
  const file = path.join(root, "tmdb", "w342", name);
  await writeFile(file, Buffer.alloc(bytes, 1));
  const when = new Date(Date.now() - ageSeconds * 1000);
  await utimes(file, when, when);
}

async function remaining(): Promise<string[]> {
  return (await readdir(path.join(root, "tmdb", "w342"))).sort();
}

describe("sweepImageCache", () => {
  it("does nothing when the cache is under the cap", async () => {
    await seed("a.jpg", 100, 10);
    await seed("b.jpg", 100, 20);

    const result = await sweepImageCache(root, 10_000);

    expect(result.deleted).toBe(0);
    expect(await remaining()).toEqual(["a.jpg", "b.jpg"]);
  });

  it("evicts oldest first until under the target ratio", async () => {
    await seed("oldest.jpg", 400, 300);
    await seed("middle.jpg", 400, 200);
    await seed("newest.jpg", 400, 100);

    // Cap 1000, target 900. Total 1200, so one file must go; 800 is under.
    const result = await sweepImageCache(root, 1000);

    expect(result.deleted).toBe(1);
    expect(await remaining()).toEqual(["middle.jpg", "newest.jpg"]);
    expect(result.bytesAfter).toBe(800);
  });

  it("evicts multiple files when one is not enough", async () => {
    await seed("oldest.jpg", 400, 300);
    await seed("middle.jpg", 400, 200);
    await seed("newest.jpg", 400, 100);

    const result = await sweepImageCache(root, 500);

    expect(result.deleted).toBe(2);
    expect(await remaining()).toEqual(["newest.jpg"]);
  });

  // Hysteresis: sweeping to exactly the cap would mean the very next cached
  // image trips the next sweep, and the cache would thrash at the boundary.
  it("sweeps below the cap, not merely to it", async () => {
    await seed("a.jpg", 500, 300);
    await seed("b.jpg", 500, 200);

    const result = await sweepImageCache(root, 900);

    expect(result.bytesAfter).toBeLessThanOrEqual(Math.floor(900 * 0.9));
  });

  it("descends into nested provider and size directories", async () => {
    await mkdir(path.join(root, "tmdb", "w780"), { recursive: true });
    await writeFile(path.join(root, "tmdb", "w780", "deep.jpg"), Buffer.alloc(500, 1));
    await seed("shallow.jpg", 500, 300);

    const result = await sweepImageCache(root, 10_000);

    expect(result.bytesBefore).toBe(1000);
  });

  it("reports totals accurately", async () => {
    await seed("a.jpg", 300, 10);

    const result = await sweepImageCache(root, 10_000);

    expect(result.bytesBefore).toBe(300);
    expect(result.bytesAfter).toBe(300);
  });

  it("returns zeroes for a cache directory that does not exist", async () => {
    const result = await sweepImageCache(path.join(root, "absent"), 1000);
    expect(result).toEqual({ bytesBefore: 0, bytesAfter: 0, deleted: 0 });
  });

  // Temporary files from interrupted downloads must not be counted as cache
  // content nor left to accumulate forever.
  it("removes stale temporary files even when under the cap", async () => {
    await writeFile(path.join(root, "tmdb", "w342", ".abandoned.tmp"), Buffer.alloc(50, 1));
    await seed("a.jpg", 100, 10);

    const result = await sweepImageCache(root, 10_000);

    expect(await remaining()).toEqual(["a.jpg"]);
    // The orphan is deleted rather than counted toward the budget.
    expect(result.bytesBefore).toBe(100);
  });
});
