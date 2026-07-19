# Harbor Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a deployable Harbor container that boots, migrates its own schema safely under concurrency, serves the compiled React application, reports health accurately, and knows whether it has been set up.

**Architecture:** A pnpm/Turborepo monorepo containing one Fastify backend and one Vite/React frontend. The backend is a modular monolith whose domains are Fastify plugins; cross-cutting concerns (config, logger, database, error handling) are separate plugins registered in a composition root. The frontend compiles to static assets served by the backend, so the whole product ships as one image. PostgreSQL is the only external dependency.

**Tech Stack:** Node 24, pnpm 10, TypeScript 6.0.3, Fastify 5, Drizzle ORM + postgres.js, Zod 4, pino 10, React 19, Vite 8, Tailwind 4, React Router 8, TanStack Query 5, Vitest 4, Testcontainers 12, Docker.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node floor: `>=22.22.0`.** React Router 8 documents `node@22.22+`, stricter than Vite 8's `>=22.12`. Development happens on Node 24.
- **TypeScript is `6.0.3`, NOT 7.x.** `typescript-eslint@8.64.0` declares `typescript: ">=4.8.4 <6.1.0"`. Installing TS 7 breaks linting. Pin exactly.
- **ESM everywhere.** Every `package.json` sets `"type": "module"`.
- **Import extensions differ by resolution mode, and this is intentional:**
  - `packages/*` and `apps/server` use `moduleResolution: nodenext`. Relative imports **must** carry an explicit `.js` extension even when the source file is `.ts`. Writing `./foo.ts` produces error `TS5097`; omitting the extension fails to resolve at runtime.
  - `apps/web` uses `moduleResolution: bundler`. Relative imports are **extensionless**, which is what Vite expects.

  Copying an import line from a server file into a web file, or the reverse, will break. Check which package you are in.
- **Exact dependency versions, no `^` ranges**, for every package listed in this plan. Harbor is self-hosted software where reproducible builds matter more than automatic minor upgrades.
- **All text files use LF line endings**, enforced by `.gitattributes`. The repository is developed on Windows and built in Linux containers; CRLF leaking into shell scripts breaks the Docker image.
- **API base path is `/api/v1`.** Internal port is `3000`.
- **Never log secrets.** Passwords, tokens, API keys, `authorization`/`cookie` headers, and `DATABASE_URL` must never appear in log output.
- **Never add a `Co-Authored-By:` trailer or any AI-attribution footer to a commit message.** Write subject and body only, ending at the last content line.

### Known ecosystem traps (verified 2026-07-19)

These are current-version behaviors that differ from what older tutorials show. Each is handled explicitly by a task below.

1. **`pg_advisory_lock` is session-scoped.** It belongs to the connection that took it. Acquiring it on a pooled client lets lock and unlock land on different connections, silently defeating the guard. Migrations use a dedicated `max: 1` client.
2. **postgres.js returns an array, not `{ rows }`.** `await db.execute(sql\`…\`)` is array-like — index it as `rows[0]`. Copying a `node-postgres` snippet gives `undefined` at runtime with no type error.
3. **`react-router-dom` no longer exists.** v8 removed it; npm has it frozen at 7.18.1. Install `react-router`, import `RouterProvider` from `react-router/dom`.
4. **Vitest 4 rejects `test: {}` inside `vite.config.ts`** with `TS2769`. Use a separate `vitest.config.ts` with `mergeConfig`.
5. **Tailwind 4 has no config file.** `@import "tailwindcss";` replaces the three `@tailwind` directives, which no longer exist. No PostCSS, no autoprefixer.
6. **Drizzle's `check()` returns from an array**, `(t) => [check(...)]`, not the pre-0.31 object form.
7. **Zod 4 moved string formats to top level** (`z.email()`, not `z.string().email()`) and replaced `.flatten()`/`.format()` with `z.flattenError()`/`z.treeifyError()`/`z.prettifyError()`. Use `z.stringbool()` for env booleans — `z.coerce.boolean()` turns the string `"false"` into `true`.
8. **Fastify 5 throws if `setErrorHandler` is called twice in one scope** unless the server is constructed with `allowErrorHandlerOverride: true`.
9. **`@testing-library/dom` is a peer**, not a transitive dependency. Install it explicitly.

---

## File Structure

| Path | Responsibility |
|---|---|
| `.gitattributes` | Force LF line endings |
| `pnpm-workspace.yaml` | Workspace member globs |
| `turbo.json` | Task graph and caching |
| `tsconfig.base.json` | Shared compiler options |
| `eslint.config.js` | Flat ESLint config for all packages |
| `packages/logger/src/index.ts` | pino construction, redaction, child loggers |
| `packages/config/src/index.ts` | Zod env schema, `loadEnv()` |
| `packages/shared/src/index.ts` | Error codes, API contract types |
| `packages/database/src/schema.ts` | Drizzle table definitions |
| `packages/database/src/client.ts` | Pool creation and shutdown |
| `packages/database/src/migrate.ts` | Advisory-locked migration runner |
| `packages/database/src/installation.ts` | Installation record queries |
| `apps/server/src/plugins/*.ts` | Cross-cutting Fastify plugins |
| `apps/server/src/modules/health/*.ts` | Three health endpoints |
| `apps/server/src/modules/installation/*.ts` | Setup-state endpoint |
| `apps/server/src/app.ts` | Composition root |
| `apps/server/src/server.ts` | Boot sequence, graceful shutdown |
| `apps/server/src/cli.ts` | `migrate` subcommand |
| `apps/web/src/*` | React shell, routing, setup redirect |
| `Dockerfile` | Multi-stage production image |
| `docker-compose.yml` / `.dev.yml` | Production and development stacks |
| `.github/workflows/ci.yml` | Lint, typecheck, test, build, smoke |

---

## Task 1: Monorepo foundation and tooling

**Files:**
- Create: `.gitattributes`, `.gitignore`, `.npmrc`, `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.js`

**Interfaces:**
- Consumes: nothing
- Produces: workspace root that resolves `@harbor/*` package names; `tsconfig.base.json` extended by every package; scripts `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`

- [ ] **Step 1: Create `.gitattributes`**

```
* text=auto eol=lf
*.png binary
*.jpg binary
*.ico binary
*.woff2 binary
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
dist/
.turbo/
coverage/
*.tsbuildinfo
.env
.env.*
!.env.example
apps/server/public/
```

- [ ] **Step 3: Create `.npmrc`**

`shamefully-hoist` is deliberately absent; strict isolation catches undeclared dependencies.

```
engine-strict=true
auto-install-peers=false
```

- [ ] **Step 4: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 5: Create root `package.json`**

```json
{
  "name": "harbor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.4",
  "engines": { "node": ">=22.22.0" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "docker:build": "docker build -t harbor:dev .",
    "docker:smoke": "bash scripts/smoke.sh"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "eslint": "10.7.0",
    "turbo": "2.10.5",
    "typescript": "6.0.3",
    "typescript-eslint": "8.64.0"
  }
}
```

- [ ] **Step 6: Create `tsconfig.base.json`**

Every option is set explicitly. TypeScript 6 and 7 have different defaults for `types`, `rootDir`, and `strict`; relying on any of them makes the config version-fragile.

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "lib": ["es2023"],
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true
  }
}
```

- [ ] **Step 7: Create `turbo.json`**

`dev` depends on `^build` so workspace packages are compiled to `dist/` before the server or web dev servers resolve them.

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "lint": {},
    "test": {
      "dependsOn": ["^build"]
    },
    "dev": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true
    }
  }
}
```

- [ ] **Step 8: Create `eslint.config.js`**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "apps/server/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "error"
    }
  }
);
```

`no-console` is an error on purpose. Everything must go through the structured logger; a stray `console.log` bypasses redaction.

- [ ] **Step 9: Install and verify**

Run: `pnpm install`
Expected: completes without `ERR_PNPM_*` errors and creates `pnpm-lock.yaml`.

Run: `pnpm lint`
Expected: turbo reports no packages with a `lint` task yet, exit code 0.

- [ ] **Step 10: Commit**

```bash
git add .gitattributes .gitignore .npmrc package.json pnpm-workspace.yaml turbo.json tsconfig.base.json eslint.config.js pnpm-lock.yaml
git commit -m "chore: scaffold pnpm/turborepo workspace"
```

---

## Task 2: `packages/logger` — structured logging with redaction

**Files:**
- Create: `packages/logger/package.json`, `packages/logger/tsconfig.json`, `packages/logger/src/index.ts`, `packages/logger/src/index.test.ts`

**Interfaces:**
- Consumes: `tsconfig.base.json`
- Produces:
  - `createLogger(options: LoggerOptions, destination?: pino.DestinationStream): Logger`
  - `LoggerOptions = { level: string; production: boolean }`
  - `forRequest(logger: Logger, requestId: string): Logger`
  - re-exports `type Logger` from pino

- [ ] **Step 1: Create `packages/logger/package.json`**

```json
{
  "name": "@harbor/logger",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc --build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "dependencies": {
    "pino": "10.3.1",
    "pino-pretty": "13.1.3"
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 2: Create `packages/logger/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Write the failing test**

This test is security-critical: it is the executable form of the spec requirement that secrets never reach log output.

`packages/logger/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createLogger } from "./index.js";

function capture(): { lines: string[]; stream: { write(s: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => { lines.push(s); } } };
}

describe("createLogger redaction", () => {
  it("removes secrets but preserves surrounding fields", () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: "info", production: true }, stream);

    log.info(
      {
        password: "hunter2",
        apiKey: "sk-live-abc123",
        provider: { credentials: { token: "tok-secret" } },
        req: { headers: { authorization: "Bearer xyz", "user-agent": "harbor-test" } },
        titleId: "tt0111161",
      },
      "provider configured",
    );

    expect(lines).toHaveLength(1);
    const raw = lines[0]!;

    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("sk-live-abc123");
    expect(raw).not.toContain("tok-secret");
    expect(raw).not.toContain("Bearer xyz");

    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry["msg"]).toBe("provider configured");
    expect(entry["titleId"]).toBe("tt0111161");
    expect(entry["password"]).toBe("[REDACTED]");
  });

  it("attaches a requestId via child loggers", () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: "info", production: true }, stream);

    forRequestLocal(log).info("handled");

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["requestId"]).toBe("req-1");
  });
});

function forRequestLocal(log: ReturnType<typeof createLogger>) {
  return log.child({ requestId: "req-1" });
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @harbor/logger test`
Expected: FAIL — `Failed to resolve import "./index.js"`.

- [ ] **Step 5: Write the implementation**

`packages/logger/src/index.ts`:

```ts
import { pino, type DestinationStream, type Logger, type LoggerOptions as PinoOptions } from "pino";

export type { Logger } from "pino";

export interface LoggerOptions {
  level: string;
  production: boolean;
}

const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "DATABASE_URL",
  "*.DATABASE_URL",
  "provider.credentials.*",
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
];

export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  const base: PinoOptions = {
    level: options.level,
    base: { service: "harbor" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };

  if (destination) return pino(base, destination);

  if (options.production) return pino(base);

  return pino({
    ...base,
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
    },
  });
}

export function forRequest(logger: Logger, requestId: string): Logger {
  return logger.child({ requestId });
}
```

Note the redaction list uses explicit paths plus single-level wildcards rather than a deep recursive match, because pino wildcards carry real cost on hot request logging.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @harbor/logger test`
Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/logger
git commit -m "feat(logger): structured pino logger with secret redaction"
```

---

## Task 3: `packages/config` — environment validation

**Files:**
- Create: `packages/config/package.json`, `packages/config/tsconfig.json`, `packages/config/src/index.ts`, `packages/config/src/index.test.ts`

**Interfaces:**
- Consumes: `tsconfig.base.json`
- Produces:
  - `loadEnv(source?: NodeJS.ProcessEnv): HarborEnv` — throws `Error` with a formatted message on invalid input
  - `type HarborEnv` with fields `NODE_ENV`, `HARBOR_PORT`, `HARBOR_HOST`, `DATABASE_URL`, `HARBOR_BASE_URL`, `HARBOR_SECRET`, `HARBOR_DATA_DIRECTORY`, `HARBOR_LOG_LEVEL`, `HARBOR_TRUST_PROXY`

- [ ] **Step 1: Create `packages/config/package.json`**

```json
{
  "name": "@harbor/config",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc --build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "dependencies": { "zod": "4.4.3" },
  "devDependencies": {
    "@types/node": "24.13.3",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 2: Create `packages/config/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Write the failing test**

`packages/config/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadEnv } from "./index.js";

const valid = {
  DATABASE_URL: "postgresql://harbor:pw@localhost:5432/harbor",
  HARBOR_BASE_URL: "https://harbor.example.com",
  HARBOR_SECRET: "0123456789abcdef0123456789abcdef",
};

describe("loadEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = loadEnv({ ...valid } as NodeJS.ProcessEnv);
    expect(env.HARBOR_PORT).toBe(3000);
    expect(env.HARBOR_DATA_DIRECTORY).toBe("/data");
    expect(env.HARBOR_LOG_LEVEL).toBe("info");
    expect(env.HARBOR_TRUST_PROXY).toBe(false);
    expect(env.NODE_ENV).toBe("development");
  });

  it("coerces the port to a number", () => {
    const env = loadEnv({ ...valid, HARBOR_PORT: "8080" } as NodeJS.ProcessEnv);
    expect(env.HARBOR_PORT).toBe(8080);
  });

  it('parses the string "false" as boolean false', () => {
    const env = loadEnv({ ...valid, HARBOR_TRUST_PROXY: "false" } as NodeJS.ProcessEnv);
    expect(env.HARBOR_TRUST_PROXY).toBe(false);
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => loadEnv(rest as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it("rejects a secret shorter than 32 characters", () => {
    expect(() => loadEnv({ ...valid, HARBOR_SECRET: "tooshort" } as NodeJS.ProcessEnv)).toThrow(
      /HARBOR_SECRET/,
    );
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() =>
      loadEnv({ ...valid, DATABASE_URL: "mysql://localhost/harbor" } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
  });

  it("rejects an unknown log level", () => {
    expect(() =>
      loadEnv({ ...valid, HARBOR_LOG_LEVEL: "verbose" } as NodeJS.ProcessEnv),
    ).toThrow(/HARBOR_LOG_LEVEL/);
  });
});
```

The `"false"` test exists specifically because `z.coerce.boolean()` would return `true` for it. It guards against someone swapping `z.stringbool()` for the more obvious-looking coercion.

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @harbor/config test`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 5: Write the implementation**

`packages/config/src/index.ts`:

```ts
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HARBOR_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HARBOR_HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  HARBOR_BASE_URL: z.url(),
  HARBOR_SECRET: z.string().min(32),
  HARBOR_DATA_DIRECTORY: z.string().default("/data"),
  HARBOR_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  HARBOR_TRUST_PROXY: z.stringbool().default(false),
});

export type HarborEnv = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): HarborEnv {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid Harbor configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
```

Variables named in `CLAUDE.md` but not consumed yet (`HARBOR_REGISTRATION_MODE`, `HARBOR_CACHE_MAX_SIZE`, `HARBOR_STREAM_CONCURRENCY`, `HARBOR_TELEMETRY_ENABLED`) are deliberately absent. They arrive with the features that read them. Unknown keys pass through harmlessly because `z.object` strips rather than rejects.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @harbor/config test`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/config
git commit -m "feat(config): validated environment loading with Zod"
```

---

## Task 4: `packages/shared` — API contracts and error codes

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `tsconfig.base.json`
- Produces:
  - `ERROR_CODES` readonly tuple and `type ErrorCode`
  - `interface ApiErrorBody { error: { code: ErrorCode; message: string; requestId: string } }`
  - `interface InstallationState { setupComplete: boolean; version: string }`
  - `interface HealthStatus { status: "ok" | "degraded"; version: string; uptimeSeconds: number }`
  - `interface ReadinessStatus { ready: boolean; checks: Record<string, boolean> }`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@harbor/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc --build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "echo \"no tests\" && exit 0"
  },
  "devDependencies": { "typescript": "6.0.3", "@types/node": "24.13.3" }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write the implementation**

There is no test here. This file contains only type declarations and one frozen constant; a test would assert that TypeScript works.

`packages/shared/src/index.ts`:

```ts
export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  "SETUP_ALREADY_COMPLETE",
  "RATE_LIMITED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
  };
}

export interface InstallationState {
  setupComplete: boolean;
  version: string;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  version: string;
  uptimeSeconds: number;
}

export interface ReadinessStatus {
  ready: boolean;
  checks: {
    database: boolean;
    migrations: boolean;
    dataDirectory: boolean;
  };
}

export const API_PREFIX = "/api/v1";
```

- [ ] **Step 4: Verify it compiles**

Run: `pnpm --filter @harbor/shared build`
Expected: exit 0, `packages/shared/dist/index.d.ts` created.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): API contract types and error codes"
```

---

## Task 5: `packages/database` — schema and connection

**Files:**
- Create: `packages/database/package.json`, `packages/database/tsconfig.json`, `packages/database/drizzle.config.ts`, `packages/database/src/schema.ts`, `packages/database/src/client.ts`, `packages/database/src/index.ts`
- Generate: `packages/database/drizzle/0000_*.sql`

**Interfaces:**
- Consumes: `tsconfig.base.json`
- Produces:
  - `installation` table with columns `id`, `setup_completed_at`, `created_at`
  - `createClient(url: string, options?: { max?: number }): { sql: Sql; db: Db }`
  - `type Db = PostgresJsDatabase<typeof schema>`
  - `closeClient(sql: Sql): Promise<void>`

- [ ] **Step 1: Create `packages/database/package.json`**

```json
{
  "name": "@harbor/database",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist", "drizzle"],
  "scripts": {
    "build": "tsc --build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "drizzle-orm": "0.45.2",
    "postgres": "3.4.9"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "12.0.4",
    "@types/node": "24.13.3",
    "drizzle-kit": "0.31.10",
    "testcontainers": "12.0.4",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 2: Create `packages/database/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create `packages/database/src/schema.ts`**

The `check` constraint is what makes a second installation row impossible at the database level rather than by convention. Note the array return form — the object form is pre-0.31 and no longer correct.

```ts
import { sql } from "drizzle-orm";
import { boolean, check, pgTable, timestamp } from "drizzle-orm/pg-core";

export const installation = pgTable(
  "installation",
  {
    id: boolean("id").primaryKey().default(true),
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("installation_singleton", sql`${t.id} = true`)],
);

export type Installation = typeof installation.$inferSelect;
```

- [ ] **Step 4: Create `packages/database/src/client.ts`**

```ts
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DatabaseClient {
  sql: Sql;
  db: Db;
}

export function createClient(url: string, options: { max?: number } = {}): DatabaseClient {
  const sql = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql, { schema }) };
}

export async function closeClient(sql: Sql): Promise<void> {
  await sql.end({ timeout: 5 });
}
```

- [ ] **Step 5: Create `packages/database/drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
  migrations: { table: "__drizzle_migrations", schema: "public" },
  casing: "snake_case",
  strict: true,
  verbose: true,
});
```

- [ ] **Step 6: Create `packages/database/src/index.ts`**

```ts
export * from "./client.js";
export * from "./schema.js";
```

- [ ] **Step 7: Generate the migration**

Run: `pnpm --filter @harbor/database db:generate`
Expected: creates `packages/database/drizzle/0000_<name>.sql` plus `drizzle/meta/`. Open the SQL and confirm it contains `CREATE TABLE "installation"`, a `CONSTRAINT "installation_singleton" CHECK`, and `"created_at" timestamp with time zone DEFAULT now() NOT NULL`.

- [ ] **Step 8: Verify the build**

Run: `pnpm --filter @harbor/database build`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/database
git commit -m "feat(database): installation schema and postgres client"
```

---

## Task 6: `packages/database` — advisory-locked migration runner

**Files:**
- Create: `packages/database/src/migrate.ts`, `packages/database/src/installation.ts`, `packages/database/src/migrate.test.ts`, `packages/database/vitest.config.ts`
- Modify: `packages/database/src/index.ts`

**Interfaces:**
- Consumes: `createClient`, `closeClient`, `Db` from Task 5
- Produces:
  - `runMigrations(url: string, migrationsFolder: string): Promise<void>`
  - `hasPendingMigrations(db: Db): Promise<boolean>`
  - `getInstallation(db: Db): Promise<Installation | null>`
  - `completeSetup(db: Db): Promise<Installation | null>` — returns `null` when setup was already complete
  - `MIGRATION_LOCK_KEY: bigint`

- [ ] **Step 1: Create `packages/database/vitest.config.ts`**

Container startup makes this test far slower than a unit test, so the timeout is raised deliberately.

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
```

- [ ] **Step 2: Write the failing test**

This is the most important test in Phase 1. It proves the advisory lock actually serializes concurrent boots — the one Phase 1 behavior that can silently corrupt an install.

`packages/database/src/migrate.test.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeClient, createClient } from "./client.js";
import { completeSetup, ensureInstallationRow, getInstallation } from "./installation.js";
import { hasPendingMigrations, runMigrations } from "./migrate.js";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let url: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  url = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await container.stop();
});

describe("runMigrations", () => {
  it("reports pending migrations before running and none after", async () => {
    const { sql, db } = createClient(url, { max: 1 });
    try {
      expect(await hasPendingMigrations(db)).toBe(true);
      await runMigrations(url, migrationsFolder);
      expect(await hasPendingMigrations(db)).toBe(false);
    } finally {
      await closeClient(sql);
    }
  });

  it("applies exactly once when two runners start concurrently", async () => {
    await Promise.all([
      runMigrations(url, migrationsFolder),
      runMigrations(url, migrationsFolder),
    ]);

    const { sql: client, db } = createClient(url, { max: 1 });
    try {
      // postgres.js returns an array directly, NOT { rows: [...] }
      const tables = await db.execute<{ count: string }>(sql`
        select count(*)::text as count from information_schema.tables
        where table_schema = 'public' and table_name = 'installation'
      `);
      expect(tables[0]?.count).toBe("1");

      const constraints = await db.execute<{ count: string }>(sql`
        select count(*)::text as count from information_schema.table_constraints
        where table_name = 'installation' and constraint_name = 'installation_singleton'
      `);
      expect(constraints[0]?.count).toBe("1");
    } finally {
      await closeClient(client);
    }
  });
});

describe("completeSetup", () => {
  it("succeeds once and returns null for the loser of a concurrent race", async () => {
    await runMigrations(url, migrationsFolder);

    const { sql: client, db } = createClient(url, { max: 5 });
    try {
      await ensureInstallationRow(db);

      const [first, second] = await Promise.all([completeSetup(db), completeSetup(db)]);
      const winners = [first, second].filter((r) => r !== null);
      expect(winners).toHaveLength(1);

      const record = await getInstallation(db);
      expect(record?.setupCompletedAt).toBeInstanceOf(Date);
    } finally {
      await closeClient(client);
    }
  });

  it("rejects a second installation row at the database level", async () => {
    await runMigrations(url, migrationsFolder);

    const { sql: client, db } = createClient(url, { max: 1 });
    try {
      await ensureInstallationRow(db);
      await expect(
        db.execute(sql`insert into installation (id) values (false)`),
      ).rejects.toThrow();
    } finally {
      await closeClient(client);
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @harbor/database test`
Expected: FAIL — cannot resolve `./migrate.js` and `./installation.js`.

Docker must be running. If the container fails to pull, run `docker pull postgres:17-alpine` first.

- [ ] **Step 4: Write `packages/database/src/migrate.ts`**

```ts
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeClient, createClient, type Db } from "./client.js";

/** Derived from the ASCII bytes of "HARB". Any stable constant works; it must not change. */
export const MIGRATION_LOCK_KEY = 1212961346n;

const MIGRATIONS_TABLE = "__drizzle_migrations";

/**
 * Applies pending migrations under a PostgreSQL advisory lock.
 *
 * Opens its own single connection rather than using the application pool.
 * pg_advisory_lock is session-scoped, so with a pool the lock and unlock could
 * land on different connections and the guard would silently not hold.
 */
export async function runMigrations(url: string, migrationsFolder: string): Promise<void> {
  const { sql: client, db } = createClient(url, { max: 1 });
  try {
    await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    try {
      await migrate(db, {
        migrationsFolder,
        migrationsTable: MIGRATIONS_TABLE,
        migrationsSchema: "public",
      });
    } finally {
      await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    }
  } finally {
    await closeClient(client);
  }
}

/**
 * True when the migrations table is absent or empty.
 *
 * Must be two statements. PostgreSQL resolves table references at plan time,
 * so a single query referencing the migrations table errors on a fresh
 * database no matter how it is guarded — the existence check has to complete
 * before the table is ever named.
 */
export async function hasPendingMigrations(db: Db): Promise<boolean> {
  const existence = await db.execute<{ present: boolean }>(
    sql`select to_regclass(${`public.${MIGRATIONS_TABLE}`}) is not null as present`,
  );
  if (existence[0]?.present !== true) return true;

  const rows = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from ${sql.identifier(MIGRATIONS_TABLE)}`,
  );
  return rows[0]?.count === "0";
}
```

- [ ] **Step 5: Write `packages/database/src/installation.ts`**

```ts
import { isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { installation, type Installation } from "./schema.js";

export async function getInstallation(db: Db): Promise<Installation | null> {
  const rows = await db.select().from(installation).limit(1);
  return rows[0] ?? null;
}

export async function isSetupComplete(db: Db): Promise<boolean> {
  const record = await getInstallation(db);
  return record?.setupCompletedAt != null;
}

/**
 * Marks setup complete. Returns null when another caller got there first.
 *
 * The WHERE clause is the concurrency guard: the conditional UPDATE is atomic,
 * so exactly one caller can transition the row out of the incomplete state.
 */
export async function completeSetup(db: Db): Promise<Installation | null> {
  const rows = await db
    .update(installation)
    .set({ setupCompletedAt: new Date() })
    .where(isNull(installation.setupCompletedAt))
    .returning();
  return rows[0] ?? null;
}

/** Inserts the singleton row if absent. Safe to call on every boot. */
export async function ensureInstallationRow(db: Db): Promise<void> {
  await db.insert(installation).values({ id: true }).onConflictDoNothing();
}
```

- [ ] **Step 6: Update `packages/database/src/index.ts`**

```ts
export * from "./client.js";
export * from "./installation.js";
export * from "./migrate.js";
export * from "./schema.js";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @harbor/database test`
Expected: PASS, 3 tests. First run takes 30-60 seconds while the Postgres image is pulled.

- [ ] **Step 8: Commit**

```bash
git add packages/database
git commit -m "feat(database): advisory-locked migrations and setup guard"
```

---

## Task 7: `apps/server` — composition root and core plugins

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/src/state.ts`, `apps/server/src/plugins/database.ts`, `apps/server/src/plugins/errors.ts`, `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `@harbor/config`, `@harbor/logger`, `@harbor/shared`, `@harbor/database`
- Produces:
  - `createApp(deps: AppDeps): Promise<FastifyInstance>`
  - `AppDeps = { env: HarborEnv; logger: Logger; db: Db; state: RuntimeState }`
  - `RuntimeState` with mutable `databaseReady`, `migrationsApplied`, `dataDirectoryWritable`, and `startedAt`
  - Fastify decorators `app.db`, `app.state`, `app.env`

- [ ] **Step 1: Create `apps/server/package.json`**

```json
{
  "name": "@harbor/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc --build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@fastify/rate-limit": "11.1.0",
    "@fastify/static": "10.1.0",
    "@harbor/config": "workspace:*",
    "@harbor/database": "workspace:*",
    "@harbor/logger": "workspace:*",
    "@harbor/shared": "workspace:*",
    "fastify": "5.10.0",
    "fastify-plugin": "6.0.0"
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "tsx": "4.23.1",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 2: Create `apps/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"],
  "references": [
    { "path": "../../packages/config" },
    { "path": "../../packages/database" },
    { "path": "../../packages/logger" },
    { "path": "../../packages/shared" }
  ]
}
```

- [ ] **Step 3: Create `apps/server/src/state.ts`**

Readiness is mutable process state, not a computed value. Boot flips these flags as each stage completes, and the readiness endpoint reports them.

```ts
export interface RuntimeState {
  startedAt: number;
  databaseReady: boolean;
  migrationsApplied: boolean;
  dataDirectoryWritable: boolean;
}

export function createRuntimeState(): RuntimeState {
  return {
    startedAt: Date.now(),
    databaseReady: false,
    migrationsApplied: false,
    dataDirectoryWritable: false,
  };
}

export function isReady(state: RuntimeState): boolean {
  return state.databaseReady && state.migrationsApplied && state.dataDirectoryWritable;
}
```

- [ ] **Step 4: Create `apps/server/src/plugins/database.ts`**

The plugin body is assigned to a typed const before being passed to `fp()`. Inlining it makes TypeScript unable to distinguish the callback and async plugin signatures — a documented fastify-plugin pitfall still present in v6.

```ts
import type { Db } from "@harbor/database";
import type { HarborEnv } from "@harbor/config";
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import type { RuntimeState } from "../state.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    state: RuntimeState;
    env: HarborEnv;
  }
}

export interface ContextOptions {
  db: Db;
  state: RuntimeState;
  env: HarborEnv;
}

const contextPlugin: FastifyPluginAsync<ContextOptions> = async (fastify, opts) => {
  fastify.decorate("db", opts.db);
  fastify.decorate("state", opts.state);
  fastify.decorate("env", opts.env);
};

export const context = fp(contextPlugin, { name: "harbor-context", fastify: "5.x" });
```

- [ ] **Step 5: Create `apps/server/src/plugins/errors.ts`**

```ts
import type { ApiErrorBody, ErrorCode } from "@harbor/shared";
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

export class HarborError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "HarborError";
  }
}

function body(code: ErrorCode, message: string, requestId: string): ApiErrorBody {
  return { error: { code, message, requestId } };
}

const errorsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler(function (error, request, reply) {
    if (error instanceof HarborError) {
      this.log.warn({ err: error, requestId: request.id }, "request rejected");
      void reply.status(error.statusCode).send(body(error.code, error.message, request.id));
      return;
    }

    if (error.validation) {
      this.log.warn({ err: error, requestId: request.id }, "request validation failed");
      void reply
        .status(400)
        .send(body("VALIDATION_FAILED", "Request validation failed.", request.id));
      return;
    }

    const status = error.statusCode ?? 500;
    if (status >= 500) {
      // The stack is logged, never serialized into the response.
      this.log.error({ err: error, requestId: request.id }, "unhandled error");
      void reply
        .status(500)
        .send(body("INTERNAL_ERROR", "An internal error occurred.", request.id));
      return;
    }

    this.log.warn({ err: error, requestId: request.id }, "request failed");
    void reply.status(status).send(body("INTERNAL_ERROR", error.message, request.id));
  });
};

export const errors = fp(errorsPlugin, { name: "harbor-errors", fastify: "5.x" });
```

- [ ] **Step 6: Create `apps/server/src/app.ts`**

The two `setNotFoundHandler` registrations are the mechanism that keeps the SPA fallback from swallowing API 404s. `setNotFoundHandler` is encapsulated by prefix, so the one registered inside the `/api/v1` scope only applies there.

```ts
import { randomUUID } from "node:crypto";
import type { HarborEnv } from "@harbor/config";
import type { Db } from "@harbor/database";
import type { Logger } from "@harbor/logger";
import { API_PREFIX, type ApiErrorBody } from "@harbor/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { context } from "./plugins/database.js";
import { errors } from "./plugins/errors.js";
import type { RuntimeState } from "./state.js";

export interface AppDeps {
  env: HarborEnv;
  logger: Logger;
  db: Db;
  state: RuntimeState;
}

export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger,
    trustProxy: deps.env.HARBOR_TRUST_PROXY,
    disableRequestLogging: false,
    genReqId(): string {
      return randomUUID();
    },
  });

  await app.register(context, { db: deps.db, state: deps.state, env: deps.env });
  await app.register(errors);

  await app.register(
    async (api) => {
      api.setNotFoundHandler((request, reply) => {
        const payload: ApiErrorBody = {
          error: { code: "NOT_FOUND", message: "Route not found.", requestId: request.id },
        };
        void reply.status(404).send(payload);
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
```

A request ID is generated server-side rather than echoed from an `x-request-id` header. Accepting a client-supplied value writes unvalidated input into every log line for that request; that can wait until there is a trusted proxy contract to validate against.

- [ ] **Step 7: Verify it compiles**

Run: `pnpm --filter @harbor/server build`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/server
git commit -m "feat(server): composition root, context and error plugins"
```

---

## Task 8: Health module

**Files:**
- Create: `apps/server/src/modules/health/routes.ts`, `apps/server/src/modules/health/routes.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `app.state`, `app.db`, `RuntimeState`, `isReady`
- Produces: routes `GET /api/v1/health`, `GET /api/v1/health/live`, `GET /api/v1/health/ready`; exported plugin `healthRoutes`

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/health/routes.test.ts`:

```ts
import { createLogger } from "@harbor/logger";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { createRuntimeState } from "../../state.js";
import type { Db } from "@harbor/database";
import type { HarborEnv } from "@harbor/config";

const env: HarborEnv = {
  NODE_ENV: "test",
  HARBOR_PORT: 3000,
  HARBOR_HOST: "0.0.0.0",
  DATABASE_URL: "postgresql://harbor:pw@localhost:5432/harbor",
  HARBOR_BASE_URL: "http://localhost:3000",
  HARBOR_SECRET: "0123456789abcdef0123456789abcdef",
  HARBOR_DATA_DIRECTORY: "/data",
  HARBOR_LOG_LEVEL: "silent",
  HARBOR_TRUST_PROXY: false,
};

function build(ready: boolean) {
  const state = createRuntimeState();
  if (ready) {
    state.databaseReady = true;
    state.migrationsApplied = true;
    state.dataDirectoryWritable = true;
  }
  return createApp({
    env,
    logger: createLogger({ level: "silent", production: true }),
    db: {} as Db,
    state,
  });
}

describe("health endpoints", () => {
  it("reports live regardless of dependency state", async () => {
    const app = await build(false);
    const res = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    await app.close();
  });

  it("reports not ready before boot completes", async () => {
    const app = await build(false);
    const res = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      ready: false,
      checks: { database: false, migrations: false, dataDirectory: false },
    });
    await app.close();
  });

  it("reports ready once every check passes", async () => {
    const app = await build(true);
    const res = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true });
    await app.close();
  });

  it("always returns 200 from the summary endpoint", async () => {
    const app = await build(false);
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    const bodyJson = res.json() as { status: string; version: string; uptimeSeconds: number };
    expect(bodyJson.status).toBe("degraded");
    expect(typeof bodyJson.version).toBe("string");
    expect(bodyJson.uptimeSeconds).toBeGreaterThanOrEqual(0);
    await app.close();
  });

  it("returns a JSON error envelope for unknown API routes", async () => {
    const app = await build(true);
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @harbor/server test`
Expected: FAIL — health routes return 404 because they are not registered yet.

- [ ] **Step 3: Create `apps/server/src/modules/health/routes.ts`**

```ts
import type { HealthStatus, ReadinessStatus } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { isReady } from "../../state.js";

export const HARBOR_VERSION = process.env["HARBOR_VERSION"] ?? "0.1.0-dev";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // Liveness deliberately checks nothing external. A failing metadata provider
  // or database must never cause the orchestrator to restart the container.
  fastify.get("/health/live", async (): Promise<{ status: "ok" }> => ({ status: "ok" }));

  fastify.get("/health/ready", async (_request, reply): Promise<ReadinessStatus> => {
    const { state } = fastify;
    const payload: ReadinessStatus = {
      ready: isReady(state),
      checks: {
        database: state.databaseReady,
        migrations: state.migrationsApplied,
        dataDirectory: state.dataDirectoryWritable,
      },
    };
    void reply.status(payload.ready ? 200 : 503);
    return payload;
  });

  fastify.get("/health", async (): Promise<HealthStatus> => {
    const { state } = fastify;
    return {
      status: isReady(state) ? "ok" : "degraded",
      version: HARBOR_VERSION,
      uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
    };
  });
};
```

- [ ] **Step 4: Register the module in `apps/server/src/app.ts`**

Replace the `app.register` block added in Task 7 Step 6 with this version, which registers health routes inside the same prefixed scope:

```ts
  await app.register(
    async (api) => {
      api.setNotFoundHandler((request, reply) => {
        const payload: ApiErrorBody = {
          error: { code: "NOT_FOUND", message: "Route not found.", requestId: request.id },
        };
        void reply.status(404).send(payload);
      });

      await api.register(healthRoutes);
    },
    { prefix: API_PREFIX },
  );
```

Add the import at the top of the file:

```ts
import { healthRoutes } from "./modules/health/routes.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @harbor/server test`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(server): liveness, readiness and health summary endpoints"
```

---

## Task 9: Installation module

**Files:**
- Create: `apps/server/src/modules/installation/routes.ts`, `apps/server/src/modules/installation/routes.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `app.db`, `isSetupComplete` from `@harbor/database`, `HARBOR_VERSION`
- Produces: route `GET /api/v1/installation/state`; exported plugin `installationRoutes`

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/installation/routes.test.ts`:

```ts
import { createLogger } from "@harbor/logger";
import type { Db } from "@harbor/database";
import type { HarborEnv } from "@harbor/config";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { createRuntimeState } from "../../state.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@harbor/database")>();
  return { ...actual, isSetupComplete: vi.fn() };
});

const { isSetupComplete } = await import("@harbor/database");

const env: HarborEnv = {
  NODE_ENV: "test",
  HARBOR_PORT: 3000,
  HARBOR_HOST: "0.0.0.0",
  DATABASE_URL: "postgresql://harbor:pw@localhost:5432/harbor",
  HARBOR_BASE_URL: "http://localhost:3000",
  HARBOR_SECRET: "0123456789abcdef0123456789abcdef",
  HARBOR_DATA_DIRECTORY: "/data",
  HARBOR_LOG_LEVEL: "silent",
  HARBOR_TRUST_PROXY: false,
};

async function build() {
  const state = createRuntimeState();
  state.databaseReady = true;
  state.migrationsApplied = true;
  state.dataDirectoryWritable = true;
  return createApp({
    env,
    logger: createLogger({ level: "silent", production: true }),
    db: {} as Db,
    state,
  });
}

describe("GET /api/v1/installation/state", () => {
  it("reports incomplete setup on a fresh install", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(false);
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ setupComplete: false });
    await app.close();
  });

  it("reports complete setup once configured", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(true);
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(res.json()).toMatchObject({ setupComplete: true });
    await app.close();
  });

  it("exposes only setupComplete and version", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(false);
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(Object.keys(res.json() as object).sort()).toEqual(["setupComplete", "version"]);
    await app.close();
  });
});
```

The third test is a security assertion. This endpoint is unauthenticated by necessity, so its response shape is pinned to prevent a later change from leaking fingerprintable detail.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @harbor/server test`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Register the rate limiter in `apps/server/src/app.ts`**

This endpoint is unauthenticated by necessity, so it needs a request ceiling. The limiter is registered with `global: false` — health checks are polled every 30 seconds by orchestrators and must never be throttled. Routes opt in individually.

Add the import:

```ts
import rateLimit from "@fastify/rate-limit";
```

Register it inside the API scope, before the route modules:

```ts
      await api.register(rateLimit, { global: false });
      await api.register(healthRoutes);
```

- [ ] **Step 4: Create `apps/server/src/modules/installation/routes.ts`**

```ts
import { isSetupComplete } from "@harbor/database";
import type { InstallationState } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { HARBOR_VERSION } from "../health/routes.js";

export const installationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/installation/state",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (): Promise<InstallationState> => {
      return {
        setupComplete: await isSetupComplete(fastify.db),
        version: HARBOR_VERSION,
      };
    },
  );
};
```

- [ ] **Step 5: Register the module in `apps/server/src/app.ts`**

Add the import:

```ts
import { installationRoutes } from "./modules/installation/routes.js";
```

And register it immediately after `healthRoutes` inside the prefixed scope:

```ts
      await api.register(healthRoutes);
      await api.register(installationRoutes);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @harbor/server test`
Expected: PASS, 8 tests total across both module test files.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(server): rate-limited installation state endpoint"
```

---

## Task 10: Boot sequence and graceful shutdown

**Files:**
- Create: `apps/server/src/paths.ts`, `apps/server/src/boot.ts`, `apps/server/src/server.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-9
- Produces:
  - `MIGRATIONS_FOLDER: string` (from `paths.ts`)
  - `bootstrap(): Promise<{ app: FastifyInstance; shutdown: () => Promise<void> }>`
  - executable entrypoint `dist/server.js`

- [ ] **Step 1: Create `apps/server/src/paths.ts`**

This lives in its own module so the CLI can import the migrations location without pulling in the entire boot graph. The environment override exists because the path differs between the workspace layout and the container layout — Task 14 sets it in the image.

```ts
import { fileURLToPath } from "node:url";

export const MIGRATIONS_FOLDER =
  process.env["HARBOR_MIGRATIONS_DIR"] ??
  fileURLToPath(new URL("../../../packages/database/drizzle", import.meta.url));
```

- [ ] **Step 2: Create `apps/server/src/boot.ts`**

The listener binds before dependencies are checked, so a slow migration presents as an honest "starting" signal rather than a connection refusal indistinguishable from a crash.

```ts
import { access, constants, mkdir } from "node:fs/promises";
import { loadEnv } from "@harbor/config";
import { closeClient, createClient, ensureInstallationRow, isSetupComplete, runMigrations } from "@harbor/database";
import { createLogger, type Logger } from "@harbor/logger";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { MIGRATIONS_FOLDER } from "./paths.js";
import { createRuntimeState } from "./state.js";

export interface Bootstrapped {
  app: FastifyInstance;
  shutdown: () => Promise<void>;
}

async function ensureDataDirectory(directory: string, logger: Logger): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.W_OK);
    return true;
  } catch (error) {
    logger.error({ err: error, directory }, "data directory is not writable");
    return false;
  }
}

export async function bootstrap(): Promise<Bootstrapped> {
  // 1. Config. A failure here exits before anything else initializes.
  const env = loadEnv();

  // 2. Logger, with redaction installed before any other code can log.
  const logger = createLogger({
    level: env.HARBOR_LOG_LEVEL,
    production: env.NODE_ENV === "production",
  });

  const state = createRuntimeState();
  const { sql, db } = createClient(env.DATABASE_URL);

  // 3. Bind the listener early so startup progress is observable.
  const app = await createApp({ env, logger, db, state });
  await app.listen({ port: env.HARBOR_PORT, host: env.HARBOR_HOST });
  logger.info({ port: env.HARBOR_PORT }, "listening, readiness pending");

  // 4-5. Database, then migrations under the advisory lock.
  try {
    await sql`select 1`;
    state.databaseReady = true;
    logger.info("database connected");

    await runMigrations(env.DATABASE_URL, MIGRATIONS_FOLDER);
    state.migrationsApplied = true;
    logger.info("migrations applied");

    await ensureInstallationRow(db);
  } catch (error) {
    logger.error({ err: error }, "database initialization failed; staying not-ready");
  }

  // 6. Data directory.
  state.dataDirectoryWritable = await ensureDataDirectory(env.HARBOR_DATA_DIRECTORY, logger);

  // 7. Log install state once. The endpoint queries live rather than caching,
  // because a cached flag goes stale as soon as a second container exists.
  if (state.migrationsApplied) {
    logger.info({ setupComplete: await isSetupComplete(db) }, "installation state");
  }

  logger.info({ ready: state.databaseReady && state.migrationsApplied && state.dataDirectoryWritable }, "boot complete");

  const shutdown = async (): Promise<void> => {
    logger.info("shutting down");
    await app.close();
    await closeClient(sql);
    logger.info("shutdown complete");
  };

  return { app, shutdown };
}
```

- [ ] **Step 3: Create `apps/server/src/server.ts`**

```ts
import { bootstrap } from "./boot.js";

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const { shutdown } = await bootstrap();

  let shuttingDown = false;
  const handle = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    const timer = setTimeout(() => {
      process.exitCode = 1;
      process.exit();
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    void shutdown()
      .then(() => {
        clearTimeout(timer);
        process.exit(0);
      })
      .catch(() => {
        clearTimeout(timer);
        process.exit(1);
      });
    void signal;
  };

  process.on("SIGTERM", () => { handle("SIGTERM"); });
  process.on("SIGINT", () => { handle("SIGINT"); });
}

main().catch((error: unknown) => {
  // The logger may not exist yet if config validation failed, so this is the
  // one place a direct stderr write is correct.
  process.stderr.write(`Harbor failed to start: ${String(error)}\n`);
  process.exit(1);
});
```

`process.stderr.write` is used rather than `console.error` because the `no-console` lint rule is global. This is the one place a direct stderr write is correct: config validation can fail before a logger exists.

- [ ] **Step 4: Verify it compiles**

Run: `pnpm --filter @harbor/server build`
Expected: exit 0.

- [ ] **Step 5: Verify it boots against a real database**

Start Postgres: `docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_USER=harbor -e POSTGRES_DB=harbor --name harbor-boot-test postgres:17-alpine`

Run:
```bash
DATABASE_URL=postgresql://harbor:pw@localhost:5433/harbor \
HARBOR_BASE_URL=http://localhost:3000 \
HARBOR_SECRET=0123456789abcdef0123456789abcdef \
HARBOR_DATA_DIRECTORY=./.tmp-data \
node apps/server/dist/server.js
```

Expected: logs `listening, readiness pending`, then `database connected`, `migrations applied`, `boot complete`.

In another shell: `curl -s localhost:3000/api/v1/health/ready` → `{"ready":true,...}`.

Send `SIGTERM` with Ctrl+C. Expected: logs `shutting down` then `shutdown complete`, exits 0.

Clean up: `docker rm -f harbor-boot-test && rm -rf .tmp-data`

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(server): boot sequence and graceful shutdown"
```

---

## Task 11: CLI migration entrypoint

**Files:**
- Create: `apps/server/src/cli.ts`
- Modify: `apps/server/package.json`

**Interfaces:**
- Consumes: `loadEnv`, `runMigrations`, `MIGRATIONS_FOLDER` from `./paths.js`
- Produces: `node dist/cli.js migrate`

- [ ] **Step 1: Create `apps/server/src/cli.ts`**

```ts
import { loadEnv } from "@harbor/config";
import { runMigrations } from "@harbor/database";
import { createLogger } from "@harbor/logger";
import { MIGRATIONS_FOLDER } from "./paths.js";

const USAGE = "Usage: harbor <migrate>\n";

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command !== "migrate") {
    process.stderr.write(USAGE);
    process.exit(command === undefined ? 1 : 2);
  }

  const env = loadEnv();
  const logger = createLogger({
    level: env.HARBOR_LOG_LEVEL,
    production: env.NODE_ENV === "production",
  });

  logger.info("applying migrations");
  await runMigrations(env.DATABASE_URL, MIGRATIONS_FOLDER);
  logger.info("migrations applied");
}

main().catch((error: unknown) => {
  process.stderr.write(`Migration failed: ${String(error)}\n`);
  process.exit(1);
});
```

This exists for restore-from-backup and manual recovery, where the schema must be brought current without starting the HTTP server. There is deliberately no flag to disable automatic migration at boot.

- [ ] **Step 2: Add the script to `apps/server/package.json`**

Add to `"scripts"`:

```json
    "migrate": "node dist/cli.js migrate",
```

- [ ] **Step 3: Verify it runs**

Start Postgres: `docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_USER=harbor -e POSTGRES_DB=harbor --name harbor-cli-test postgres:17-alpine`

Run:
```bash
pnpm --filter @harbor/server build
DATABASE_URL=postgresql://harbor:pw@localhost:5433/harbor \
HARBOR_BASE_URL=http://localhost:3000 \
HARBOR_SECRET=0123456789abcdef0123456789abcdef \
node apps/server/dist/cli.js migrate
```

Expected: logs `applying migrations` then `migrations applied`, exits 0. Running it a second time succeeds and applies nothing.

Verify the wrong argument path: `node apps/server/dist/cli.js bogus` → prints usage, exits 2.

Clean up: `docker rm -f harbor-cli-test`

- [ ] **Step 4: Commit**

```bash
git add apps/server
git commit -m "feat(server): CLI migrate subcommand"
```

---

## Task 12: `apps/web` — React shell with setup routing

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/index.css`, `apps/web/src/api.ts`, `apps/web/src/routes.tsx`, `apps/web/src/pages/Setup.tsx`, `apps/web/src/pages/Home.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/installation/state`
- Produces: static build output at `apps/server/public/`

- [ ] **Step 1: Create `apps/web/package.json`**

Note `react-router`, not `react-router-dom` — the latter was removed in v8 and is frozen at 7.18.1 on npm.

```json
{
  "name": "@harbor/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run --passWithNoTests",
    "dev": "vite"
  },
  "dependencies": {
    "@tanstack/react-query": "5.101.2",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "react-router": "8.2.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@testing-library/dom": "10.4.1",
    "@testing-library/react": "16.3.2",
    "@types/react": "19.2.7",
    "@types/react-dom": "19.2.7",
    "@vitejs/plugin-react": "6.0.3",
    "jsdom": "29.1.1",
    "tailwindcss": "4.3.3",
    "typescript": "6.0.3",
    "vite": "8.1.5",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 2: Create `apps/web/tsconfig.json`**

The web package targets the DOM and does not use `composite`, so it needs its own options rather than extending the Node-oriented base.

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "es2023",
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["es2023", "dom", "dom.iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client", "vitest/globals"],
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `apps/web/vite.config.ts`**

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
```

- [ ] **Step 4: Create `apps/web/vitest.config.ts`**

A separate file is required: Vitest 4 rejects a `test` key inside `vite.config.ts` with `TS2769`.

```ts
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: { environment: "jsdom", globals: true },
  }),
);
```

- [ ] **Step 5: Create `apps/web/index.html`**

`class="dark"` on `<html>` makes the dark palette the pre-hydration default so there is no flash of a light theme.

```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Harbor</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `apps/web/src/index.css`**

Tailwind 4 is CSS-first. `@import "tailwindcss";` replaces the three `@tailwind` directives, which no longer exist.

```css
@import "tailwindcss";

@custom-variant dark (&:where(.dark, .dark *));

@theme {
  --color-harbor-950: oklch(0.18 0.04 265);
  --color-harbor-900: oklch(0.24 0.05 265);
  --color-harbor-800: oklch(0.30 0.05 265);
  --color-accent-500: oklch(0.62 0.19 275);
  --color-accent-400: oklch(0.70 0.17 285);
  --font-display: "Inter", ui-sans-serif, system-ui, sans-serif;
  --radius-card: 0.75rem;
}

:root {
  --surface: var(--color-harbor-950);
  --text: oklch(0.97 0.01 265);
}

body {
  background-color: var(--surface);
  color: var(--text);
}
```

- [ ] **Step 7: Create `apps/web/src/api.ts`**

```ts
export interface InstallationState {
  setupComplete: boolean;
  version: string;
}

export async function fetchInstallationState(signal: AbortSignal): Promise<InstallationState> {
  const response = await fetch("/api/v1/installation/state", { signal });
  if (!response.ok) {
    throw new Error(`Installation state request failed with ${String(response.status)}`);
  }
  return (await response.json()) as InstallationState;
}
```

- [ ] **Step 8: Create the placeholder pages**

Note: these files import the `JSX` type explicitly. Under `jsx: "react-jsx"` there is no automatic `React` value or namespace in scope, so writing `React.JSX.Element` without an import is a type error.

`apps/web/src/pages/Setup.tsx`:

```tsx
import type { JSX } from "react";

export function Setup(): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md rounded-card bg-harbor-900 p-8">
        <h1 className="text-2xl font-display">Welcome to Harbor</h1>
        <p className="mt-3 text-sm opacity-80">
          This server has not been set up yet. The onboarding wizard arrives in Phase 2.
        </p>
      </div>
    </main>
  );
}
```

`apps/web/src/pages/Home.tsx`:

```tsx
import type { JSX } from "react";

export function Home(): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md rounded-card bg-harbor-900 p-8">
        <h1 className="text-2xl font-display">Harbor</h1>
        <p className="mt-3 text-sm opacity-80">This server is configured.</p>
      </div>
    </main>
  );
}
```

- [ ] **Step 9: Create `apps/web/src/routes.tsx`**

```tsx
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router";
import { fetchInstallationState } from "./api";
import { Home } from "./pages/Home";
import { Setup } from "./pages/Setup";

function useInstallationState() {
  return useQuery({
    queryKey: ["installation-state"],
    queryFn: ({ signal }) => fetchInstallationState(signal),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 2,
  });
}

function RootLayout(): JSX.Element {
  const location = useLocation();
  const { data, isPending, isError } = useInstallationState();

  if (isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center" role="status">
        Starting Harbor…
      </main>
    );
  }

  if (isError) {
    return (
      <main className="flex min-h-screen items-center justify-center" role="alert">
        Harbor is unavailable. Check the server logs.
      </main>
    );
  }

  const onSetup = location.pathname === "/setup";

  if (!data.setupComplete && !onSetup) return <Navigate to="/setup" replace />;
  if (data.setupComplete && onSetup) return <Navigate to="/home" replace />;

  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    children: [
      { index: true, Component: () => <Navigate to="/home" replace /> },
      { path: "setup", Component: Setup },
      { path: "home", Component: Home },
    ],
  },
]);
```

- [ ] **Step 10: Create `apps/web/src/main.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import { router } from "./routes";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 11: Verify the build**

Run: `pnpm --filter @harbor/web build`
Expected: `tsc --noEmit` passes, then Vite writes `index.html` and `assets/` into `apps/server/public/`.

Verify: `ls apps/server/public` shows `index.html` and `assets/`.

- [ ] **Step 12: Commit**

```bash
git add apps/web
git commit -m "feat(web): React shell with setup-state routing"
```

---

## Task 13: Serve the web application from Fastify

**Files:**
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/src/plugins/static.ts`

**Interfaces:**
- Consumes: `@fastify/static`, build output at `apps/server/public`
- Produces: static asset serving with an SPA fallback that never shadows `/api/v1/*`

- [ ] **Step 1: Create `apps/server/src/plugins/static.ts`**

The root `setNotFoundHandler` returns `index.html` so client-side routes resolve. Because `setNotFoundHandler` is encapsulated by prefix, the JSON handler registered inside the `/api/v1` scope in Task 7 still wins for API routes — unknown API paths get a JSON error, everything else gets the app shell.

```ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const staticPluginAsync: FastifyPluginAsync = async (fastify) => {
  if (!existsSync(PUBLIC_DIR)) {
    fastify.log.warn({ dir: PUBLIC_DIR }, "web assets missing; serving API only");
    return;
  }

  await fastify.register(fastifyStatic, { root: PUBLIC_DIR, wildcard: false });

  const indexPath = path.join(PUBLIC_DIR, "index.html");

  fastify.setNotFoundHandler(async (_request, reply) => {
    const html = await readFile(indexPath, "utf8");
    return reply.status(200).type("text/html").send(html);
  });
};

export const staticAssets = fp(staticPluginAsync, { name: "harbor-static", fastify: "5.x" });
```

`wildcard: false` is required so `@fastify/static` does not install its own catch-all route, which would otherwise conflict with the not-found handler.

- [ ] **Step 2: Register it last in `apps/server/src/app.ts`**

Add the import:

```ts
import { staticAssets } from "./plugins/static.js";
```

Register it after the API scope, immediately before `return app;`:

```ts
  await app.register(staticAssets);

  return app;
```

Order matters: the API scope must be registered first so its routes and its scoped 404 take precedence.

- [ ] **Step 3: Write the failing test**

Add to `apps/server/src/modules/health/routes.test.ts`:

```ts
  it("returns a JSON 404 for unknown API routes even with the SPA fallback active", async () => {
    const app = await build(true);
    const res = await app.inject({ method: "GET", url: "/api/v1/definitely-not-a-route" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    await app.close();
  });
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @harbor/server test`
Expected: PASS. If the assets directory is absent the static plugin logs a warning and skips, and this test still passes because the API 404 is scoped independently.

- [ ] **Step 5: Verify end to end with assets present**

```bash
pnpm --filter @harbor/web build
pnpm --filter @harbor/server build
```

Boot the server as in Task 10 Step 4, then:

- `curl -s -o /dev/null -w "%{http_code}" localhost:3000/` → `200`
- `curl -s localhost:3000/setup | head -c 20` → HTML, not JSON
- `curl -s localhost:3000/api/v1/nope` → `{"error":{"code":"NOT_FOUND",...}}`

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(server): serve web assets with scoped SPA fallback"
```

---

## Task 14: Production Docker image

**Files:**
- Create: `Dockerfile`, `.dockerignore`

**Interfaces:**
- Consumes: the whole workspace
- Produces: image exposing port 3000, running as non-root, with a health check

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
**/node_modules
**/dist
**/.turbo
.git
.github
docs
*.md
.env
.env.*
apps/server/public
coverage
```

- [ ] **Step 2: Create `Dockerfile`**

FFmpeg is deliberately not installed. It arrives in Phase 5 when media inspection needs it; adding it now would inflate the image for no current benefit.

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS dependencies
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/config/package.json ./packages/config/
COPY packages/database/package.json ./packages/database/
COPY packages/logger/package.json ./packages/logger/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
WORKDIR /app
COPY . .
RUN pnpm run build
RUN pnpm deploy --filter=@harbor/server --prod --legacy /app/deploy

FROM node:24-alpine AS runtime
RUN apk add --no-cache wget && addgroup -S harbor && adduser -S harbor -G harbor
WORKDIR /app

COPY --from=builder --chown=harbor:harbor /app/deploy/node_modules ./node_modules
COPY --from=builder --chown=harbor:harbor /app/apps/server/dist ./dist
COPY --from=builder --chown=harbor:harbor /app/apps/server/public ./public
COPY --from=builder --chown=harbor:harbor /app/packages/database/drizzle ./packages/database/drizzle

ENV NODE_ENV=production \
    HARBOR_PORT=3000 \
    HARBOR_HOST=0.0.0.0 \
    HARBOR_DATA_DIRECTORY=/data \
    HARBOR_MIGRATIONS_DIR=/app/packages/database/drizzle

RUN mkdir -p /data && chown -R harbor:harbor /data
VOLUME ["/data"]

USER harbor
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD wget --spider --quiet http://localhost:3000/api/v1/health || exit 1

CMD ["node", "dist/server.js"]
```

- [ ] **Step 3: Confirm the migrations path override is set**

`paths.ts` resolves `MIGRATIONS_FOLDER` relative to its own location, which is correct in the workspace (`apps/server/dist/` → `../../../packages/database/drizzle`) but wrong in the image, where `dist/` sits directly at `/app/dist`. The `HARBOR_MIGRATIONS_DIR` override in the `ENV` block above handles this.

Verify the `Dockerfile` `ENV` block contains:

```dockerfile
    HARBOR_MIGRATIONS_DIR=/app/packages/database/drizzle
```

and that the `COPY` of `packages/database/drizzle` places the SQL files at exactly that path.

- [ ] **Step 4: Build the image**

Run: `docker build -t harbor:dev .`
Expected: build succeeds. Note the final image size from `docker images harbor:dev`.

- [ ] **Step 5: Verify it runs as non-root**

Run: `docker run --rm --entrypoint sh harbor:dev -c "id -u"`
Expected: a non-zero UID, not `0`.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build: multi-stage production image"
```

---

## Task 15: Compose deployments

**Files:**
- Create: `docker-compose.yml`, `docker-compose.dev.yml`, `.env.example`

**Interfaces:**
- Consumes: `harbor:dev` image or `ghcr.io/harbor-media/harbor`
- Produces: a working two-container stack and a Postgres-only development stack

- [ ] **Step 1: Create `.env.example`**

```
# Public URL where Harbor is reachable.
HARBOR_BASE_URL=http://localhost:3000

# Encryption secret. Generate with: openssl rand -hex 32
# Must be at least 32 characters. Changing it invalidates sessions.
HARBOR_SECRET=replace-me-with-32-plus-random-characters

# PostgreSQL password for the harbor role.
POSTGRES_PASSWORD=replace-me

# Optional. error | warn | info | debug | trace
HARBOR_LOG_LEVEL=info

# Optional. Set true when running behind a reverse proxy.
HARBOR_TRUST_PROXY=false
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  harbor:
    image: ghcr.io/harbor-media/harbor:latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://harbor:${POSTGRES_PASSWORD}@postgres:5432/harbor
      HARBOR_BASE_URL: ${HARBOR_BASE_URL}
      HARBOR_SECRET: ${HARBOR_SECRET}
      HARBOR_LOG_LEVEL: ${HARBOR_LOG_LEVEL:-info}
      HARBOR_TRUST_PROXY: ${HARBOR_TRUST_PROXY:-false}
      HARBOR_DATA_DIRECTORY: /data
    ports:
      - "3000:3000"
    volumes:
      - harbor_data:/data
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--spider", "--quiet", "http://localhost:3000/api/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: harbor
      POSTGRES_USER: harbor
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - harbor_postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U harbor -d harbor"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  harbor_data:
  harbor_postgres:
```

PostgreSQL deliberately publishes no ports. It is reachable only on the Compose network.

- [ ] **Step 3: Create `docker-compose.dev.yml`**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: harbor
      POSTGRES_USER: harbor
      POSTGRES_PASSWORD: harbor
    ports:
      - "5432:5432"
    volumes:
      - harbor_postgres_dev:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U harbor -d harbor"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  harbor_postgres_dev:
```

Development runs only PostgreSQL in Docker; the server and web app run on the host with hot reload.

- [ ] **Step 4: Verify the production stack against a locally built image**

```bash
cp .env.example .env
sed -i 's/replace-me-with-32-plus-random-characters/'"$(openssl rand -hex 32)"'/' .env
sed -i 's/^POSTGRES_PASSWORD=replace-me/POSTGRES_PASSWORD=devpassword/' .env
docker build -t ghcr.io/harbor-media/harbor:latest .
docker compose up -d
```

Wait for health, then:
- `curl -s localhost:3000/api/v1/health/ready` → `{"ready":true,...}`
- `curl -s localhost:3000/api/v1/installation/state` → `{"setupComplete":false,...}`

- [ ] **Step 5: Verify state survives container replacement**

```bash
docker compose down
docker compose up -d
curl -s localhost:3000/api/v1/health/ready
```

Expected: ready again, with migrations reported as already applied rather than re-run. Volumes persist.

Clean up: `docker compose down -v && rm .env`

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml docker-compose.dev.yml .env.example
git commit -m "build: production and development compose stacks"
```

---

## Task 16: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/smoke.sh`

**Interfaces:**
- Consumes: every task above
- Produces: CI running lint, typecheck, tests, build, image build, and a container smoke test. No publishing.

- [ ] **Step 1: Create `scripts/smoke.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-harbor:dev}"
NETWORK="harbor-smoke-$$"
PG="harbor-smoke-pg-$$"
APP="harbor-smoke-app-$$"

cleanup() {
  docker rm -f "$APP" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NETWORK" >/dev/null

docker run -d --name "$PG" --network "$NETWORK" \
  -e POSTGRES_DB=harbor -e POSTGRES_USER=harbor -e POSTGRES_PASSWORD=smoke \
  postgres:17-alpine >/dev/null

echo "waiting for postgres..."
for _ in $(seq 1 30); do
  if docker exec "$PG" pg_isready -U harbor -d harbor >/dev/null 2>&1; then break; fi
  sleep 1
done

docker run -d --name "$APP" --network "$NETWORK" -p 3000:3000 \
  -e DATABASE_URL="postgresql://harbor:smoke@$PG:5432/harbor" \
  -e HARBOR_BASE_URL=http://localhost:3000 \
  -e HARBOR_SECRET=0123456789abcdef0123456789abcdef \
  "$IMAGE" >/dev/null

echo "waiting for readiness..."
ready=false
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:3000/api/v1/health/ready >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done

if [ "$ready" != "true" ]; then
  echo "FAIL: readiness never reported true"
  docker logs "$APP"
  exit 1
fi

echo "checking endpoints..."
curl -fsS http://localhost:3000/api/v1/health/live  | grep -q '"status":"ok"'
curl -fsS http://localhost:3000/api/v1/health       | grep -q '"version"'
curl -fsS http://localhost:3000/api/v1/installation/state | grep -q '"setupComplete":false'

echo "checking API 404 shape..."
curl -sS http://localhost:3000/api/v1/nope | grep -q '"code":"NOT_FOUND"'

echo "checking no secrets in logs..."
if docker logs "$APP" 2>&1 | grep -q "0123456789abcdef0123456789abcdef"; then
  echo "FAIL: HARBOR_SECRET leaked into logs"
  exit 1
fi

echo "checking graceful shutdown..."
docker stop --timeout 20 "$APP" >/dev/null
code=$(docker inspect "$APP" --format '{{.State.ExitCode}}')
if [ "$code" != "0" ]; then
  echo "FAIL: exit code $code after SIGTERM"
  docker logs "$APP"
  exit 1
fi

echo "SMOKE PASSED"
```

The secret-leak check is a real assertion, not decoration: it fails the build if configuration ever ends up in log output.

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/smoke.sh && git update-index --chmod=+x scripts/smoke.sh`

- [ ] **Step 3: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10.33.4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        run: pnpm test

      - name: Build
        run: pnpm build

  image:
    runs-on: ubuntu-latest
    needs: verify
    steps:
      - uses: actions/checkout@v4

      - name: Build image
        run: docker build -t harbor:ci .

      - name: Smoke test
        run: bash scripts/smoke.sh harbor:ci
```

There is no publish job. Publishing, multi-architecture manifests, and version tags are Phase 7, and pull requests must never publish images.

- [ ] **Step 4: Verify the smoke test locally**

Run: `docker build -t harbor:ci . && bash scripts/smoke.sh harbor:ci`
Expected: ends with `SMOKE PASSED`.

- [ ] **Step 5: Commit**

```bash
git add .github scripts
git commit -m "ci: lint, typecheck, test, build and container smoke test"
```

---

## Task 17: Developer documentation

**Files:**
- Modify: `README.md`
- Create: `docs/development.md`

**Interfaces:**
- Consumes: every task above
- Produces: instructions sufficient to run Harbor locally from a clean checkout

- [ ] **Step 1: Replace `README.md`**

```markdown
# Harbor

A self-hosted media server with a catalog-first library experience.

Harbor is deployed by the person hosting it. Every installation owns its own
users, configuration, library, and watch history. There is no central Harbor
service.

## Status

Phase 1 (foundation) — the server boots, migrates, serves the web application,
and reports health. Authentication and the onboarding wizard arrive in Phase 2.

## Quick start

```bash
cp .env.example .env
# edit .env, then:
docker compose up -d
```

Open http://localhost:3000.

## Development

See [docs/development.md](docs/development.md).

## License

GPL-2.0. See [LICENSE](LICENSE).
```

- [ ] **Step 2: Create `docs/development.md`**

```markdown
# Development

## Requirements

- Node >= 22.22 (24 recommended)
- pnpm 10.33.4
- Docker

## Setup

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d
```

Create `apps/server/.env`:

```
DATABASE_URL=postgresql://harbor:harbor@localhost:5432/harbor
HARBOR_BASE_URL=http://localhost:5173
HARBOR_SECRET=0123456789abcdef0123456789abcdef
HARBOR_DATA_DIRECTORY=./.data
HARBOR_LOG_LEVEL=debug
NODE_ENV=development
```

## Running

```bash
pnpm dev
```

The API runs on :3000 and the web dev server on :5173, which proxies `/api` to
the backend. Open http://localhost:5173.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Server and web with hot reload |
| `pnpm build` | Build all packages |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript, no emit |
| `pnpm test` | Vitest (database tests need Docker) |
| `pnpm docker:build` | Build the production image |
| `pnpm docker:smoke` | Run the container smoke test |

## Database

Migrations apply automatically at boot. To generate a new one after changing
`packages/database/src/schema.ts`:

```bash
pnpm --filter @harbor/database db:generate
```

Commit the generated SQL. To apply migrations without starting the server:

```bash
pnpm --filter @harbor/server migrate
```

## Notes

- TypeScript is pinned to 6.0.3. TypeScript 7 is not yet supported by
  typescript-eslint. See the Phase 1 design spec.
- Install `react-router`, never `react-router-dom` — the latter was removed in v8.
- Database integration tests start a real PostgreSQL container via Testcontainers.
  The first run pulls `postgres:17-alpine`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/development.md
git commit -m "docs: development setup and quick start"
```

---

## Definition of Done

Verify each against the design spec before declaring Phase 1 complete.

1. `pnpm install && pnpm dev` runs server and web with hot reload against Compose PostgreSQL.
2. `docker compose up` produces a working stack from a clean volume.
3. A fresh install serves `/setup`; a completed install redirects away from it.
4. All three health endpoints return correct values in healthy and degraded states.
5. Migrations apply exactly once under concurrent boot, and `cli.js migrate` brings a schema current without starting the server.
6. `SIGTERM` drains and exits zero.
7. Logs are structured JSON with no secrets present.
8. Container replacement preserves all state.
9. Lint, typecheck, and tests pass in CI.
