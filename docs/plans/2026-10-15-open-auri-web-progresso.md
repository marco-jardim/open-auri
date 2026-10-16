# Progresso · open-auri web v1

## Estado

Fase atual: F3 · Etapa: PF3 · F2 concluída (Q2 PASS, push 008315f)

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

Verificação central da W2.4: `check:web` 0 erros; `test:web:unit` 61 arquivos, 586 testes; lint do web limpo; build ok; e2e smoke 2/2; raiz 613/613.

Verificação central da W2.2: `check:web` 0 erros; `test:web:unit` 23 arquivos, 284 testes; lint do web limpo; build ok; raiz 613/613.

## Pre-flights

| PF | Data | Resultado | Evidências |
|---|---|---|---|
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
| wrangler | 4.151.0 | MIT OR Apache-2.0 | 2026-10-16 |
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
- 2026-10-16 · Verificação central: nunca rode `build:web` junto com `test:web:unit`; o plugin do Paraglide regenera `src/lib/paraglide` durante o build e derruba o Vitest browser ("error when mocking a module", módulos de mensagens ausentes).
- 2026-10-16 · X1 (Q2): CSP com `style-src 'unsafe-inline'`, sem `frame-ancestors` e sem `Permissions-Policy` é escopo da T3.3 (cabeçalhos) e da T5.4 (CSP estrita com nonce, `Permissions-Policy: hid=(self)`); o requisito global de cabeçalhos do plano (§ "Cabeçalhos": HSTS, `frame-ancestors 'none'`, COOP) entra no checklist do PF3. Só documentado.

- 2026-10-16 · W2.4: testes de componente que navegam ou recarregam a página derrubam o runner do Vitest browser ("failed to find the runner") nas execuções combinadas; o export da Comparar trocou o clique em link por callback e `location.assign` por link. Lint: `ignoreGoto: true` junto de `ignoreLinks` (mesma justificativa: sem `base`). Achados para o Q2: `1 unsaved changes` já no primeiro carregamento (curva `dirty` sem gravação anterior); estratégia `preferredLanguage` faz a página prerenderizada em pt-BR trocar para en-US no cliente em navegadores en-US (comportamento do plano, mas há flash de idioma).

## Bloqueios e perguntas ao humano

Nenhum.
