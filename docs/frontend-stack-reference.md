# Harbor Frontend Stack — Verified API Reference

**Verification method:** every version below was installed into a scratch project (`npm install`, clean, zero peer warnings), type-checked with `tsc --noEmit`, built with `vite build`, and tested with `vitest run`. The dev-server proxy was exercised against a live upstream. Anything not confirmed this way is marked **UNCONFIRMED**.

> **Note:** verification ran against TypeScript 7.0.2, but Harbor builds on **TypeScript 6.0.3**. See [the Phase 1 design spec](superpowers/specs/2026-07-19-harbor-phase-1-foundation-design.md) — `typescript-eslint@8.64.0` declares `typescript: ">=4.8.4 <6.1.0"` and so cannot parse TS 7. Nothing else in this document is affected; all snippets compile identically under both.

## Confirmed dependency set

```json
{
  "dependencies": {
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "react-router": "8.2.0",
    "@tanstack/react-query": "5.101.2"
  },
  "devDependencies": {
    "vite": "8.1.5",
    "@vitejs/plugin-react": "6.0.3",
    "tailwindcss": "4.3.3",
    "@tailwindcss/vite": "4.3.3",
    "typescript": "6.0.3",
    "vitest": "4.1.10",
    "jsdom": "^28.0.0",
    "@testing-library/react": "16.3.2",
    "@testing-library/dom": "^10.4.0",
    "@testing-library/jest-dom": "^6.9.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0"
  }
}
```

**Node requirement for Harbor:** `>=22.22.0`.
Vite 8 declares `engines: { node: "^20.19.0 || >=22.12.0" }`, but React Router v8 documents a minimum of `node@22.22+`. Take the stricter one. Verified working on Node v24.15.0.

---

## 1. Vite 8

### ⚠️ Biggest change vs Vite 5/6: the bundler was replaced

**Vite 8 uses Rolldown + Oxc instead of esbuild + Rollup.** This is the headline change. Dependency optimization, JS transforms, and JS minification are all Oxc/Rolldown now; CSS minification is Lightning CSS.

For a standard React SPA this is transparent — the config below builds unchanged. It matters if you touch `build.rollupOptions`.

### Plugin package — unchanged name, new major

Still `@vitejs/plugin-react`. Current: **6.0.3**, peer `vite: ^8.0.0`.

```json
{ "peerDependencies": { "vite": "^8.0.0",
  "@rolldown/plugin-babel": "^0.1.7 || ^0.2.0",
  "babel-plugin-react-compiler": "^1.0.0" },
  "peerDependenciesMeta": { "@rolldown/plugin-babel": { "optional": true },
                            "babel-plugin-react-compiler": { "optional": true } } }
```

Both Babel peers are **optional** — do not install them. Plain Fast Refresh + JSX works with `@vitejs/plugin-react` alone (verified: 121 modules transformed, build succeeded).

### Exact config (verified building)

`apps/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
})
```

`base`, `build.outDir`, and `server.proxy` schemas are **unchanged from Vite 5/6**.

**Proxy verified live.** Request to `http://localhost:5199/api/v1/health` reached the upstream as:

```
{"gotPath":"/api/v1/health","hostHeader":"localhost:3111"}
```

Path is preserved in full (no rewrite needed for a `/api/v1` backend); `changeOrigin: true` rewrites the `Host` header to the target. `server.proxy` now extends **`http-proxy-3`** (was `http-proxy`) — relevant only if you pass advanced options. If `base` is non-relative, proxy keys must be prefixed with that base.

### Breaking changes in the config schema

Deprecated (still work, will be removed):

| Old | New |
| --- | --- |
| `build.rollupOptions` | `build.rolldownOptions` |
| `worker.rollupOptions` | `worker.rolldownOptions` |
| `build.commonjsOptions` | now a no-op |
| `build.dynamicImportVarsOptions.warnOnError` | now a no-op |
| `resolve.alias[].customResolver` | custom plugin with `resolveId` + `enforce: 'pre'` |

Removed outright:

- `build.rollupOptions.watch.chokidar` → `build.rolldownOptions.watch.watcher`
- **Object form of `build.rollupOptions.output.manualChunks` is removed**; function form is deprecated. Use Rolldown's `codeSplitting`. ⚠️ *Manual chunking was a very common Vite 5/6 pattern — this is the config change most likely to bite an existing project.*
- Passing a URL to `import.meta.hot.accept` (pass an id)
- `output.format: 'system'` and `'amd'`
- `import.meta.url` is no longer polyfilled in UMD/IIFE output

Default `build.target` (`'baseline-widely-available'`) moved up: Chrome 107→111, Edge 107→111, Firefox 104→114, Safari 16.0→16.4.

Not applicable to Harbor but worth knowing: `plugin-legacy` can no longer transform to ES5; extglobs are not yet supported; all Rollup parallel hooks now run sequentially.

---

## 2. Tailwind CSS 4.3.3

Correct — CSS-first, no `tailwind.config.js`.

### Vite plugin

Package is **`@tailwindcss/vite`**, version `4.3.3` (versioned in lockstep with `tailwindcss`). Wiring is one line in the `plugins` array — see the vite.config.ts above.

### Is PostCSS involved?

**No, not in the Vite path.** `@tailwindcss/vite` depends only on `@tailwindcss/oxide`, `@tailwindcss/node`, and `tailwindcss` — no `postcss` dependency. `tailwindcss` itself has **zero** runtime dependencies. There is no `postcss.config.js`, no `autoprefixer`, no `postcss-import`.

(`postcss` does appear in `node_modules` — Vite itself pulls it in for its own CSS pipeline. That is not Tailwind's, and you do not configure it.)

A separate `@tailwindcss/postcss@4.3.3` package exists for non-Vite builds. **Do not use it here** — with Vite, `@tailwindcss/vite` is the faster and correct path.

### Exact CSS file (verified compiling)

`apps/web/src/index.css`:

```css
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

@theme {
  /* Harbor brand — deep navy surfaces, blue/violet accents */
  --color-harbor-950: oklch(0.18 0.04 265);
  --color-harbor-900: oklch(0.24 0.05 265);
  --color-harbor-800: oklch(0.30 0.05 265);
  --color-accent-500: oklch(0.62 0.19 275);
  --color-accent-400: oklch(0.70 0.17 285);

  --font-display: "Inter", ui-sans-serif, system-ui, sans-serif;
  --radius-card: 0.75rem;
}
```

⚠️ **`@import "tailwindcss";` replaces the three `@tailwind base/components/utilities` directives** that were standard through Tailwind 3. Those directives no longer exist.

**Verified emitted output** — `--color-harbor-950: oklch(18% .04 265)` appears in the built CSS, and `bg-harbor-950`, `font-display`, `rounded-card` all resolved as utilities. Naming is mechanical: a `--color-*` token yields `bg-*` / `text-*` / `border-*`; `--font-*` yields `font-*`; `--radius-*` yields `rounded-*`.

By default Tailwind only emits CSS variables that are actually used. To always emit every token (useful if you read tokens from JS or hand-written CSS), use `@theme static { … }`.

### Dark-first design

Tailwind's default `dark:` variant follows `prefers-color-scheme`. For an operator-controlled dark-first UI you override the variant. Two documented forms:

```css
/* class-based (matches <html class="dark">) */
@custom-variant dark (&:where(.dark, .dark *));

/* or data-attribute based (matches <html data-theme="dark">) */
@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
```

For dark-*first*, put `class="dark"` on `<html>` in `index.html` so the dark palette is the pre-hydration default and never flashes light:

```html
<html lang="en" class="dark">
```

Semantic CSS variables layer on top of the `@theme` tokens:

```css
:root {
  --surface: var(--color-harbor-950);
  --surface-raised: var(--color-harbor-900);
  --text: oklch(0.97 0.01 265);
}
```

Reference these in custom CSS as `var(--surface)`. Tokens declared in `@theme` are available as plain CSS variables anywhere in your stylesheet.

---

## 3. React Router 8.2.0

### ⚠️ Install `react-router`, NOT `react-router-dom`

**v8 removes the `react-router-dom` re-export package entirely.** `react-router-dom` on npm is frozen at `7.18.1` and will not receive v8. This is the single most important change for a fresh project.

```sh
npm install react-router      # 8.2.0
npm uninstall react-router-dom
```

Import rule in v8:

- Everything general → `react-router`
- **DOM-specific APIs → `react-router/dom`**

`react-router/dom` exports exactly: `HydratedRouter`, `RouterProvider`, `unstable_RSCHydratedRouter`, `unstable_createCallServer`, `unstable_getRSCStream`.

⚠️ **`RouterProvider` should be imported from `react-router/dom`** in a browser SPA. A `RouterProvider` is also still exported from the root `react-router` (both compile), but the docs direct DOM apps to the `/dom` subpath. Both were verified to build; use `/dom`.

### Recommended API for a client-side SPA

**`createBrowserRouter` + `RouterProvider` remains correct.** The framework/data/declarative mode split did not change this — a client-side SPA is "data mode," and data mode is `createBrowserRouter`. No framework mode, no `react-router.config.ts`, no `@react-router/dev` Vite plugin needed.

### Exact code (verified: tsc clean, vite build clean)

`apps/web/src/routes.tsx`:

```tsx
import {
  createBrowserRouter,
  Outlet,
  redirect,
  useNavigate,
  useNavigation,
  useLoaderData,
} from 'react-router'
import { RouterProvider } from 'react-router/dom'

function RootLayout() {
  const navigation = useNavigation()
  const navigate = useNavigate()

  return (
    <div className="bg-harbor-950 font-display">
      {/* route-level loading state: global pending indicator */}
      {navigation.state === 'loading' && <div role="status">loading…</div>}
      <button onClick={() => void navigate('/login', { replace: true })}>
        Sign out
      </button>
      <Outlet />
    </div>
  )
}

function Home() {
  const data = useLoaderData() as { name: string }
  return <h1 className="rounded-card">{data.name}</h1>
}

export const router = createBrowserRouter([
  {
    path: '/',
    Component: RootLayout,
    HydrateFallback: () => <div>Starting Harbor…</div>,
    errorElement: <div>Something went wrong.</div>,
    children: [
      {
        index: true,
        // programmatic redirect from a loader
        loader: async () => {
          const res = await fetch('/api/v1/me')
          if (res.status === 401) throw redirect('/login')
          return { name: 'harbor' }
        },
        Component: Home,
      },
      {
        path: 'login',
        lazy: async () => ({ Component: () => <div>login</div> }),
      },
    ],
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
```

Notes on the shape above:

- `Component:` (capital C, a component reference) is preferred over `element:` (JSX). Both work.
- `HydrateFallback` is required on the root route if any route has a loader and you are not server-rendering — it renders during initial loader resolution.
- `redirect(path)` is **thrown**, not returned, when short-circuiting a loader.
- `useNavigate()` returns the imperative navigator; `navigate(to, { replace: true })` for redirect-without-history.
- Route-level loading: `useNavigation().state` is `'idle' | 'loading' | 'submitting'`.
- `lazy: async () => ({ Component })` is the code-splitting form.

### What changed from v6/v7

| | |
| --- | --- |
| **Minimum versions** | `node@22.22+`, `react@19.2.7+` / `react-dom@19.2.7+` — peer range is literally `>=19.2.7`, so React 19.2.7 is the floor, not a coincidence |
| **`react-router-dom`** | removed; import from `react-router` and `react-router/dom` |
| **v7 future flags now default** | `v8_middleware`, `v8_splitRouteModules`, `v8_viteEnvironmentApi`, `v8_passThroughRequests`, `v8_trailingSlashAwareDataRequests` |
| **`meta`/`matches` `data` values** | semantics changed (framework mode) |
| **Cloudflare dev proxy** | removed; use `@cloudflare/vite-plugin` (N/A for Harbor) |
| **Stabilized** | `unstable_mask` → `mask` on `<Link>`, `useLinkClickHandler`, `useNavigate`; `Location.unstable_mask` → `Location.mask` |

v6 → v8 in one hop is not documented; the official path is v6 → v7 → v8.

---

## 4. TanStack Query 5.101.2

Peer dependency is `react: "^18 || ^19"` — **React 19 fully supported, no compatibility shims, no notes, no workarounds.** Installed against React 19.2.7 with zero peer warnings.

### Setup (verified)

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppRouter />
    </QueryClientProvider>
  </StrictMode>,
)
```

Create the `QueryClient` at module scope (as above) or in `useState(() => new QueryClient())`. Module scope is correct for a browser-only SPA — there is no request isolation to worry about.

### `useQuery` — object form only

The positional-argument overloads were removed in v5. Object form is the only signature.

```ts
useQuery({ queryKey, queryFn, ...options }): UseQueryResult<TData, TError>
```

### App-boot config query that must never refetch on focus

```tsx
import { useQuery } from '@tanstack/react-query'

export function useServerConfig() {
  return useQuery({
    queryKey: ['server-config'],
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/v1/config', { signal })
      if (!res.ok) throw new Error('config failed')
      return res.json() as Promise<{ setupComplete: boolean }>
    },
    staleTime: Infinity,        // never goes stale
    gcTime: Infinity,           // never garbage-collected
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: 2,
  })
}
```

`staleTime: Infinity` alone is sufficient to stop focus refetches (a fresh query never refetches). Setting the three `refetchOn*` flags to `false` explicitly is belt-and-braces and self-documenting. ⚠️ `cacheTime` was renamed to **`gcTime`** in v5 — a v4 holdover that is silently ignored if you use the old name.

The `queryFn` receives `{ signal }` — forward it to `fetch` so Harbor's in-flight requests cancel on unmount.

Other v5 API surface confirmed present: `queryOptions`, `infiniteQueryOptions`, `mutationOptions`, `skipToken`, `useSuspenseQuery`, `usePrefetchQuery`, `experimental_streamedQuery`, `keepPreviousData`.

---

## 5. Vitest 4.1.10 + React

### ⚠️ Config schema change: `test` in `vite.config.ts` no longer type-checks

This is the one thing that will trip you up. In Vitest 3 and earlier, a `test: {}` key inside `defineConfig` from `vite` type-checked via global augmentation. **In Vitest 4 it does not.** Verified error:

```
vite.config.ts(15,3): error TS2769: No overload matches this call.
    Object literal may only specify known properties,
    and 'test' does not exist in type 'UserConfigExport'.
```

Two working fixes, both verified:

**A — separate `vitest.config.ts` (recommended, and what Harbor should use):**

```ts
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: true,
    },
  }),
)
```

**B — keep it in `vite.config.ts` with a triple-slash reference on line 1:**

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
// … test: { … } now type-checks
```

### Minimum viable setup

Since no component tests exist yet, option A plus this setup file is the whole story:

`apps/web/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())
```

Dev deps needed: `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/jest-dom`.

If you want the absolute floor, you can drop the setup file and `@testing-library/*` entirely — `{ test: { environment: 'jsdom' } }` is enough for Vitest to run. But wiring the setup file now costs nothing and means the first component test needs no config work.

### @testing-library/react with React 19

**`@testing-library/react@16.3.2` — compatible.** Declared peers:

```json
{ "@testing-library/dom": "^10.0.0",
  "@types/react": "^18.0.0 || ^19.0.0",
  "@types/react-dom": "^18.0.0 || ^19.0.0",
  "react": "^18.0.0 || ^19.0.0",
  "react-dom": "^18.0.0 || ^19.0.0" }
```

`@testing-library/dom` is a **peer**, not a dependency — install it explicitly or npm will not resolve it.

**Verified end-to-end** — a real render/assert test passed against React 19.2.7:

```
RUN  v4.1.10
Test Files  1 passed (1)
     Tests  1 passed (1)
  Duration  669ms
```

---

## 6. React 19.2.7

**Nothing in 19.1 or 19.2 changes SPA bootstrapping.** `createRoot` + `StrictMode` is unchanged and remains correct. `react-dom/client` exports exactly `createRoot`, `hydrateRoot`, `version`.

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

**No deprecations in 19.1/19.2 affect a fresh project.** Every 19.2.1 → 19.2.7 patch was React Server Components only (Server Action hardening, DoS mitigations, `FormData` fix) — zero client-side impact. Harbor uses no RSC.

New in 19.2.0 that may be worth using:

- **`useEffectEvent`** — extracts non-reactive logic from an Effect. Directly useful for playback-progress sync, where the effect should re-run on session change but read the latest position without re-subscribing.
- **`<Activity>`** — hides/restores UI *and internal state* of children. Relevant to Harbor's catalog rows and route transitions where you want to preserve scroll/state off-screen.
- **React Performance tracks** in the browser Performance panel.
- Suspense boundary reveals are now batched before first paint.

⚠️ **`useId` now generates IDs with `_` instead of `:`.** Only matters if you have snapshot tests or CSS/query selectors keyed on generated IDs — Harbor has neither yet, so this is free.

The 19.0 deprecations still stand and are the ones that matter for greenfield code: no `ReactDOM.render`, no `ReactDOM.hydrate`, no `unmountComponentAtNode`, no string refs, no legacy context, no `propTypes`/`defaultProps` on function components. `forwardRef` is no longer needed — `ref` is a normal prop on function components.

---

## Serving from Fastify

`build.outDir: '../server/public'` puts the compiled SPA where the Fastify app can serve it with `@fastify/static`, with a catch-all falling back to `index.html` for client-side routes. Verified build output:

```
../server/public/index.html                   0.29 kB │ gzip:  0.22 kB
../server/public/assets/index-*.css           4.54 kB │ gzip:  1.54 kB
../server/public/assets/index-*.js          309.03 kB │ gzip: 97.30 kB
```

309 kB raw / 97 kB gzip is the React + React Router + TanStack Query baseline before any Harbor code.

The SPA fallback must not shadow `/api/v1/*`. Register the API routes before the static catch-all, and keep the dev proxy target (`http://localhost:3000`) aligned with Harbor's documented internal port.
