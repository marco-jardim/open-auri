# `#lib/server/api`: kit of the `/api/v1/**` routes

Every `/api/v1` `+server.ts` export is built with `defineApi`. The wrapper runs, in order:

1. **Same origin** (POST/PUT/PATCH/DELETE): `Origin` must equal `PUBLIC_ORIGIN` (on a loopback
   `PUBLIC_ORIGIN`, any `http://localhost:*` / `http://127.0.0.1:*` too). Missing → 403.
2. **Auth level**: `public` (user or null), `user`, `verified`, `admin` (`requireAdmin`, with
   `destructive` for fresh-session actions).
3. **Rate limit**: Workers binding `RL_API` (reads) or `RL_WRITE` (writes), keyed by
   `<group>` + user id, or + the daily-salted IP hash when signed out; optional D1 `quotas`
   (default window one day). Fails closed (503).
4. **Turnstile** (`turnstile: action`): token in the `x-turnstile-token` header.
5. **Handler**. `ApiError` thrown anywhere becomes its JSON error; any other error becomes 500
   `INTERNAL` with one log line `{"event":"api.error","route":…,"error":<name>}`.

The global read-only handle already answers 503 `READ_ONLY` to writes; routes do not repeat it.
Server routes still declare `export const prerender = false`.

## Example

```ts
// src/routes/api/v1/curves/[id]/reports/+server.ts
import { z } from 'zod';
import {
	ApiError,
	CACHE_PUBLIC_60,
	cached,
	defineApi,
	json,
	readJson
} from '#lib/server/api/index.ts';
import { TURNSTILE_ACTIONS } from '#lib/server/security/turnstile.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

const Body = z.object({ reason: z.enum(['spam', 'abuse', 'other']), note: z.string().max(500) });

export const POST: RequestHandler = defineApi(
	{
		auth: 'verified',
		rateLimit: { group: 'api.reports', quotas: [{ limit: 20 }] },
		turnstile: TURNSTILE_ACTIONS.report
	},
	async ({ event, env, user }) => {
		const body = await readJson(event.request, Body);
		const created = await createReport(env.db, user.id, event.params.id, body);
		if (!created) throw new ApiError(404, 'NOT_FOUND');
		return json({ id: created.id }, { status: 201 });
	}
);

export const GET: RequestHandler = defineApi(
	{ auth: 'public', rateLimit: { group: 'api.curves.read' } },
	async ({ event, env }) => {
		const body = JSON.stringify(await loadCurve(env.db, event.params.id));
		return cached(event.request, body, { cacheControl: CACHE_PUBLIC_60 });
	}
);
```

## Modules

| File         | Exports                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `errors.ts`  | `API_ERROR_CODES`, `API_ERROR_STATUS`, `ApiError(status, code, details?, { headers?, cause? })`, `apiError(status, code, details?, headers?)`, `apiErrorFrom(error)`                       |
| `http.ts`    | `json(data, init?)` (default `private, no-store`), `readJson(request, schema, { maxBytes = 16384 })`, `assertSameOrigin(request, publicOrigin)`                                            |
| `guard.ts`   | `apiUser(locals)`, `apiVerified(locals)`, `apiOwner(locals, ownerId)`, `apiAdmin(locals, env, request, rawEnv, options?)`                                                                  |
| `limits.ts`  | `apiRateLimit(env, event, rule, now?)`, `apiTurnstile(env, request, action)`                                                                                                               |
| `cache.ts`   | `strongEtag(body)`, `ifNoneMatch(request, etag)`, `cached(request, body, { etag?, cacheControl, contentType?, headers? })`, `CACHE_PUBLIC_60`, `CACHE_IMMUTABLE`, `CACHE_PRIVATE_NO_STORE` |
| `handler.ts` | `defineApi(options, handler)`                                                                                                                                                              |

## Error codes

Body: `{ "error": { "code": "…", "details"?: … } }`, `content-type: application/json; charset=utf-8`,
`cache-control: no-store`. Codes are stable: add new ones, never rename or reuse.

| Code                     | Status | When                                                                                       |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------ |
| `INVALID_BODY`           | 400    | Empty, non-UTF-8 or malformed JSON; schema failure with `details.issues: [{ path, code }]` |
| `UNSUPPORTED_MEDIA_TYPE` | 415    | Body without `content-type: application/json`                                              |
| `PAYLOAD_TOO_LARGE`      | 413    | Body over `maxBytes` (Content-Length or counted while reading)                             |
| `BAD_ORIGIN`             | 403    | Unsafe method with a missing, `null` or foreign `Origin`                                   |
| `AUTH_REQUIRED`          | 401    | Not signed in                                                                              |
| `EMAIL_NOT_VERIFIED`     | 403    | `verified` route, e-mail not verified                                                      |
| `BANNED`                 | 403    | Account banned                                                                             |
| `FORBIDDEN`              | 403    | Route-specific refusal (reserved for handlers)                                             |
| `NOT_FOUND`              | 404    | Missing resource, someone else's resource (`apiOwner`), or not an admin (`apiAdmin`)       |
| `REAUTH_REQUIRED`        | 403    | Destructive admin action on a session older than 10 minutes                                |
| `CONFLICT`               | 409    | Route-specific state conflict (reserved for handlers)                                      |
| `RATE_LIMITED`           | 429    | Burst binding or quota exceeded; `retry-after` in seconds                                  |
| `RATE_LIMIT_UNAVAILABLE` | 503    | Binding, salt store or D1 failed (fail closed)                                             |
| `TURNSTILE_FAILED`       | 403    | Missing, invalid, mismatched or unverifiable `x-turnstile-token`                           |
| `INTERNAL`               | 500    | Any other error                                                                            |
| `INVALID_CURSOR`         | 400    | Pagination cursor that does not decode (`SocialRepoError('invalid-cursor')`)               |
| `INVALID_CURVE`          | 422    | S1/S5 that does not decode or validate (`details.codes`: core `s1:*` / `env:*` codes)      |
| `GATE_REJECTED`          | 422    | Curve reproved by the safety gate (`details.reasons`: gate reason codes)                   |
| `HEAD_MOVED`             | 409    | New version whose parent is no longer the lineage head                                     |
| `ALREADY_ACTIVE`         | 409    | One-per-user resource already active (S7 trade)                                            |
| `DUPLICATE`              | 409    | Unique resource already exists (e.g. second report of the same target)                     |
| `GONE`                   | 410    | Retracted lineage (tombstone) read by someone other than the owner                         |
| `QUOTA_EXCEEDED`         | 429    | Per-user daily quota of a domain action exceeded                                           |
| `CONSENT_REQUIRED`       | 400    | S6 batch without the current consent version                                               |

No error body or log line carries user input, e-mail, IP or token.
