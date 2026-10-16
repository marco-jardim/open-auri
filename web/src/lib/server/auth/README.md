# Authentication core (T3.5)

Better Auth 1.7.10 on Cloudflare Workers with D1. Server-only modules; nothing here imports
`$app/*` except `kit.ts` (which only imports `@sveltejs/kit`), so the integration tests drive
`auth.handler(request)` inside workerd.

## Modules

| File                         | What it does                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../auth.ts`                 | `createAuth(env, { waitUntil, plugins?, baseURL?, beforeDeleteUser? })`: one instance per request. `toAuthLocals()` maps `getSession()` to `App.Locals`. Re-exports the session-policy helpers.                                                                                                                                   |
| `password.ts`                | scrypt `N=2^14 r=8 p=5`, 16-byte salt, 64-byte key, NFKC, constant-time compare. Format `scrypt$16384$8$5$<saltHex>$<hashHex>`; malformed or out-of-bounds hashes never verify; `needsRehash`.                                                                                                                                    |
| `username.ts`, `reserved.ts` | Nickname rules (§3.7): NFKC + lowercase, 3 to 24 chars of `[a-z0-9._-]`, confusable skeleton, reserved names.                                                                                                                                                                                                                     |
| `compose.ts`                 | Order of the server hooks (`HOOK_ORDER`, read-only first) and `createReadOnlyHandle`.                                                                                                                                                                                                                                             |
| `hooks.ts`                   | `hooks.before` (admin plugin and unused endpoints closed over HTTP, origin, sign-up switch, nickname and name rules, delete needs password, T3.3 guard + Turnstile, per-user secret limits, change-email freshness, single-use change-email links) and `hooks.after` (wrong-secret count, 2FA marker, "password changed" notice). |
| `secret-guard.ts`            | Per-user limits on password and second-factor checks of a session (`beginSecretAttempt`, `recordSecretFailure`, `checkUserPassword`, raw `verifyUserPassword`).                                                                                                                                                                   |
| `link-uses.ts`               | `claimLinkUse`: first-use claim of a change-email link (table `auth_link_uses`, migration 0010).                                                                                                                                                                                                                                  |
| `emails.ts`                  | Auth e-mails through the T3.2 provider under `waitUntil`; the change-email confirmation to the current address has its own copy here. `withEmailLocale` sets the locale of server-side calls.                                                                                                                                     |
| `session-policy.ts`          | `isAdminEffective`, `isFreshSession` / `requireFreshSession`, `hasTwoFactorMarker`.                                                                                                                                                                                                                                               |
| `guards.ts`, `kit.ts`        | `checkUser` / `checkVerified` (typed results) and the SvelteKit `requireUser` / `requireVerified` (`error(401 \| 403)`).                                                                                                                                                                                                          |
| `logger.ts`, `user-agent.ts` | Better Auth logger without personal data (warn level, redacted messages, error names only); session user agent reduced to "browser on OS".                                                                                                                                                                                        |

## Wiring

- `src/hooks.server.ts`: `sequence(readOnly, paraglide, auth, securityHeaders, accessLog)`; the
  order lives in `compose.ts` (unit-tested). `readOnly` (T3.8 switch) answers 503 `READ_ONLY` to
  writes outside its allowlist before anything else runs, so that response carries neither the
  security headers nor an access-log record. The auth step builds the instance
  (`sveltekitCookies(getRequestEvent)` as the last plugin, `beforeDeleteUser:
accountDeletionHook(env)` from T3.7), puts it in `locals.auth` and fills `locals.user` /
  `locals.session` (null on failure; never throws for anonymous users). Everything steps aside
  while prerendering.
- `/api/auth/*` is served only by `src/routes/api/auth/[...all]/+server.ts` with `locals.auth.handler`
  (no `svelteKitHandler`), so auth responses get a route id in the access log and pass through the
  header and access-log hooks.
- Server code (T3.7/T3.8 actions) calls `locals.auth.api.*({ headers: request.headers, ... })`.

## Contracts for the pages (T3.6, T3.7)

- **Turnstile:** guarded endpoints (`/sign-up/email`, `/sign-in/email`, `/sign-in/username`,
  `/request-password-reset`, `/change-email`) read the widget token from the
  **`x-turnstile-token`** request header (`TURNSTILE_HEADER`, also exported by `$lib/auth-client`).
  Actions: `sign-up`, `sign-in`, `reset-password`, `change-email`.
- **Error codes** (JSON `code`): `SIGNUP_DISABLED` (403), `INVALID_ORIGIN` (403),
  `TURNSTILE_REQUIRED` (400), `TURNSTILE_FAILED` (403), `TURNSTILE_UNAVAILABLE` /
  `RATE_LIMIT_UNAVAILABLE` (503), `RATE_LIMITED` (429 + `Retry-After`), `INVALID_USERNAME`,
  `USERNAME_IS_ALREADY_TAKEN` (also for reserved names), `DISPLAY_USERNAME_MISMATCH`,
  `PASSWORD_REQUIRED` (delete without password), `INVALID_NAME`, `SESSION_NOT_FRESH` (403),
  `INVALID_PASSWORD` (400, change-email of a stale session), `TWO_FACTOR_REQUIRED` (403),
  `LINK_ALREADY_USED`, plus Better Auth's own codes
  (`EMAIL_NOT_VERIFIED`, `INVALID_EMAIL_OR_PASSWORD`, `INVALID_TOKEN`, `BANNED_USER`, ...).
- **Links in e-mails:** reset → `/redefinir-senha?token=…` (the page POSTs `/reset-password`);
  verification, change-email steps and account deletion → Better Auth GET endpoints under
  `/api/auth/` that redirect to the `callbackURL` sent by the page (relative paths or
  `PUBLIC_ORIGIN` only). "Secure my account" links → `/esqueci-senha`.
- **Nickname:** set at sign-up (`displayUsername` may differ from `username` only in
  case/compatibility forms; a nickname on its 90-day hold answers `USERNAME_IS_ALREADY_TAKEN`, like
  a taken one). Every later change goes through `account/nickname.ts` (/conta: 30-day interval,
  holds), which writes D1 directly. `/update-user` with `username` or `displayUsername` answers
  400 `USERNAME_CHANGE_NOT_ALLOWED`, over HTTP and server-side alike, and
  `databaseHooks.user.update.before` refuses a nickname write from any Better Auth endpoint
  (including the admin plugin's `/admin/update-user`). Only writes outside Better Auth endpoints
  (none today) could bypass the rules; new code must use `changeNickname`.
- **Admin plugin:** its endpoints (`/admin/*`: set-role, ban/unban, create/update/remove user,
  set-user-password, sessions, impersonate/stop-impersonating, has-permission) answer 404 over
  HTTP. The /admin area (T3.8) calls them server-side (`locals.auth.api.banUser({ headers, body })`,
  no request object) after its own role + 2FA + freshness guard.

## Decisions

- **Per-request instance, D1 native.** `database: env.DB` (Kysely D1 dialect, no interactive
  transactions). Runtime schema validation is off: with per-request instances it would introspect
  D1 on every request. `tests/integration/auth/schema.test.ts` runs Better Auth's explicit schema
  check against `migrations/0001_auth.sql` instead.
- **Rate limiting** (`rateLimit.enabled: false`, which also drops Better Auth's `/two-factor/*`
  throttle) is ours: the T3.3 guard on the anonymous endpoints, and per-user D1 limits on every
  secret checked for a session (`secret-guard.ts`): `/two-factor/verify-totp` and
  `/verify-backup-code` of a signed-in session (admin re-authentication included, it calls
  `verifyTOTP`), `/change-password`, `/delete-user` with a password, `/two-factor/enable` and
  `/disable`, and the password `/change-email` takes from a stale session. 5 attempts per 5 min
  (counted before the check) and 20 wrong secrets per day (checked before, counted on failure:
  the lockout) per user and kind; 429 `RATE_LIMITED` + `Retry-After`. The sign-in 2FA challenge
  (no session yet) keeps Better Auth's own lockout (5 tries per challenge, 10 consecutive failures
  lock the account 15 min). IP: `disableIpTracking`; the client IP (`cf-connecting-ip`) is only
  hashed by the guard.
- **Closed endpoints** (`CLOSED_AUTH_PATHS`, 404 over HTTP, still callable server-side): everything
  the app does not use: `/update-session`, `/update-user`, `/is-username-available`,
  `/list-sessions`, `/verify-password`, `/reset-password/:token`, `/two-factor/get-totp-uri`,
  `/generate-backup-codes`, `/send-otp`, `/verify-otp`, and the social/linked-account endpoints.
  `/revoke-session(s)` and `/revoke-other-sessions` stay open (they only remove the caller's own
  sessions, as /conta does). `name` (sign-up, server-side `/update-user`) is at most 64 characters
  without control or bidi characters (400 `INVALID_NAME`): it greets the user in e-mails.
- **Cookies:** `open-auri.*` names (`__Secure-` prefixed on https), HttpOnly, SameSite=Lax, Secure
  on https, Path=/. No cookie cache: every request reads the session row, so sign-out, revocation,
  password reset and bans apply at once.
- **Freshness / re-authentication.** Better Auth's `session.freshAge` (10 min) only applies to
  endpoints using its `freshSessionMiddleware`; `/change-email`, `/delete-user` and
  `/two-factor/disable` use `sensitiveSessionMiddleware`, which only requires a session. So the
  before-hook enforces it (every caller, HTTP and /conta alike):

  | Endpoint                                                        | Requirement                                                                                                                                 |
  | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
  | `/change-email`                                                 | `isFreshSession` (created or 2FA-verified < 10 min), or a correct `password` in the body (403 `SESSION_NOT_FRESH` / 400 `INVALID_PASSWORD`) |
  | `/delete-user`                                                  | the password (400 `PASSWORD_REQUIRED`), or the mailed confirmation token                                                                    |
  | `/change-password`, `/two-factor/enable`, `/two-factor/disable` | the current password (checked by Better Auth)                                                                                               |
  | `/two-factor/enable`, `/two-factor/disable` (admin with 2FA on) | also the session's 2FA marker (403 `TWO_FACTOR_REQUIRED`)                                                                                   |

  Every password checked there is under the per-user limits above. `requireFreshSession` (T3.8
  destructive actions) also accepts a 2FA verification within the last 10 minutes.

- **E-mail locale:** the request's `oa_lang` cookie (a malformed value is ignored), then
  Accept-Language, then pt-BR. Server-side calls carry no Request: the /conta actions wrap their
  `auth.api.*` calls in `withEmailLocale(<locale of the page request>)`.
- **Admin 2FA marker:** `session.twoFactorVerifiedAt` (additional field, `input: false`;
  `/update-session` is disabled). Set in `hooks.after` when `/two-factor/verify-totp` or
  `/two-factor/verify-backup-code` succeed, on the session created by that request (challenged
  sign-in, or the first verification that enables 2FA and rotates the session) or else the current
  one. It dies with the session. `isAdminEffective` = role `admin`, not banned, not an impersonation
  session, and (ADMIN_2FA_REQUIRED off, or 2FA enabled and marker present).
- **Anti-enumeration:** sign-in gives one error for unknown e-mail and wrong password (Better Auth
  hashes a dummy password for unknown users); request-password-reset and sign-up (verification
  required) answer the same for existing and new addresses; change-email to a taken address answers
  like a free one and sends nothing. E-mails go out under `waitUntil`, so response time does not
  depend on delivery.
- **E-mail change** (verified users): confirmation link to the current address → then
  `confirm-new-email` to the new address and `email-change-notice` to the old one → the new
  address's link switches the e-mail. That last link signs its opener in when no session is
  present (Better Auth behaviour; the change was already approved from the old mailbox). If the new
  address got registered in between, the unique index rejects the update (500, nothing changes).
  Both links are single-use (Q3-4): the hook claims a link (SHA-256 of the token in
  `auth_link_uses`) right before Better Auth acts on it, only when it would act (valid token,
  account found, no session of another account); a reused link redirects to its same-origin
  `callbackURL` with `?error=LINK_ALREADY_USED` (400 JSON otherwise). A claimed link whose step
  then fails (e.g. the new address was taken meanwhile) needs a new request. The final messages
  (`confirm-new-email`, `email-change-notice`) are keyed for Resend on (user, new address,
  `email_change_requests.requested_at`), so they go out once per request; requests made outside
  /conta (no row) fall back to the token key.
- **Account deletion:** password required, then a confirmation link (1 h) that only works in a
  browser signed in as that user. `beforeDelete` runs the injected content-deletion policy (default:
  delete `policy_acceptances`); `afterDelete` sends "account deleted". Child auth rows cascade.

## D1 atomicity (plan §12)

D1 has no interactive transactions; Better Auth's `runWithTransaction` runs its steps one by one.

- **Password reset** (`resetCredentialPassword`): 1) consume the token (`DELETE … RETURNING`, a
  single atomic statement, so two concurrent resets cannot both use it), 2) delete all sessions, 3) write the new hash. A failure after 1 leaves the old password and a spent token (the user
  requests a new link); a failure after 2 leaves everyone signed out with the old password. Neither
  order leaves a new password with old sessions alive. Tested: single use, expiry, revocation.
- **Change password with `revokeOtherSessions`:** sessions are deleted before the new hash is
  written and a new session is created last; a failure in between signs the user out.
- **Account deletion:** `beforeDelete` (content policy) runs before the user row is deleted. If the
  delete then fails, the policy's deletions stay done; T3.7 must make its policy idempotent so a
  retry completes. The confirmation token is consumed first, so a retry needs a new link.
- **Sign-up:** user row, then credential account. A failure in between leaves an account without a
  password; the user can recover through password reset (which creates the credential).
