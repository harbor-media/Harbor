import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "@harbor/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EvictModule from "./evict.js";
import { startEvictionSweep } from "./scheduler.js";

// Only the throwing case below uses the mock; every other test resets it and
// exercises the real sweep against a temporary directory.
vi.mock("./evict.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof EvictModule;
  return { ...actual, sweepImageCache: vi.fn(actual.sweepImageCache) };
});

let root: string;
const logger = createLogger({ level: "silent", production: true });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "harbor-sweep-"));
});

/** Seeds an over-cap cache so a sweep has something observable to do. */
async function seedOverCap(): Promise<string> {
  const directory = path.join(root, "tmdb", "w342");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "a.jpg"), Buffer.alloc(800, 1));
  return directory;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `predicate` holds or the budget runs out.
 *
 * Fake timers are deliberately NOT used here. They fire the interval but do
 * not wait for the sweep's real filesystem I/O to finish, so an assertion
 * immediately after advancing the clock races the work it is meant to
 * observe -- and would fail intermittently rather than honestly.
 */
async function eventually(predicate: () => Promise<boolean>, budgetMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
}

describe("startEvictionSweep", () => {
  it("sweeps once the interval elapses", async () => {
    const directory = await seedOverCap();
    const handle = startEvictionSweep({ root, maxBytes: 100, intervalMs: 20, logger });

    const swept = await eventually(async () => (await readdir(directory)).length === 0);

    handle.stop();
    expect(swept).toBe(true);
  });

  it("has not swept before the first interval elapses", async () => {
    const directory = await seedOverCap();
    // An interval far longer than the observation window: a sweep at boot or
    // on any other trigger would show up here.
    const handle = startEvictionSweep({ root, maxBytes: 100, intervalMs: 60_000, logger });

    await sleep(150);

    expect(await readdir(directory)).toEqual(["a.jpg"]);
    handle.stop();
  });

  it("stops sweeping after stop()", async () => {
    const directory = await seedOverCap();
    const handle = startEvictionSweep({ root, maxBytes: 100, intervalMs: 20, logger });

    handle.stop();
    await sleep(150);

    // Still present: the interval was cleared before it could ever fire.
    expect(await readdir(directory)).toEqual(["a.jpg"]);
  });

  it("logs and keeps running when a sweep throws", async () => {
    // A sweep rejecting must not escape the timer callback: an unhandled
    // rejection there can take the whole process down over a cache chore.
    const { sweepImageCache } = await import("./evict.js");
    const spy = vi.mocked(sweepImageCache);
    spy.mockRejectedValue(new Error("disk exploded"));

    const errors: unknown[] = [];
    const capturing = {
      info: () => undefined,
      error: (details: unknown) => errors.push(details),
    } as unknown as Parameters<typeof startEvictionSweep>[0]["logger"];

    const handle = startEvictionSweep({ root, maxBytes: 100, intervalMs: 20, logger: capturing });

    const logged = await eventually(async () => errors.length >= 1);
    // Still scheduled after the failure rather than dead: it fires repeatedly.
    const repeated = await eventually(async () => errors.length >= 2);

    handle.stop();
    spy.mockReset();

    expect(logged).toBe(true);
    expect(repeated).toBe(true);
  });
});
