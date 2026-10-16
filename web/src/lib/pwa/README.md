# PWA integration (T2.17)

Kit **3.1.0** is installed under `web/node_modules/@sveltejs/kit`, not the root node_modules.
Its `types/index.d.ts` exposes `$app/manifest` (`immutable`, `assets`, `prerendered`),
`$app/env` (`version`) and `$app/service-worker` (`self`). The package has no docs folder.
There is no `$service-worker` import and **no Vite manifest plugin is needed**.

## Shared-file integration, owned by the orchestrator

Merge `messages/_staging/T2.17.{pt-BR,en-US}.json` and regenerate Paraglide first.

Inside the `app.html` head, before `%sveltekit.head%`, add:

```html
<link rel="manifest" href="%sveltekit.assets%/manifest.webmanifest" />
<meta name="theme-color" content="#171715" />
<link rel="icon" href="%sveltekit.assets%/icons/icon.svg" type="image/svg+xml" />
```

Inside the root layout script, add:

```ts
import { dev } from '$app/env';
import { resolve } from '$app/paths';
import UpdatePrompt from '#lib/pwa/UpdatePrompt.svelte';
```

Render once in the root layout (outside conditional app initialization):

```svelte
<UpdatePrompt enabled={!dev} workerUrl={resolve('service-worker.js')} scope={resolve('/')} />
```

In `sveltekit({...})` in `vite.config.ts`, add this option so the component alone owns registration
and dev never installs an inert service worker:

```ts
serviceWorker: { register: false },
```

The root layout already exports `prerender = true`, so `/offline` inherits prerendering. The worker
uses the registration scope as the base for all manifest paths, including non-root deployments.
Unknown offline document URLs redirect to the cached `/offline` route so relative asset URLs and
hydration agree with the document location. Its editor link uses Kit 3's public `resolve('/')` API.

## Cable-write contract

Before starting any write, the cable service must set `window.__oaWriteInProgress = true`
**synchronously**, before the first await, and clear it in a `finally` after the entire write/queue
settles. Keep it true while any overlapping write remains active (use the service's aggregate
`writing` state or a reference counter, not one independent boolean per device).

The global Window type is declared in `register.ts`. The prompt checks the flag both before sending
`OA_SKIP_WAITING` and immediately before reloading on `controllerchange`. If a write starts between
those events, it retains the prompt and requires a **new click** after the write finishes. There is
no timer-based reload. First installation and activation requested in another tab never reload the
current tab. Existing UI should not permit new writes once a user-confirmed page reload begins.

## Cache policy and F3 contract

- Shell: build-versioned precache of Kit's immutable JS/CSS/assets, static fonts/icons/manifest and
  prerendered pages. Install fetches explicitly omit credentials. Private/no-store, cookie-varying,
  opaque, redirected and non-200 responses cannot enter caches. A failed install leaves the existing
  worker active. Old **app-owned** caches are deleted on activation; unrelated caches are untouched.
- Navigation: network first; on offline/server failure use the matching public prerendered page,
  ignoring query parameters, then redirect to `/offline`. Live HTML is **never** written to
  CacheStorage.
- `/api/**`: network first; credentialed requests and Authorization/Cookie-bearing requests never
  read or write an API cache. Only F3 public GET fetches using `credentials: 'omit'` and returning
  `Cache-Control: public` (without private/no-store/no-cache or Vary Cookie/Authorization/*) can be
  retained. Cache misses offline return no-store JSON `{ "error": "offline" }`, status 503.
  Account/authenticated calls must keep their normal credentials and remain network-only.
- `/data/autoeq/**`: public static files, cache first only after first fetch, with credentials omitted.
  Packs are **not** eagerly precached. Runtime FIFO is bounded to 32 entries, serialized across
  concurrent writes. The API cache also has a 32-entry bound. Both are build-versioned.
- POST/PUT/PATCH/DELETE/HEAD, Range, cross-origin, private routes and unknown subresources bypass all
  worker caches. Cache write/quota failures do not discard a successful network response.

## Icons and verification

`static/icons/icon.svg` has an opaque full-bleed background and safe-zone artwork, referenced in the
manifest with `sizes: "any"` and `purpose: "any maskable"`. PNG generation is not available in this
dispatch. The orchestrator must rasterize **192×192 and 512×512 PNGs**, including a maskable variant,
and add manifest entries if a target browser/installability audit requires raster assets.

`tests/unit/pwa/strategy.test.ts` covers pure routing, cache admission, versioning and bounds.
`register.test.ts` covers explicit updates, first install, cross-tab activation, disposal, and a write
racing activation. `tests/e2e/offline.spec.ts` requires a production build with the layout integration
above. It waits for worker control after first load, goes offline, reloads, loads a preset, starts
preview, visits an unvisited prerendered page, checks the social notice and tests the fallback.

Web unit tests, `check:web`, build and Playwright must be run centrally after merging the staging
messages and shared-file integration. Root npm test/lint/typecheck do not execute the web tests.
