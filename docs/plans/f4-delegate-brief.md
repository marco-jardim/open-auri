# Brief comum dos delegados da Fase 4 (social completo)

Leia antes de qualquer tarefa da F4, junto com `D:\git\open-auri\docs\plans\f2-delegate-brief.md` (stack do web, SvelteKit 3, i18n por staging, qualidade) e `D:\git\open-auri\docs\plans\f3-delegate-brief.md` (backend, Better Auth, testes em workerd, seção "Lições"). Plano: `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-plano.md` (§0.12 invariantes, §3.7 social, §3.8 LGPD, Fase 4 a partir da linha ~1976, anexo A.1 API e A.2 tabelas).

## Fatos do PF4

- **Imagem OG:** `@cf-wasm/resvg` 0.4.0 (MPL-2.0, motor `@resvg/resvg-wasm` 2.6.2) aprovado. Já está nas dependências do `web`.
  - Uso: `const { Resvg } = await import('@cf-wasm/resvg/workerd')` **dentro do handler** (import dinâmico). Import estático no topo do módulo quebra o build: a análise do SvelteKit carrega o módulo no Node e o `.wasm` pede o pacote `wbg`. O wrangler empacota o `.wasm` no deploy e no `wrangler dev`.
  - `await Resvg.async(svg, { font: { fontBuffers: [Uint8Array, ...] } })` → `.render().asPng()`; libere com `.free()`. O workerd não tem fontes de sistema: passe TTF/OTF (não WOFF2). Fontes em `web/static/og-font/` lidas por `env.ASSETS.fetch(...)` (fora do bundle).
  - Medido no `wrangler dev`: PNG 1200×630 em ~30 ms (primeira chamada ~80–120 ms com a inicialização do WASM); ~20 KB; mesmo SVG gera bytes idênticos (determinístico). Bundle do Worker com resvg: 6,1 MiB / 1,6 MiB gzip (limite atual: 64 MiB sem compressão). Browser Rendering não é necessário.
- **Gate no Worker:** `gateForWrite` (grade `full`, 16 384 intervalos) leva ~150 ms por curva no workerd. Abaixo de 1 s, mas caro: o resultado é cacheado em `curves` por `curve_id` + `gate_ver`.
- **`gate_ver`:** o núcleo não exporta versão do gate. Use `'v2:' + primeiros 16 hex de SHA-256(JSON.stringify(THRESHOLDS))` (`THRESHOLDS` de `open-auri/safety`), calculado uma vez por isolate. Se o `gate_ver` gravado divergir do atual, o gate roda de novo e `gate_ok`/`gate_reasons` são atualizados.
- **QR:** `uqr` 0.1.3 (MIT), já usado em `web/src/lib/qr/index.ts` (`renderSVG`). Reutilize.
- **Bradley–Terry (S6):** implementação própria, iteração MM de Zermelo: `p_i ← W_i / Σ_{j≠i} n_ij / (p_i + p_j)`, com `W_i` = vitórias de i e `n_ij` = comparações entre i e j; normalize a cada passada pela média geométrica (Wikipedia, "Bradley–Terry model", eq. 3 e 4; Hunter 2004, Ann. Statist. 32(1):384–406, doi:10.1214/aos/1079120141). Empate conta meia vitória para cada lado. O estimador só existe se o grafo de comparações for fortemente conexo (Ford 1957): itens fora da maior componente fortemente conexa ficam sem pontuação publicada. Critério de parada: variação máxima relativa < 1e-9 ou 10 000 iterações.
- **Texto do usuário:** nunca HTML. No Svelte, só interpolação `{valor}` (escapa). `{@html}` é proibido com qualquer dado vindo de usuário ou da API. Normalização de nome e descrição com `normalizeText` de `open-auri/share` (NFKC, sem invisíveis e bidi, recusa URL).
- **Homenagens:**
  - Comunidade, Bob Clearmountain (1953–): texto do mock `design/mocks/v2/comunidade.html` confirmado na Wikipedia (engenheiro-chefe do Power Station; "credited with establishing the role of mixing engineer"; mixou o Live Aid em 13/07/1985 no JFK Stadium, Filadélfia). A transmissão mundial do Live Aid tem fonte em https://en.wikipedia.org/wiki/Live_Aid. Fontes: https://en.wikipedia.org/wiki/Bob_Clearmountain e https://en.wikipedia.org/wiki/Live_Aid.
  - Perfil `/u/[apelido]`, Chris Lord-Alge (1963–): mixou *American Idiot* (2004) e *21st Century Breakdown* (2009), do Green Day, os dois premiados com o Grammy; desde o início dos anos 1980 trabalha num console SSL 4000 E. Fontes: https://en.wikipedia.org/wiki/Chris_Lord-Alge e https://solidstatelogic.com/media/chris-lord-alges-mix-la-installs-solid-state-logic-origin-for-its-intimate-and-artist-focused-studio-d. Não use contagem de Grammys.

## Mapa do esquema existente (não recrie)

- Perfil não tem tabela própria: fica em colunas de `"user"` (migração 0009: `bio`, `activity_visibility`, `library_visibility`, `username_changed_at`; apelido em `username`/`displayUsername`/`usernameSkeleton`). `nickname_history` do anexo A.2 = `username_holds` (0009). `audit_log` (0003, só acréscimo) e `email_suppressions` (0002) já existem.
- Num banco novo, 0004–0006 rodam **antes** de 0009 e 0010: não referencie colunas ou tabelas criadas nelas. Num banco já migrado elas rodam depois; as duas ordens precisam funcionar.
- Helpers D1 em `web/src/lib/server/db.ts` (`sql`, `first`, `all`, `run`, `batch`). Guardas em `web/src/lib/server/auth/guards.ts` e `kit.ts`; admin em `web/src/lib/server/admin/{guard,audit,read-only}.ts`; Turnstile, rate limit e hash de IP em `web/src/lib/server/security/`. Somente leitura: o handle global já responde 503 `READ_ONLY` às escritas.

## Contratos da F4

- **Acesso a dados sociais:** só por `web/src/lib/server/social/repo.ts` (T4.1). Na W4.2 o `repo.ts` é **só leitura**; se um serviço precisar de consulta nova, ela vai em `web/src/lib/server/social/queries/<serviço>.ts`, usando os predicados de visibilidade exportados pelo `repo.ts` (nunca reescreva a regra de visibilidade).
- **Kit da API v1:** `web/src/lib/server/api/**` (T4.1b): respostas JSON e erros com código estável, leitura de corpo com zod e limite de tamanho, checagem de origem nas escritas, guardas `user`/`verified`/`owner`/`admin` em JSON, rate limit, Turnstile por cabeçalho `x-turnstile-token`, ETag e `Cache-Control`. Todas as rotas `/api/v1/**` usam esse kit.
- **Publicação:** nenhuma versão referencia curva reprovada no gate (gatilho no banco + checagem no serviço). Fork e nova versão passam pelo mesmo caminho de publicação.
- **Visibilidade pública** = `visibility = 'public'`, linhagem ativa, sem ocultação de moderação, curva do head com `gate_ok = 1` no `gate_ver` atual e dono não banido. Não listada: acessível por id, nunca em feed, ranking, perfil ou busca. Privada: só o dono.
- **Rotas:** `export const prerender = false` em toda rota de servidor. Nada de `fetch` para URL vinda do usuário (SSRF).
- **Testes:** integração em `web/tests/integration/social/<serviço>/**` (workerd, `npm run -w web test:int`, o orquestrador roda); componentes em `web/tests/unit/**`. Cobertura alvo ≥ 90% em `web/src/lib/server/social/**`.
- **Mensagens:** staging `web/messages/_staging/<TASK>.{pt-BR,en-US}.json` (sem `$schema`). Sem travessão em pt-BR.
## W4.2 (serviços de API): como trabalhar

- Prontos e **só leitura** na W4.2: `web/src/lib/server/social/{repo,types,deletion,export}.ts` + `README.md` (T4.1, commit `61dd163`) e `web/src/lib/server/api/**` + `README.md` (T4.1b, commit `ddc3104`). Leia os dois READMEs primeiro: eles listam funções, predicados de visibilidade, códigos de erro do repositório (`RepoResult`) e da API, e um exemplo de rota.
- Cada serviço: `web/src/lib/server/social/<serviço>.ts` (regras de negócio, sem SQL direto além de `queries/<serviço>.ts`), rotas `+server.ts` com `defineApi` e `export const prerender = false`, schemas zod, testes em `web/tests/integration/social/<serviço>/**` chamando as rotas reais (importe o `GET`/`POST` do `+server.ts` e chame com um evento sintético, como os testes de `web/tests/integration/api/handler.test.ts`) e o serviço diretamente. Use contas criadas pelo harness da F3 (`web/tests/integration/auth/harness.ts`) ou inserções diretas em `"user"` nos helpers do seu próprio diretório de testes.
- Mapeie `RepoResult.code` para os códigos da API: `head-moved` → `HEAD_MOVED`, `gate-rejected` → `GATE_REJECTED`, `not-found` → `NOT_FOUND`, `already-active` → `ALREADY_ACTIVE`, `duplicate` → `DUPLICATE`, `invalid-input` → `INVALID_BODY`, `invalid-cursor` → `INVALID_CURSOR`. Cotas diárias → `QUOTA_EXCEEDED` (ou `RATE_LIMITED` do kit, via `quotas`).
- Testes dividem o mesmo D1 entre arquivos: use ids e apelidos únicos por teste (prefixo do serviço + aleatório) e nunca dependa de contagem global.
- Não rode testes (o orquestrador roda); informe no relatório o que não rodou. Linhas no padrão do Prettier do projeto (tabs, aspas simples, largura 100).

- **Regras gerais:** nunca commitar; nunca `Co-Authored-By` nem "Generated with"; sem `as any`, `@ts-ignore`, `@ts-expect-error`; sem `catch` vazio; nada do `.env` em arquivo, teste ou log; logs sem PII.
