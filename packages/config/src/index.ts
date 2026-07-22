import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HARBOR_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HARBOR_HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  HARBOR_BASE_URL: z.url({ protocol: /^https?$/ }),
  HARBOR_SECRET: z.string().min(32),
  HARBOR_DATA_DIRECTORY: z.string().default("/data"),
  HARBOR_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  HARBOR_TRUST_PROXY: z.stringbool().default(false),
  HARBOR_VERSION: z.string().default("0.1.0-dev"),
  // The per-IP ceiling on general API requests per minute. CLAUDE.md requires
  // rate limits to be configurable without recompilation: an operator behind
  // CGNAT, where many households share one address, needs to raise it, and the
  // end-to-end suite -- which bursts far past any human pace from a single IP
  // -- sets it high so its own traffic is not throttled. Login keeps its own
  // tighter, separate limit.
  HARBOR_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  // Maximum bytes the image cache may occupy before the sweep evicts.
  HARBOR_CACHE_MAX_SIZE: z.coerce.number().int().min(0).default(2_147_483_648),
  // Overrides the image CDN base URL. This is a SEPARATE host from
  // HARBOR_TMDB_BASE_URL below: metadata comes from api.themoviedb.org,
  // images from image.tmdb.org. Pointing one at the other silently breaks
  // whichever it was not meant for.
  HARBOR_TMDB_IMAGE_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  // Overrides the TMDB API base URL. Set by the end-to-end suite to point at
  // a local fixture so tests never depend on -- or hammer -- the real TMDB,
  // and usable in production by operators who reach TMDB through a mirror or
  // egress proxy. It is deliberately an environment variable rather than a
  // database setting: like DATABASE_URL it is operator-controlled
  // infrastructure, so it carries no SSRF exposure from ordinary users, who
  // can never influence it.
  HARBOR_TMDB_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
});

export type HarborEnv = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): HarborEnv {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid Harbor configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
