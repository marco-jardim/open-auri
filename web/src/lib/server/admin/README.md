# Administration base (T3.8)

Server modules of the `/admin` area. Everything except `kit.ts` and `actions.ts` is plain
TypeScript without `$app/*` or SvelteKit imports, tested inside workerd
(`web/tests/integration/admin/**`).

## Modules

| File           | What it does                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `guard.ts`     | `requireAdmin(locals, env, { destructive, request, rawEnv })` → typed result. 1) `isAdminEffective` (role admin, not banned, not impersonating, 2FA marker when `ADMIN_2FA_REQUIRED`), 2) Access JWT when configured, 3) fresh session if destructive. |
| `access.ts`    | Optional Cloudflare Access: `readAccessConfig(rawEnv)`, `verifyAccessJwt(token, config, { fetch, now })`, `checkAccess(request, rawEnv)`. RS256 via WebCrypto, JWKS cache 5 min, fail closed.                                                          |
| `audit.ts`     | `audit`, `auditStatement` (for `batch`), `audited` (audit-first mutation), `listAudit` (newest first, paginated, optional target filter), `parsePage`, `AUDIT_ACTIONS`.                                                                                |
| `users.ts`     | `searchUsers` (nickname prefix, exact e-mail, exact id; e-mail masked), `getAdminUser`, `banUser` / `unbanUser` through `auth.api.banUser` / `unbanUser`, form parsers.                                                                                |
| `read-only.ts` | KV `CONFIG` key `mode:read-only` (`"1"` = on): `isReadOnly` (≤ 10 s isolate cache), `setReadOnly` (audited), `enforceWritable` (write middleware), allowlist.                                                                                          |
| `reauth.ts`    | TOTP re-authentication (`auth.api.verifyTOTP` on the admin's own session → the auth after-hook refreshes `twoFactorVerifiedAt`), rate limited through `RL_AUTH` (fail closed), every attempt audited.                                                  |
| `kit.ts`       | `requireAdminPage(event)` (404) and `requireAdminAction(event)` (404, or `fail(403, { reauth: true, code: 'REAUTH_REQUIRED' })`), `ADMIN_HEADERS`.                                                                                                     |
| `actions.ts`   | Shared form actions: `reauthAction`, `readOnlyAction`, `banAction`, `unbanAction`.                                                                                                                                                                     |

Routes: `src/routes/admin/` (dashboard + read-only toggle), `admin/usuarios` (search, ban/unban),
`admin/auditoria` (trail). All SSR, `prerender = false`, `x-robots-tag: noindex, nofollow`,
`cache-control: no-store`, `<meta name="robots" content="noindex, nofollow">`. Every load and every
action runs the guard itself (SvelteKit does not make them wait for the layout load).

## Decisions

- **Hidden area.** Anyone who is not an effective admin, or fails Access, gets a plain 404 (no
  hint that `/admin` exists). A stale session on a destructive action gets 403 `REAUTH_REQUIRED`
  and the page shows the re-authentication prompt.
- **Freshness.** Destructive = ban, unban, read-only toggle. Fresh = signed in, or second factor
  verified, in the last 10 minutes (`isFreshSession`). Re-authentication posts a TOTP code; admins
  without 2FA (only possible with `ADMIN_2FA_REQUIRED=false`) sign out and in again. Better Auth
  does not count TOTP failures for an existing session, hence the `RL_AUTH` limit keyed
  `admin-reauth:<userId>`.
- **Cloudflare Access (optional).** Set `ACCESS_AUD` (application audience tag) and
  `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`) as Worker vars to require
  `Cf-Access-Jwt-Assertion` on every `/admin` request. Only one of the two set = everything denied
  (misconfiguration fails closed). Checks: `alg` RS256, `kid` in the team JWKS
  (`https://<team>/cdn-cgi/access/certs`, no redirects followed), signature, `aud` contains
  `ACCESS_AUD`, `iss` = `https://<team>`, `exp` / `nbf` / `iat` with 60 s skew. Unknown `kid`
  refetches at most once per 30 s. The dashboard shows whether Access is configured;
  production should have it (Q3).
- **Audit trail.** `audit_log` (migration 0003) rejects UPDATE and DELETE with triggers. Mutations
  are audit-first (`audited`): the intent row is written before the change, so nothing changes
  without a trail; a failing change appends `<action>.failed` with the error code. `detail` holds
  ids, durations and the admin-written reason only; keys that look like personal data (e-mail,
  IP, token, password, user agent, address, cookie) throw. Reasons are admin-written free text; the
  form tells admins not to include personal data. Rendering is always text (Svelte escapes it).
- **Users.** Search never matches partial e-mails (no address harvesting); exact e-mail searches
  are POSTed (`?/searchEmail`) so addresses stay out of URLs and edge logs, and a `?q=` with `@` is
  ignored. Results show nickname, masked e-mail (`m***@e***.com`), verified, role, ban state,
  creation date. Admins cannot ban themselves or other admins from the UI (the operator removes the
  role first). Ban durations: 1, 7, 30, 90, 365 days or permanent; `banUser` also revokes the
  user's sessions. Expired bans are lifted by Better Auth at the next sign-in.
- **Read-only switch.** `"1"` in KV = on. The isolate cache (≤ 10 s) bounds KV reads; KV itself can
  take about a minute to propagate. A KV read failure keeps the last known value (or off) and logs
  `admin.read_only_lookup_failed` with the error class only. While on, `enforceWritable` answers
  every non-GET/HEAD/OPTIONS request with 503 `{"code":"READ_ONLY"}`, `Retry-After: 300`,
  `Cache-Control: no-store`, except: `/api/auth/sign-in/email`, `/api/auth/sign-in/username`,
  `/api/auth/two-factor/verify-totp`, `/api/auth/two-factor/verify-backup-code`,
  `/api/auth/sign-out`, `/admin` and `/admin/*` (guarded and audited; moderation keeps working
  during an incident). Webhooks get 503 and are retried by the sender.

## Wiring (outside this directory)

- `src/hooks.server.ts`, first step of the sequence:

  ```ts
  import { enforceWritable } from '#lib/server/admin/read-only.ts';
  const readOnly: Handle = async ({ event, resolve }) =>
  	(building || !event.platform
  		? null
  		: await enforceWritable(event.request, getServerEnv(event.platform))) ?? resolve(event);
  export const handle = sequence(readOnly, paraglide, auth, securityHeaders, accessLog);
  ```

- Better Auth's own `/api/auth/admin/*` HTTP endpoints check only the role. The auth `before` hook
  must reject them when called over HTTP (`ctx.request` set); the admin pages call
  `auth.api.banUser` / `unbanUser` server-side (no request), after this guard.

## Operator tools

- `tools/grant-admin.mjs` is the only way to get the admin role:
  `node tools/grant-admin.mjs [--email <a>] [--create] [--operator <label>] [--env staging|production] [--local]`.
  `--email` defaults to `ADMIN_EMAIL` from `.env` and is never printed. `--create` creates the
  account without a password (e-mail marked verified, role admin, nothing sent); the operator then
  uses `/esqueci-senha` (only that mailbox receives the link) and enables 2FA in `/conta`. Writes
  `audit_log` (`user.grant_admin`, actor_kind `operator`, detail `previousRole` / `created`).
- `tools/access-log-query.mjs` mirrors each judicial request into `audit_log`
  (`access_log.query`, actor_kind `operator`, target the request id, detail request id + window).
- Other tools writing audit rows: `INSERT INTO audit_log (id, actor_id, actor_kind, action,
target_kind, target_id, detail, created_at)` with `actor_kind 'operator'`, a UUID id, JSON
  detail without personal data and `created_at` in epoch milliseconds.
