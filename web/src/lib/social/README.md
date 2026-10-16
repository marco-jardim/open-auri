# `#lib/social`: browser social library (T4.12b)

Used by the social pages (Comunidade, Biblioteca, Curva, Cabo/Teste cego, Comparar/Soe como X).
Import from `#lib/social/index.ts`. Nothing here imports `$app/*` or runs anything at module load;
there is no singleton: create the session, API client and outbox once per client (layout or page).

- `api.ts`: `createSocialApi({ fetch?, origin?, online? })`, `SocialApi`, `SocialApiError`,
  `isSocialApiError`, `isApiErrorCode`, `errorFromResponse`, request/response types.
- `outbox.ts`: `createSocialOutbox(options)` (`store`, `session`, optional `locks`, `now`,
  `online`, `randomId`, `random`, `log`), `parseQueued`, constants (`SOCIAL_OUTBOX_TYPE`, `SOCIAL_OUTBOX_LOCK`, `PREVIEW_MIN_MS`,
  `OUTBOX_MAX_AGE_MS`, `OUTBOX_BATCH_MAX`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`).
- `session.svelte.ts`: `createSocialSession({ initial?, fetch? })`, `requireLoginHref(currentPath)`.

## API client

Every method takes an optional last `{ signal }` (abort: the `AbortError` is rethrown as is).
Requests are same-origin with cookies; JSON bodies send `content-type: application/json`; the
Turnstile token goes in `x-turnstile-token`. Response types are the server DTOs (type-only imports).

Methods (paths under `/api/v1`):

- `feed({ sort?, window?, cursor?, limit? })`: `GET /feed`.
- `rankings({ metric?, window?, cursor?, limit? })`: `GET /rankings`.
- `getCurve(lineageId, { versionId? })`: `GET /curves/[id]?v=`.
- `publishCurve({ envelope, visibility })`: `POST /curves`.
- `getLineage(lineageId, { cursor?, limit? })`: `GET /lineages/[id]`.
- `appendVersion(lineageId, { parentVersionId, envelope })`: `POST /lineages/[id]/versions`.
- `forkLineage(lineageId, { versionId?, visibility?, envelope? })`: `POST /lineages/[id]/fork`.
- `retractLineage(id)`, `restoreLineage(id)`: `POST /lineages/[id]/retract`, `.../restore`.
- `setVisibility(id, visibility)`: `PUT /lineages/[id]/visibility`.
- `favorite(lineageId, { shareId? })`, `unfavorite(lineageId)`: `PUT`/`DELETE /curves/[id]/favorite`.
- `postActivity(lineageId, { kind, eventId, at?, durationMs?, shareId? })`:
  `POST /curves/[id]/activity` (pages use the outbox instead).
- `audience(lineageId)`: `GET /curves/[id]/audience`.
- `myActivity({ cursor?, limit? })`, `deleteMyActivity({ lineageId?, kind? })`: `GET`/`DELETE /me/activity`.
- `postActivityOutbox(events)`: `POST /me/activity/outbox` (used by the outbox).
- `myLibrary({ shelf, visibility?, cursor?, limit? })`: `GET /me/library`.
- `mergeLibrary(items)`: `POST /me/library/merge` (at most 100 items).
- `createShare({ lineageId, versionId?, channel? })`: `POST /shares`.
- `shareStats(shareId)`, `openShare(shareId)`: `GET /shares/[id]/stats`, `POST /shares/[id]/open`.
- `getUser(nickname)`, `getUserList(nickname, list, { cursor?, limit? })`: `GET /users/[apelido]`
  (the browser follows the 308 of an old nickname).
- `getPack(id)`, `createPack(body)`, `updatePack(id, body)`, `deletePack(id)`: `/packs`, `/packs/[id]`.
- `report({ targetKind, targetId, reason, note? }, turnstileToken)`: `POST /reports`.
- `postS6Batch(body, turnstileToken)`, `deleteS6Batch(receipt)`, `s6Preferences()`: `/s6/**`.
- `joinTrade({ lineageId, versionId? })`, `myTrades({ cursor?, limit? })`, `scoreTrade(id, 1..5)`,
  `cancelTrade(id)`: `POST /trades`, `GET /trades/me`, `POST /trades/[id]/score`,
  `DELETE /trades/[id]`.
- `ogImageUrl(versionId)`: `/og/<versionId>.png` (URL only, no request).

```ts
import { createSocialApi, isSocialApiError } from '#lib/social/index.ts';

const api = createSocialApi();
try {
	const { lineageId } = await api.publishCurve({ envelope, visibility: 'public' });
	await api.favorite(lineageId);
} catch (error) {
	if (!isSocialApiError(error)) throw error;
	switch (error.code) {
		case 'AUTH_REQUIRED':
			goto(requireLoginHref(page.url.pathname + page.url.search));
			break;
		case 'EMAIL_NOT_VERIFIED': // ask to verify the e-mail
		case 'GATE_REJECTED': // error.details.reasons: gate reason codes
		case 'INVALID_CURVE': // error.details.codes: core s1:* / env:* codes
		case 'HEAD_MOVED': // reload the lineage, then retry on the new head
		case 'QUOTA_EXCEEDED':
		case 'RATE_LIMITED': // error.retryAfterMs when the server sent retry-after
		case 'NETWORK':
		case 'OFFLINE': // see "Offline" below
	}
}
```

`SocialApiError` has `status` (0 without a response), `code` (an `ApiErrorCode` of
`#lib/server/api/errors.ts`, or `NETWORK` / `OFFLINE`), optional `details` and `retryAfterMs`,
and `unreachable` (true for `NETWORK` / `OFFLINE`). An error answer without a known JSON code (an
edge HTML page) gets the code of its status (`404` → `NOT_FOUND`, `5xx` → `INTERNAL`, ...). Show
messages by code; never show `details` verbatim.

## Session

```ts
const session = createSocialSession({ initial: data.account }); // or undefined, then:
void session.refresh(); // reuses fetchAccount (GET /api/auth/get-session), failures = signed out
// Rune-backed getters: session.signedIn, session.verified, session.nickname.
const href = requireLoginHref(page.url.pathname + page.url.search); // "Entrar" that comes back
```

Every social write needs `verified` (retracting needs only `signedIn`). Without a session, show the
sign-in link instead of the action; with an unverified e-mail, the verify prompt.

## Activity outbox

Record "experimentou" (preview ≥ 10 s) and "instalou" through the outbox, never by calling
`postActivity` from the page: it survives offline, reloads and closed tabs.

```ts
const outbox = createSocialOutbox({ store: app.state.outbox, session });
const queued = await outbox.enqueue({ kind: 'previewed', lineageId, durationMs, shareId });
// queued.ok === false: 'too-short' (< 10 s, nothing stored), 'invalid' or 'storage'
await outbox.enqueue({ kind: 'installed', lineageId });
void outbox.flush(api); // after enqueue, on page load, and on the window 'online' event
```

- Each event gets `eventId = crypto.randomUUID()` and `at`; the server deduplicates by `eventId`.
- Stored in the IndexedDB `outbox` store of `#lib/state` (`type: 'oa.social.outbox'`, `id` =
  `eventId`). `enqueue` never throws (failures logged without PII, result `storage`).
- `flush(api)` runs only when signed in, verified and online, and in one tab at a time (Web Lock
  `oa-social-outbox`, `ifAvailable`; the other tabs answer `busy`). It drops events older than 7
  days, sends due events oldest first in batches of at most 50, removes items answered
  `recorded`, `duplicate` or `rejected` (permanent), and keeps the rest with exponential backoff
  (30 s doubling, at most 6 h, jitter, at least `retry-after`). `AUTH_REQUIRED`,
  `EMAIL_NOT_VERIFIED` and `BANNED` stop the flush without counting an attempt. It resolves a
  `FlushReport` (`status`, `sent`, `removed`, `dropped`, `kept`, `error?`) and never throws.
- `pending()` lists the queued events (e.g. "3 atividades aguardando conexão").

## Offline (plan §3.9: "O social degrada com aviso")

Presets, editor, cable, previews and the blind test work without network; the social features
degrade with a notice, never silently and never with a blocking error:

- `error.unreachable` (or `navigator.onLine === false`): keep the page usable with what is local,
  disable the social actions and show one inline notice (e.g. "Sem conexão: a parte social volta
  quando a rede voltar."). Do not retry in a loop; retry on the `online` event or a user click.
- Activity is never lost: it waits in the outbox and is sent by the next `flush`.
- Reads that fail offline show the notice in place of the list (no empty state that suggests
  "nothing here"). Writes that fail offline keep the user's input and say it was not sent.
