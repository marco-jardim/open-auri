# Brief comum dos delegados da Fase 5 (produção, operação e aceite)

Leia antes de qualquer tarefa da F5, junto com `D:\git\open-auri\docs\plans\f2-delegate-brief.md`, `f3-delegate-brief.md` (seção "Lições") e `f4-delegate-brief.md`. Plano: `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-plano.md` (§0.15 configuração do operador, §0.16 repositório público, §3.8 LGPD e segurança, Fase 5 a partir da linha ~2269, §8–§10 aceite e QG).

## Fatos do PF5

- **Conta e recursos:** `wrangler whoami` confere com `CLOUDFLARE_ACCOUNT_ID` do `.env`. D1, KV, R2 (ciclo de vida de 180 dias em `access-log/`), filas e DLQ existem em produção e staging desde o PF3 (IDs só no `.env`). Rate limits por namespace no template.
- **OAuth do wrangler:** cobre Workers, rotas e domínios customizados de Workers, D1, KV, R2, filas, Turnstile e leitura de zona. **Não** escreve DNS. O token fica só em variável de processo (`npx wrangler auth token --json`), nunca impresso.
- **Domínio:** a zona `open-auri.com` está ativa na mesma conta. **Decisão:** produção em `https://open-auri.com` (domínio customizado do Worker web; o `workers.dev` de produção redireciona 301 para ele). Staging continua em `workers.dev`. O nome do domínio é público (é o produto); IDs da zona e da conta continuam só no `.env`.
- **Resend:** o domínio de envio exige registros DNS (SPF, DKIM, MX de retorno) que o OAuth não consegue criar → bloqueio documentado (issue `bloqueio`); até lá produção sobe com `SIGNUP_ENABLED=false` e o remetente de teste. Nada no código depende disso.
- **`.env`:** campos `PUBLIC_LGPD_*` e `PUBLIC_POLICY_EFFECTIVE_DATE` preenchidos (Q-LEGAL-FIELDS ok). Ausentes e opcionais: `CLOUDFLARE_API_TOKEN` (deploy pelo GitHub, H-CF-TOKEN), `ACCESS_AUD`/Access (H-ACCESS), `RESEND_WEBHOOK_SECRET` (criado na T5.7 pela API do Resend).
- **SvelteKit 3:** não existe `svelte.config.js`; CSP e opções do Kit ficam em `D:\git\open-auri\web\vite.config.ts` (arquivo da fila de integração; na W5.1 só a T5.4 pode editá-lo, e só o bloco `csp`).
- **Analytics Engine (T5.2):** binding novo `METRICS` (dataset `open_auri_metrics`, criado na primeira escrita). Binding novo exige: template do wrangler (web e/ou jobs), `Env` em `web/src/lib/server/types.ts`, o teste que compara `Env` com o template, e `getServerEnv`.
- **Versões (0.14):** eslint 10.13.0 e svelte-check 4.7.7 atualizados no PF5; demais iguais ao PF4; `autocannon` 8.0.0 (MIT) para a T5.6.

## Regras da F5

- Nenhum valor do `.env` em arquivo versionado, log, teste ou relatório. Scripts leem o `.env` (`node --env-file`) e nunca ecoam valores. `node D:\git\open-auri\tools\check-sensitive.mjs` precisa sair 0.
- Ferramentas em `tools/*.mjs` seguem o padrão existente (`tools/render-wrangler.mjs`, `tools/sync-secrets.mjs`, `tools/grant-admin.mjs`): funções puras testáveis + CLI fino; testes em `test/tools/*.test.mjs` (`node --test`, rodados pela raiz).
- Nada de deploy, migração remota ou chamada a APIs externas pelos delegados: os delegados escrevem código, scripts e documentação; o orquestrador executa contra a conta.
- Documentos operacionais em pt-BR, sem travessão, sem dados pessoais ou da empresa, sem IDs.
- Nunca commitar; nunca `Co-Authored-By` nem "Generated with"; sem `as any`, `@ts-ignore`, `@ts-expect-error`, `catch` vazio.
