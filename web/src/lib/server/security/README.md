# Security layer (T3.3)

Server-only modules. No `$app/*` imports, so the integration tests can run them inside workerd.

## Modules

| File            | What it does                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turnstile.ts`  | `verifyTurnstile({ token, action, hostname, secret })`: Siteverify with `idempotency_key`, no `remoteip`, token ≤ 2048. It fails closed: anything other than success with a matching action and hostname is a failure, and network or config errors return `unavailable`.                                                                                                                                                 |
| `iphash.ts`     | `ipHash(ip, { pepper, salt })`: HMAC-SHA256(pepper ‖ daily salt, normalized IP). IPv4-mapped IPv6 is folded into IPv4, and IPv6 is hashed per /64 by default. `getDailySalt(kv, date)` reads or creates `salt:YYYY-MM-DD` in CONFIG. The file header documents the creation race.                                                                                                                                         |
| `ratelimit.ts`  | `rateLimit(binding, key)` wraps the Workers RateLimit bindings. `slidingWindowLimit(db, rules)` keeps D1 sliding-window counters, which handle any window, including > 60 s. `rateLimitKey.*` builds keys and refuses raw IPs. `authRateLimit(subject)` holds the per-path auth rules: sign-in 3/10 s, sign-up 3/60 s, reset 3/60 s, resend verification 3/300 s, change-email 3/300 s, plus per-e-mail and per-IP rules. |
| `auth-guard.ts` | `createAuthGuard({ env })` returns `guard({ path, ip, email, userId, turnstileToken })`, which resolves to `{ ok }` or `{ ok: false, status, code, retryAfter? }`. The order is RL_AUTH per IP hash, then the D1 rules, then Turnstile. Any dependency failure returns 503.                                                                                                                                               |
| `headers.ts`    | `securityHeaders()` and `applySecurityHeaders(response, { origin })` cover the headers of §3.8. `renderStaticHeadersFile()` produces the content of `web/_headers`.                                                                                                                                                                                                                                                       |
| `access-log.ts` | `captureAccess(event, { queue, enabled, waitUntil, key, status, userId })` handles the Marco Civil art. 15 capture. It encrypts the record and sends it to ACCESS_LOG_QUEUE through `waitUntil`. On S6 routes the group becomes `s6`, the user id is dropped and the send is randomly delayed.                                                                                                                            |

Related modules elsewhere in the repo:

- `workers/jobs/src/jobs/`: `rotate-salt`, `rate-limit-gc`, `access-log-consumer`, `access-log-retention`, and `access-log-crypto.js`, which defines the shared encryption format.
- `tools/access-log-query.mjs`: the operator export for judicial orders.
- `web/migrations/0007_access_log.sql`: the D1 tables.

## Decisions

- **No raw IP outside the encrypted access log.** Rate-limit keys contain only keyed hashes, made with the daily salt. Salts older than yesterday are deleted every day, so old hashes cannot be recomputed. Logs carry codes and counts only.
- **D1, not KV, counts the exact auth limits.** KV has no atomic increment and is eventually consistent. RL_AUTH is set to 20/60 s in wrangler, so it cannot express 3/10 s or windows over 60 s; it stays as a coarse guard.
- **Access-log messages are encrypted before they enter the queue.** Neither the queue nor the dead-letter queue ever holds a clear IP. The key is derived with HKDF from the ACCESS_LOG_KEY keyring (`kid:secret[,…]`): the first key encrypts and every key decrypts. The object header carries the key id, and the object key is bound as AAD.
- **Kit owns the document CSP.** The headers code never replaces Kit's policy. It adds `X-Frame-Options: DENY` and a separate `frame-ancestors 'none'` policy. Non-HTML responses get `default-src 'none'`, and JavaScript responses get no CSP. Nonce-only CSP is T5.4.

## What T3.5 wires (hooks.server.ts and auth.ts)

1. **Better Auth `hooks.before`:** call `guard({ path: ctx.path, ip: <cf-connecting-ip>, email: <body email, or username for /sign-in/username, or new email for /change-email>, userId, turnstileToken: <cf-turnstile-response> })`. On failure, throw an `APIError` with its status and code, and send `Retry-After` on 429. Run Better Auth with `rateLimit.enabled: false`.
2. **Every response:** `applySecurityHeaders(await resolve(event), { origin: PUBLIC_ORIGIN })`.
3. **After `resolve`:** `captureAccess(event, { queue: env.ACCESS_LOG_QUEUE, enabled: flags.accessLogEnabled, waitUntil: (p) => platform.ctx.waitUntil(p), key: secrets.accessLogKey, status: response.status, userId: locals.user?.id })`.
4. **Pages:** render `<Turnstile siteKey={PUBLIC_TURNSTILE_SITE_KEY} action={TURNSTILE_ACTIONS.signIn} bind:token />`. The site key comes from `$app/env/public`.
