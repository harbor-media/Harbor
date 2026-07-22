import { describe, expect, it } from "vitest";
import { buildTestApp } from "./test-helpers.js";

/**
 * Regression guard for a bug that made every Harbor container report itself
 * unhealthy forever.
 *
 * The image's HEALTHCHECK runs `wget --spider`, which issues a HEAD request.
 * Fastify auto-generates a HEAD route for every GET, but PUBLIC_ROUTES
 * matches the literal "METHOD /path" and listed only GET -- so HEAD hit the
 * auth guard and came back 401 against a completely healthy server.
 *
 * The consequences are all in orchestration rather than in the app: a Compose
 * stack using `depends_on: condition: service_healthy` waits forever, and an
 * orchestrator watching container health restarts a container that is fine.
 * Nothing in the application logs looks wrong, which is what let it survive
 * from Phase 1.
 */
describe("health endpoints answer unauthenticated probes", () => {
  const paths = ["/api/v1/health", "/api/v1/health/live", "/api/v1/health/ready"];

  it.each(paths)("answers GET %s without a session", async (url) => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it.each(paths)("answers HEAD %s without a session", async (url) => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "HEAD", url });

    // 401 here is the bug: a probe using HEAD would mark the container
    // unhealthy even though the server is serving normally.
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
