# Authentication core (T3.5)

Better Auth 1.7.10 on Cloudflare Workers with D1. Server-only modules; nothing here imports
`$app/*` except `kit.ts` (which only imports `@sveltejs/kit`), so the integration tests drive
`auth.handler(request)` inside workerd.

## Modules

| File                         | What it does                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../auth.ts`                 | `createAuth(env, { waitUntil, plugins?, baseURL?, beforeDeleteUser? })`: one instance per request. `toAuthLocals()` maps `getSession()` to `App.Locals`. Re-exports the session-policy helpers. |
| `password.ts`                | scrypt `N=2^14 r=8 p=5`, 16-byte salt, 64-byte key, NFKC, constant-time compare. Format `scrypt$16384$8$5$<saltHex>$<hashHex>`; malformed or out-of-bounds hashes never verify; `needsRehash`.  |
| `username.ts`, `reserved.ts` | Nickname rules (§3.7): NFKC + lowercase, 3 to 24 chars of `[a-z0-9._-]`, confusable skeleton, reserved names.                                                                                   |
| `hooks.ts`                   | `hooks.before` (origin, sign-up switch, nickname rules, delete needs password, T3.3 guard + Turnstile) and `hooks.after` (2FA marker, "password changed" notice).                               |
| `emails.ts`                  | Auth e-mails through the T3.2 provider under `waitUntil`; the change-email confirmation to the current address has its own copy here.                                                           |
| `session-policy.ts`          | `isAdminEffective`, `isFreshSession` / `requireFreshSession`, `hasTwoFactorMarker`.                                                                                                             |
| `guards.ts`, `kit.ts`        | `checkUser` / `checkVerified` (typed results) and the SvelteKit `requireUser` / `requireVerified` (`error(401 \| 403)`).                                                                        |
| `logger.ts`, `user-agent.ts` | Better Auth logger without personal data (warn level, redacted messages, error names only); session user agent reduced to "browser on OS".                                                      |

## Wiring

- `src/hooks.server.ts`: `sequence(paraglide, auth, securityHeaders, accessLog)`. The auth step builds
  the instance (`sveltekitCookies(getRequestEvent)` as the last plugin), puts it in `locals.auth`
  and fills `locals.user` / `locals.session` (null on failure; never throws for anonymous users).
  It steps aside while prerendering.
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
  `PASSWORD_REQUIRED` (delete without password), plus Better Auth's own codes
  (`EMAIL_NOT_VERIFIED`, `INVALID_EMAIL_OR_PASSWORD`, `INVALID_TOKEN`, `BANNED_USER`, ...).
- **Links in e-mails:** reset → `/redefinir-senha?token=…` (the page POSTs `/reset-password`);
  verification, change-email steps and account deletion → Better Auth GET endpoints under
  `/api/auth/` that redirect to the `callbackURL` sent by the page (relative paths or
  `PUBLIC_ORIGIN` only). "Secure my account" links → `/esqueci-senha`.
- **Nickname:** `displayUsername` may differ from `username` only in case/compatibility forms.
  Not done here: change once per 30 days and the 90-day hold of the old nickname (§3.7, T3.7).

## Decisions

- **Per-request instance, D1 native.** `database: env.DB` (Kysely D1 dialect, no interactive
  transactions). Runtime schema validation is off: with per-request instances it would introspect
  D1 on every request. `tests/integration/auth/schema.test.ts` runs Better Auth's explicit schema
  check against `migrations/0001_auth.sql` instead.
- **Rate limiting** is the T3.3 guard only (`rateLimit.enabled: false`). IP: `disableIpTracking`;
  the client IP (`cf-connecting-ip`) is only hashed by the guard.
- **Cookies:** `open-auri.*` names (`__Secure-` prefixed on https), HttpOnly, SameSite=Lax, Secure
  on https, Path=/. No cookie cache: every request reads the session row, so sign-out, revocation,
  password reset and bans apply at once.
- **Freshness:** `session.freshAge` = 10 min for Better Auth's sensitive endpoints (change e-mail,
  delete, 2FA disable). `requireFreshSession` (T3.8 destructive actions) also accepts a 2FA
  verification within the last 10 minutes.
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
