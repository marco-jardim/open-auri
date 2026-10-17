# Deploy do open-auri

Este guia cobre o deploy dos dois Workers (web e jobs) na Cloudflare, o caminho padrão pela máquina do operador, o caminho opcional pelo GitHub, o rollback e o domínio customizado. Nenhum valor real aparece aqui: IDs, nomes de recursos, chaves e e-mails ficam só no `.env` do operador (ou nos segredos do repositório, no deploy pelo GitHub).

## Ambientes

| Ambiente | Worker web | Origem | Banco D1 |
| --- | --- | --- | --- |
| staging | `<WORKER_NAME_WEB>-staging` | `https://<WORKER_NAME_WEB>-staging.<subdominio>.workers.dev` | `D1_DATABASE_NAME_STAGING` |
| production | `<WORKER_NAME_WEB>` | `https://open-auri.com` | `D1_DATABASE_NAME` |

O `PUBLIC_ORIGIN` usado no build e no `wrangler.jsonc` gerado vem do ambiente escolhido (`tools/deploy.mjs`, função `originFor`), não do `.env`: o `.env` pode continuar com a origem de desenvolvimento.

## Pré-requisitos

- Node 24 e `npm ci` feito na raiz.
- Login do Wrangler na conta certa: `npx wrangler login` e depois `npx wrangler whoami` (a conta listada precisa ser a de `CLOUDFLARE_ACCOUNT_ID`; o script confere de novo).
- `.env` completo na raiz (modelo em `.env.example`): identificadores Cloudflare, nomes e IDs dos recursos de produção e staging, todas as `PUBLIC_*` (inclusive `PUBLIC_LGPD_*` e `PUBLIC_POLICY_EFFECTIVE_DATE`) e os segredos de runtime. `RESEND_WEBHOOK_SECRET` é opcional (o sync pula com aviso).
- Segredos próprios de staging (recomendado): `BETTER_AUTH_SECRET_STAGING`, `ACCESS_LOG_KEY_STAGING`, `IPHASH_PEPPER_STAGING` e `RESEND_WEBHOOK_SECRET_STAGING`, gerados à parte. Com `--env staging`, `tools/sync-secrets.mjs` (e portanto o deploy) envia o valor de `<CHAVE>_STAGING` quando ela existe e não está vazia; senão usa `<CHAVE>`, o mesmo valor de produção, e imprime `Warning: <CHAVE>_STAGING is not set; staging uses the same <CHAVE> as production` (só o nome da chave, nunca o valor). Produção nunca lê as variantes `_STAGING`. Compartilhar esses segredos permite que uma sessão ou um hash de IP de staging valha em produção e que a chave dos registros de acesso de produção fique exposta em staging; evite.
- Recursos já criados (PF3/PF5): D1, KV, R2, filas e DLQ de cada ambiente.
- Para produção: o domínio customizado configurado no template web (seção "Domínio customizado").

## Deploy pela máquina do operador (padrão)

Staging:

```powershell
node --env-file=.env tools/deploy.mjs --env staging
```

Produção (exige a confirmação explícita):

```powershell
node --env-file=.env tools/deploy.mjs --env production --confirm-production
```

`--skip-tests` pula só os testes da raiz (use apenas quando acabaram de passar no mesmo commit) e só vale para staging: com `--env production` o script recusa (`--skip-tests is not allowed for a production deploy`). A varredura de dados sensíveis e o build nunca são pulados.

O script executa, nesta ordem, e para no primeiro erro:

1. **Conta:** `wrangler whoami --json` precisa listar `CLOUDFLARE_ACCOUNT_ID`.
2. **Verificações e build:** `node tools/check-sensitive.mjs`, `node --test "test/**/*.test.mjs"` e `vite build` do web com as `PUBLIC_*` reais e a origem do ambiente.
3. **Configuração:** gera `web/wrangler.jsonc` e `workers/jobs/wrangler.jsonc` a partir dos templates e envia os segredos de cada Worker (`tools/sync-secrets.mjs`, um `wrangler secret put` por segredo, valor pelo stdin).
4. **Bookmark do Time Travel:** `wrangler d1 time-travel info <banco> --env <ambiente> --json`. O bookmark aparece só na saída da execução (linha `Time Travel bookmark (...)`). **Anote-o**: é o ponto de restauração do D1 anterior às migrações.
5. **Migrações:** `wrangler d1 migrations apply DB --remote --env <ambiente>` (em `web/`).
6. **Deploy:** `wrangler deploy --env <ambiente>` em `web/` e depois em `workers/jobs/`.
7. **Smoke:** contra a origem do ambiente, `GET /` (200 e cabeçalhos de segurança: `x-content-type-options`, `x-frame-options`, `referrer-policy`, `permissions-policy`, `content-security-policy`, `strict-transport-security`), `GET /docs` (200), `GET /api/v1/feed` (200, JSON) e `GET /og/<id-inexistente>.png` (404). Cada verificação tenta até 3 vezes, com 5 s entre as tentativas.

A saída do Wrangler é capturada e nunca repassada ao terminal (pode conter e-mail ou IDs da conta). Quando um passo do Wrangler falha, o script mostra o comando para repetir manualmente e ver a mensagem completa.

Depois do primeiro deploy de produção, o grant de admin: `node --env-file=.env tools/grant-admin.mjs --env production` (atribui `admin` ao usuário de `ADMIN_EMAIL`, já verificado, no D1 remoto, com registro na auditoria; detalhes no cabeçalho do script).

## Deploy pelo GitHub (opcional)

O workflow `.github/workflows/deploy.yml` roda o mesmo `tools/deploy.mjs`. É manual (aba Actions, "Deploy", "Run workflow", escolha `staging` ou `production`) e só executa quando o segredo `CLOUDFLARE_API_TOKEN` existe; sem ele, termina com um aviso e não faz nada.

Configuração única:

1. **Token da Cloudflare** (`CLOUDFLARE_API_TOKEN`), restrito à conta do projeto, com permissões de conta: Workers Scripts (editar), D1 (editar), Workers KV Storage (editar), Workers R2 Storage (editar), Queues (editar), Account Settings (ler, para o `whoami` listar a conta); e, na zona `open-auri.com`, Workers Routes (editar). Ajuste se o Wrangler acusar permissão faltando.
2. **Segredos do repositório** com os mesmos nomes do `.env`: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_SUBDOMAIN`, `WORKER_NAME_WEB`, `WORKER_NAME_JOBS`, os recursos (`D1_*`, `KV_CONFIG_ID*`, `R2_BUCKET*`, `ACCESS_LOG_QUEUE*`, `ACCESS_LOG_DLQ*`), as `PUBLIC_*` (exceto `PUBLIC_ORIGIN`, derivada do ambiente) e os segredos de runtime (`BETTER_AUTH_SECRET`, `RESEND_API_KEY`, `RESEND_FROM`, `TURNSTILE_SECRET_KEY`, `IPHASH_PEPPER`, `ACCESS_LOG_KEY` e, quando existir, `RESEND_WEBHOOK_SECRET`). Para staging, também `BETTER_AUTH_SECRET_STAGING`, `ACCESS_LOG_KEY_STAGING`, `IPHASH_PEPPER_STAGING` e `RESEND_WEBHOOK_SECRET_STAGING` (opcionais; sem eles staging usa os de produção, com aviso, como no deploy local). Os segredos só entram no ambiente do passo que roda `tools/deploy.mjs`, nunca no `checkout`, no `setup-node` ou no `npm ci`.
3. **Variáveis do repositório** (opcionais, não secretas): `ACCESS_LOG_ENABLED` (padrão `true`), `SIGNUP_ENABLED` (padrão `false`), `ADMIN_2FA_REQUIRED` (padrão `true`).
4. **Ambiente `production`** em Settings, Environments, com revisores obrigatórios, para que todo deploy de produção espere uma aprovação.

Confirmação de produção: ao rodar o workflow com `production`, digite `production` no campo `confirm`. Sem esse texto exato, o job `gate` falha antes de ler qualquer segredo e nada é implantado; só com ele o workflow passa `--confirm-production` ao `tools/deploy.mjs` (e o deploy ainda espera a aprovação do ambiente). Para staging, o campo é ignorado.

As actions de terceiros (`actions/checkout`, `actions/setup-node`) ainda são referenciadas pela tag `v4`. Fixe cada uma pelo SHA completo do commit, com a versão em comentário (`uses: actions/checkout@<sha-de-40-caracteres> # v4.x.y`), depois de conferir o SHA no repositório da action.

Sem `.env` no runner, a varredura do passo 2 roda em `--no-env` (só padrões genéricos); a varredura completa continua sendo a do operador, local. Os logs do Actions são públicos: o script não imprime valores, e o GitHub mascara os segredos.

## CI

`.github/workflows/ci.yml` roda em todo PR e push na `main`, sempre com valores **fictícios** (nenhuma chamada à Cloudflare): lint e typecheck da raiz, varredura `check-sensitive --no-env`, `npm audit --omit=dev --audit-level=high`, compilação do Paraglide, Prettier, ESLint, `svelte-kit sync`, `svelte-check`, `check:int`, tipos e testes dos jobs, testes do núcleo com as metas de cobertura, unidade e componentes (Chromium do Playwright), integração, build com orçamentos e e2e (Chrome).

## Rollback

Decida primeiro se o problema é só de código (volte o Worker) ou também de dados ou esquema (volte o D1). Volte o código antes do banco, para o código antigo não rodar sobre um esquema que ele não conhece por mais tempo que o necessário.

### Versão anterior dos Workers

Em `web/` (e, se preciso, em `workers/jobs/`), com o `wrangler.jsonc` gerado (`npm run gen` no diretório):

```powershell
npx wrangler versions list --env production
npx wrangler rollback --env production --message "rollback: <motivo>"
```

Sem argumento, `wrangler rollback` volta para a versão anterior; para outra, passe o ID da versão listado por `versions list`. O rollback não mexe em segredos nem no D1.

### D1 pelo bookmark do Time Travel

Use o bookmark impresso no passo 4 do deploy que causou o problema. Em `web/`:

```powershell
npx wrangler d1 time-travel restore <nome-do-banco> --bookmark=<bookmark> --env production
```

**Atenção:** a restauração desfaz tudo o que foi gravado depois do bookmark, inclusive cadastros e conteúdo de usuários. Sem o bookmark anotado, `npx wrangler d1 time-travel info <nome-do-banco> --timestamp=<ISO 8601> --env production` devolve o bookmark de um instante (até 30 dias para trás). Depois de restaurar o D1, confirme que a versão do Worker em produção é compatível com aquele esquema.

## Domínio customizado

Produção atende em `https://open-auri.com` (domínio customizado do Worker web; a zona está na mesma conta). O template `web/wrangler.template.jsonc` precisa ter, **só** em `env.production` (e no nível superior, que espelha produção):

```jsonc
"routes": [{ "pattern": "open-auri.com", "custom_domain": true }]
```

Com `custom_domain: true`, o `wrangler deploy` cria o registro DNS e o certificado do domínio (coberto pelo OAuth do operador, que tem rotas e domínios customizados de Workers). Pela decisão do PF5, o `workers.dev` de produção redireciona com 301 para o domínio. Staging fica só no `workers.dev`. O deploy de produção sempre usa `https://open-auri.com` como `PUBLIC_ORIGIN` e como alvo do smoke, então o domínio precisa estar ativo antes do primeiro deploy de produção com o smoke.

## Problemas comuns

- **"The Wrangler login does not include CLOUDFLARE_ACCOUNT_ID":** o login está em outra conta. `npx wrangler logout`, `npx wrangler login` e confira com `npx wrangler whoami`.
- **"Missing environment variables: ...":** faltam chaves no `.env` (só os nomes aparecem). Compare com `.env.example`.
- **`check-sensitive` acusa achados:** algum valor do `.env` (ou um padrão de credencial) está em arquivo do repositório. Corrija o arquivo indicado (`caminho:linha: rótulo`); nunca adicione o valor a uma lista de exceções.
- **Build falha:** confira as `PUBLIC_*` e rode `npm run -w web build` localmente para ver a mensagem.
- **Falha em `secrets-web` ou `secrets-jobs`:** rode `node --env-file=.env tools/sync-secrets.mjs --env <ambiente> --worker web` (ou `jobs`) para repetir só esse passo.
- **Bookmark ilegível:** confirme que o D1 do ambiente existe (`npx wrangler d1 list`) e que o nome no `.env` confere. Nada foi migrado ainda.
- **Migração falhou:** nada foi publicado. Corrija a migração e rode o deploy de novo; se a migração deixou o banco pela metade, restaure com o bookmark do passo 4.
- **Smoke falhou:** os Workers novos já estão no ar. Veja a falha indicada (rota e motivo), confira no navegador e, se for regressão, faça o rollback dos Workers.
- **Deploy pelo GitHub termina com "Deploy skipped":** o segredo `CLOUDFLARE_API_TOKEN` não existe. Comportamento esperado enquanto o H-CF-TOKEN estiver pendente.
