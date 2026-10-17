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

Triggers: `versions_gate_ok` (no version on a curve with `gate_ok <> 1`, invariant §0.12.4, also
for forks and new versions), `versions_append_only` (no UPDATE), `versions_parent_same_lineage`,
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

## Visibility rules

Use the predicates of `repo.ts`; never rewrite them.

- `publicLineageSql(alias)`: **publicly listable** = `visibility = 'public'`, `status = 'active'`,
  `moderation = 'visible'`, head curve `gate_ok = 1`, owner not banned (`"user".banned = 1`) or
  anonymized. The only lineages that feeds, rankings, profiles, other people's packs, curve lookups
  and searches may show. Private and unlisted lineages are never listed.
- `linkableLineageSql(alias)`: the same rules with `visibility IN ('public', 'unlisted')`: what
  anyone who has the id can open.
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
  `<hash>` is the first 16 hex of SHA-256 over `GATE_IMPL + ':' + JSON.stringify(THRESHOLDS)`.
  Rows written before the ordinal existed (`v2:<hash>`) have ordinal 0.
- **Bump rule:** increase `GATE_IMPL` by one (never reuse or lower it) in the same commit as ANY
  change that can alter a verdict: the core's `gateForWrite` or `THRESHOLDS`, the S1 codec
  (`decodeS1`/`canonKey`), `levelDb`, or `runGate` in `gate.ts`. The threshold hash re-gates even if
  the bump is forgotten, but only the ordinal makes the cache monotonic across a deploy.
- **Monotonic upsert:** `upsertCurveStatement` (used by `saveCurveGate`, `publishLineage`,
  `appendVersion`) never overwrites a row whose stored ordinal (`gateImplSql`) is greater than the
  writer's, and a verdict of a newer ordinal is served as current (`isGateCurrent`): an older
  isolate during a deploy cannot flip a curve back to a stale verdict.
- **Lazy re-gate:** every by-id read or action of `curves.ts` (curve read, history, fork, append,
  retract, restore, visibility) re-gates a head or requested version whose verdict is not current
  (`regateCurve`) and reads it again, so a head that now fails is not linkable.
- **Job:** `regateStale` (jobs Worker, `regate`) drains the rest within a wall-clock budget
  (`REGATE_BUDGET_MS`, 20 s), heads of linkable lineages first, then oldest
  (`listStaleCurvesByPriority` in `queries/curves.ts`).
- **CPU quota:** every attempt that reaches the gate through the curves service (publish, version,
  fork; accepted or rejected) counts toward `DAILY_GATE_ATTEMPT_QUOTA` per user (D1 sliding window,
  429 `QUOTA_EXCEEDED`), on top of the successful-publication quota.

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
  `SOCIAL_ERROR_CODES`): `head-moved` → 409, `not-found` → 404 (also for "exists but not
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
