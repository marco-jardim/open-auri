# Progresso · open-auri web v1

## Estado

- 2026-10-28: **FH em andamento.** B1, B2, byte-stream no fio e sondas acústicas B4, B7, B10, B12 e B13 feitas (B13 com ressalvas; ver "FH: progresso"). Ainda não feitas: B3, B5, B6, B8, B9 e B11.
- 2026-10-18: **v1.0.0 lançada e em produção** (https://open-auri.com). F1 a F5 e FUX concluídas; QG PASS na rodada 2. Falta só a FH (validação em hardware), que espera a chegada do cabo (issue #6). Ver "Resumo final (v1.0.0)" no fim deste arquivo.
- 2026-10-16: **F4 concluída** (Q4 PASS em 3 rodadas). Próximo: PF5 e F5.

Fase atual: FH (em andamento desde 2026-10-28) · Etapa: v1.0.0 lançada (tag `v1.0.0`) · F1 a F5 e FUX concluídas

## Locks ativos

| Tarefa | Agente/sessão | W | R | Início |
|---|---|---|---|---|
| — | — | — | — | — |

## Mapa de locks da F1 (calculado no PF1, ajustado na execução)

| Wave | Tarefa | W | R | Conflitos |
|---|---|---|---|---|
| W1.1 | T1.1 | tooling raiz, `design\**`, `docs\README.md` | — | serial |
| W1.2 | T1.2 | `src\safety\{gate,thresholds,policy}.mjs`, `src\dsp\level.mjs`, `tools\gen-thresholds.mjs`, `test\safety\*`, `test\dsp\level.test.mjs` | `design\analysis\*` (estável) | nenhum |
| W1.2 | T1.3 | `src\share\s1.mjs`, `docs\s1-format.md`, `docs\social.md`, `test\share\s1.test.mjs` | — | nenhum |
| W1.2 | T1.5 | `src\io\equalizer-apo.mjs`, `test\io\equalizer-apo.test.mjs` | — | nenhum |
| W1.2 | T1.6 | `src\io\measurement.mjs`, `test\io\measurement.test.mjs` | `src\dsp\grid.mjs` (estável) | nenhum |
| W1.2 | T1.7 | `src\dsp\{distance,iso226}.mjs`, `test\dsp\{distance,iso226}.test.mjs` | `src\dsp\grid.mjs` (estável) | nenhum |
| W1.2 | T1.9 | `src\transport\{webhid,fake-device}.mjs`, `test\transport\webhid.test.mjs` | — | nenhum (gate injetado) |
| W1.2 | T1.10 | `src\policy\{flash,loudness,journal}.mjs`, `test\policy\*` | — | nenhum (`levelDb` injetado) |
| W1.2 | T1.11 | `src\meter\*.mjs`, `test\meter\*` | — | nenhum |
| W1.3 | T1.4 | `src\share\envelope.mjs`, `schemas\preset-envelope-1.schema.json`, `test\share\envelope.test.mjs` | `src\share\s1.mjs` (estável) | nenhum |
| W1.3 | T1.8 | `src\catalog\presets.mjs`, `test\catalog\presets.test.mjs` | gate e level (estáveis) | nenhum |
| W1.3 | T1.12 | `src\solver\peq.mjs`, `test\solver\peq.test.mjs` (+ `THIRD_PARTY_NOTICES.md` pela fila) | núcleo estável | nenhum |
| W1.4 | T1.13 | `src\index.mjs`, `src\*\index.mjs`, `test\index.test.mjs`, `types\**`, `docs\README.md` | — | paralela à T1.T (W disjuntos; T1.T importa módulos diretamente) |
| W1.4 | T1.T | `test\integration\*` | núcleo estável | idem |

## Tarefas

| ID | Status | Commit | Notas |
|---|---|---|---|
| PF1 | verificada | b60fc72 | ver Pre-flights |
| T1.1 | commitada | 6384d56 | orquestrador rodou format:check, types e coverage (allowlist); script `types` corrigido com `jsconfig.types.json` |
| prep | commitada | 06b95cf | `src\dsp\grid.mjs` (grade canônica de 481 pontos) criado pelo orquestrador para a T1.6 e a T1.7 |
| T1.2 | commitada | 52951aa | paridade bit a bit em `full`; drag 1,6–2,0 ms, full 8,8–10 ms por chamada |
| T1.3 | commitada | 9844007 | S1 v1: 408 bits = 51 B = 68 caracteres; CRC-16/CCITT-FALSE |
| T1.4 | commitada | 57fff6b, 6b8dde9 | 176 casos estruturais concordam com Ajv 2020; 12 exclusões semânticas marcadas |
| T1.5 | commitada | f991e8a | |
| T1.6 | commitada | f77373c | |
| T1.7 | commitada | 1714e62 | |
| T1.8 | commitada | 519e123 | `descriptionEn: null` (o mock não traz traduções das descrições da Kuba) |
| T1.9 | commitada | 9fe76e3 | |
| T1.10 | commitada | e1f254e | |
| T1.11 | commitada | 2b8b756 | teste de ganho DC do FIR corrigido pelo orquestrador (tabela publicada não é unitária) |
| T1.12 | commitada | 1deacf2, 2ba3f7c | RMS por preset 0,107–0,289 dB; 61–210 ms por solução |
| T1.13 | commitada | ca72131 | "NOT ACCEPTED" do verificador era falso (rodou durante a escrita da T1.T); verificação independente verde |
| T1.T | commitada | 1811c06 | 36 testes de integração; 8 propriedades × 1 000 execuções (semente 20261016) |
| Q1.1 | concluída | — | FAIL: 1 critical, 4 major, 12 minor → FX1.1–FX1.7 |
| FX1.1 | commitada | 140a931, c00be9e | C1, M1, M2 (codec/gate/transporte), minors 2, 3, 4, 11, 12; barris e regressão ajustados pelo orquestrador |
| FX1.2 | commitada | b15ac9f | M2 (S1), M4, minors 7 e 9 |
| FX1.4 | commitada | 56c35ff | minor 8 |
| FX1.5 | commitada | da08a72 | M3, minor 1 |
| FX1.6 | commitada | 0858ed5 | minor 6 (libebur128), pelo orquestrador |
| FX1.7 | commitada | 79a1110 | minor 5 |
| Q1.2 | concluída | — | FAIL: 1 major (B1), 6 minor, 4 nits → FX1.8–FX1.10, todos corrigidos |
| FX1.8 | commitada | bb21283 | B1, B2, B3, B4, B7, N2, N4 |
| FX1.9 | commitada | 785fee0 | B5, B6, N3 |
| FX1.10 | commitada | 35aabf7 | N1 |
| Q1.3 | concluída | — | verificação pós-rodada 2: 2 major novos no envelope (M-1, M-2) → FX1.11; 6 minor → issues #8–#13 (qa-minor) |
| FX1.11 | commitada | df46bb3 | M-1, M-2 |
| Q1 | PASS | — | nenhum achado major, critical ou blocking aberto |

Bateria completa no fim da W1.4: 517/517; cobertura `src\**` 99,80% linhas, 99,45% branches, 99,55% funções; lint, typecheck, prettier e scanner limpos; `npm run types` emite 34 declarações.

## Tarefas F2

| ID | Status | Commit | Notas |
|---|---|---|---|
| PF2 | verificada | — | ver Pre-flights |
| T2.1 | commitada | a46cd60, 19fc321 | scaffold e instalação pelo orquestrador; configuração pelo implementer; verificação central (check, unit 2/2, e2e 2/2, build) |
| T2.2 | commitada | c6201b8, cd07501 | binários das fontes copiados pelo orquestrador (o editor do implementer não copia binários) |
| T2.3 | commitada | b425684 | Footer recebe `githubUrl` por prop (`\/env/public` não roda em teste de componente) |
| T2.4 | commitada | a2341bf | |
| T2.5 | commitada | 4f6d309 | preamp Q23 antes das seções (ordem do chip) |
| T2.6 | commitada | 1439d0b | núcleo puro do worklet em `components/meters/meter-core.js`; worklet via `?worker&url` |
| T2.7 | commitada | c0e1640 | |
| T2.8 | commitada | 5afd7c1 | |
| T2.19 | commitada | 54afef7, cd07501 | pipeline real rodando (pacotes gerados não versionados) |
| msgs | commitada | 298db8e | T2.3, T2.5, T2.6, T2.7 mescladas |
| T2.9 | commitada | 4bfbb67, 4080a5d | adaptador `flash.get` do layout sem efeito colateral (rodava dentro de `\`: `state_unsafe_mutation`) |
| T2.10 | commitada | ebc5dc0 | heavy; 2 retomadas por orçamento |
| T2.11 | commitada | 62af6a8 | QR com `uqr` (MIT) |
| T2.12 | commitada | 25ea899 | |
| T2.13 | commitada | 7dfc7a4 | |
| T2.14 | commitada | 36ecc5c | |
| T2.15 | commitada | 4ea5b62 | |
| T2.16 | commitada | 187be25 | Escape no campo de busca fecha o diálogo (o Chrome consumia o 1º Escape para limpar o campo), corrigido pelo orquestrador |
| W2.4 fix | commitada | 83c244b, af4061c | env LGPD público, ARIA dos medidores em repouso, `lang` do `<html>` sincronizado no cliente, `PENDING_ROUTES` só com `/comunidade`, e2e com `locale: 'pt-BR'` |
| T2.19 (pipeline real) | em execução | 5fb6dd3 | `write EOF` corrigido; falhas transitórias de rede retomam do cache (2 688/5 901 blobs na 1ª tentativa); pacotes gerados não são versionados |
| T2.17 | commitada | a132d95, 73d83b3 | `\/manifest` (Kit 3); flag `__oaWriteInProgress` no serviço do cabo |
| T2.18 | commitada | 77537f3 | todas as rotas ≤ 148 kB gzip de JS inicial (limite 250) |
| T2.T | commitada | 390af8b, 62d8f54 | e2e 253 ok + 32 referências visuais (sem `/privacidade` e `/termos`, que exibem dados do operador); unidade 933 testes; cobertura web 96,7 % instruções, 87,9 % branches, 97,3 % funções, 97,2 % linhas; pendentes: smoke da Soe como X (depende dos pacotes AutoEq) e testes de componente instáveis sob carga (falhas diferentes a cada rodada, ex.: `cabo/edges.svelte.test.ts:112`) |
| Q2.1 | concluída | — | FAIL: 4 major (S1, A1, M1, M2), minors S2–S4, A2, A3, E1, E2, I1–I3, X1, T1, T2; revisão incompleta (orçamento): faltam capturas visuais, passada completa de a11y, outros testes instáveis, asserts vazios e paridade de chaves i18n → corrigir tudo (rodada 1) e completar esses itens na rodada 2 |
| T2.19 (dados) | concluída | — | pipeline real completo a partir do cache: 5 840 medições, 59 alvos, 2 ignorados, 39 pacotes; smoke 20/20 |
| FX2.1 | commitada | 48bb9f0, 8b84937 | S1–S4 (heavy); regressão de espaçamento achada no e2e e corrigida (2 s contados a partir do fim da gravação anterior) |
| FX2.2 | commitada | 588b8f2 | A1, A2, A3, M1, M2, E2 (heavy) |
| FX2.3 | commitada | 945781f | E1, I1, I2, I3, T1 |
| FX2.4 | commitada | a866f7a | T2 (referências visuais com dados AutoEq); `expect.poll` com 5 s no Vitest (instabilidade sob carga) |
| Q2.2 | concluída | — | FAIL: 2 major (R2-01 diálogo dispensável durante a gravação, R2-02 `structuredClone` de proxy na Biblioteca), 6 minor, 5 nit → FX2.5, FX2.6, todos corrigidos |
| FX2.5 | commitada | 7e965bd | R2-01, R2-02, R2-03, R2-05, R2-06, R2-07, R2-08, R2-12 (heavy) |
| FX2.6 | commitada | 008315f | R2-04, R2-09, R2-10, R2-11, R2-13 |
| Q2.3 | PASS | — | verificação pós-rodada 2: nenhum major ou pior; minors N-1…N-5 e T-1 → issues #14–#19 (`qa-minor`) |

## Tarefas F3

| ID | Status | Commit | Notas |
|---|---|---|---|
| PF3 | verificada | 455a611, 90008ca | ver Pre-flights; brief `docs/plans/f3-delegate-brief.md` |
| T3.1 | commitada | f25f5e8, 5e361d2 | testes de integração numa config própria (`vitest.integration.config.ts`); `Env` escrito à mão (os tipos de runtime do `wrangler types` conflitam com o DOM e puxam `.svelte-kit/output`); orquestrador assumiu a separação da config após 2 tentativas |
| T3.2 | commitada | e76c59a | campo de bounce confirmado na documentação (`data.bounce.type: "Permanent"`); falhas de rede também são repetidas (a chave de idempotência evita duplicatas); a supressão guarda HMAC do endereço com chave derivada do `BETTER_AUTH_SECRET` (girar o segredo esvazia a lista: runbook) |
| T3.3 | commitada | 904b750 | heavy; limites da auth contados em D1 (o binding só tem 10/60 s); IPv6 por /64; mensagens da fila já cifradas; `ACCESS_LOG_KEY` como chaveiro `kid:segredo`; S6 só com o dia; `web/_headers` gerado de `renderStaticHeadersFile()`; CSP do Kit com `challenges.cloudflare.com` e `frame-ancestors 'none'` |
| T3.4 | commitada | 16d9b62 | data de vigência aceita `AAAA/MM/DD` e é normalizada; `PUBLIC_ORIGIN` obrigatório; primeira visita anônima conta como vista |

| T3.5 | commitada | 3736a4d, c41731a | heavy; handler único via `locals.auth.handler`; apelido 3–24 (§3.7); marcador `twoFactorVerifiedAt`; checagem de origem; token do Turnstile em `x-turnstile-token`; endpoints HTTP do plugin admin escondidos (404); troca de apelido só pelo /conta; apelido retido recusado no cadastro; `event.platform` reconstruído de `cloudflare:workers` (o adapter 8 não o passa: 42 e2e falharam com 500 até a correção, feita pelo orquestrador) |
| T3.6 | commitada | f9eef25 | acento `#7FA7D9`; páginas com ações de formulário sem JS; e2e de teclado esperava hidratação |
| T3.7 | commitada | e68188d | migração 0009 (perfil, retenções, pedidos de troca de e-mail e de encerramento) |
| T3.8 | commitada | 63a7be8 | `grant-admin --create` cria conta sem senha (o operador usa "esqueci a senha"); busca por e-mail só por POST |

| T3.T | commitada | 5297a6a, ede3555, f0baee7 | matriz de autorização, fluxos completos com caixa de e-mail capturada (só localhost) e stub do Turnstile (só no modo local), corridas e expirações, e2e de auth e conta nos dois idiomas, cobertura istanbul do servidor 98/94/99/99, login com mediana 157 ms; bug real achado: `auth.api` com `request` devolvia Response e as páginas tratavam 4xx como sucesso (`asResponse: false`) |
| Q3.1 | concluída | — | FAIL: 6 major (adivinhação ilimitada de 2FA/senha por quem tem sessão, bloqueio de conta sem Turnstile, GET que escrevem no modo somente leitura, enxurrada de e-mails pelo link de troca, frescor só no /conta, tokens e e-mails nos logs da plataforma), 4 minor, 3 nit → FX3.1, FX3.2 |
| FX3.1 | commitada | 4a6ec5e | guarda de segredos por usuário, ordem do guard, links de uso único, teto diário de reenvio, frescor ou senha, endpoints fechados, idioma do e-mail |
| FX3.2 | commitada | 536616a | GETs bloqueados no somente leitura, logs de invocação desligados e query strings redigidas, grant-admin, CAS do apelido |
| Q3.2 | concluída | — | FAIL: 3 major (claim do link pela forma bruta do token, redirecionamento aberto, sem UI de 2FA), 2 minor, 4 nit → FX3.3, FX3.4 |
| FX3.3 | commitada | 890ab43 | claim pela parte assinada, callbacks só canônicos e da mesma origem, limite por IP nos links, sem escrita de refresh no somente leitura |
| FX3.4 | commitada | 86ff820, cc4b633 | seção de verificação em duas etapas no /conta; e2e: segundo servidor espera o build, perf depois dos projetos funcionais |
| Q3.3 | PASS | c215b9d, 34f01f5 | verificação: 1 major de regressão (chave por conta virou oráculo de existência) e 1 major anterior (oráculo de apelido no cadastro) corrigidos com testes; minors → issues #20–#24 |

Verificação central final da F3: raiz 663/663; `check:web` 0/0; `check:int` ok; unidade web 1 462/1 462; integração 487/487 (cobertura 97,3/93,3/98,7/98,5); jobs 16/16; build e orçamentos ok; e2e 294/294.

Verificação central da W3.3–W3.4: raiz 660/660; `check:web` 0/0; `check:int` ok; unidade web 1 446/1 446; integração 242/242; jobs 16/16; build e orçamentos ok; e2e completo 284 (1 instável corrigido: espera de hidratação).

Verificação central da W3.2: raiz 652/652; `check:web` 0 erros; `check:int` ok; unidade web 1 229/1 229 (14 snapshots de e-mail gravados); integração 87/87; jobs 16/16; build ok; orçamentos ok; e2e smoke + a11y + i18n + offline 96/96.

Verificação central da W2.4: `check:web` 0 erros; `test:web:unit` 61 arquivos, 586 testes; lint do web limpo; build ok; e2e smoke 2/2; raiz 613/613.

Verificação central da W2.2: `check:web` 0 erros; `test:web:unit` 23 arquivos, 284 testes; lint do web limpo; build ok; raiz 613/613.

## Tarefas F4

| ID | Status | Commit | Notas |
|---|---|---|---|
| PF4 | verificada | 818074d | ver Pre-flights; brief `docs/plans/f4-delegate-brief.md` |
| T4.1 | commitada | 61dd163 | heavy; esquema 0004–0006 (moderação separada do status do dono; gatilho impede versão de curva reprovada; versões só por acréscimo), `repo.ts`, partes de exclusão e exportação |
| T4.1b | commitada | ddc3104, 6b58ea1 | kit da API v1 (origem, guardas, limites, Turnstile, ETag, códigos estáveis + códigos de domínio) |
| T4.1c | commitada | 63de348 | criada na W4.2: `social/gate.ts` (`checkCurve`, cache por `curve_id` + `gate_ver`, `regateStale`) compartilhado por T4.2/T4.3 |
| T4.2 | commitada | 7a8975b | heavy |
| T4.3 | commitada | 5841717 | |
| T4.4 | commitada | fdeb407 | heavy; anti-replay por `eventId` (8 dias, tabela de rate limit) |
| T4.5 | commitada | aa38de2, cf7effd | link "abrir na Curva" com `l`/`v` |
| T4.6 | commitada | eec3ecf | `GET /api/v1/feed` incluído |
| T4.7 | commitada | ad076b9 | fontes OFL baixadas pelo orquestrador |
| T4.8 | commitada | 2d302ac | link no `AdminNav` pelo orquestrador |
| T4.9 | commitada | 55082e4 | sem cota D1 por IP (anonimato); pares embaralhados |
| T4.10 | commitada | c8fa2d7 | heavy; parceiro cego sem `versionId` |
| T4.11 | commitada | f942519 | 308 para grafia não canônica do apelido |
| W4.2 (integração) | commitada | c5b300f | cursores tipados (repo compila com `noUncheckedIndexedAccess` do Worker de jobs); `rootDirs` e shim de `RequestInit` no TS project de integração |
| T4.12 | commitada | 02df6f7 | crons `5 0 * * *` (rotate-salt, rate-limit-gc, access-log-retention, s6-aggregate, regate), `0 * * * *` (trades-expire), `*/15 * * * *` (rankings); OG aquecida na publicação não privada |
| T4.12b | commitada | b28055c, 8d744b1 | cliente social, outbox, sessão, `origins.ts` (escrito pelo orquestrador) |
| T4.13 | commitada | 6fa0a04 | heavy; `/comunidade` prerenderizada (shell offline) |
| T4.14 | commitada | 7901c4a | `SocialSync` e ponte do cabo montados no layout pelo orquestrador |
| T4.14b | commitada | 8487cd5 | criada na W4.4: `GET /api/v1/me/packs` e `/me/shares` |
| T4.15–T4.18 | commitadas | 5f58550, 4d834ab, a1c0e94, b0136f0 | |
| T4.T | commitada | 25c9316, 401ef1b, 2f04413, 61412ea | matriz de autorização autoverificada (33 rotas), paridade do gate em 560 curvas, invariantes de visibilidade, proteções; e2e social (9 passos) e Comunidade; bug real achado: o motor de áudio criava as stores library/outbox sem keyPath quando abria o IndexedDB primeiro (salvar na biblioteca local caía para memória); referências visuais refeitas (Comunidade com relógio e aleatório fixos). Verificação: unidade 1 625, integração 913 (cobertura 96,4/91,2/98,4/98,2), e2e 298/299 (1 instável de medidor sob carga, passa isolado) |

### Mapa de locks da F4 (PF4)

- **W4.1 (paralelo):** T4.1 → `web/migrations/0004_social.sql`, `0005_s6_s7.sql`, `0006_rankings.sql`, `web/src/lib/server/social/{repo,types,deletion,export}.ts`, `web/src/lib/server/account/deletion.ts` (só acrescentar a parte social em `ACCOUNT_DELETION_PARTS`), `web/src/lib/server/account/export.ts` (só acrescentar a seção social), `web/tests/integration/social/repo/**`. T4.1b → `web/src/lib/server/api/**`, `web/tests/integration/api/**`.
- **W4.2 (paralelo):** cada serviço é dono de `web/src/lib/server/social/<serviço>.ts`, de `web/src/lib/server/social/queries/<serviço>.ts` (se precisar), das suas rotas e de `web/tests/integration/social/<serviço>/**`. `repo.ts`, `types.ts`, o kit da API e as migrações ficam só leitura. Rotas com sobreposição resolvidas assim: T4.2 é dona de `api/v1/curves/+server.ts`, `api/v1/curves/[id]/+server.ts` e `api/v1/lineages/**`; T4.3 de `api/v1/curves/[id]/favorite/**`, `api/v1/me/library/**`; T4.4 de `api/v1/curves/[id]/activity/**`, `api/v1/curves/[id]/audience/**`, `api/v1/me/activity/**`; T4.6 de `api/v1/rankings/**` e `api/v1/feed/**`. Jobs (`workers/jobs/src/jobs/<job>.ts`) de cada serviço; o registro (`index.ts`, `registry.ts`, template) só na T4.12. Mensagens por staging. Serviços que dependem de outro (ex.: T4.5 usa a publicação da T4.2) leem só `repo.ts` e o kit, nunca o arquivo do outro serviço em edição.
- **Fila de integração (orquestrador):** `package.json`, `web/package.json`, `vite.config.ts`, `+layout.*`, mensagens, migrações depois da W4.1, `hooks.server.ts`, templates do wrangler, `web/src/lib/server/types.ts`.

## Tarefas F5

| ID | Status | Commit | Notas |
|---|---|---|---|
| PF5 | verificada | 8a1bd33 | ver Pre-flights; brief `docs/plans/f5-delegate-brief.md`; bloqueio #32 (DNS do Resend) |
| T5.1 | commitada | 760c082 | CI com `PUBLIC_*` fictícias e modo `--no-env` do scanner; `tools/deploy.mjs` com plano testado; deploy pelo GitHub só com `CLOUDFLARE_API_TOKEN`; `PUBLIC_ORIGIN` do deploy vem de `--env` |
| T5.2 | commitada | c421a31 | log de requisição sem PII (depois do `platformShim`), métricas no Analytics Engine (`METRICS`) |
| T5.3 | commitada | 421e115 | backup semanal (sem registros de acesso), dump público, limpeza diária; migração 0011 permite apagar auditoria com mais de 5 anos; `tools/restore-backup.mjs` |
| T5.4 | commitada | 91ac6f8 | CSP estrita (`default-src 'none'`, sem `unsafe-inline` em script/style; exceção só `style-src-attr`); `Permissions-Policy` mínima; redirecionamento 301 workers.dev → domínio próprio só em produção; rota de domínio próprio só em `env.production` (no topo quebrava o e2e); `visual.spec` com `bypassCSP` (estilo injetado pelo Playwright) |
| T5.5 | commitada | 83dbe3f | README, CONTRIBUTING, runbooks (inclui ativação do .com com o bloqueio de DNS) |
| T5.7 | concluída | 2949294 | jobs registrados; staging no ar (smoke ok); webhook do Resend criado (segredo só no `.env` e nos Workers) |
| T5.T | commitada | 55ff9e5, 2c8ee63 | staging 38 ok + 1 pulado (cadastro aberto); jobs idempotentes, dump sem PII, restauração ida e volta; achados corrigidos em f87e4e9 (prévia S6 vazia, webhook liberado no somente leitura) |
| T5.8 | concluída | — | produção em https://open-auri.com (smoke ok, cabeçalhos ok); domínio de envio verificado e e-mail de teste entregue; Turnstile com o domínio próprio; cadastro aberto; bookmarks do Time Travel registrados na saída do deploy; pendente do operador: criar a conta de `ADMIN_EMAIL` e rodar `tools/grant-admin.mjs` |
| T5.6 | commitada | 9ec9abb | `autocannon` 8; recusa origem de produção; execução em staging pendente |

## Pre-flights

| PF | Data | Resultado | Evidências |
|---|---|---|---|
| PF5 | 2026-10-16 | aprovado (deploy de produção com ressalva) | Q4 PASS e árvore limpa (`11d894f`); campos LGPD e data da política preenchidos; whoami confere com a conta do `.env`; zona `open-auri.com` ativa na mesma conta (decisão: produção no domínio próprio, staging no workers.dev); OAuth sem escrita de DNS → domínio de envio do Resend bloqueado (issue `bloqueio`), produção com `SIGNUP_ENABLED=false`; opcionais ausentes: H-CF-TOKEN, H-ACCESS; versões: eslint 10.13.0, svelte-check 4.7.7, autocannon 8.0.0; brief `docs/plans/f5-delegate-brief.md` |
| PF4 | 2026-10-16 | aprovado | Q3 PASS e árvore limpa (HEAD `ae6244d`); **spike OG:** `@cf-wasm/resvg` 0.4.0 no `wrangler dev`, PNG 1200×630 em ~30 ms (1ª chamada 80–120 ms), ~20 KB, determinístico (hash igual), fontes TTF via `ASSETS`; também validado dentro do build do Kit com import dinâmico (o import estático quebra a análise do Kit no Node: `wbg`); Worker com resvg 6,1 MiB / 1,6 MiB gzip (limite atual 64 MiB) → **aprovado, sem Browser Rendering**; **spike do gate:** `gateForWrite` (`full`) ~150 ms por curva no workerd (11 presets × 20) → abaixo de 1 s, cache por `curve_id` + `gate_ver` mantido; QR `uqr` 0.1.3 (MIT) já em uso; Bradley–Terry próprio (MM de Zermelo, Wikipedia eq. 3–4, Hunter 2004 doi:10.1214/aos/1079120141; existência pelo critério de Ford; empate = meia vitória); texto do usuário só por interpolação do Svelte (escapa; `{@html}` proibido) + `normalizeText` do núcleo; Clearmountain (texto do mock confirmado na Wikipedia) e Lord-Alge (1963; *American Idiot* e *21st Century Breakdown*; SSL 4000 E, fonte SSL) verificados; brief `docs/plans/f4-delegate-brief.md` |
| PF3 | 2026-10-16 | aprovado | Q2 PASS e árvore limpa (push `03cd0ef`); versões abaixo; Better Auth 1.7.10 resolve `better-auth/crypto` para `node:crypto` no workerd (condição de export `workerd`); spike de CPU no `wrangler dev` (mediana local, 5 amostras): padrão do Better Auth (N=2^14, r=16, p=1) 53 ms, mas abaixo do custo OWASP; OWASP N=2^13 r=8 p=10 120 ms, **N=2^14 r=8 p=5 123 ms (adotado, 16 MiB)**, N=2^15 r=8 p=3 148 ms, N=2^16 r=8 p=2 202 ms, N=2^17 r=8 p=1 228 ms; recursos criados na conta do `.env` (whoami conferido): D1 `open-auri` e `-staging`, KV `open-auri-config` e `-staging`, R2 `open-auri-media` e `-staging` com ciclo de vida de 180 dias em `access-log/`, filas `open-auri-access-log` (+ `-staging`, DLQs); H-RESEND e H-TURNSTILE não bloqueiam (chaves no `.env`; domínio de envio espera o `.com`); Q-MCI resolvida (cumprir, `ACCESS_LOG_ENABLED=true`); Rupert Neve (1926–2021): eleito pelos pares a personalidade nº 1 do áudio do século XX (Studio Sound, dez. 1999) e gravou os discursos de guerra de Churchill para distribuição às rádios (Wikipedia, citando o WSJ) |
| PF2 | 2026-10-16 | aprovado | Q1 PASS e árvore limpa; versões verificadas (abaixo); spike de áudio com `qa-audio.mjs --all`: 191 PASS (96 kHz exatos, `createMediaElementSource`, 20 nós IIR, IndexedDB), 1 FAIL estrutural no rodapé do mock da Docs (defeito do mock, não do áudio); fontes e licenças verificadas; AutoEq `master` em `7ae0f56` (2025-07-20), sem LFS, colisão `measurements/Rtings` × `rtings` |
| PF1 | 2026-10-16 | aprovado | HEAD 1e2f241; `git status`: só `design/` não versionado (49 arquivos, ~33,7 MB; maior 4,24 MB); Node v24.21.0, npm 12.0.2; `npm test` 59/59 (52 codec + 6 scanner + 1 agregado do `design\analysis\gate.test.mjs`); `qa-parity.mjs` 0 falhas (Neutro 0x4FFF); `check-sensitive` saída 0; 16 núcleos |

### Versões verificadas (0.14)

| Pacote | Versão | Licença | Data da verificação |
|---|---|---|---|
| node (LTS em uso) | 24.21.0 (LTS mais recente: 24.22.0; Current: 26.12.0) | MIT | 2026-10-16 |
| typescript | 7.0.2 (port nativo) | Apache-2.0 | 2026-10-16 |
| eslint | 10.12.0 | MIT | 2026-10-16 |
| @eslint/js | 10.0.1 | MIT | 2026-10-16 |
| globals | 17.13.0 | MIT | 2026-10-16 |
| prettier | 3.9.10 | MIT | 2026-10-16 |
| fast-check | 4.10.2 | MIT | 2026-10-16 |
| @types/node | 24.x | MIT | 2026-10-16 |
| ajv | 8.20.0 | MIT | 2026-10-16 |
| typescript (núcleo e web, a partir da F2) | 6.0.3 | Apache-2.0 | 2026-10-16 |
| @sveltejs/kit | 3.1.0 | MIT | 2026-10-16 |
| svelte | 5.57.2 | MIT | 2026-10-16 |
| vite | 8.3.4 | MIT | 2026-10-16 |
| @sveltejs/adapter-cloudflare | 8.0.1 | MIT | 2026-10-16 |
| tailwindcss / @tailwindcss/vite | 4.3.3 | MIT | 2026-10-16 |
| @inlang/paraglide-js | 2.29.0 | MIT | 2026-10-16 |
| vitest / @vitest/coverage-v8 / @vitest/browser-playwright | 5.0.5 | MIT | 2026-10-16 |
| @playwright/test | 1.64.1 | Apache-2.0 | 2026-10-16 |
| @axe-core/playwright | 4.14.0 | MPL-2.0 (só dev) | 2026-10-16 |
| svelte-check | 4.7.6 | MIT | 2026-10-16 |
| typescript-eslint | 8.71.2 | MIT | 2026-10-16 |
| fake-indexeddb | 6.2.5 | Apache-2.0 | 2026-10-16 |
| wrangler | 4.151.1 (F3) | MIT OR Apache-2.0 | 2026-10-16 |
| better-auth | 1.7.10 | MIT | 2026-10-16 |
| zod | 4.6.7 | MIT | 2026-10-16 |
| @cloudflare/vitest-plugin | 1.4.4 (peer vitest ^4.1 \|\| ^5) | MIT | 2026-10-16 |
| @msw/cloudflare / msw | 0.2.0 / 3.0.3 | MIT | 2026-10-16 |
| @cf-wasm/resvg (motor @resvg/resvg-wasm 2.6.2) | 0.4.0 | MPL-2.0 | 2026-10-16 (PF4) |
| uqr | 0.1.3 | MIT | 2026-10-16 (PF4) |
| wrangler, better-auth, zod, @cloudflare/vitest-plugin, kit, svelte, vite, vitest, playwright | sem mudança desde o PF3 (4.151.1, 1.7.10, 4.6.7, 1.4.4, 3.1.0, 5.57.2, 8.3.4, 5.0.5, 1.64.1) | — | 2026-10-16 (PF4) |
| Fontsource (10 famílias) | 5.3.x | OFL-1.1; Special Elite e Permanent Marker Apache-2.0 | 2026-10-16 |

### Fatos do `node:test` (PF1.6)

- `--experimental-test-coverage` segue experimental no Node 24/26; `--test-coverage-lines|branches|functions=<n>` encerram com código 1 abaixo do limite; `--test-coverage-include|exclude` aceitam globs repetíveis; `--test-concurrency` tem padrão `availableParallelism() − 1`.
- Globs entre aspas (`node --test "test/**/*.test.mjs"`) são expandidos pelo próprio Node.

### Fontes dos medidores (T1.11)

- BS.1770-5 (11/2023, igual à -4 nos coeficientes): ponderação K a 48 kHz (tabelas 1 e 2), offset −0,691, janelas de 400 ms e 3 s; outras taxas pela derivação do libebur128 (MIT).
- BS.1770 anexo 2: FIR de 48 coeficientes e 4 fases. As fases publicadas não têm ganho DC unitário (0 e 3: 1,0015869140625; 1 e 2: 0,9730224609375). O teste 15 da EBU Tech 3341 passa (−6,0 dBTP dentro da tolerância).
- EBU Tech 3341 (2016): casos 1, 2, 9, 12 e 15 cobertos.
- VU: IEC 60268-17 via fontes secundárias (ITU-R BS.2054-4, Wikipedia): 99% em 300 ms, overshoot de 1 a 1,5%. Constantes adotadas: ζ = 0,81, ωn = 13,422 rad/s (99% em 300 ms exatos), calibração por valor médio retificado.
- PPM: IEC 60268-10 é paga. Tipo II pela EBU Tech 3205 (tabela 2), com dois retificadores (1,1 ms e 5 ms) em média; tipo I pela Wikipedia (secundária), τ = 1,42 ms; tolerâncias do tipo I definidas pelo projeto.
- −14 dBFS como alinhamento: sem fonte encontrada. Mantido como opção do produto, rotulado sem citar norma.

## QA

| Q | Ciclo | Resultado | Achados → FX |
|---|---|---|---|
| Q1 | 1 | FAIL | C1 (gate/transporte liam campos várias vezes: getter/Proxy burlava D7, tipo e bytes enviados), M1 (gate injetável), M2 (arrays esparsos), M3 (diário recusava LP/HP sem ganho e contava UTF-16), M4 (bypass de URL no envelope), 12 minor → FX1.1–FX1.7, todos corrigidos; bateria 571/571, cobertura 99,78% |
| Q1 | 2 | FAIL | B1 major (reentrada burlava o mutex por dispositivo), B2–B7 minor, N1–N4 → FX1.8–FX1.10, todos corrigidos; 591/591 |
| Q1 | 3 (verificação) | 2 major → FX1.11 | M-1 (campos de receita aceitavam texto de link), M-2 (texto escondido em tags de bandeira emoji); minors m-1…m-6 → issues #8–#13; após FX1.11: 594/594, cobertura 99,77% · **PASS** |
| Q2 | 1 | FAIL | S1, A1, M1, M2 major + 13 minor → FX2.1–FX2.4 |
| Q2 | 2 | FAIL | R2-01, R2-02 major + 6 minor + 5 nit → FX2.5, FX2.6; unidade web 1 051/1 051, e2e 256 (5 falhas corrigidas e reexecutadas), raiz 625/625, cobertura lib 97,4 % linhas e 88,1 % branches |
| Q2 | 3 (verificação) | **PASS** | minors N-1…N-5, T-1 → issues #14–#19 |
| Q3 | 1 | FAIL | 6 major → FX3.1, FX3.2 |
| Q3 | 2 | FAIL | 3 major → FX3.3, FX3.4 |
| Q3 | 3 (verificação) | **PASS** | 2 major corrigidos (FX3.5, FX3.6); minors → #20–#24 |
| Q4 | 1 | FAIL (corrigido em 5701f13) | 7 major: M1 ids internos no feed/rankings; M2 outbox não ligada a quem agiu; M3 apelido gravado na OG e PNGs órfãos; M4 cache do gate confiável demais (gate_ver só dos limites, regate lento, regressão por skew); M5 S7 entrega curva moderada/retirada/privada; M6 funil e audiência revelam atividade privada; M7 inundação S6 derruba os jobs diários. 8 minor, 3 nit → FX4.1–FX4.8 |
| Q4 | 2 | FAIL (corrigido em 5405850 + docs) | 1 major (R2-1: leituras por id /c, OG e S7 serviam veredito do gate desatualizado) + 7 minor (ator da outbox no servidor, purga por falha de sonda, PacksPanel, regressão da mescla, deriva do pi.md, origens entre contas, contagens do funil) + nits → FX4.9–FX4.12. Verificação: unidade 1 672, integração 968 (95,9/90,8/97,8/97,8), jobs 42, raiz 663, e2e 305/305 |
| Q4 | 3 (verificação) | **PASS** | nenhum major ou pior; minors → issues #25–#31 (qa-minor) |
| QG | 1 | FAIL (corrigido) | 3 major: Access citado como em uso sem existir, dump público sem rota, avisos de licença incompletos; minors → FXG.1 `a48c1ad` (textos legais), FXG.2 `2520f25` (rota do dump público), FXG.3 `c4919e3` (lista de licenças gerada dos bundles), FXG.4 `4452f24` (operação e deploy), todos corrigidos |
| QG | 2 | **PASS** | M1 corrigido em `3a55af0` (CI: capturas comparadas só no Windows, checagens de comportamento seguem no Linux; spec de estado da Comparar espera o tour carregado sob demanda) |
| FUX.Q | 1 | FAIL (corrigido) | achados corrigidos em `1893ebf` (contagem do espaçamento não redesenha durante a gravação USB, o que restaura o tempo dos relatórios), `5e8f4c0` (painel de áudio no celular abre no primeiro toque, início adiado silencioso, apelido sem oráculo da lista de bloqueio, falha social não esconde o resgate do cabo, controles desativados dizem por quê, dono do motor no Perfil e em /c, teto de 250 kB) e `d7c5428` (prévia do solver da Soe como X sem depender da carga da máquina) |
| FUX.Q | 2 | FAIL (corrigido) | captura do painel de áudio e major B da Biblioteca (só VUs, decisão do PO no plano §3.6) → `08ad7a0` |
| Issues | 1 | FAIL (corrigido) | 1 major: desativar o 2FA era alcançável por HTTP (cookie roubado e senha pulavam o código) → `c5ac828`; 14 minors e nits → `097a443` (núcleo), `6c1dd98` (app), `11fa0ee` (deploy, #33) |
| Pós-FUX | 1 | FAIL (corrigido) | 1 major: "Salvar" acrescentava versão a uma linhagem que já não era privada → `296ee55` (lê a linhagem logo antes e cria nova cópia privada com aviso); minors → `dcba7d5` (cabo e curva compartilhada), `a74030e` (Teste cego), `b7d58e9` (Biblioteca), `dfd4035` (Comunidade) |

## Achados do Q2 rodada 1 (a corrigir: FX2.k)

- **S1 (major):** duas abas podem gravar ao mesmo tempo (`writing` é por aba; spacing de flash gravado só depois do I/O, `service.ts:193,359,406`) e o aviso de loudness pode ser perdido (`lastWrittenLevelDb` só em memória, `client.svelte.ts:31,62,112`). Correção: `navigator.locks.request('oa-cable-write', {ifAvailable:true})` em authorize→settle, marcador persistido de gravação em curso antes do I/O, `lastWrittenLevelDb` vindo do último `ok` do diário.
- **A1 (major):** áudio continua tocando ao trocar de página e fica audível sem clique: Soe `Preview.svelte:41-59,108-109` (dispose sem `engine.stop()`), Comparar `CompararPage.svelte:70-78` + `chains.ts:52` (monta cadeias audíveis se `playing`), Curva `preview.svelte.ts:39-41` (sem checar geração após `await start`). Correção: parar o motor ao desmontar se a página iniciou o modo cadeias (como `TrackSheet:68-77` e `BlindTest:131-140`), checar geração após o await, Comparar só audível após o próprio Play.
- **M1 (major):** medidores da Biblioteca leem `engine.getAnalyserTap()` depois do volume da prévia (`Biblioteca.svelte:74`, `engine.ts:990-997`): o VU muda com o volume "só no navegador". Correção: medir antes do estágio de volume; acrescentar e2e de leitura ao vivo dentro do app.
- **M2 (major):** referência 0 VU (−18/−20/−14) não é selecionável nem aplicada: ninguém chama `setReference` (`meters.ts:303`); Curva, Comparar e Teste cego ignoram `meterRef`. Correção: seletor ligado a `meterRef` e `setReference` na inicialização e na troca.
- **Minors:** S2 diário e flash só gravados depois do I/O (fechar a aba no meio não deixa registro; gravar registro pendente antes); S3 checklist não mostra o dispositivo alvo e dispositivos restaurados são selecionados sozinhos; S4 contadores da página Cabo no modo simulado divergem do checklist; A2 edição durante o início da prévia da Curva toca curva antiga; A3 Curva sem nota de prévia aproximada quando 96 kHz é recusado; E1 "1 alterações não gravadas" no primeiro carregamento (flag 0/1 passada como contagem, `written` não persistido, mensagem sem plural; `+layout.svelte:133`, `curve.svelte.ts:28,85`); E2 link `#p=` reaplicado a cada recarga (remover o hash com `replaceState` depois de aplicar); I1 troca de idioma após a hidratação (script de idioma antecipado ou markup dependente de idioma fora do prerender); I2 `biblioteca_jump_warning` não usa o texto literal "A nova curva pode soar mais alta. Abaixe o volume antes de gravar." (reusar `cable_loudness_warning`); I3 ajuda sem as teclas 1/2/3 e Ctrl+K; X1 CSP com `unsafe-inline` em estilos e sem `frame-ancestors`/`Permissions-Policy hid=(self)` (cabeçalhos são da F3/F5: só documentar se for o caso); T1 causa do teste instável da Cabo (`cabo/edges.svelte.test.ts:112`: clique em Parar numa animação de ~294 ms; usar o modo ×10 ou rAF falso); T2 smoke e visual da `/soe-como-x` incompatíveis: recapturar as referências visuais com os dados AutoEq presentes.

## Decisões durante a execução

- 2026-10-16 · PF1: o router_run recusa `node`, `npm --version`, `check:sensitive`, `format:check`, `types`, `test:coverage` e os scripts `test:<área>` (fora da allowlist; só `test`, `lint` e `typecheck` passam). O orquestrador roda esses comandos direto (0.17) numa rodada central após cada wave. `npm install` também é feito pelo orquestrador (fila de integração).
- 2026-10-16 · Locks: `src\dsp\level.mjs` e `test\dsp\level.test.mjs` passaram da T1.7 para a T1.2, porque o gate usa `levelDb`. A T1.7 ficou com distância e ISO 226.
- 2026-10-16 · Exports por área apontam para `src\<área>\index.mjs`, criados na T1.13 (W ampliado). A raiz exporta namespaces (`dsp`, `safety`, …) e 20 atalhos sem colisão.
- 2026-10-16 · W1.2/W1.3: a T1.4 e a T1.8 passaram para a W1.3, junto da T1.12, porque leem arquivos em edição na W1.2. A T1.9 e a T1.10 recebem o gate e o `levelDb` por injeção e testam com stubs; a integração real está na T1.T.
- 2026-10-16 · Gate: os códigos do plano (§T1.2) são o contrato estável; `reasons` é uma lista de objetos `{code, stage?, value?, limit?}`, em ordem documentada. O modo `drag` pode aprovar o que o `full` reprova (caso LP 20 968 Hz Q 2, diferença de 1,55e-4 dB); por isso transporte e servidor usam sempre `gateForWrite` (sempre `full`). Na amostra de 234 curvas, os vereditos foram idênticos.
- 2026-10-16 · Transporte: espera de 16 ms depois de cada um dos 9 relatórios, inclusive o último, e mais 150 ms antes do commit (total ≈ 294 ms), conforme `docs\protocol-0xcb.md`. `writeMany` para na primeira falha e marca os demais como `skipped`.
- 2026-10-16 · S1: além dos códigos de decodificação do plano, a codificação usa `s1:bands` e `s1:grid`. LP/HP são gravados com ganho 0 e decodificados sem `gainDb`; o payload continua idêntico.
- 2026-10-16 · Solver: as caixas padrão são as `ABS_RANGES`, porque os presets oficiais ficam fora das `SOFT_RANGES` (PK em 20–25 Hz, Q 0,1–0,5, +9,2 dB); `ranges: 'soft'` continua disponível. Termo `trebleDetail` (padrão 0,5) acrescentado à perda do AutoEq: com 0 a perda é exatamente a do AutoEq, mas o preset Enérgico fica com 1,22 dB e falha o critério de < 1 dB. O otimizador é Levenberg–Marquardt próprio sobre (log f, log Q, ganho).
- 2026-10-16 · ISO 226: tabela 1 confirmada por duas implementações independentes e pelo texto da norma até 5 kHz; linhas de 6,3 a 12,5 kHz só pelas implementações. Delta da revisão 2023 documentado (até 0,6 dB).

- 2026-10-16 · Q1.1 minor 10: `writeCurve` devolve `{status, crc, startedAt, finishedAt, reportsSent, committed, error?}` em vez de `reports` (plano T1.9). Contagem e estado do commit são o que o diário e o aviso de loudness precisam; os bytes exatos saem de `reportsFromPayload(metrics.payload)`.
- 2026-10-16 · FX1.1: o transporte importa `gateForWrite` e o aplica sempre; um gate injetado só acrescenta checagens. O gate e o transporte trabalham sobre um snapshot congelado das bandas (uma leitura por campo). O scan refina também o primeiro e o último intervalo: fica até 3,06e-6 dB mais estrito que a referência, e os 11 presets e o Neutro continuam aprovados.

- 2026-10-16 · FX1.11: nomes de receita (medição, alvo) passam pela detecção de URL depois de remover uma extensão permitida (csv, txt, json, frd, zma, mdat, wav, rew); versão do solver só `X.Y.Z` com pré-release alpha/beta/rc/dev/pre e build hexadecimal. Só as três bandeiras de subdivisão RGI (Inglaterra, Escócia, País de Gales) mantêm tags; demais sequências de tag são removidas.

- 2026-10-16 · PF2: adotado o **SvelteKit 3** (estável desde 2026-10-01; 0.14). Itens do plano escritos para o Kit 2 foram mapeados: configuração no `sveltekit({...})` do `web/vite.config.ts` (não há `svelte.config.js`), `#lib` no lugar de ``, `/env/public` no lugar de `/static/public`. Brief comum dos delegados em `docs/plans/f2-delegate-brief.md`.
- 2026-10-16 · PF2: **TypeScript 6** no núcleo e no web. O TS 7 (port nativo) não tem API JavaScript, e Kit 3, svelte-check e typescript-eslint exigem TS 6. O typecheck do núcleo passa igual; as declarações foram regeneradas.
- 2026-10-16 · T2.1: testes de componente em Chromium real (`@vitest/browser-playwright`), em vez de jsdom, que é o padrão atual do `sv` para runes. Opções do Paraglide em `web/project.inlang/paraglide.config.mjs` (o `.gitignore` do inlang ignora `.json`), importado pelo `vite.config.ts`; cookie `oa_lang` e localStorage `oa.lang` confirmados no runtime gerado. O npm 12 bloqueia scripts de instalação: `esbuild` e `workerd` aprovados em `allowScripts`.
- 2026-10-16 · Fontes: Special Elite e Permanent Marker são Apache-2.0 (não OFL); mantidas por serem permissivas e compatíveis com a AGPL, com atribuição no THIRD_PARTY_NOTICES (T2.2). Fontes usadas pelos mocks: Instrument Serif, Geist, JetBrains Mono, Courier Prime, Barlow Condensed, Oswald, Special Elite, EB Garamond, Permanent Marker e VT323.
- 2026-10-16 · AutoEq: `measurements/Rtings` e `measurements/rtings` colidem em sistema de arquivos sem distinção de maiúsculas. A T2.19 lê os blobs via git (`ls-tree` + `cat-file`), sem checkout.

- 2026-10-16 · W2.2: nenhum delegado consegue rodar os testes do web (o `router_run` só aceita `test`, `lint` e `typecheck` da raiz). O orquestrador roda `check:web`, `test:web:unit`, lint do web e build depois de cada wave e devolve as falhas com a saída colada. O WASM do `@lix-js/sdk` corrompeu no disco durante instalações concorrentes (erro `Invalid opcode` no compile do Paraglide); remover a pasta e rodar `npm install` resolve.
- 2026-10-16 · Lint do web: `svelte/no-navigation-without-resolve` com `ignoreLinks: true` (app servido na raiz da origem, sem `base`; `resolve()` exige o runtime do Kit, ausente nos testes de componente).

- 2026-10-16 · FX2.1 (S1–S4): exclusão entre abas com Web Locks (`oa-cable-write`, `ifAvailable`, injetável); marcador `oa.cable.inflight` gravado antes do I/O e removido dentro do lock; tentativa de flash registrada antes do primeiro byte; marcador órfão vira entrada `interrupted` + resgate ao carregar (esquema do diário do núcleo inalterado); nível da última gravação derivado da última entrada `ok` do diário; dispositivos restaurados nunca viram alvo em silêncio (alvo implícito só com exatamente um cabo, exibido no checklist); contadores da Cabo vêm de `cable.counters()`, a mesma fonte do checklist.
- 2026-10-16 · FX2.2 (A1, A2, A3, M1, M2, E2): cada página só para o motor se ela o iniciou (token por tentativa); Comparar só fica audível depois do próprio Play; barramento de medição pré-volume (`getMeterBus()`), também usado pelos analisadores de espectro; seletor global de referência 0 VU no popover de áudio, ligado a `meterRef` e a `setReference`; hash `#p=` removido com `history.replaceState` nativo depois de aplicado.
- 2026-10-16 · FX2.3 (E1, I1, I2, I3, T1): indicador booleano `unsaved` (só depois de uma gravação ou edição na sessão) e `oa.curve.written` persistido; I1 com script externo bloqueante `web/static/lang-boot.js` (a estratégia `preferredLanguage` é exigida pelo plano §3.5), que oculta a página até o idioma do cliente ser aplicado; `biblioteca_jump_warning` igual ao texto literal; ajuda com 1/2/3 e Ctrl/⌘+K; `TransportTape` com relógio injetável.
- 2026-10-16 · PF3, fatos da API (Better Auth 1.7.10, lidos no pacote): `svelteKitHandler({ auth, event, resolve, building })` não preenche `locals`; `sveltekitCookies(getRequestEvent)` como último plugin; D1 nativo (`database: env.DB`, dialeto Kysely D1, sem transações interativas); `user.changeEmail.sendChangeEmailConfirmation`; `user.deleteUser.{sendDeleteAccountVerification,beforeDelete,afterDelete}`; `session.freshAge` padrão 1 dia; rotas `/sign-up/email`, `/sign-in/email`, `/sign-in/username`, `/request-password-reset`, `/reset-password`, `/change-email`, `/change-password`, `/delete-user`, `/send-verification-email`, `/list-sessions`, `/revoke-session`, `/revoke-sessions`, `/revoke-other-sessions`; `disableIpTracking` faz `getIP()` devolver `null`; o plugin `twoFactor` não grava marcador de 2FA na sessão (a T3.5 precisa de marcador próprio para o 2FA de admin); CLI `npx auth@latest generate` (o `migrate` não alcança D1: migrações SQL revisadas e aplicadas com `wrangler d1 migrations`). Testes de Worker: `cloudflareTest` de `@cloudflare/vitest-plugin`, `applyD1Migrations` de `cloudflare:test`, `exports` de `cloudflare:workers`; mocks de saída com `@msw/cloudflare` (`fetchMock` saiu da documentação). Resend exige `User-Agent`; `Idempotency-Key` ≤ 256 caracteres, 24 h. Turnstile: chaves de teste `1x…AA`/`2x…AA`/`3x…AA`. Rate limiting binding: `period` 10 ou 60.
- 2026-10-16 · PF3, hash: `password.hash/verify` próprios com `node:crypto` scrypt N=2^14, r=8, p=5, dkLen 64, sal de 16 bytes, formato versionado `scrypt$N$r$p$salt$hash` (OWASP; 123 ms locais, ≤ 200 ms). O `msw@3` exigido pelo `@msw/cloudflare` conflita com o peer opcional `msw@^2` do `@vitest/mocker`; a suíte de componentes (que usa `vi.mock` no Chromium) continua 1 051/1 051.
- 2026-10-16 · Verificação central: nunca rode `build:web` junto com `test:web:unit`; o plugin do Paraglide regenera `src/lib/paraglide` durante o build e derruba o Vitest browser ("error when mocking a module", módulos de mensagens ausentes).
- 2026-10-16 · X1 (Q2): CSP com `style-src 'unsafe-inline'`, sem `frame-ancestors` e sem `Permissions-Policy` é escopo da T3.3 (cabeçalhos) e da T5.4 (CSP estrita com nonce, `Permissions-Policy: hid=(self)`); o requisito global de cabeçalhos do plano (§ "Cabeçalhos": HSTS, `frame-ancestors 'none'`, COOP) entra no checklist do PF3. Só documentado.

- 2026-10-16 · W2.4: testes de componente que navegam ou recarregam a página derrubam o runner do Vitest browser ("failed to find the runner") nas execuções combinadas; o export da Comparar trocou o clique em link por callback e `location.assign` por link. Lint: `ignoreGoto: true` junto de `ignoreLinks` (mesma justificativa: sem `base`). Achados para o Q2: `1 unsaved changes` já no primeiro carregamento (curva `dirty` sem gravação anterior); estratégia `preferredLanguage` faz a página prerenderizada em pt-BR trocar para en-US no cliente em navegadores en-US (comportamento do plano, mas há flash de idioma).

- 2026-10-16 · PF4: OG com `@cf-wasm/resvg` (sem Browser Rendering); import dinâmico dentro do handler (o estático quebra a análise do Kit no Node); fontes TTF em `web/static/og-font/` lidas via `ASSETS`. `gate_ver` derivado de SHA-256 de `THRESHOLDS` (o núcleo não tem constante de versão do gate). Perfil continua em colunas de `"user"` (0009) e `nickname_history` = `username_holds`: o anexo A.2 foi mapeado, não recriado.
- 2026-10-16 · PF4, delegação: T4.1 marcada heavy (fundação de esquema e visibilidade de toda a fase). Duas tarefas novas: **T4.1b** (kit da API v1: o código da F3 não tem helpers de resposta JSON, erro estável, ETag nem checagem de origem para JSON; sem ele cada serviço reinventaria) e **T4.12b** (cliente social no navegador: API, outbox, estado de sessão, usado por T4.13–T4.16; o plano não atribuía esse código). `GET /api/v1/feed` atribuído à T4.6; exportação LGPD social e parte social da exclusão de conta na T4.1.
- 2026-10-16 · Domínio `open-auri.com` registrado pelo operador no Cloudflare Domains. Libera o runbook "Ativação do .com" (T5.5) no PF5/F5: `PUBLIC_ORIGIN`, hostnames do Turnstile, domínio de envio do Resend (SPF/DKIM; o OAuth do wrangler não escreve DNS), rota de domínio próprio do Worker e `SIGNUP_ENABLED=true` depois disso.

- 2026-10-16 · W4.2–W4.4: rotas de página importam `./$types`, que puxam tipos do layout e módulos de cliente; o TS project de integração ganhou `rootDirs` para `.svelte-kit/types` e um shim só de teste para `RequestInit.credentials` (o tipo do Workers não tem). O Worker de jobs importa módulos do web por caminho relativo (`#lib` resolve pelo `web/package.json`); o `repo.ts` foi ajustado para compilar também com `noUncheckedIndexedAccess`. Módulos de servidor usados pelos jobs importam `api/errors.ts`, nunca o barril do kit (o `handler.ts` depende de tipos do Kit). Origens de curva (`oa.social.origins`, curveId → linhagem/versão) decidem a atribuição de `previewed`/`installed`: só bytes exatos de uma versão publicada contam. A Biblioteca prerenderizada não pode ler `url.search`.
- 2026-10-16 · Instabilidade conhecida: sob carga, o pool do `@cloudflare/vitest-plugin` às vezes falha ao iniciar um worker ("bad port") e o arquivo não roda; reexecutar o arquivo isolado resolve. Não rodar `test:web:unit` e `test:int` ao mesmo tempo.

- 2026-10-17 · Retorno do operador sobre a UI: a página Curva regrediu em relação ao mock v2 (edição sem limites visíveis, mensagens do gate opacas com "estágio ?", VU de saída parado, sem animação nem botões do mock) e, de modo geral, todas as páginas pedem mais impacto, didática para leigos, revisão de tipografia, cores e tamanhos, e uma estratégia de carregamento (pré-aquecimento e carregamento sob demanda). Decisão: correção imediata da Curva (FX-UX, heavy) e nova fase **FUX** (polimento de UI/UX) guiada por `docs/plans/fux-spec.md` (auditoria do architect), antes do QG rodada 2 e do aceite global. Achado de carga inicial: ~127 kB gzip de JS compartilhado mesmo em páginas estáticas (`/offline`).

- **2026-10-17 · FUX, decisões do operador e do orquestrador:**
  - Metas de JS por classe revisadas após medição (FUX.B): instrumento leve 150 (meta-alvo 140), instrumento pesado 170 (160), Curva em classe própria 180 (170); formulários de e-mail e senha passam à classe auth (100). Base de toda rota de instrumento ≈ 118 kB (framework e layout ≈ 76, runtime estático ≈ 38, gatilhos do tour ≈ 4).
  - Volume da prévia: padrão −6 dB (era −12) e persistido em `oa.audio.volume`; auditoria confirmou que não há atenuação dupla (volume único no master, matching só abaixa, preamp aplicado uma vez).
  - Barra superior compacta (FUX.NAV, `3a61850`): uma linha de 40 px no desktop (52 px no celular), navegação que dobra em "Mais", menus carregados na primeira interação; ocupação medida 47,2 % (1440×900) e 24,0 % (390×844) do original; sem rolagem horizontal de 320 a 2560 px.
  - Dropdowns: opções com cores explícitas (escuro e papel) e e2e de contraste (`select-contrast.spec.ts`).
  - Glossário do Docs: link profundo derrubava a página (rootMargin negativo do IntersectionObserver após hidratação); corrigido em `34ced6d`.
  - Pedidos novos em andamento: barra de seek, voltar ao início, loop sempre, início aleatório entre 25 % e 75 % nos comparativos e play/pause na barra (SEEK.1 a SEEK.3); arte temática e animações por página (FUX.ART, `docs/plans/fux-art-brief.md`, que flexibiliza o loop decorativo da spec §2.5).
  - **Limite de JS por rota volta a 250 kB gzip (plano §3.9), decisão do PO em 2026-10-17** para dar liberdade às páginas WOW. As metas por classe da FUX (estática 80, auth 100, docs 130, instrumento leve 150, pesado 170, Curva 180) ficam como `goalBytes` informativos em `web/scripts/budget-targets.json`: aparecem na tabela, não falham o build.
  - **Biblioteca: só VUs, decisão do PO em 2026-10-17** ("quero tudo VU reagindo em tempo real"): a ponte mantém os mesmos cinco mostradores parado e ao vivo, L/R viram o maior dos dois e a loudness momentânea deixa de ser exibida nesta página; plano §3.6 atualizado (fecha o major B do FUX.Q rodada 2).
  - Container local de avaliação reconstruído em segundo plano a cada commit (`_qa/preview-rebuild.ps1`, só a partir de commits).
  - Pendências para o QA: publicação "Não listada" como padrão (proposta, aguarda PO); pack de referência com 4 curvas (cartão mostra o número real); "Mais" e a folha mobile não abrem sem JavaScript.

- **2026-10-18 · Lançamento v1.0.0, decisões do operador e do orquestrador:**
  - Simple Analytics só em produção: a tag do script (`scripts.simpleanalyticscdn.com`, beacon em `queue.simpleanalyticscdn.com`, ambos liberados na CSP) só é injetada lá; local, staging e CI ficam sem script. O rodapé ganhou o link para o painel público de estatísticas. Versão da política `2026-10-18` (`POLICY_VERSION`, política pt-BR e en-US e `docs/lgpd.md`).
  - Teste cego como palco ao vivo (`89ec604`): cortina translúcida sobre três caixas iguais que acendem com o nível real da prévia, embaralhamento de 3 s, compartimentos clicáveis e revelação com a cortina subindo no resultado. Os faders de nota ficam no palco. A saída vem pré-selecionada a partir do estado do cabo. Sem "Cabo em Neutro" automático quando a última gravação real não foi Neutro: a escolha passa a ser manual (`a74030e`).
  - Editar nome e descrição: na biblioteca local é um `update` do registro; na conta é uma nova versão (versões só por acréscimo), que passa pelo gate como qualquer publicação.
  - `run_worker_first` só nas rotas de página, também no staging (`11fa0ee`), mais o wrapper de host canônico (#33). O build do deploy (`tools/deploy.mjs`) agora embrulha o Worker como o `npm run build` (`47cc6fc`, `0a5302d`), então a produção recebe de fato o wrapper. Resultado: o workers.dev de produção responde 301 nas páginas (#33 fechada).
  - Portão de cobertura no CI (`1d78dac`, fecha #36): unidade web com limite de 85 % (statements, branches, functions e lines); o servidor é medido por `test:int:coverage`.
  - Desempenho do arraste da Curva: cache da resposta por seção, e efeitos de pintura desligados durante o arraste (`6f2c8bc`: sem brilhos com blur e sem sombras, varredura e arte decorativa pausadas, rótulos sem ler o cookie de idioma a cada quadro; em repouso nada muda). Medição local: média de 16,7 ms em ×1 e 17,6 ms com a CPU 4× mais lenta.

## Resumo final (v1.0.0, 2026-10-18)

Resumo pedido pelo plano (§0.13 e §9).

### O que foi entregue

- **Núcleo (F1):** codec 0xCB, gate v2 (envelope observado), S1, envelope de preset, importação de medições, exportação Equalizer APO, distância e ISO 226, catálogo de presets, transporte WebHID com mutex por dispositivo, política de gravação e diário, medidores (BS.1770, VU, PPM) e solver PEQ.
- **Aplicação web local-first (F2):** Curva, Comparar, Teste cego, Soe como X (dados AutoEq embutidos), Biblioteca, Cabo e Docs, com áudio a 96 kHz, medidores em AudioWorklet, offline e pt-BR e en-US.
- **Backend, autenticação e conta (F3):** Better Auth com scrypt próprio, conta e LGPD (exportação, exclusão, troca de e-mail), 2FA obrigatório no admin, registros de acesso cifrados (Marco Civil), rate limit com HMAC do IP.
- **Social (F4):** publicação, versões e forks, favoritos, atividade com privacidade, rankings, feed, imagens OG, S6 anônimo, S7 troca às cegas, Comunidade e moderação.
- **Produção e operação (F5):** CI, deploy pela máquina do operador, logs sem PII, métricas, backup semanal, dump público, CSP estrita, runbooks; produção em https://open-auri.com e staging no workers.dev.
- **FUX:** polimento de UI e UX em todas as páginas (barra compacta, arte e animações por tema, camada didática, carregamento sob demanda), seek e loop nos comparativos, menu do usuário e lista de bloqueio de apelidos.
- **Fechamento:** QG em 2 rodadas (PASS), lote de issues `qa-minor`, lote pós-FUX, Simple Analytics, Teste cego como palco, edição de nome e descrição, #33, portão de cobertura, desempenho do arraste, `SECURITY.md` e CodeQL (PR #37, `b9426a2`), tag `v1.0.0`.

### Evidências de aceite (verificação central desta sessão)

- Raiz: `npm test` 722/722; lint e typecheck limpos.
- Web, unidade e componente: 2 845/2 845 antes do último lote; depois dele, todas as áreas tocadas verdes.
- Cobertura da unidade web em `89ec604`: statements 96,68 %, branches 88,78 %, functions 97,39 %, lines 97,53 % (limites de 85 %).
- Cobertura da integração: 1 075 testes; linhas 96,2 %, branches 91 %, funções 98,4 %.
- CI verde em `0a5302d` (lint, tipos e varreduras; testes; build e orçamentos; E2E Chrome). CodeQL verde (JS/TS e Actions). PR #37 (`SECURITY.md` e CodeQL) mesclado como `b9426a2`.
- E2E em staging: 38 ok e 1 pulado (o caso de cadastro fechado, porque o staging está com cadastro aberto).
- Deploy de produção: smoke ok (`/`, `/docs`, `/api/v1/feed`, OG); páginas de produção respondem 200; o workers.dev de produção responde 301 nas páginas (#33 fechada).
- Orçamentos: todas as rotas com até 250 kB gzip (`/teste-cego` 157 kB).
- Desempenho local do arraste: média de 16,7 ms em ×1 e 17,6 ms com a CPU 4× mais lenta.
- Issues fechadas nesta sessão: #8 a #31, #33, #35 e #36.

### Decisões do PO (2026-10-18, todas respondidas)

1. Apelidos: as marcas `final`, `chord` e `tidal` continuam recusadas só quando o apelido é exatamente igual à marca (mantido).
2. Desativar o 2FA: a senha é conferida antes do código, então uma senha errada nunca consome um código de backup (`/verify-password` antes do código; teste de integração).
3. Política: subir a versão volta a mostrar o aviso (mantido; versão `2026-10-18`).
4. Faders do Teste cego: a nota dada não pode ser apagada e Enter registra 5 (mantido).
5. Da FUX: "Não listada" é o padrão de publicação na Curva, na Comunidade e no Comparar (`a34146b`); o pack de referência da Biblioteca traz os 11 presets oficiais (`c7fa290`).
6. Simple Analytics: site cadastrado e painel público, funcionando (confirmado pelo operador).
7. Painel admin: o aviso "Cloudflare Access: não configurado" é esperado; o Access é uma camada opcional (`ACCESS_AUD` e `ACCESS_TEAM_DOMAIN`). Ligar ou não fica a critério do operador.

### O que falta

- **FH:** validação em hardware quando o cabo chegar (issue #6). Iniciada em 2026-10-28: ver "FH: progresso".
- Issue #7 (acompanhamento do plano) segue aberta; a #5 é fechada com o lançamento.

## FH: progresso

- **2026-10-28 · FH iniciada; o cabo chegou.** Kuba Auri, VID `0x3302` / PID `0x8902`, interface HID `mi_03`; Windows 11, Edge 156 (WebHID), USBPcap 1.5.4.0, tshark 4.6.9. Detalhes em `docs/probing.md` (seção F) e `docs/verification.md`.
  - **B1** ✅: uma collection Consumer Control; input report `1` (botões), input e output `0xCB` de 31 bytes (usos vendor `0xFF000003` / `0xFF000002`); nenhum feature report; **nenhum report `0x4B`**.
  - **B2** ✅: `receiveFeatureReport(0/1/0xCB)` rejeitam com `NotAllowedError`; escuta passiva de 10 s sem input reports.
  - **Byte-stream no fio** ✅: 13 gravações capturadas (11 pela página oficial na ordem do fixture, depois `padrao` e Neutro pelo open-auri), 130 transferências interrupt OUT no endpoint `0x05`, nenhuma SET_REPORT com dados, nenhum interrupt IN. 11/11 iguais ao `eq0xcb.reference.json`; `padrao` do open-auri igual ao oficial nos 10 reports; Neutro igual ao `encodeReports`; CRC 13/13; commit de 5 e de 31 bytes idênticos no fio. Intervalos: oficial 18–32 ms (típico 24) e 176–195 ms antes do commit; open-auri 18–33 ms e 175–178 ms.
  - `tools/usb-golden.mjs` ganhou o modo `--input-format interrupt-out-raw` e `--provenance`; golden real em `test/fixtures/usb-wire-golden.json`, testes em `test/tools/usb-golden-real.test.mjs`.
  - **B3** não executada: falta decisão (nenhum comando de leitura documentado para o `0xCB`; os do `0x4B` não se aplicam, porque o cabo não tem esse report).
  - **Medição acústica:** fone Kuba Auri → HyperX QuadCast S, concha fixada contra o mic, volume constante ~40–50%; WebAudio a 48 kHz no Windows, `echoCancellation`/`noiseSuppression`/`autoGainControl` desligados. Senoides de 707 Hz a 8 kHz, 1/6 de oitava, 2 passagens/ponto, pico na FFT de 32768; SNR 40–60 dB a partir de 1 kHz (<30 dB abaixo de ~1 kHz, acoplamento fraco). A/B ×3 (Neutro/curva), referência distante 6,3–8 kHz. Tentativa inicial invalidada por movimento (±15–25 dB): fixar transdutor e manter volume.
  - **Envio acústico:** console do navegador, mesmos frames do codec (9 reports, 16 ms, 150 ms de espera, commit), 2,1 s entre escritas; B12 sem commit. PK 2000/5000 Hz −12 dB Q3, pré-amp −0,5 dB, `standard` por `src/safety/classify.mjs`, CRCs `0x3D48`/`0xBE68`. Tabela completa de medições em `docs/probing.md`, seção F.
  - **B4** ✅: PK 2 kHz concorda com `magnitudeDb` em ~0,5 dB na média dos 3 ciclos (2000 Hz −12,4 dB vs −12,0 previstos); efeito imediato (≤ ~1,5 s), sem replug. Neutro reproduzível em ±0,5 dB entre 4 medições.
  - **B10** ✅: vales em 2000/5040 Hz e simetria dos vizinhos (−7,7/−7,5 dB) confirmam DSP a 96 kHz com host a 48 kHz, resolução de 1/6 de oitava + simetria. PK 5 kHz válido: 5040 −12,4; 4490 −7,5; 5657 −7,4; 4000 −4,2 dB (previstos: 5657 −7,4; 4000 −4,4).
  - **B7** ✅: PK 5 kHz com CRC corrompido (último byte `XOR 0xFF`, report 7 byte 10) manteve PK 2 kHz armazenado, medido duas vezes; CRC correto aplicou. Firmware valida CRC; rejeição silenciosa, sem input report.
  - **B13** ✅ com ressalva: Neutro → PK 2 kHz com tom de 2 kHz, queda de ~10 dB em rampa suave de ~15 ms, sem energia de clique audível nem mute. Limite de sensibilidade HF do mic para cliques muito curtos só em HF; ScriptProcessor perdeu ~17% dos frames, impedindo alinhar o tempo absoluto dentro da escrita.
  - **B12** ✅: PK 2 kHz commitado → 9 reports de Neutro sem `01 65 00 01 FF`: som neutro ao vivo (2 medições); replug restaurou PK 2 kHz (2000 Hz −12,8 dB vs referência, 3 passagens). Dados aplicam em RAM; commit persiste na flash. Bytes `01 FF` não variados. Modo sem flash, X2 no cabo e teste cego no cabo são viáveis, **não implementados**; continuam EM BREVE.
  - **Desgaste de hoje:** ~12 escritas com commit na bancada + 13 na captura; mais 1 envio só de dados. **Estado final:** Padrão Auri, bytes oficiais, CRC `0x1970`, regravado com commit.
  - **Ainda não feitas:** B3 (sem comando de leitura `0xCB` documentado), B5, B6, B8, B9 e B11.

## Bloqueios e perguntas ao humano

Nenhum bloqueio. Perguntas ao PO: ver "Resumo final (v1.0.0)", "Perguntas em aberto para o PO".
