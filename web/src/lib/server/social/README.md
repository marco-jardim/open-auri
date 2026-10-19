# Social data layer (T4.1)

Schema, repository, account-deletion part and LGPD export section of the social features
(plan §3.7, §3.8, annex A.2). Owned by T4.1; in W4.2 every file here is **read-only**.

| File          | Role                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| `types.ts`    | Enums (`as const`, same values as the SQL `CHECK`s), limits, DTOs, error codes         |
| `repo.ts`     | The only data-access point for social tables (queries, visibility predicates, cursors) |
| `deletion.ts` | `socialContentPart`, first entry of `ACCOUNT_DELETION_PARTS` (account/deletion.ts)     |
| `export.ts`   | `socialSection` (key `social`) of `ACCOUNT_EXPORT_SECTIONS` (account/export.ts)        |

Tests: `web/tests/integration/social/repo/**` (workerd, `npm run -w web test:int`).

## Schema map (migrations 0004–0006)

Times are epoch milliseconds (`INTEGER`). Profile data is **not** here: it lives on `"user"`
columns (0009: `bio`, `activity_visibility`, `library_visibility`, `username_changed_at`) and the
nickname history is `username_holds` (0009).

**0004_social.sql**

| Table               | Key                               | Notes                                                                                                                                                           |
| ------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curves`            | `id` = `curveId(s1)` (12, base32) | `s1` UNIQUE (68 chars), `canon_key`, gate cache `gate_ver`/`gate_ok`/`gate_reasons` (JSON array), `level_db`. No author.                                        |
| `lineages`          | `id`                              | `owner_user_id` → user (SET NULL), `forked_from_version` → versions (SET NULL), `head_version`, `visibility`, `status` (owner), `moderation` (admin), `curated` |
| `versions`          | `id`                              | `lineage_id` (CASCADE), `parent_id` (CASCADE), `curve_id` (RESTRICT); UNIQUE (`lineage_id`, `parent_id`) + one root per lineage                                 |
| `favorites`         | (`user_id`, `lineage_id`)         | `created_at`                                                                                                                                                    |
| `activity`          | (`user_id`, `lineage_id`, `kind`) | `kind` ∈ previewed, installed; `first_at`, `last_at`, `count`                                                                                                   |
| `shares`            | `id`                              | `lineage_id`, `version_id`, `owner_user_id` (the sharer), `channel`                                                                                             |
| `share_events`      | (`share_id`, `day`, `kind`)       | anonymous daily counter `anon_count` (kinds open, previewed, installed, favorited)                                                                              |
| `share_event_users` | (`share_id`, `user_id`, `kind`)   | attributed events of signed-in users, once per kind; only counts leave the repository                                                                           |
| `packs`             | `id`                              | `owner_user_id` (SET NULL), `name`, `description`, `visibility`, `moderation`                                                                                   |
| `pack_items`        | (`pack_id`, `lineage_id`)         | UNIQUE (`pack_id`, `position`); `license` copied from the head version                                                                                          |
| `reports`           | `id`                              | `target_kind` ∈ lineage, pack, user; `reason`; `note` ≤ 500; UNIQUE (`target_kind`, `target_id`, `reporter_user_id`)                                            |

Triggers: `versions_gate_ok` (no version on a curve that is neither standard nor YOLO, invariant
§0.12.4, also for forks and new versions; recreated by 0013), `versions_append_only` (no UPDATE), `versions_parent_same_lineage`,
`curves_identity_immutable` (`id`, `s1`, `canon_key`), `lineages_head_null_on_insert`,
`lineages_head_advances` (the head only moves to a child of the current head),
`lineages_owner_fixed` and `packs_owner_fixed` (ownership can only be cleared, never transferred).
Trigger messages start with a stable token (`gate_rejected:`, `versions_append_only:`,
`head_not_child:`, ...); `constraintCode()` maps them to repository error codes.

**0005_s6_s7.sql**: `s6_batches` (`receipt_hash` = SHA-256 hex of the browser's receipt,
`consent_ver`, `day` YYYY-MM-DD; no user, no IP, nothing finer than the day), `s6_pairs` (`a`, `b`,
`choice`, `level_matched`; CASCADE with the batch), `trades` (partial UNIQUE index: one `waiting`
or `matched` trade per user; `score` = the score this user gave to the partner's curve).

**0006_rankings.sql**: `rankings` (PK `metric`, `"window"`, `lineage_id`; UNIQUE rank) and
`ranking_state` (last `computed_at` per metric and window). `"window"` is always quoted.

Ordering: on a fresh database 0004–0006 run before 0007–0010, on an already migrated one after;
they reference only `"user"("id")` and their own tables (both orders are tested).

**0013_yolo.sql**: `curves.gate_yolo` (0/1, CHECK: never 1 with `gate_ok = 1`; existing rows get 0)
and `lineage_yolo_acks` (PK `lineage_id`, `curve_id`; `acked_at`; CASCADE with the lineage): the
owner's acknowledgement that a YOLO curve is shown to others in that lineage. `versions_gate_ok` is
recreated: a version may reference a standard or a YOLO curve, never a rejected one (message token
`gate_rejected:` unchanged). Cached class per curve:

| Class    | `gate_ok` | `gate_yolo` | `gate_reasons`                                       |
| -------- | --------- | ----------- | ---------------------------------------------------- |
| standard | 1         | 0           | `[]`                                                 |
| yolo     | 0         | 1           | the codes the YOLO profile waived                    |
| rejected | 0         | 0           | the standard codes, plus the YOLO-only blocking ones |

## Visibility rules

Use the predicates of `repo.ts`; never rewrite them.

- Head predicates (0013): `headStandardSql(alias)` = the head curve is standard (`gate_ok = 1`);
  `headPublishableSql(alias, yolo)` = standard, or, only with `yolo` = `'on'`, YOLO
  (`gate_yolo = 1`) with a `lineage_yolo_acks` row for this lineage and that curve;
  `headYoloSql(alias)` = the head is YOLO, acknowledged or not (curation refusal). There is no
  unqualified "gate ok" predicate: every caller chooses.
- **Kill switch on reads (`YoloPublication`, types.ts).** `headPublishableSql`, `linkableLineageSql`,
  `readableLineageSql` and `publicYoloLineageSql` take the YOLO_PUBLICATION switch as a parameter,
  **default `'off'`**, and so do the reads built on them (`getLineageForViewer`,
  `getVersionForViewer`, `listVersions`, `listPublicFeed`, `forkLineage`, favorites, activity,
  installed, counts, shares, `isLinkableTombstone`, report targets). While off, no YOLO head is
  served to anyone but its owner (or an admin), acknowledged or not: not by id (curve, history,
  `/c/:id`), not in `feed?yolo=only` (an empty page), not as an OG card (404), not as a fork source,
  not favoritable, reportable or shareable. The routes pass `env.yoloPublication`; a forgotten
  parameter hides YOLO (fail closed). Turned on again, acknowledged heads are served again (the
  acknowledgement rows stay). The re-gate priority lists pass `'on'` explicitly (an acknowledged
  YOLO head must be current before the switch serves it), and the S7 reveal passes `'off'`
  explicitly (standard heads only, trades never involve YOLO curves).
- **Packs fail closed.** `setPackItems`, `getPackForViewer` and the pack queries keep the default
  `'off'` whatever the switch: someone else's YOLO lineage is never added to, nor shown in, a pack
  (a pack is a list, and lists never show YOLO heads). The owner's own lineages pass as before.
- `publicLineageSql(alias)`: **publicly listable** = `visibility = 'public'`, `status = 'active'`,
  `moderation = 'visible'`, STANDARD head (`headStandardSql`), owner not banned
  (`"user".banned = 1`) or anonymized. The only lineages that feeds, rankings, profiles, other
  people's packs, curve lookups, S6, S7 and the public dump may show. Private and unlisted lineages
  are never listed, and neither are YOLO heads.
- `publicYoloLineageSql(alias)`: the same rules with an acknowledged YOLO head instead: only
  `GET /api/v1/feed?yolo=only` (sort `new`) lists them. Never mixed into another list.
- `linkableLineageSql(alias)`: the same rules with `visibility IN ('public', 'unlisted')` and a
  PUBLISHABLE head (`headPublishableSql`): what anyone who has the id can open. A YOLO head without
  its acknowledgement is not linkable. `getVersionForViewer` and `isLinkableTombstone` use the same
  rule for a version's own curve and for tombstones.
- `readableLineageSql(alias, viewer)`: linkable, or the viewer's own lineage in any state, or
  anything when `viewer.admin === true` (explicit flag only; never inferred).
- `publicPackSql` / `readablePackSql`: the same for packs. Items of someone else's pack are only
  publicly listable lineages.
- `canViewLineage(facts, viewer, listing)`: the same rules in TypeScript.
- Owner-scoped lists (`listOwnLineages`, `listOwnPacks`, `listOwnShares`, `listOwnActivity`,
  `listOwnTrades`) return the caller's own rows in any state; pass the user id from the session
  only.
- Profiles: `listProfileLineages` and `listProfilePacks` need `library_visibility = 'public'`;
  `listProfileFavorites` also needs `activity_visibility = 'public'`. Counts are always available.
- Public counts and rankings count distinct users with a verified e-mail who are not banned, and
  never the owner of the lineage. Audience names only include users with
  `activity_visibility = 'public'`; the others are a count.
- Gate version: the predicates read the stored `gate_ok`. When the gate changes, the service
  re-gates stale rows (`listCurvesWithStaleGate`, `saveCurveGate`); a curve that now fails drops
  out of every list at once. See "Gate cache" below.

## Gate cache (`gate.ts`)

- `gate_ver` = `v2.<GATE_IMPL>:<hash>`, where `GATE_IMPL` is an integer constant in `gate.ts` and
  `<hash>` is the first 16 hex of SHA-256 over `gateVersionInput()` = `GATE_IMPL + ':' +
JSON.stringify(THRESHOLDS) + ':' + classifierVersionInput()` (the core's stable JSON of
  `THRESHOLDS`, `YOLO_THRESHOLDS` and the classification's waivable codes). Rows written before
  the ordinal existed (`v2:<hash>`) have ordinal 0. `GATE_IMPL = 2`: the server classification.
- **Classification (`checkPublishable`):** the standard write gate runs first with `experimental`
  derived from the curve (HS, LP or HP present, as the editor does), so HS/LP/HP curves within the
  limits are standard on the server. A curve it refuses is classified by the core's classification
  step `classifyWith` (the one behind `classifyCurve`; re-exported with its types by
  `classify-core.mjs` / `classify-core.d.mts`, since `open-auri/safety` does not export it) on the
  SAME injected gate, handed the standard verdict already computed: a YOLO curve costs exactly two
  gate runs (standard + YOLO profile), a curve refused on a reason the classification never waives
  one, and every run goes through the injected gate (`gateRuns` is exact). The class is never
  taken from a client. `checkCurve` keeps its old meaning (ok = standard) for the callers that
  only accept standard curves.
- **Bump rule:** increase `GATE_IMPL` by one (never reuse or lower it) in the same commit as ANY
  change that can alter a verdict or a class: the core's `gateForWrite`, `classifyCurve`,
  `THRESHOLDS` or `YOLO_THRESHOLDS`, the S1 codec (`decodeS1`/`canonKey`), `levelDb`, the
  derivation of `experimental`, or `runGate` in `gate.ts`. The hash re-gates even if the bump is
  forgotten for a threshold or waivable-code change, but only the ordinal makes the cache monotonic
  across a deploy (and covers code changes).
- **Why `GATE_IMPL` is still 2 after the YOLO verdict changes of PR #49 (QA round 1).** The bump
  exists to invalidate verdicts some deployed D1 already holds. Round 1 changed YOLO verdicts
  (YOLO-only checks only when a waiver is relied on, the extended checks at 20 kHz too) after
  `GATE_IMPL` became 2, but no D1 has a single `v2.2:` row: the only staging and production deploys
  were of `main` at `e157c16` (`_qa/deploy-staging-e157c16.txt`, `_qa/deploy-production-e157c16.txt`),
  which predates the server classification, and the PR #49 branch (`de95c57`, `9f95b55` and the
  QA rounds) never reached staging or production. Every verdict of ordinal 2 written so far lives in
  local or test databases, recomputed from scratch. So ordinal 2 means "the server classification as
  first deployed", whatever it is when the branch merges. Once this branch is deployed anywhere,
  the next verdict change bumps to 3.
- **Monotonic upsert:** `upsertCurveStatement` (used by `saveCurveGate`, `publishLineage`,
  `appendVersion`) never overwrites a row whose stored ordinal (`gateImplSql`) is greater than the
  writer's, and a verdict of a newer ordinal is served as current (`isGateCurrent`): an older
  isolate during a deploy cannot flip a curve back to a stale verdict.
- **Lazy re-gate:** every by-id read or action of `curves.ts` (curve read, history, fork, append,
  retract, restore, visibility) re-gates a head or requested version whose verdict is not current
  (`regateCurve`) and reads it again, so a head that now fails is not linkable. The other by-id
  public reads do the same (FX4.9): `/c/[id]` (`loadSharedCurve` through `readCurrentLineage` /
  `readCurrentVersion` in `shares.ts`), the OG image (`og/store.ts`, which also re-gates the head
  of an older version) and S7 (`trades.ts`: the join target, the own trade and the candidates
  before pairing, and the partner's curve before it is served; at most `TRADE_REGATE_PER_READ`
  partner curves per read, a partner still stale is withheld for that read). A head the current
  gate rejects is then 404 / not tradeable / withheld.
- **Job:** `regateStale` (jobs Worker, `regate`) drains the rest within a wall-clock budget
  (`REGATE_BUDGET_MS`, 20 s), heads of linkable lineages first, then oldest
  (`listStaleCurvesByPriority` in `queries/curves.ts`). It runs hourly AND every 15 minutes
  (before rankings on the quarter-hour tick).
- **Accepted decision: list drain window.** Lists (feed, rankings, profiles, packs, S6 eligibility)
  and the hourly S7 pairing retry (`retryWaitingPairs`) read the STORED verdict and never run the
  gate (a list page would need ~150 ms of CPU per stale head). After a gate change, a head the new
  gate rejects can still appear in a list until the job reaches it: up to ~15 minutes when the
  stale set fits one run's budget (about 130 curves per 20 s run), longer for a larger backlog
  (linkable heads go first). Opening any such item by id re-gates it at once and returns 404,
  so no S1 of a rejected head is served by id, by OG or by S7 during the window.
- **CPU quota:** every attempt that reaches the gate through the curves service (publish, version,
  fork; accepted or rejected) counts toward `DAILY_GATE_ATTEMPT_QUOTA` per user (D1 sliding window,
  429 `QUOTA_EXCEEDED`), on top of the successful-publication quota. When the curve's class is
  already cached under the current gate version, the YOLO rules (403, 409 `YOLO_ACK_REQUIRED`, 429)
  answer before the attempt is counted. In a library merge, the counting gate wraps every run
  (a YOLO curve counts 2 toward `MERGE_GATE_RUNS_MAX`) and refuses a run past the budget before it
  starts, so a request never exceeds it. The re-gate job's runs are counted the same way (one per
  standard curve or hard rejection, two per YOLO curve or curve the YOLO profile rejects). Proof:
  `tests/integration/social/yolo/classification.test.ts`, `qa-round1.test.ts` (m4) and
  `qa-round2.test.ts` ("classification run counts"), `workers/jobs/test/regate.test.ts`.

## YOLO publication (`curves.ts`)

- A YOLO curve may always be saved privately (publish, append, fork, merge) without anything else.
- A write that leaves a YOLO head visible to others (unlisted or public: publish, append, fork,
  visibility change, restore) needs, in this order: `YOLO_PUBLICATION = on` (env, default `off`:
  403 `YOLO_PUBLICATION_OFF`), an account at least 72 h old (`MIN_REPORTER_AGE_MS`; 403
  `FORBIDDEN`, `details.reason = 'account-age'`), `acknowledge: 'yolo'` in the body (409
  `YOLO_ACK_REQUIRED`, `details.waived`) and one of `YOLO_ACKS_DAILY_MAX` (5) acknowledgements per
  sliding day (group `curves.yolo.ack`, 429 `QUOTA_EXCEEDED`). The acknowledgement row is written in
  the same batch as the write, only in the state that write leaves (that curve and version are the
  head, the lineage has that visibility), so it exists exactly when the write applied. The daily
  slot is taken atomically right before the write (`writeWithAckSlot` → `takeWindowSlot` in
  `security/ratelimit.ts`: increment and check in one D1 batch, so concurrent openings never exceed
  the cap) and given back (`releaseWindowSlot`) when the write fails (409 `HEAD_MOVED`, any
  repository error, a throw); a refused take is given back at once. When the class is cached, a
  read-only check (`peek`) answers a 429 before a gate attempt is counted.
- Lineage state races: the decision reads the head's class and the visibility, and an append or a
  visibility change can land before the write. The writes carry what they relied on:
  `appendVersion` `expectedVisibility` (a YOLO curve), `setLineageVisibility` `expectedHead` (an
  opening), `restoreLineage` `expectedHead` + `expectedVisibility` (`LineageExpectation` in
  `repo.ts`). A moved state writes nothing and returns `head-moved`; the service reads the lineage
  again and re-applies the YOLO rules, up to `STATE_ATTEMPTS` (3) times, then 409 `HEAD_MOVED`. A
  lineage is therefore never visible to others with a YOLO head its owner did not acknowledge,
  whichever of the two requests lands first. `CurveDeps.beforeWrite` (tests only) runs a request in
  that window.
- Restore while `YOLO_PUBLICATION` is off: a non-private lineage whose head is YOLO is restored as
  **private** in the same statement (nothing to acknowledge); the answer carries the effective
  `visibility`. (A retracted lineage's visibility cannot be changed first, so a 403 was a dead end.)
- Moderation: a lineage whose head is YOLO is auto-hidden at `YOLO_AUTO_HIDE_THRESHOLD` (2)
  eligible reporters, judged by the head it has as the write runs (`autoHideLineage`: the threshold
  condition is in the UPDATE, and the audit row of the threshold applied is written in the same
  batch under the same condition); the admin queue preview carries `yolo` and `waived`; curation
  refuses YOLO heads, checked again in the write (`curateLineage`: audit row and UPDATE in one batch
  under the same condition; refused, nothing is written and the decision is `UNSUPPORTED`).
- OG sweep (jobs Worker): it reads `YOLO_PUBLICATION` from its own env (same value as the web
  Worker's) and keeps the images of acknowledged YOLO versions only while it is `on`.
- OG: card layout `3` draws a "YOLO" chip; `customMetadata.yolo` is compared by the store; the meta
  image URL carries `?y=1` and a YOLO curve is never indexable. A request whose `?y=` does not name
  the version's current class (`?y=1` on a standard version, none on a YOLO one) is a 302 to the
  URL of the right class with `cache-control: no-store`, before any R2 read or render
  (`og/route.ts`), so a URL-keyed cache only ever holds the card of the class its URL names. The
  redirect only sets or removes `y`; the other query parameters are kept in order.
- Data export (`export.ts`): the owner's `lineage_yolo_acks` rows (`lineageId`, `curveId`,
  `ackedAt`) as `social.yoloAcks`. Deleted lineages take their rows with them (ON DELETE CASCADE);
  an anonymized public lineage keeps them (they hold no user id).
- Never listed: feed (except `yolo=only`), rankings, profiles, packs, S6 eligibility, S7 trades and
  the public dump keep `gate_ok = 1`.

## Deletion semantics (account closure)

`socialContentPart` runs in the single batch of account/deletion.ts, before the account parts.

- Both modes: favorites, activity, attributed share events, the user's shares (and their funnel),
  trades and reports about the user are deleted; partners of active trades are cancelled; reports
  the user filed are deleted while open (they stop counting towards auto-hide) and kept with
  `reporter_user_id = NULL` once resolved.
- `delete-all`: every lineage (all versions) and pack of the user is deleted.
- `anonymize`: lineages that are public **and** active, and public packs, stay with
  `owner_user_id = NULL` ("autor removido", `author: null` in DTOs); every other lineage (private,
  unlisted, retracted) and pack is deleted.
- Forks by other users survive: `lineages.forked_from_version` is `ON DELETE SET NULL`.
- Curves stay (content-addressed, no author, gate cache). S6 batches have no user.

## How W4.2 services use `repo.ts`

- Import functions and types from `#lib/server/social/repo.ts` and `#lib/server/social/types.ts`.
  The repository is read-only in W4.2: a new query goes in `web/src/lib/server/social/queries/<service>.ts`,
  built with `sql()` from `#lib/server/db.ts` and the exported predicates (`publicLineageSql`,
  `readableLineageSql`, `countedUserSql`, cursor helpers).
- Writes return `RepoResult<T>` (`{ ok: true, value }` or `{ ok: false, code }`, codes in
  `SOCIAL_ERROR_CODES`): `head-moved` → 409 (also when a `LineageExpectation` or
  `expectedVisibility` no longer holds), `not-found` → 404 (also for "exists but not
  readable"), `gate-rejected` → 422, `already-active` / `duplicate` → 409, `invalid-input` → 400.
  Invalid cursors throw `SocialRepoError('invalid-cursor')` (→ 400).
- Pagination: pass `{ cursor, limit }`; get `{ items, nextCursor }`. Cursors are opaque base64url,
  validated on decode; page size is clamped to 1–100 (default 20).
- Publication (T4.2): normalize text, run the gate, then `publishLineage` / `appendVersion` /
  `forkLineage` with the gate result in `curve` (cached in `curves`). A rejected curve is cached and
  refused; the trigger refuses it again if anything slips through.
- Rankings (T4.6): the job calls `recomputeRankings(db, metric, window, now)` for each pair; reads
  use `listRankings` (visibility re-checked at read time).
- S7 (T4.10): `createTrade`, `pairTrade` (built on `tryPairTrades`, two conditional UPDATEs in one
  batch), `scoreTrade` (reveals both in the same batch), `expireTrades`, `cancelTrade`.
- Moderation (T4.8): `insertReport`, `countEligibleReporters` (verified, not banned, account age),
  `setModeration(..., expected)` (auto-hide passes `'visible'` so it never overrides an admin),
  `listReportQueue`, `resolveReports`; write the audit row with `admin/audit.ts`.
