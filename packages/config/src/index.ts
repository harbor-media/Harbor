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
});

export type HarborEnv = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): HarborEnv {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid Harbor configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
