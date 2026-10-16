# Brief comum dos delegados da Fase 3 (backend, autenticação e conta)

Leia antes de qualquer tarefa da F3, junto com `D:\git\open-auri\docs\plans\f2-delegate-brief.md` (stack do web, SvelteKit 3, i18n por staging, regras de qualidade). Plano: `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-plano.md` (§3.7, §3.8, §12, Fase 3 a partir da linha ~1615 e a tarefa citada no despacho).

## Infra (PF3)

- Worker do SvelteKit (`web/`, `adapter-cloudflare`, Workers Static Assets) e Worker de jobs (`workers/jobs/`, criado na T3.1).
- `compatibility_date` ≥ 2026-08-04: `nodejs_compat` já vem ligado; `node:crypto` disponível no workerd.
- Recursos já criados na conta do `.env` (os IDs estão no `.env`, **nunca** em arquivo versionado; templates usam `${VAR}`): D1 `${D1_DATABASE_NAME}` / `${D1_DATABASE_ID}` (+ `_STAGING`), KV `${KV_CONFIG_ID}` (+ `_STAGING`), R2 `${R2_BUCKET}` (+ `_STAGING`, ciclo de vida de 180 dias em `access-log/`), filas `${ACCESS_LOG_QUEUE}` e DLQ `${ACCESS_LOG_DLQ}` (+ `_STAGING`).
- Bindings (plano T3.1): D1 `DB`, R2 `MEDIA`, KV `CONFIG`, rate limits `RL_AUTH`, `RL_API`, `RL_WRITE` (`ratelimits: [{ name, namespace_id, simple: { limit, period } }]`, `period` só 10 ou 60), fila `ACCESS_LOG_QUEUE`, variáveis `PUBLIC_ORIGIN`, `GITHUB_URL`, flags; segredos `BETTER_AUTH_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TURNSTILE_SECRET`, `IPHASH_PEPPER`, `ACCESS_LOG_KEY`.

## Better Auth 1.7.10 (fatos lidos no pacote instalado)

- SvelteKit: `svelteKitHandler({ auth, event, resolve, building })` de `better-auth/svelte-kit` (`building` de `$app/env`); **não** preenche `event.locals`: faça `auth.api.getSession({ headers: event.request.headers })` antes. `sveltekitCookies(getRequestEvent)` (de `$app/server`) é sempre o **último** plugin.
- D1 nativo: `database: env.DB`. Sem transações interativas (usa `batch`); o reset de senha não é atômico (documentar e mitigar pela ordem das operações).
- Hash: **não** use o padrão. Use `emailAndPassword.password: { hash, verify }` com `node:crypto` scrypt N=16384, r=8, p=5, dkLen 64, sal de 16 bytes, formato `scrypt$16384$8$5$<salHex>$<hashHex>`, comparação em tempo constante (`timingSafeEqual`), `normalize('NFKC')` na senha. 123 ms locais (PF3), dentro do limite de 200 ms.
- Opções: `emailAndPassword.{requireEmailVerification, minPasswordLength, sendResetPassword, revokeSessionsOnPasswordReset}`; `emailVerification.sendVerificationEmail`; `user.changeEmail.{enabled, sendChangeEmailConfirmation}`; `user.deleteUser.{enabled, sendDeleteAccountVerification, beforeDelete, afterDelete}`; `session.freshAge` (padrão 1 dia).
- Rotas (`ctx.path`): `/sign-up/email`, `/sign-in/email`, `/sign-in/username`, `/request-password-reset`, `/reset-password`, `/change-email`, `/change-password`, `/delete-user`, `/delete-user/callback`, `/update-user`, `/send-verification-email`, `/list-sessions`, `/revoke-session`, `/revoke-sessions`, `/revoke-other-sessions`.
- Hooks: `hooks.before: createAuthMiddleware(async (ctx) => { … throw new APIError('TOO_MANY_REQUESTS', { message }) })` de `better-auth/api`.
- `advanced.ipAddress.disableIpTracking: true` faz `getIP()` devolver `null`. `rateLimit.enabled: false` (nosso rate limit é o da T3.3).
- `twoFactor` não grava marcador de "2FA verificado" na sessão: a T3.5 cria o seu (campo adicional da sessão ou tabela), definido no momento da verificação TOTP/backup.
- CLI: `npx auth@latest generate` gera o esquema; o `migrate` não alcança D1. Migrações SQL ficam em `web/migrations/NNNN_*.sql` (números pré-atribuídos pelo plano) e são aplicadas com `wrangler d1 migrations apply`.

## Testes de Worker

- **T3.1 pronta (commit `f25f5e8`).** Config própria `web/vitest.integration.config.ts` (fora dos `projects` do `vite.config.ts`: o plugin do adaptador do SvelteKit virtualizaria `cloudflare:workers`). Script `npm run -w web test:int` (o orquestrador roda). Os testes ficam em `web/tests/integration/**` (TS project próprio `web/tests/integration/tsconfig.json`, sem DOM; `npm run -w web check:int`). Migrações de `web/migrations/*.sql` são aplicadas no setup. Segredos de teste fixos em `vitest.integration.config.ts` (o segredo do Turnstile lá é o de teste que sempre passa). Código de servidor testado aqui não pode importar `$app/*`.
- Tipos: `Env` escrito à mão em `web/src/lib/server/types.ts` (imports de tipo de `@cloudflare/workers-types` em forma de módulo; um teste compara com o template). `getServerEnv(platform)` em `web/src/lib/server/env.ts`; helpers D1 em `web/src/lib/server/db.ts`: `sql(db, 'SELECT … WHERE a = ?', valor)` (confere o número de `?`), `first`, `all`, `run`, `batch(db, [...])` (atômico, sem transação interativa). Worker de jobs: `workers/jobs/src/index.ts` + registro tipado em `workers/jobs/src/jobs/registry.ts`.
- Projeto `integration` do Vitest com `cloudflareTest({ wrangler: { configPath } })` de `@cloudflare/vitest-plugin` 1.4.4 (Vitest 5). `env`/`exports` de `cloudflare:workers`; `applyD1Migrations`, `createExecutionContext`, `waitOnExecutionContext`, `createMessageBatch` de `cloudflare:test`.
- Saídas HTTP (Resend, Turnstile) mockadas com `@msw/cloudflare` (`setupNetwork`) + `msw` 3 (`http`, `HttpResponse`). Nada sai para a rede nos testes.
- Turnstile, chaves de teste: site `1x00000000000000000000AA` (passa), `2x00000000000000000000AB` (falha); segredo `1x0000000000000000000000000000000AA` (passa), `2x0000000000000000000000000000000AA` (falha), `3x0000000000000000000000000000000AA` (`timeout-or-duplicate`).
- Resend: `POST https://api.resend.com/emails`, cabeçalhos `Authorization: Bearer`, `User-Agent` (obrigatório) e `Idempotency-Key` (≤ 256 caracteres, 24 h; 409 em conflito). Webhook svix: `svix-id`, `svix-timestamp`, `svix-signature` (`v1,<base64>` separados por espaço), HMAC-SHA256 com a chave base64 depois de `whsec_`, sobre `${id}.${timestamp}.${corpoBruto}`, tolerância de tempo e comparação em tempo constante. Eventos `email.bounced`, `email.complained`.

## Regras

- O `router_run` só aceita `npm test`, `npm run lint`, `npm run typecheck` da raiz. Testes do web, wrangler, `npm install` e migrações são rodados pelo orquestrador. Escreva os testes e informe o que não rodou.
- Segredos só por `wrangler secret`/`.dev.vars` (ignorado). Nada do `.env` em arquivo versionado, log, teste ou mensagem. Logs sem PII (nada de e-mail, IP, token, user-agent completo).
- Consultas SQL sempre parametrizadas (`prepare(...).bind(...)`).
- Nunca commite. Nunca `Co-Authored-By` nem "Generated with".
