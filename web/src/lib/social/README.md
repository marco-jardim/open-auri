# `#lib/social`: browser social library (T4.12b)

Used by the social pages (Comunidade, Biblioteca, Curva, Cabo/Teste cego, Comparar/Soe como X).
Import from `#lib/social/index.ts`. Nothing here imports `$app/*` or runs anything at module load;
there is no singleton: create the session, API client and outbox once per client (layout or page).

- `api.ts`: `createSocialApi({ fetch?, origin?, online? })`, `SocialApi`, `SocialApiError`,
  `isSocialApiError`, `isApiErrorCode`, `errorFromResponse`, request/response types.
- `outbox.ts`: `createSocialOutbox(options)` (`store`, `session`, optional `locks`, `now`,
  `online`, `randomId`, `random`, `log`), `parseQueued`, constants (`SOCIAL_OUTBOX_TYPE`, `SOCIAL_OUTBOX_LOCK`, `PREVIEW_MIN_MS`,
  `OUTBOX_MAX_AGE_MS`, `OUTBOX_BATCH_MAX`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`).
- `session.svelte.ts`: `createSocialSession({ initial?, fetch? })` (`signedIn`, `verified`,
  `accountId`, `nickname`, `account`, `known`, `set`, `refresh`), `requireLoginHref(currentPath)`.

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
- `retractLineage(id)`, `restoreLineage(id, { acknowledge? })`: `POST /lineages/[id]/retract`,
  `.../restore` (a body only with `acknowledge: 'yolo'`).
- `setVisibility(id, visibility, { acknowledge? })`: `PUT /lineages/[id]/visibility`.
- YOLO curves (migration 0013): `publishCurve`, `appendVersion`, `forkLineage`, `setVisibility`
  and `restoreLineage` take `acknowledge: 'yolo'` when a YOLO head is opened to others; the UI
  sends it only after the acknowledgement step (`components/yolo/YoloPublishAck.svelte`).
  `feed({ sort: 'new', yolo: 'only' })` is the separate list of public YOLO curves.
- `favorite(lineageId, { shareId? })`, `unfavorite(lineageId)`: `PUT`/`DELETE /curves/[id]/favorite`.
- `postActivity(lineageId, { kind, eventId, at?, durationMs?, shareId? })`:
  `POST /curves/[id]/activity` (pages use the outbox instead).
- `audience(lineageId)`: `GET /curves/[id]/audience`.
- `myActivity({ cursor?, limit? })`, `deleteMyActivity({ lineageId?, kind? })`: `GET`/`DELETE /me/activity`.
- `postActivityOutbox(events)`: `POST /me/activity/outbox` (used by the outbox).
- `myLibrary({ shelf, visibility?, cursor?, limit? })`: `GET /me/library`.
- `mergeLibrary(items)`: `POST /me/library/merge` (at most 100 items).
- `myPacks({ cursor?, limit? })`, `myShares({ cursor?, limit? })`: `GET /me/packs`, `GET /me/shares`
  (the caller's own packs in any visibility and own share links; `MyPackItem`, `MyShareItem`).
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
void session.refresh(); // reuses fetchAccount (GET /api/auth/get-session), failures stay unknown
// Rune-backed getters: session.signedIn, session.verified, session.accountId, session.nickname.
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
// queued.ok === false: 'signed-out' / 'unverified' (nothing stored), 'too-short' (< 10 s,
// nothing stored), 'invalid' or 'storage'
await outbox.enqueue({ kind: 'installed', lineageId }, { actedAs }); // actedAs: id at the action
void outbox.flush(api); // after enqueue, on page load, and on the window 'online' event
await outbox.purge(); // on sign-out (removes all) or account switch (keeps the current account's)
```

- **Events belong to who acted.** `enqueue` refuses unless the session is signed in **and**
  verified at that moment (`signed-out`, `unverified`): anonymous activity is never stored. Each
  event is stamped with the account id (`owner` = `session.accountId`, the user's own id from the
  account summary). The optional `actedAs` (id captured when the action happened, e.g. at the cable
  write) refuses the event as `signed-out` if the session changed meanwhile.
- `flush` sends only the current account's events and removes the events of any other owner
  (counted in `dropped`); it stops (`signed-out` / `unverified`) if the session changes between
  batches. `pending()` lists only the current account's events. Payloads without an owner (v1,
  before FX4.2) are unreadable and dropped. `SocialSync` calls `purge` when the signed-in account
  changes (keep the new one) or signs out (purge everything). A sign-out purges only on a
  **definitive** answer: a session read as signed out is confirmed with `probeAccount`
  (`#lib/components/chrome/account.ts`), which returns `signed-out` only when the auth API answered
  successfully without a session and `error` for any failure (offline, HTTP error, bad body). On
  `error` the queue is kept and the probe is retried when the tab comes back online or visible.
  `fetchAccount` also distinguishes failure (`undefined`, unknown) from a definitive sign-out
  (`null`); hidden preferences stay closed and offer a retry while the session is unknown.
- **The server binds the batch too (FX4.10).** Every POST carries `actor` = the owner of its items.
  When the session cookie belongs to someone else (another tab switched account while a flush or a
  stale tab was running), the server answers 409 `CONFLICT` with
  `details.reason: 'actor-mismatch'` and records, claims and counts nothing. `flush` then stops with
  status
  `actor-mismatch` and keeps the items (no backoff; `isActorMismatch(error)` tells the case);
  `SocialSync` re-probes the session and follows it (switch: purge the old owner's events and flush
  for the new one; definitive sign-out: purge everything). `SocialSync` also flushes whenever the
  signed-in account id changes.
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

### Curve origins per account (FX4.10)

`rememberOrigin` / `originOf` (`origins.ts`) keep the published lineage of a curve by its exact
bytes. A signed-in account's origins live under `oa.social.origins:<accountId>` (they can hold its
private lineage ids, e.g. from Minha Biblioteca); the plain `oa.social.origins` key is the
anonymous one (public/unlisted curves opened while signed out, or before the session is known).
The account is the one bound by `setOriginsActor` (SocialSync binds the tab's signed-in account;
`options.actor` overrides it). `purgeOrigins(keep)` removes every other account's key and the
anonymous key; SocialSync calls it together with the outbox purge (first signed-in account seen,
switch, definitive sign-out), so another account's private lineage ids are never kept nor read.

## Offline (plan §3.9: "O social degrada com aviso")

Presets, editor, cable, previews and the blind test work without network; the social features
degrade with a notice, never silently and never with a blocking error:

- `error.unreachable` (or `navigator.onLine === false`): keep the page usable with what is local,
  disable the social actions and show one inline notice (e.g. "Sem conexão: a parte social volta
  quando a rede voltar."). Do not retry in a loop; retry on the `online` event or a user click.
- Activity is never lost: it waits in the outbox and is sent by the next `flush`.
- Reads that fail offline show the notice in place of the list (no empty state that suggests
  "nothing here"). Writes that fail offline keep the user's input and say it was not sent.
