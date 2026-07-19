import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "../test-helpers.js";

const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");
const assetsPresent = existsSync(INDEX_HTML);

// This suite exercises the SPA fallback end to end. It requires real build output
// at apps/server/public (produced by `pnpm --filter @harbor/web build`), which is
// gitignored and absent in a backend-only checkout or a fresh clone. Rather than
// silently passing with no assertions, we skip visibly via `it.skipIf` so the test
// report always shows whether this path was actually exercised.
describe("SPA fallback (static assets)", () => {
  it.skipIf(!assetsPresent)(
    "serves the app shell for an unmatched non-API path",
    async () => {
      const app = await buildTestApp({ ready: true });
      const res = await app.inject({ method: "GET", url: "/setup" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("<html");
      await app.close();
    },
  );

  if (!assetsPresent) {
    it("skipped the SPA fallback assertion because apps/server/public is absent", () => {
      expect(assetsPresent).toBe(false);
    });
  }
});
